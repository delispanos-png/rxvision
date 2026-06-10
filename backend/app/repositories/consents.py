"""Patient consent ledger — an append-only record of marketing/communications consent
per data subject (GDPR Art.6/7, Art.21 objection). Each grant/withdrawal is a new event;
the *current* status for a (patient, channel) is the latest event. Kept separate from
`patient_contacts.marketing_consent` so we have an auditable history, not just a flag.

Tenant-scoped by construction via BaseRepository (THE rule)."""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository, jsonsafe

# Channels a patient can consent to (or "all" = every channel).
CONSENT_CHANNELS = ("email", "sms", "all")
CONSENT_STATUSES = ("granted", "withdrawn")


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(v)
    except (InvalidId, TypeError):
        return None


class PatientConsentRepository(BaseRepository):
    collection_name = "patient_consents"

    async def record(self, *, patient_id, channel: str, status: str, source: str,
                      policy_version: str | None, actor_user_id: str | None = None) -> dict:
        """Append a consent event. Returns the stored event (jsonsafe)."""
        oid = _oid(patient_id)
        if not oid:
            raise ValueError("invalid patient_id")
        if channel not in CONSENT_CHANNELS:
            raise ValueError(f"invalid channel: {channel}")
        if status not in CONSENT_STATUSES:
            raise ValueError(f"invalid status: {status}")
        now = datetime.now(tz=timezone.utc)
        event = {
            "tenant_id": self.tenant_id,
            "patient_id": oid,
            "channel": channel,
            "status": status,
            "source": source,
            "policy_version": policy_version,
            "actor_user_id": actor_user_id,
            "granted_at": now if status == "granted" else None,
            "withdrawn_at": now if status == "withdrawn" else None,
            "at": now,
        }
        await self._coll.insert_one(event)
        return jsonsafe(event)

    async def history(self, patient_id) -> list[dict]:
        oid = _oid(patient_id)
        if not oid:
            return []
        return await self.find({"patient_id": oid}, sort=[("at", -1)], limit=500)

    async def current(self, patient_id) -> dict[str, str]:
        """Latest status per channel for one patient → {channel: status}."""
        oid = _oid(patient_id)
        if not oid:
            return {}
        rows = await self.aggregate([
            {"$match": {"patient_id": oid}},
            {"$sort": {"at": -1}},
            {"$group": {"_id": "$channel", "status": {"$first": "$status"}}},
        ])
        return {r["_id"]: r["status"] for r in rows}

    async def withdrawn_patient_ids(self, channel: str) -> set:
        """Patient _ids whose LATEST event for `channel` (or the catch-all "all") is a
        withdrawal — used to exclude them from a campaign even if a stale contact flag
        still says consented. Returns a set of ObjectId."""
        rows = await self.aggregate([
            {"$match": {"channel": {"$in": [channel, "all"]}}},
            {"$sort": {"at": -1}},
            {"$group": {"_id": "$patient_id", "status": {"$first": "$status"}}},
            {"$match": {"status": "withdrawn"}},
        ])
        return {oid for r in rows if (oid := _oid(r["_id"]))}
