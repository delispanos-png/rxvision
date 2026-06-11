"""Patient contact details — pharmacist-entered PII (phone/email/address) kept in a
SEPARATE collection from `patients_anonymized`, so ΗΔΙΚΑ re-ingestion never touches it.
The pharmacist is the data controller; `marketing_consent` gates newsletters/SMS."""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository, jsonsafe

CONTACT_FIELDS = (
    "phone", "mobile", "email", "address", "city", "postal_code",
    "notes", "marketing_consent", "preferred_channel",
    "reactivation_reason", "discontinuation_reason",
)


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
        return jsonsafe(await self._coll.find_one({"_id": oid, "tenant_id": self.tenant_id}))

    async def upsert(self, patient_id: str, data: dict) -> dict | None:
        oid = _oid(patient_id)
        if not oid:
            return None
        payload = {k: data.get(k) for k in CONTACT_FIELDS if k in data}
        # pharmacist-controlled lifecycle (deceased / moved / stopped) — kept in THIS protected
        # collection so a ΗΔΙΚΑ re-ingest can never resurrect an inactive patient.
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
