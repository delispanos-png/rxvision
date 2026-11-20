"""Κύπρος: «Στοχευμένη Προώθηση» με τα ΙΔΙΑ σχήματα απαντήσεων με την Ελλάδα (`services/marketing.py`),
ώστε να δουλεύουν αυτούσιες οι οθόνες Marketing → Dashboard και Θεραπευτικές κατηγορίες.

Πηγή: οι εκτελέσεις ΓεΣΥ (`cy_dispensings`) και ο ATC κάθε γραμμής από τον κατάλογο Κύπρου
(`services/cy/atc_link.py` — ΕΝΑΣ ορισμός με Εικόνα Πελάτη/Segments/Διατροφή). Ίδιες 10 θεραπευτικές
κατηγορίες (`THERAPY_CATEGORIES`). Κοινό & συγκατάθεση: `services/cy/contacts.py` (cy_patients.contact),
ΠΟΤΕ τα ελληνικά `patient_contacts`.

Τα κοινά που βγαίνουν από φάρμακα είναι ΔΕΔΟΜΕΝΑ ΥΓΕΙΑΣ → μόνο μήνυμα φροντίδας (ο κανόνας ζει στο
`contacts.clinical`, ίδιος για χειροκίνητη καμπάνια και αυτοματισμό).
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.repositories.cy import CyDispensingRepository
from app.services.marketing import THERAPY_CATEGORIES

_TB_CACHE: dict[str, tuple[float, dict]] = {}
_TB_TTL = 300.0


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def category_of(atc: str | None) -> str | None:
    a = str(atc or "").upper()
    for c in THERAPY_CATEGORIES:
        if any(a.startswith(x) for x in c["atc"]):
            return c["key"]
    return None


def reset() -> None:
    _TB_CACHE.clear()


async def therapy_breakdown(tenant_id: str) -> dict[str, dict]:
    """{κατηγορία → {"patients": set(pseudo_id), "value": λεπτά}}. Ασθενής ανήκει σε κατηγορία αν του
    ΔΟΘΗΚΕ φάρμακό της (qty_disp > 0). Αξία = το ποσό ΤΗΣ ΓΡΑΜΜΗΣ (όχι όλης της εκτέλεσης)."""
    hit = _TB_CACHE.get(tenant_id)
    if hit and time.monotonic() - hit[0] < _TB_TTL:
        return hit[1]
    from app.services.cy import atc_link
    lk = await atc_link.lookup()
    out: dict[str, dict] = {c["key"]: {"patients": set(), "value": 0} for c in THERAPY_CATEGORIES}
    rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        {"$match": {"patient_ref": {"$nin": [None, ""]}}},
        {"$project": {"patient_ref": 1, "lines.code": 1, "lines.barcode": 1, "lines.qty_disp": 1,
                      "lines.amounts.total": 1}}])
    from app.services.cy.chains import deceased_refs
    dead = await deceased_refs(tenant_id)
    for d in rows:
        if d["patient_ref"] in dead:
            continue                        # απεβίωσε → εκτός θεραπευτικών κοινών
        for ln in d.get("lines") or []:
            if not ln.get("qty_disp"):
                continue
            info = lk.for_line(ln)
            key = category_of(info["atc"]) if info else None
            if key:
                out[key]["patients"].add(d["patient_ref"])
                out[key]["value"] += int((ln.get("amounts") or {}).get("total") or 0)
    _TB_CACHE[tenant_id] = (time.monotonic(), out)
    return out


async def _reachable(tenant_id: str) -> set[str]:
    """Όσοι μπορούν να λάβουν μήνυμα: συγκατάθεση + κινητό ή email + δεν ζήτησαν να σταματήσουν."""
    from app.services.cy.contacts import _find_all
    pats = await _find_all(tenant_id, {
        "erased": {"$ne": True}, "contact.marketing_consent": True, "contact.unsubscribed_at": None,
        "$or": [{"contact.mobile": {"$nin": [None, ""]}}, {"contact.email": {"$nin": [None, ""]}}]})
    return {p["pseudo_id"] for p in pats}


async def category_sizes(tenant_id: str) -> list[dict]:
    br = await therapy_breakdown(tenant_id)
    reach = await _reachable(tenant_id)
    res = [{"key": c["key"], "label": c["label"], "icon": c["icon"], "offer": c["offer"],
            "patients": len(br[c["key"]]["patients"]),
            "reachable": len(br[c["key"]]["patients"] & reach),
            "value": round(br[c["key"]]["value"])} for c in THERAPY_CATEGORIES]
    res.sort(key=lambda x: x["patients"], reverse=True)
    return res


async def dashboard(tenant_id: str) -> dict:
    """Ίδιο σχήμα με `marketing.dashboard`. Τα `segment` των καρτών είναι κλειδιά κοινού ΚΥΠΡΟΥ
    (`soon`, `inactive`, `therapy:<κατηγορία>`) με `value=None` — η οθόνη ανοίγει τις Καμπάνιες Κύπρου."""
    from app.services import marketing
    from app.services.cy import contacts as cy_contacts
    perf = await marketing._campaign_performance(tenant_id)   # noqa: SLF001 — κοινό comms_campaigns
    cats = await category_sizes(tenant_id)
    reach = await _reachable(tenant_id)
    soon = await cy_contacts.segment_refs(tenant_id, "soon") or set()
    inactive = await cy_contacts.segment_refs(tenant_id, "inactive") or set()
    br = await therapy_breakdown(tenant_id)

    cards: list[dict] = []
    if soon:
        cards.append({"id": "refill", "icon": "⏰", "urgency": "high",
                      "title": f"{len(soon)} πελάτες με επόμενη φάση συνταγής σε 7 ημέρες",
                      "why": "Θύμισέ τους να περάσουν — καλύτερη συνέπεια στην αγωγή & σίγουρη εκτέλεση.",
                      "count": len(soon), "reachable": len(soon & reach),
                      "cta": "Υπενθύμιση φάσης", "segment": "soon", "value": None})
    for c in cats[:4]:
        if c["patients"] >= 3:
            cards.append({"id": f"cat:{c['key']}", "icon": c["icon"], "urgency": "medium",
                          "title": f"{c['patients']} πελάτες — {c['label']}",
                          "why": f"Μήνυμα φροντίδας: {c['offer']}.",
                          "count": c["patients"], "reachable": len(br[c["key"]]["patients"] & reach),
                          "cta": "Μήνυμα φροντίδας", "segment": f"therapy:{c['key']}", "value": None})
    if inactive:
        cards.append({"id": "winback", "icon": "🔄", "urgency": "medium",
                      "title": f"{len(inactive)} πελάτες που δεν ήρθαν 90+ ημέρες",
                      "why": "Φέρ' τους πίσω με μια προσφορά ή ένα μήνυμα ενδιαφέροντος.",
                      "count": len(inactive), "reachable": len(inactive & reach),
                      "cta": "Καμπάνια επαναφοράς", "segment": "inactive", "value": None})

    from app.repositories.patient_portal import PatientAccountRepository
    db = shared_db()
    shells = await PatientAccountRepository().cy_shell_ids(tenant_id)
    acc_ids = await db["patient_links"].distinct(          # tenant-ok: tenant_id στο φίλτρο
        "account_id", {"tenant_id": tenant_id, "patient_ref": {"$in": [str(s) for s in shells] + shells}})
    push_reach = len(await db["patient_push_subs"].distinct(
        "account_id", {"account_id": {"$in": acc_ids}})) if acc_ids else 0
    return {"performance": perf, "categories": cats, "suggestions": cards,
            "campaigns": await marketing.campaigns_with_roi(tenant_id),
            "totals": {"upcoming": len(soon), "winback": len(inactive), "at_risk": 0,
                       "push_reach": int(push_reach)},
            "country": "CY", "generated_at": _now().isoformat()}


# ── Αυτοματισμοί: ποιοι ταιριάζουν σήμερα (ίδιοι κανόνες/δικλείδες με την Ελλάδα) ────────────────
CY_TRIGGERS = ("inactive_days", "first_visit", "portal_joined")


async def automation_candidates(tenant_id: str, trigger: str, param: int) -> set[str]:
    """Παραλήπτες ως `cy:<pseudo_id>`. Παράθυρο ΜΙΑΣ ημέρας στο κατώφλι (όχι «όσοι το ξεπέρασαν»),
    όπως η Ελλάδα — αλλιώς την πρώτη μέρα θα έφευγαν όλοι μονομιάς."""
    from app.services.cy.contacts import PREFIX, _find_all
    now = _now()
    if trigger in ("inactive_days", "first_visit"):
        lo, hi = now - timedelta(days=param + 1), now - timedelta(days=param)
        field = "last_seen" if trigger == "inactive_days" else "first_seen"
        pats = await _find_all(tenant_id, {field: {"$gte": lo, "$lt": hi}, "erased": {"$ne": True}})
        refs = {p["pseudo_id"] for p in pats}
        if trigger == "first_visit" and refs:
            # «πρώτη φορά» = μόνο μία επίσκεψη ως τώρα
            rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
                {"$match": {"patient_ref": {"$in": list(refs)}}},
                {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}}}])
            refs = {r["_id"] for r in rows if r["n"] <= 1}
        return {PREFIX + r for r in refs}
    if trigger == "portal_joined":
        db = shared_db()
        since = now - timedelta(days=param + 1)
        links = [lk async for lk in db["patient_links"].find(   # tenant-ok: tenant_id στο φίλτρο
            {"tenant_id": tenant_id, "created_at": {"$gte": since}}, {"patient_ref": 1})]
        from app.repositories.patient_portal import PatientAccountRepository
        pseudos = await PatientAccountRepository().cy_pseudos_of(tenant_id, [lk["patient_ref"] for lk in links])
        return {PREFIX + p for p in pseudos}
    return set()
