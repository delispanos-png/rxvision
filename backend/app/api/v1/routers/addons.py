"""Add-ons router — tenant-facing self-service activation of à-la-carte modules.

Entitlement takes effect on the tenant's next token refresh (modules are baked into the JWT); the
client should refresh the session right after (un)activating.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import TenantContext, get_current_context, require
from app.services import addon_service

router = APIRouter()


@router.get("")
async def list_addons(ctx: TenantContext = Depends(get_current_context)):
    """Add-on catalog annotated for this tenant (status: included/active/granted/available)."""
    return await addon_service.for_tenant(ctx.tenant_id)


@router.get("/{addon_id}/quote")
async def quote(addon_id: str, ctx: TenantContext = Depends(require("billing:manage"))):
    """Πόσο θα χρεωθεί ΤΩΡΑ η κάρτα για ενεργοποίηση — ο πελάτης το βλέπει πριν πατήσει."""
    res = await addon_service.activation_quote(ctx.tenant_id, addon_id)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=res)
    return res


@router.post("/{addon_id}/activate")
async def activate(addon_id: str, ctx: TenantContext = Depends(require("billing:manage"))):
    res = await addon_service.activate(ctx.tenant_id, addon_id)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=res)
    return res


@router.get("/{addon_id}/removal-preview")
async def removal_preview(addon_id: str, ctx: TenantContext = Depends(require("billing:manage"))):
    """Τι θα γίνει αν το αφαιρέσει: πότε κλείνει + (έτοιμος κατάλογος) πόσα είδη σβήνονται/κλειδώνουν."""
    from app.core.db import shared_db
    sub = await shared_db()["subscriptions"].find_one({"tenant_id": ctx.tenant_id},
                                                      {"current_period_end": 1}) or {}
    return {"effective_at": sub.get("current_period_end"),
            **(await addon_service.removal_preview(ctx.tenant_id, addon_id))}


@router.post("/{addon_id}/deactivate")
async def deactivate(addon_id: str, ctx: TenantContext = Depends(require("billing:manage"))):
    """Αφαίρεση από τον ΠΕΛΑΤΗ: ισχύει στη λήξη της περιόδου που πλήρωσε (όχι αμέσως)."""
    res = await addon_service.schedule_removal(ctx.tenant_id, addon_id, by=ctx.user_id)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=res)
    return res


@router.post("/{module}/trial")
async def trial(module: str, ctx: TenantContext = Depends(require("billing:manage"))):
    """Start a 14-day self-service trial of the smallest package that unlocks `module`."""
    res = await addon_service.start_trial(ctx.tenant_id, module)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=res)
    return res
