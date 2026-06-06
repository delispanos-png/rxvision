"""Platform (CloudOn) auth router — separate login surface for the back-office.

Distinct from /auth (tenant users): authenticates against `platform_admins` and
issues `padmin` tokens that gate every /admin endpoint.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr

from app.core.db import shared_db
from app.core.deps import PlatformContext, get_platform_admin
from app.services.platform_auth import PlatformAuthService

router = APIRouter()


@router.get("/status")
async def public_status():
    """Public (no auth): maintenance banner state for the tenant app."""
    m = await shared_db()["platform_settings"].find_one({"_id": "maintenance"})
    return {"maintenance": {"enabled": (m or {}).get("enabled", False),
                            "message": (m or {}).get("message", "")}}


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int


@router.post("/auth/login", response_model=TokenOut)
async def login(body: LoginIn):
    tokens = await PlatformAuthService().login(body.email, body.password)
    if tokens is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")
    return tokens


@router.post("/auth/refresh", response_model=TokenOut)
async def refresh(body: RefreshIn):
    tokens = await PlatformAuthService().refresh(body.refresh_token)
    if tokens is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_refresh")
    return tokens


@router.get("/auth/me")
async def me(ctx: PlatformContext = Depends(get_platform_admin)):
    from bson import ObjectId
    try:
        oid = ObjectId(ctx.admin_id)
    except Exception:  # noqa: BLE001
        oid = ctx.admin_id
    admin = await shared_db()["platform_admins"].find_one({"_id": oid}) or {}
    is_super = bool(admin.get("super_admin")) or admin.get("permissions") is None
    return {"admin_id": ctx.admin_id, "email": ctx.email, "platform_admin": True,
            "full_name": admin.get("full_name", ""), "super_admin": is_super,
            "permissions": admin.get("permissions") or []}
