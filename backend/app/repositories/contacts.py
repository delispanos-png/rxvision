"""Patient contact details — pharmacist-entered PII (phone/email/address) kept in a
SEPARATE collection from `patients_anonymized`, so ΗΔΥΚΑ re-ingestion never touches it.
The pharmacist is the data controller; `marketing_consent` gates newsletters/SMS."""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository, jsonsafe

CONTACT_FIELDS = (
    "phone", "mobile", "email", "address", "city", "postal_code",
    "notes", "observations", "marketing_consent", "preferred_channel",
    "reactivation_reason", "discontinuation_reason",
    "g6pd_deficiency",   # clinical flag (pharmacist-set) — έλλειψη ενζύμου G6PD
    "height_cm",         # ύψος (cm) — σταθερό· για υπολογισμό ΔΜΣ/BMI
)

_MEASURE_KINDS = ("bp", "glucose", "weight")


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(v)
    except (InvalidId, TypeError):
        return None


class PatientContactRepository(BaseRepository):
    collection_name = "patient_contacts"

    async def get(self, patient_id: str) -> dict | None:
        oid = _oid(patient_id)
        if not oid:
            return None
        doc = await self._coll.find_one({"_id": oid, "tenant_id": self.tenant_id})
        # GDPR: σε «πελάτη παρουσίασης» ή περιορισμένο χρήστη (mask_pii) κρύβουμε ΟΛΑ τα
        # προσωπικά στοιχεία επικοινωνίας — όχι μόνο τηλέφωνο/email αλλά & διεύθυνση/σημειώσεις.
        if doc and self.demo:
            for k in ("phone", "mobile", "email", "address", "city", "postal_code", "notes"):
                if doc.get(k):
                    doc[k] = None
        return jsonsafe(doc)

    async def upsert(self, patient_id: str, data: dict) -> dict | None:
        oid = _oid(patient_id)
        if not oid:
            return None
        payload = {k: data.get(k) for k in CONTACT_FIELDS if k in data}
        # pharmacist-controlled lifecycle (deceased / moved / stopped) — kept in THIS protected
        # collection so a ΗΔΥΚΑ re-ingest can never resurrect an inactive patient.
        if "active" in data:
            active = bool(data.get("active"))
            payload["active"] = active
            payload["inactive_reason"] = (data.get("inactive_reason") or None) if not active else None
            payload["inactive_at"] = datetime.now(tz=timezone.utc) if not active else None
        payload["tenant_id"] = self.tenant_id
        payload["updated_at"] = datetime.now(tz=timezone.utc)
        await self._coll.update_one(
            {"_id": oid, "tenant_id": self.tenant_id},
            {"$set": payload, "$setOnInsert": {"_id": oid}},
            upsert=True,
        )
        return await self.get(patient_id)

    # ── κλινικές μετρήσεις (πίεση / ζάχαρο / βάρος) με ημερομηνία + ιστορικό ──
    async def add_measurement(self, patient_id: str, kind: str, *, systolic=None,
                              diastolic=None, value=None, at=None, note=None) -> dict | None:
        oid = _oid(patient_id)
        if not oid or kind not in _MEASURE_KINDS:
            return None
        now = datetime.now(tz=timezone.utc)
        doc = {"tenant_id": self.tenant_id, "patient_ref": oid, "kind": kind,
               "at": at or now, "note": (note or "")[:200], "created_at": now}
        if kind == "bp":
            if systolic is None or diastolic is None:
                return None
            doc["systolic"], doc["diastolic"] = int(systolic), int(diastolic)
        else:
            if value is None:
                return None
            doc["value"] = float(value)
        await self._db["patient_measurements"].insert_one(doc)
        return await self.measurements(patient_id)

    async def delete_measurement(self, patient_id: str, measurement_id: str) -> dict | None:
        oid, mid = _oid(patient_id), _oid(measurement_id)
        if not oid or not mid:
            return None
        await self._db["patient_measurements"].delete_one(
            {"_id": mid, "tenant_id": self.tenant_id, "patient_ref": oid})
        return await self.measurements(patient_id)

    async def measurements(self, patient_id: str) -> dict:
        """Latest + last-10 history per kind (newest first)."""
        oid = _oid(patient_id)
        if not oid:
            return {"latest": {}, "history": {}}
        latest, history = {}, {}
        for kind in _MEASURE_KINDS:
            rows = [r async for r in self._db["patient_measurements"].find(
                {"tenant_id": self.tenant_id, "patient_ref": oid, "kind": kind})
                .sort("at", -1).limit(10)]
            history[kind] = jsonsafe(rows)
            if rows:
                latest[kind] = jsonsafe(rows[0])
        return {"latest": latest, "history": history}
