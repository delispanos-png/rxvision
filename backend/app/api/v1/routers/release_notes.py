"""«Τι νέο υπάρχει» — δημόσια (ανά φαρμακείο) ανάγνωση + διαχείριση από το adminpanel."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.deps import TenantContext, get_current_context
from app.services import release_notes

router = APIRouter()


@router.get("")
async def mine(ctx: TenantContext = Depends(get_current_context)):
    """Χωρίς module gate: κάθε πελάτης δικαιούται να ξέρει τι άλλαξε στο προϊόν που πληρώνει."""
    return await release_notes.for_tenant(ctx.tenant_id)


@router.post("/seen")
async def seen(ctx: TenantContext = Depends(get_current_context)):
    return await release_notes.mark_seen(ctx.tenant_id)


# ── adminpanel ───────────────────────────────────────────────────────────────────────────────
admin_router = APIRouter()


class ItemIn(BaseModel):
    title: str
    body: str = ""
    icon: str | None = None


class NoteIn(BaseModel):
    version: str
    title: str = ""
    date: datetime | None = None
    items: list[ItemIn] = []
    published: bool = False


@admin_router.get("/release-notes")
async def list_notes():
    return {"items": await release_notes.admin_list()}


@admin_router.put("/release-notes")
async def save_note(body: NoteIn):
    res = await release_notes.upsert(
        body.version, date=body.date, title=body.title,
        items=[i.model_dump() for i in body.items], published=body.published)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=res)
    return res


@admin_router.post("/release-notes/{version}/publish")
async def publish(version: str, published: bool = True):
    return await release_notes.set_published(version, published)


@admin_router.delete("/release-notes/{version}")
async def remove(version: str):
    return await release_notes.delete(version)
