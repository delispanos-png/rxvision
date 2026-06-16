"""Tenant-scoped repository base.

THE rule of this codebase: no query reaches MongoDB without a tenant_id filter.
Services NEVER touch a collection directly — they go through a repository that
extends this class, so isolation is enforced by construction, not by discipline.
"""

from __future__ import annotations

from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorCollection

from app.core.db import db_resolver


def jsonsafe(value: Any) -> Any:
    """Recursively convert BSON types (ObjectId) to JSON-serialisable forms.

    Applied to every read result so any endpoint can return raw documents
    without FastAPI choking on ObjectId. datetimes are left as-is (handled
    natively by the JSON encoder).
    """
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, list):
        return [jsonsafe(v) for v in value]
    if isinstance(value, dict):
        return {k: jsonsafe(v) for k, v in value.items()}
    return value


# Hard ceiling on any single page, regardless of what a caller/endpoint asks for.
# Defense-in-depth against unbounded reads exhausting memory on the shared DB.
MAX_PAGE_SIZE = 500


class BaseRepository:
    collection_name: str

    def __init__(self, *, tenant_id: str, isolation_tier: str = "shared",
                 demo: bool = False) -> None:
        self.tenant_id = tenant_id
        self.demo = demo            # «πελάτης παρουσίασης» → masking PII στα reads
        self._db = db_resolver.resolve(tenant_id=tenant_id, isolation_tier=isolation_tier)

    @property
    def _coll(self) -> AsyncIOMotorCollection:
        return self._db[self.collection_name]

    def _scope(self, query: dict[str, Any] | None = None) -> dict[str, Any]:
        """Inject tenant_id into every filter."""
        return {"tenant_id": self.tenant_id, **(query or {})}

    # ── reads ──────────────────────────────────────────────
    async def find_one(self, query: dict | None = None) -> dict | None:
        return jsonsafe(await self._coll.find_one(self._scope(query)))

    async def find(self, query: dict | None = None, *, sort=None, skip=0, limit=50) -> list[dict]:
        limit = max(1, min(int(limit), MAX_PAGE_SIZE))
        skip = max(0, int(skip))
        cursor = self._coll.find(self._scope(query))
        if sort:
            cursor = cursor.sort(sort)
        return jsonsafe(await cursor.skip(skip).limit(limit).to_list(length=limit))

    async def count(self, query: dict | None = None) -> int:
        return await self._coll.count_documents(self._scope(query))

    # ── writes ─────────────────────────────────────────────
    async def insert_one(self, doc: dict) -> Any:
        doc = {**doc, "tenant_id": self.tenant_id}
        res = await self._coll.insert_one(doc)
        return res.inserted_id

    async def update_one(self, query: dict, update: dict, *, upsert: bool = False):
        return await self._coll.update_one(self._scope(query), update, upsert=upsert)

    async def delete_many(self, query: dict | None = None):
        return await self._coll.delete_many(self._scope(query))

    # ── analytics ──────────────────────────────────────────
    async def aggregate(self, pipeline: list[dict]) -> list[dict]:
        """Force tenant scope as the first stage of every pipeline."""
        scoped = [{"$match": {"tenant_id": self.tenant_id}}, *pipeline]
        return jsonsafe(await self._coll.aggregate(scoped).to_list(length=None))
