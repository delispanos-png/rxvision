"""ΗΔΥΚΑ reconciliation — βρίσκει εκτελέσεις που υπάρχουν στην ΗΔΥΚΑ αλλά ΛΕΙΠΟΥΝ τοπικά και τις
ανακτά. Το forward-only watermark (`_watermark` = last_exec − 1 μέρα) ΔΕΝ ξαναγυρίζει ποτέ πίσω,
οπότε μια εκτέλεση που καταχωρήθηκε καθυστερημένα στην ΗΔΥΚΑ (ή που έπεσε σε στιγμιαία αποτυχία CDA
fetch) μένει ΜΟΝΙΜΑ εκτός. Αυτός ο έλεγχος κλείνει αυτό το κενό.

Σχεδιασμός: ξανασαρώνει ένα κυλιόμενο παράθυρο (~40 μέρες), συγκρίνει τα external_id (`barcode:execNo`)
της ΗΔΥΚΑ με τα δικά μας, και για ό,τι λείπει πυροδοτεί στοχευμένο backfill (ίδιο, δοκιμασμένο path)
+ καταγράφει admin alert. Robust: πολλαπλά περάσματα pagination + union — η ΗΔΥΚΑ επιστρέφει ασταθώς
(διαφορετική σελιδοποίηση ανά κλήση), γι' αυτό ένα μόνο πέρασμα μπορεί να χάσει εγγραφές.
"""

from __future__ import annotations

from datetime import date

from app.services.ingestion.hdika_client import _PAGE_SIZE, _first, _to_dict

RECONCILE_WINDOW_DAYS = 40
_MAX_PAGES = 120
_DEFAULT_PASSES = 2


def _explicit_last(data: dict) -> bool:
    """ΜΟΝΟ ο ρητός δείκτης τελευταίας σελίδας — ΟΧΙ το `n < size` (η ΗΔΥΚΑ επιστρέφει ασταθώς
    κοντές σελίδες στη μέση → το n<size κόβει την pagination πρόωρα & χάνει εκτελέσεις)."""
    return str(data.get("lastPage", data.get("last", ""))).lower() == "true"


def _extract(raw: dict) -> tuple[str, str, int, str]:
    presc = raw.get("prescription") if isinstance(raw.get("prescription"), dict) else {}
    bc = str(_first(presc, "barcode") or _first(raw, "barcode", default=""))
    day = str(_first(raw, "executionDate", default=""))[:10]
    try:
        execno = int(float(_first(raw, "executionNo", default=1) or 1))
    except (TypeError, ValueError):
        execno = 1
    cancel = str(_first(raw, "cancelDate", default="") or "").strip()
    return day, bc, execno, cancel


def hdika_window_keys(client, start_day: date, end_day: date, passes: int = _DEFAULT_PASSES) -> dict:
    """{external_id `barcode:execNo` -> ημέρα εκτέλεσης} για ΜΗ-ακυρωμένες εκτελέσεις στο
    [start_day, end_day]. Πολλαπλά περάσματα + union για να αντισταθμιστεί η ασταθής pagination."""
    from datetime import date as _date, timedelta as _td
    lo, hi = start_day.isoformat(), end_day.isoformat()
    found: dict[str, str] = {}
    for _ in range(max(1, passes)):
        # TILING: η ΗΔΥΚΑ search καπάρει ~650 records ανά executionDate query, οπότε ΕΝΑ query 40
        # ημερών ΔΕΝ τα φέρνει όλα. Re-anchor στη ΜΕΓΙΣΤΗ μέρα που είδαμε → καλύπτουμε όλο το
        # παράθυρο με λίγα queries. (executionDate = «από αυτή τη μέρα & μετά, μέχρι το cap».)
        anchor = start_day
        tiles = 0
        while anchor <= end_day and tiles < 12:
            tiles += 1
            max_day = anchor.isoformat()
            page = 0
            seen_ids: set = set()      # loop-detection ΑΝΑ tile (η ΗΔΥΚΑ μπορεί να επαναλαμβάνει σελίδα)
            while page < _MAX_PAGES:
                params = {"size": _PAGE_SIZE, "page": page, "executionDate": anchor.isoformat()}
                if client.pharmacy_id:
                    params["pharmacyId"] = client.pharmacy_id
                try:
                    data = _to_dict(client._get_xml("/api/v1/prescription-execution/search", params))
                except Exception:  # noqa: BLE001 — μία κακή σελίδα δεν ρίχνει τον έλεγχο
                    break
                rows = client._rows(data)
                if not rows:
                    break
                fresh = 0
                for raw in rows:
                    if not isinstance(raw, dict):
                        continue
                    rid = str(raw.get("id") or "")
                    if rid and rid in seen_ids:
                        continue
                    if rid:
                        seen_ids.add(rid); fresh += 1
                    day, bc, execno, cancel = _extract(raw)
                    if not day:
                        continue
                    if day > max_day:
                        max_day = day
                    if cancel or not bc:
                        continue
                    if lo <= day <= hi:
                        found[f"{bc}:{execno}"] = day
                # ΔΕΝ βασιζόμαστε στο n<size (η ΗΔΥΚΑ επιστρέφει κοντές σελίδες στη μέση)
                if _explicit_last(data) or fresh == 0:
                    break
                page += 1
            # προχώρα το anchor ΠΕΡΑ από την πιο πρόσφατη μέρα που κάλυψε αυτό το tile (εγγυημένη πρόοδος)
            try:
                nxt = _date.fromisoformat(max_day) + _td(days=1)
            except ValueError:
                nxt = anchor + _td(days=1)
            anchor = nxt if nxt > anchor else anchor + _td(days=1)
    return found


async def find_missing(db, client, tenant_id: str, start_day: date, end_day: date) -> dict:
    """Σύγκρινε ΗΔΥΚΑ vs δικά μας για το παράθυρο. Επιστρέφει {missing: {ext_id: day}, hdika: N,
    ours: N}. ΔΕΝ γράφει τίποτα — pure diff (εύκολο σε test)."""
    hd = hdika_window_keys(client, start_day, end_day)
    # τα δικά μας external_id στο παράθυρο (με βάση την ημέρα εκτέλεσης, string-safe)
    ours: set[str] = set()
    pipe = [
        {"$match": {"tenant_id": tenant_id, "status": {"$ne": "cancelled"}}},
        {"$project": {"ext": "$external_id",
                      "day": {"$substr": [{"$toString": "$executed_at"}, 0, 10]}}},
        {"$match": {"day": {"$gte": start_day.isoformat(), "$lte": end_day.isoformat()}}},
    ]
    async for r in db["prescription_executions"].aggregate(pipe):
        if r.get("ext"):
            ours.add(str(r["ext"]))
    missing = {ext: day for ext, day in hd.items() if ext not in ours}
    return {"missing": missing, "hdika": len(hd), "ours": len(ours)}
