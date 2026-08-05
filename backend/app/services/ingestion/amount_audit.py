"""Ελεγκτής ποσών απέναντι στο ΕΝΤΥΠΟ (PDF) της ΗΔΥΚΑ — το ground truth.

Το structured search/CDA στρογγυλοποιεί τα ανά-εκτέλεση ποσά (±1-2 λεπτά στα repeats/partials).
Το έντυπο εκτέλεσης (`/prescriptions/print/{barcode}?executionNo=N`) τυπώνει τα ΑΚΡΙΒΗ
«ΠΛΗΡΩΤΕΟ ΑΠΟ ΑΣΦ/ΝΟ» & «ΠΛΗΡΩΤΕΟ ΑΠΟ ΤΑΜΕΙΟ» ανά εκτέλεση. Αυτή η μηχανή διαβάζει το έντυπο
για κάθε εκτέλεση (μία φορά· flag `amount_audited_at`), συγκρίνει και ΔΙΟΡΘΩΝΕΙ όπου διαφέρει,
κρατώντας ίχνος στο `amount_audit_log`. Τρέχει σε batches από beat → 100% ταύτιση με Soft1.

ΚΥΥΑΠ/ΕΤΥΑΠ (ΤΡΙΜΕΡΗΣ) ΕΛΕΓΧΟΝΤΑΙ ΚΑΝΟΝΙΚΑ: το έντυπο δίνει po_patient (ασφ/νος) & po_fund (ΚΑΘΑΡΟ
ΕΟΠΥΥ, χωρίς ΚΥΥΑΠ). Αποθηκεύουμε patient_share=po_patient, amount_claimed=amount_total−po_patient
(περιέχει ΚΥΥΑΠ)· ο «Κλείσιμο» αφαιρεί το kyyap_covered ΜΙΑ φορά ανά visit → καθαρό ΕΟΠΥΥ=po_fund.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone


async def audit_amounts_against_printout(
    tenant_id: str, *, db, limit: int = 150, window_days: int | None = None,
    dry_run: bool = False, tolerance: int = 0,
) -> dict:
    """Ελέγχει έως `limit` ανέλεγκτες εκτελέσεις του tenant απέναντι στο έντυπο PDF και διορθώνει.

    - `window_days`: αν οριστεί, μόνο εκτελέσεις με executed_at εντός του παραθύρου (αλλιώς όλο το ιστορικό).
    - `tolerance`: ανοχή σε λεπτά πριν θεωρηθεί διόρθωση (default 0 = ακριβής ταύτιση).
    - Επιστρέφει counters + πόσες απομένουν ανέλεγκτες."""
    from app.api.v1.routers.ingestion import _effective_hdika_creds
    from app.services.ingestion.hdika_client import HdikaClient

    creds = await _effective_hdika_creds(tenant_id)
    if not creds or not creds.get("base_url") or not creds.get("api_key"):
        return {"ok": False, "reason": "no_credentials"}
    if not (creds.get("pharmacy_id") or creds.get("pharmacy_code")):
        # φρουρός GDPR: χωρίς pharmacy_id το έντυπο μπορεί να αφορά άλλο φαρμακείο
        return {"ok": False, "reason": "no_pharmacy_id"}

    client = HdikaClient(dict(creds, throttle=creds.get("throttle") or 0.05))
    coll = db["prescription_executions"]

    q: dict = {
        "tenant_id": tenant_id,
        "source": "HDIKA",
        "amount_audited_at": {"$exists": False},
        "cancelled": {"$ne": True},
    }
    if window_days:
        q["executed_at"] = {"$gte": datetime.now(tz=timezone.utc) - timedelta(days=window_days)}

    # Εκτελέσεις που το PDF τους αποτυγχάνει επίμονα (π.χ. μερική/κατοχυρωμένη χωρίς έντυπο) δεν
    # πρέπει να ξαναδοκιμάζονται ατέρμονα → όποια ξεπέρασε το όριο αποτυχιών εξαιρείται.
    q["amount_audit_fails"] = {"$not": {"$gte": 5}}   # ΝΒ: πιάνει & τα docs χωρίς το πεδίο (missing)
    docs = await coll.find(
        q, {"external_id": 1, "patient_share": 1, "amount_total": 1, "amount_claimed": 1},
    ).sort("executed_at", -1).limit(limit).to_list(length=limit)

    checked = corrected = failed = skipped = 0
    now = datetime.now(tz=timezone.utc)
    for d in docs:
        ext = str(d.get("external_id") or "")
        # ⚠ ΚΥΥΑΠ/ΕΤΥΑΠ (ΤΡΙΜΕΡΗΣ split) ΔΕΝ εξαιρούνται πλέον. Το ΕΟΠΥΥ έντυπο (`_printout_split`) δίνει
        # ΣΩΣΤΑ το τριμερές: po_patient = ΠΛΗΡΩΤΕΟ ΑΠΟ ΑΣΦ/ΝΟ, po_fund = ΚΑΘΑΡΟ ΕΟΠΥΥ (χωρίς το ΚΥΥΑΠ).
        # Το μοντέλο αποθήκευσης: patient_share = po_patient· amount_claimed = amount_total − po_patient
        # (ΠΕΡΙΕΧΕΙ το ΚΥΥΑΠ)· ο «Κλείσιμο» αφαιρεί το `details.kyyap_covered` ΜΙΑ φορά ανά visit → καθαρό
        # ΕΟΠΥΥ = po_fund (επαληθευμένο vs έντυπο). Δηλαδή ο audit είναι AUTHORITATIVE και για τα ΚΥΥΑΠ.
        # (Ιστορικό: παλαιότερη «εξαίρεση ΚΥΥΑΠ + restore σε ingestion τιμές» μετατόπιζε τη χρέωση ταμείου
        # κατά λεπτά — αφαιρέθηκε 2026-08-05· βλ. memory kyyap-audit-fund-charge-bug.)
        barcode, _, exn = ext.rpartition(":")
        try:
            exec_no = int(exn)
        except ValueError:
            barcode, exec_no = ext, 1
        if not barcode:
            skipped += 1
            continue

        po = await asyncio.to_thread(client._printout_split, barcode, exec_no)
        if not po:
            failed += 1
            if not dry_run:               # μετρητής αποτυχιών → μετά από 5 σταματά να ξαναδοκιμάζεται
                await coll.update_one({"_id": d["_id"]}, {"$inc": {"amount_audit_fails": 1}})
            continue                      # ΔΕΝ μαρκάρουμε audited — να ξαναδοκιμαστεί (έως το όριο)
        checked += 1
        po_patient, po_fund = po
        cur_patient = d.get("patient_share")
        cur_total = d.get("amount_total")
        cur_claimed = d.get("amount_claimed")

        # ── ΚΡΙΣΙΜΟ: ΠΟΤΕ δεν αλλάζουμε το amount_total (=ΗΔΥΚΑ retail, authoritative) ──────────────
        # Το έντυπο δίνει ΔΙΜΕΡΗ split (ασφ/νος + ταμείο). Σε ΚΥΥΑΠ/ΕΤΥΑΠ ο επιμερισμός είναι ΤΡΙΜΕΡΗΣ
        # (ασφ/νος·ΚΥΥΑΠ·ΕΟΠΥΥ) → το po_fund ΔΕΝ είναι όλο το ταμείο. Αν γράφαμε total=po_patient+po_fund
        # θα κόβαμε τη μερίδα ΚΥΥΑΠ. Αντ' αυτού: κρατάμε το amount_total, διορθώνουμε ΜΟΝΟ το split του
        # ασφαλισμένου (po_patient = ΠΛΗΡΩΤΕΟ ΑΠΟ ΑΣΦ/ΝΟ — ίδιο νόημα σε ΚΥΥΑΠ & μη-ΚΥΥΑΠ) και το
        # amount_claimed = amount_total − ασφ/νος (ο ορισμός του engine· το «Κλείσιμο» αφαιρεί μόνο του
        # το kyyap_covered για το ΕΟΠΥΥ). Έτσι ΚΥΥΑΠ & repeats διορθώνονται σωστά χωρίς διαφθορά.
        if cur_total is None or po_patient < 0 or po_patient > cur_total + 1:
            skipped += 1                       # φρουρός: garbage/ασυνεπές έντυπο → μην πειράξεις
            if not dry_run:
                await coll.update_one({"_id": d["_id"]},
                                      {"$set": {"amount_audited_at": now, "amount_audit_skip": "guard"}})
            continue
        new_claimed = cur_total - po_patient
        set_fields: dict = {"amount_audited_at": now}
        drift = max(abs((cur_patient or 0) - po_patient), abs((cur_claimed or 0) - new_claimed))
        if (cur_patient != po_patient or cur_claimed != new_claimed) and drift > tolerance:
            corrected += 1
            if not dry_run:
                set_fields.update(patient_share=po_patient, amount_claimed=new_claimed)
                await db["amount_audit_log"].insert_one({
                    "tenant_id": tenant_id, "external_id": ext, "barcode": barcode,
                    "exec_no": exec_no, "ts": now,
                    "old": {"patient_share": cur_patient, "amount_total": cur_total,
                            "amount_claimed": cur_claimed},
                    "new": {"patient_share": po_patient, "amount_total": cur_total,
                            "amount_claimed": new_claimed},
                    "drift_cents": drift,
                })
        if not dry_run:
            await coll.update_one({"_id": d["_id"]}, {"$set": set_fields})

    client.close()
    remaining = await coll.count_documents(q)
    return {"ok": True, "tenant_id": tenant_id, "batch": len(docs), "checked": checked,
            "corrected": corrected, "failed": failed, "skipped": skipped,
            "remaining": remaining, "dry_run": dry_run}
