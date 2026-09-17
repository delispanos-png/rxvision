"""Προσωπικό μενού & μενού ανά ρόλο.

ΕΜΦΑΝΙΣΗ, ΟΧΙ ΑΣΦΑΛΕΙΑ: η απόκρυψη μιας ομάδας δεν εμποδίζει κανέναν να ανοίξει τη
διεύθυνση. Τα δικαιώματα επιβάλλονται αλλού και δεν αγγίζονται από εδώ.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.deps import TenantContext, get_current_context, require
from app.services import nav_prefs

router = APIRouter()


class PinItem(BaseModel):
    href: str
    label: str | None = None
    en: str | None = None


class PinnedIn(BaseModel):
    items: list[PinItem]
    groups: list[str] = []


@router.get("/prefs")
async def get_prefs(ctx: TenantContext = Depends(get_current_context)):
    """Ό,τι χρειάζεται το μενού για να ζωγραφιστεί για ΑΥΤΟΝ τον χειριστή."""
    return await nav_prefs.get_for(ctx.tenant_id, ctx.user_id, ctx.roles)


@router.put("/pinned")
async def set_pinned(body: PinnedIn, ctx: TenantContext = Depends(get_current_context)):
    """Τα «δικά μου». Κάθε χειριστής ορίζει τα δικά του — κανένα δικαίωμα δεν απαιτείται,
    γιατί δεν αλλάζει τίποτα για κανέναν άλλον."""
    return await nav_prefs.set_pinned(ctx.user_id, [i.model_dump() for i in body.items], body.groups)


class ModeIn(BaseModel):
    mode: str


@router.put("/mode")
async def set_mode(body: ModeIn, ctx: TenantContext = Depends(get_current_context)):
    """Εναλλαγή «Κεντρικό μενού» ↔ «Τα δικά μου». Προσωπική επιλογή, κανένα δικαίωμα."""
    return await nav_prefs.set_mode(ctx.user_id, body.mode)


@router.get("/role-menus")
async def get_role_menus(ctx: TenantContext = Depends(require("settings:write"))):
    from app.core.db import shared_db
    roles = [r["key"] async for r in shared_db()["roles"].find(
        {"$or": [{"tenant_id": ctx.tenant_id}, {"tenant_id": None}]}, {"key": 1})]
    return {"roles": sorted(set(roles)),
            "menus": await nav_prefs.role_menus(ctx.tenant_id, sorted(set(roles)))}


class RoleMenuIn(BaseModel):
    hidden_groups: list[str] | None = None
    hidden_items: list[str] | None = None


@router.put("/role-menus/{role}")
async def set_role_menu(role: str, body: RoleMenuIn,
                        ctx: TenantContext = Depends(require("settings:write"))):
    return await nav_prefs.set_role_menu(ctx.tenant_id, role, body.hidden_groups,
                                         body.hidden_items,
                                         by=getattr(ctx, "email", None) or ctx.user_id)
