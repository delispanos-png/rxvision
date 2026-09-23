"""Συνομιλία συνεργαζόμενων φαρμακείων — ομάδες, προσκλήσεις με ΑΦΜ, μηνύματα.

Κάθε endpoint δουλεύει ΓΙΑ ΤΟΝ ΣΥΝΔΕΔΕΜΕΝΟ tenant· το αποθετήριο δεν δέχεται «για ποιον».
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.pharmacy_chat import PharmacyChatRepository

router = APIRouter()
_MODULE = "pharmacy_chat"
_PERM = "portal:manage"


def _repo(ctx: TenantContext) -> PharmacyChatRepository:
    return PharmacyChatRepository(tenant_id=ctx.tenant_id)


class GroupIn(BaseModel):
    name: str = ""


class InviteIn(BaseModel):
    group_id: str
    afm: str


class RespondIn(BaseModel):
    accept: bool


class SendIn(BaseModel):
    group_id: str
    body: str
    to_tenant_id: str | None = None      # None = προς όλη την ομάδα


@router.get("/groups")
async def groups(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    r = _repo(ctx)
    return {"groups": await r.groups(), "invites": await r.my_invites(),
            "unread": await r.unread_total()}


@router.post("/groups")
async def create_group(body: GroupIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).create_group(body.name)


@router.post("/invite")
async def invite(body: InviteIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    res = await _repo(ctx).invite(body.group_id, body.afm)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=res)
    return res


@router.post("/invites/{invite_id}")
async def respond(invite_id: str, body: RespondIn,
                  ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    res = await _repo(ctx).respond(invite_id, body.accept)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=res)
    return res


@router.post("/groups/{group_id}/leave")
async def leave(group_id: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    res = await _repo(ctx).leave(group_id)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=res)
    return res


@router.get("/messages")
async def thread(group_id: str, with_tenant: str | None = Query(None),
                 ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    res = await _repo(ctx).thread(group_id, with_tenant=with_tenant)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail=res)
    return res


@router.post("/messages")
async def send(body: SendIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    res = await _repo(ctx).send(body.group_id, body.body, to_tenant_id=body.to_tenant_id,
                                user_name=getattr(ctx, "user_name", None) or ctx.user_id)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=res)
    return res
