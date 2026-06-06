"""PlatformAuthService — login/refresh for CloudOn platform admins.

Platform admins are a separate identity class from tenant users: they live in the
`platform_admins` collection, belong to NO tenant, and their tokens carry `padmin`.
This is what gates the back-office (adminpanel) — never a tenant `owner` role.
"""

from __future__ import annotations

from bson import ObjectId

from app.core.config import settings
from app.core.db import shared_db
from app.core.security import (
    create_platform_refresh_token,
    create_platform_token,
    decode_token,
    verify_password,
)


def _as_object_id(value):
    try:
        return ObjectId(value)
    except Exception:  # noqa: BLE001
        return value


class PlatformAuthService:
    async def login(self, email: str, password: str) -> dict | None:
        db = shared_db()
        admin = await db["platform_admins"].find_one({"email": email, "status": "active"})
        if not admin or not verify_password(password, admin["password_hash"]):
            return None
        return self._issue(admin)

    async def refresh(self, refresh_token: str) -> dict | None:
        try:
            claims = decode_token(refresh_token)
        except ValueError:
            return None
        if claims.get("scope") != "refresh" or not claims.get("padmin"):
            return None
        db = shared_db()
        admin = await db["platform_admins"].find_one({"_id": _as_object_id(claims["sub"])})
        if not admin or admin.get("refresh_token_version", 0) != claims.get("ver"):
            return None
        return self._issue(admin)

    def _issue(self, admin: dict) -> dict:
        aid = str(admin["_id"])
        return {
            "access_token": create_platform_token(admin_id=aid, email=admin["email"]),
            "refresh_token": create_platform_refresh_token(
                admin_id=aid, version=admin.get("refresh_token_version", 0)),
            "expires_in": settings.ACCESS_TOKEN_TTL_SECONDS,
        }
