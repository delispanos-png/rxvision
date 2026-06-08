"""User & role repositories — tenant-scoped CRUD.

password_hash is never returned to clients; routers project it out.
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository

_PUBLIC_PROJECTION = {"password_hash": 0, "refresh_token_version": 0}


def _as_oid(value):
    """Coerce a string id (from a URL) into an ObjectId; None if malformed."""
    if isinstance(value, ObjectId):
        return value
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError):
        return None


class UserRepository(BaseRepository):
    collection_name = "users"

    async def list_users(self, *, skip: int, limit: int) -> list[dict]:
        cursor = self._coll.find(self._scope(), _PUBLIC_PROJECTION)
        return await cursor.sort([("created_at", -1)]).skip(skip).limit(limit).to_list(length=limit)

    async def get(self, user_id) -> dict | None:
        oid = _as_oid(user_id)
        if oid is None:
            return None
        return await self._coll.find_one(self._scope({"_id": oid}), _PUBLIC_PROJECTION)

    @staticmethod
    def _coerce_roles(doc: dict) -> dict:
        """role_ids must be ObjectId so role/permission lookups ($in) match."""
        if doc.get("role_ids"):
            doc["role_ids"] = [_as_oid(r) or r for r in doc["role_ids"]]
        return doc

    async def create(self, doc: dict) -> dict:
        now = datetime.now(tz=timezone.utc)
        doc = self._coerce_roles({**doc, "status": doc.get("status", "active"),
               "mfa_enabled": False, "refresh_token_version": 0,
               "created_at": now, "updated_at": now})
        user_id = await self.insert_one(doc)
        return await self.get(user_id)

    async def update(self, user_id, fields: dict) -> dict | None:
        oid = _as_oid(user_id)
        if oid is None:
            return None
        fields = self._coerce_roles({**fields, "updated_at": datetime.now(tz=timezone.utc)})
        await self.update_one({"_id": oid}, {"$set": fields})
        return await self.get(oid)

    async def set_password(self, user_id, password_hash: str) -> bool:
        """Set password and revoke existing sessions (bump refresh_token_version)."""
        oid = _as_oid(user_id)
        if oid is None:
            return False
        res = await self.update_one(
            {"_id": oid},
            {"$set": {"password_hash": password_hash,
                      "updated_at": datetime.now(tz=timezone.utc)},
             "$inc": {"refresh_token_version": 1}})
        return res.matched_count > 0

    async def delete(self, user_id) -> None:
        oid = _as_oid(user_id)
        if oid is not None:
            await self.delete_many({"_id": oid})


class RoleRepository(BaseRepository):
    collection_name = "roles"

    async def list_roles(self, *, skip: int, limit: int) -> list[dict]:
        return await self.find({}, sort=[("key", 1)], skip=skip, limit=limit)

    async def get(self, role_id) -> dict | None:
        return await self.find_one({"_id": role_id})

    async def create(self, doc: dict) -> dict:
        doc = {**doc, "is_system": False,
               "created_at": datetime.now(tz=timezone.utc)}
        role_id = await self.insert_one(doc)
        return await self.get(role_id)

    async def update(self, role_id, fields: dict) -> dict | None:
        await self.update_one({"_id": role_id}, {"$set": fields})
        return await self.get(role_id)

    async def delete(self, role_id) -> None:
        await self.delete_many({"_id": role_id})
