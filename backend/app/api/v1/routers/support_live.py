"""Ζωντανή υποστήριξη: `router` για τον φαρμακοποιό, `admin_router` για τον supporter."""

from __future__ import annotations

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field

from app.core.db import shared_db
from app.core.deps import PlatformContext, TenantContext, get_current_context, get_platform_admin
from app.core.ratelimit import rate_limit
from app.services import support_live as svc

router = APIRouter()
admin_router = APIRouter()


class EventsIn(BaseModel):
    data: str = Field(min_length=1, max_length=svc.MAX_BATCH_CHARS)


class JoinIn(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")


class ConnectIn(BaseModel):
    login_sid: str = Field(min_length=1, max_length=64)


class PointerIn(BaseModel):
    x: float = Field(ge=0, le=20000)
    y: float = Field(ge=0, le=20000)


def _gone() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, "support_session_not_found")


async def _labels(ctx: TenantContext) -> tuple[str, str]:
    db = shared_db()
    uid = ObjectId(ctx.user_id) if ObjectId.is_valid(ctx.user_id) else ctx.user_id
    user = await db["users"].find_one(
        {"_id": uid, "$or": [{"tenant_id": ctx.tenant_id}, {"tenant_ids": ctx.tenant_id}]},
        {"full_name": 1, "email": 1})
    tenant = await db["tenants"].find_one({"_id": ctx.tenant_id}, {"name": 1})
    return ((user or {}).get("full_name") or (user or {}).get("email") or "—",
            (tenant or {}).get("name") or ctx.tenant_id)


@router.post("", status_code=201)
async def start(ctx: TenantContext = Depends(get_current_context)):
    user_label, tenant_name = await _labels(ctx)
    return await svc.start(ctx.tenant_id, ctx.user_id, user_label, tenant_name)


@router.get("/incoming")
async def incoming(ctx: TenantContext = Depends(get_current_context)):
    """Ζητά supporter να μπει σε αυτή τη σύνδεση; Δεν ανανεώνει τη θέση (βλ. deps.NO_SEAT_TOUCH)."""
    sid = await svc.claim(ctx.sid)
    return {"sid": sid if sid and await svc.customer_session(sid, ctx.tenant_id, ctx.user_id) else None}


@router.get("/{sid}")
async def state(sid: str, ctx: TenantContext = Depends(get_current_context)):
    m = await svc.customer_session(sid, ctx.tenant_id, ctx.user_id)
    if not m:
        raise _gone()
    return await svc.customer_state(sid, m)


@router.post("/{sid}/events")
async def events(sid: str, body: EventsIn, ctx: TenantContext = Depends(get_current_context)):
    m = await svc.customer_session(sid, ctx.tenant_id, ctx.user_id)
    if not m:
        raise _gone()
    await svc.push(sid, m, body.data)
    return await svc.customer_state(sid, m)


@router.post("/{sid}/end")
async def end(sid: str, ctx: TenantContext = Depends(get_current_context)):
    if await svc.customer_session(sid, ctx.tenant_id, ctx.user_id):
        await svc.end(sid, by="customer")
    return {"ok": True}


async def _supporter_name(ctx: PlatformContext) -> str:
    query = {"_id": ObjectId(ctx.admin_id)} if ObjectId.is_valid(ctx.admin_id) else {"_id": ctx.admin_id}
    admin = await shared_db()["platform_admins"].find_one(query, {"full_name": 1})
    return (admin or {}).get("full_name") or ctx.email.split("@")[0]


@admin_router.get("/support-live/online")
async def online(_: PlatformContext = Depends(get_platform_admin)):
    return {"items": jsonable_encoder(await svc.online_sessions())}


@admin_router.post("/support-live/connect")
async def connect(body: ConnectIn, ctx: PlatformContext = Depends(get_platform_admin)):
    login = next((s for s in await svc.online_sessions() if s["login_sid"] == body.login_sid), None)
    if not login:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "support_customer_offline")
    return await svc.connect(login, ctx.admin_id, await _supporter_name(ctx), ctx.email)


@admin_router.post("/support-live/join",
                   dependencies=[Depends(rate_limit("support_live_join", limit=10, window_seconds=60))])
async def join(body: JoinIn, ctx: PlatformContext = Depends(get_platform_admin)):
    res = await svc.join(body.code, ctx.admin_id, await _supporter_name(ctx), ctx.email)
    if not res:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "support_code_invalid")
    return res


async def _admin_session(sid: str, ctx: PlatformContext) -> dict:
    m = await svc.admin_session(sid, ctx.admin_id)
    if not m:
        raise _gone()
    return m


@admin_router.get("/support-live/{sid}/events")
async def pull(sid: str, ctx: PlatformContext = Depends(get_platform_admin)):
    return await svc.pull(sid, await _admin_session(sid, ctx))


@admin_router.post("/support-live/{sid}/resume")
async def resume(sid: str, ctx: PlatformContext = Depends(get_platform_admin)):
    m = await _admin_session(sid, ctx)
    await svc.request_snapshot(sid)
    return {"tenant_name": m.get("tenant_name"), "user_label": m.get("user_label"),
            "tenant_id": m.get("tenant_id")}


@admin_router.post("/support-live/{sid}/pointer")
async def pointer(sid: str, body: PointerIn, ctx: PlatformContext = Depends(get_platform_admin)):
    await _admin_session(sid, ctx)
    await svc.set_pointer(sid, body.x, body.y)
    return {"ok": True}


@admin_router.post("/support-live/{sid}/end")
async def finish(sid: str, ctx: PlatformContext = Depends(get_platform_admin)):
    await _admin_session(sid, ctx)
    await svc.end(sid, by="supporter")
    return {"ok": True}
