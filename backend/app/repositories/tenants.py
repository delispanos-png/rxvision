"""Tenant repository.

The `tenants` collection uses `_id` as the tenant identifier (it has no `tenant_id`
field), so it cannot use BaseRepository's tenant_id scoping. We read/write the single
document matching the caller's tenant via `_id`, which is itself the isolation boundary.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.core.db import shared_db


class TenantRepository:
    collection_name = "tenants"

    def __init__(self, *, tenant_id: str) -> None:
        self.tenant_id = tenant_id
        self._coll = shared_db()[self.collection_name]

    async def get(self) -> dict | None:
        return await self._coll.find_one({"_id": self.tenant_id})

    async def update(self, fields: dict[str, Any]) -> dict | None:
        fields = {**fields, "updated_at": datetime.now(tz=timezone.utc)}
        await self._coll.update_one({"_id": self.tenant_id}, {"$set": fields})
        return await self.get()

    async def get_modules(self) -> dict:
        doc = await self.get() or {}
        return doc.get("modules", {})

    async def set_modules(self, modules: dict[str, str]) -> dict:
        sets = {f"modules.{k}": v for k, v in modules.items()}
        sets["updated_at"] = datetime.now(tz=timezone.utc)
        await self._coll.update_one({"_id": self.tenant_id}, {"$set": sets})
        return await self.get_modules()

    async def set_credentials_ref(self, source: str, ref: str | None) -> None:
        await self._coll.update_one(
            {"_id": self.tenant_id},
            {"$set": {f"credentials_ref.{source}": ref,
                      "updated_at": datetime.now(tz=timezone.utc)}},
        )

    async def set_ingestion_config(self, source: str, config: dict) -> None:
        """Persist the NON-secret connection config/status for a source (hdika/gesy)."""
        await self._coll.update_one(
            {"_id": self.tenant_id},
            {"$set": {f"ingestion_config.{source}": config,
                      "updated_at": datetime.now(tz=timezone.utc)}},
        )

    async def get_ingestion_config(self, source: str) -> dict:
        doc = await self.get() or {}
        return (doc.get("ingestion_config") or {}).get(source) or {}

    async def patch_ingestion_config(self, source: str, fields: dict) -> None:
        sets = {f"ingestion_config.{source}.{k}": v for k, v in fields.items()}
        sets["updated_at"] = datetime.now(tz=timezone.utc)
        await self._coll.update_one({"_id": self.tenant_id}, {"$set": sets})

    async def request_deletion(self, *, reason: str | None) -> dict | None:
        """GDPR right-to-be-forgotten: mark tenant pending_deletion (async purge job)."""
        await self._coll.update_one(
            {"_id": self.tenant_id},
            {"$set": {"status": "pending_deletion",
                      "deletion_request": {
                          "reason": reason,
                          "requested_at": datetime.now(tz=timezone.utc)},
                      "updated_at": datetime.now(tz=timezone.utc)}},
        )
        return await self.get()
