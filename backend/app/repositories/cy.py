"""Κυπριακά δεδομένα συνταγών (ΓεΣΥ) — ΜΟΝΟ συλλογές `cy_*`, πάντα μέσα από BaseRepository.

- `cy_dispensings`: μία εγγραφή ανά εκτέλεση (DispensingId), με τις γραμμές ενσωματωμένες.
- `cy_patients`: ένας δικαιούχος ανά φαρμακείο, κλειδί = ψευδώνυμο (HMAC ταυτότητας, pepper φαρμακείου).
  Η ΤΑΥΤΟΤΗΤΑ ΔΕΝ αποθηκεύεται· μόνο ονοματεπώνυμο (ο φαρμακοποιός πρέπει να ξέρει ποιος είναι),
  φύλο, ημερομηνία γέννησης, κωδικός ΟΑΥ.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.repositories.base import BaseRepository


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class CyPatientRepository(BaseRepository):
    collection_name = "cy_patients"

    async def upsert(self, pseudo_id: str, patient: dict, seen_at: datetime, *,
                     id_ref: str | None = None) -> None:
        name = f"{patient.get('first_name', '')} {patient.get('last_name', '')}".strip()
        await self.update_one(
            {"pseudo_id": pseudo_id},
            {"$set": {"full_name": name or None, "gender": patient.get("gender"),
                      **({"id_ref": id_ref} if id_ref else {}),
                      "dob": patient.get("dob"), "hio_code": patient.get("hio_code"),
                      "updated_at": _now()},
             "$min": {"first_seen": seen_at},
             "$max": {"last_seen": seen_at},
             # tenant_id + pseudo_id μπαίνουν από το φίλτρο (upsert)
             "$setOnInsert": {"created_at": _now()}},
            upsert=True)


class CyDispensingRepository(BaseRepository):
    collection_name = "cy_dispensings"

    async def save(self, doc: dict) -> str:
        """Αποθήκευση μιας εκτέλεσης με ΕΚΔΟΣΕΙΣ. Επιστρέφει "new" | "duplicate" | "updated" | "stale".

        Η πύλη ΓεΣΥ μπορεί να ξαναβγάλει την ΙΔΙΑ εκτέλεση (ίδιο DispensingId) με αλλαγμένο περιεχόμενο —
        διόρθωση ή ακύρωση γραμμής (QtyDisp που έπεσε στο 0). Το PharmacyOne Κύπρου το χειρίζεται
        συγκρίνοντας με τις προηγούμενες ποσότητες ανά γραμμή· εδώ: η ΝΕΟΤΕΡΗ έκδοση αντικαθιστά την
        παλιά και η παλιά μένει στο ιστορικό (`history`, τελευταίες 10).
        - ίδιο `content_hash` → "duplicate" (τίποτα δεν αλλάζει)
        - παλαιότερο `dispensed_at` από το αποθηκευμένο → "stale" (δεν γυρνάμε πίσω)
        """
        cur = await self._coll.find_one(self._scope({"dispensing_id": doc["dispensing_id"]}),
                                        {"content_hash": 1, "dispensed_at": 1, "totals": 1, "versions": 1})
        if cur is None:
            try:
                await self.insert_one({**doc, "versions": 1, "imported_at": _now()})
            except Exception as exc:  # noqa: BLE001 — ταυτόχρονο ανέβασμα: το unique index κερδίζει
                if "duplicate key" in str(exc).lower() or "E11000" in str(exc):
                    return "duplicate"
                raise
            return "new"
        if cur.get("content_hash") == doc["content_hash"]:
            return "duplicate"
        old_at, new_at = cur.get("dispensed_at"), doc.get("dispensed_at")
        if old_at and new_at and _aware(new_at) < _aware(old_at):
            return "stale"
        await self.update_one(
            {"dispensing_id": doc["dispensing_id"]},
            {"$set": {**doc, "corrected_at": _now()},
             "$inc": {"versions": 1},
             "$push": {"history": {"$each": [{"at": _now(), "content_hash": cur.get("content_hash"),
                                              "totals": cur.get("totals")}], "$slice": -10}}})
        return "updated"

    async def overview(self) -> dict[str, Any]:
        """Σύνολα εκτελέσεων. Οι καταστάσεις συνταγών (ανοιχτές/χαμένες) ΔΕΝ υπολογίζονται εδώ —
        έρχονται από τον ΕΝΑ ορισμό στο services/cy/chains.py (βλ. chains.overview)."""
        tot = await self.aggregate([{"$group": {
            "_id": None, "dispensings": {"$sum": 1},
            "prescriptions": {"$addToSet": "$prescription_id"},
            "patients": {"$addToSet": "$patient_ref"},
            "hio": {"$sum": "$totals.hio"}, "beneficiary": {"$sum": "$totals.beneficiary"},
            "pc2": {"$sum": "$totals.pc2"}, "total": {"$sum": "$totals.total"},
            "drugs": {"$sum": {"$cond": [{"$eq": ["$kind", "drug"]}, 1, 0]}},
            "consumables": {"$sum": {"$cond": [{"$eq": ["$kind", "consumable"]}, 1, 0]}},
            "first": {"$min": "$dispensed_at"}, "last": {"$max": "$dispensed_at"},
            "last_import": {"$max": "$imported_at"}}}])
        t = tot[0] if tot else {}
        not_disp = await self.aggregate([
            {"$unwind": "$lines"}, {"$match": {"lines.qty_disp": 0}}, {"$count": "n"}])
        return {
            "dispensings": t.get("dispensings", 0), "drugs": t.get("drugs", 0),
            "consumables": t.get("consumables", 0),
            "prescriptions": len(t.get("prescriptions") or []),
            "patients": len(t.get("patients") or []),
            "lines_not_dispensed": not_disp[0]["n"] if not_disp else 0,
            "amounts": {k: t.get(k, 0) for k in ("hio", "beneficiary", "pc2", "total")},
            "first": t.get("first"), "last": t.get("last"), "last_import": t.get("last_import"),
        }
