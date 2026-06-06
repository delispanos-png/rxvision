"""User & role repositories — tenant-scoped CRUD.

password_hash is never returned to clients; routers project it out.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.repositories.base import BaseRepository

_PUBLIC_PROJECTION = {"password_hash": 0, "refresh_token_version": 0}


class UserRepository(BaseRepository):
    collection_name = "users"

    async def list_users(self, *, skip: int, limit: int) -> list[dict]:
        cursor = self._coll.find(self._scope(), _PUBLIC_PROJECTION)
        return await cursor.sort([("created_at", -1)]).skip(skip).limit(limit).to_list(length=limit)

    async def get(self, user_id) -> dict | None:
        return await self._coll.find_one(self._scope({"_id": user_id}), _PUBLIC_PROJECTION)

    async def create(self, doc: dict) -> dict:
        now = datetime.now(tz=timezone.utc)
        doc = {**doc, "status": doc.get("status", "active"),
               "mfa_enabled": False, "refresh_token_version": 0,
               "created_at": now, "updated_at": now}
        user_id = await self.insert_one(doc)
        return await self.get(user_id)

    async def update(self, user_id, fields: dict) -> dict | None:
        fields = {**fields, "updated_at": datetime.now(tz=timezone.utc)}
        await self.update_one({"_id": user_id}, {"$set": fields})
        return await self.get(user_id)

    async def delete(self, user_id) -> None:
        await self.delete_many({"_id": user_id})


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
