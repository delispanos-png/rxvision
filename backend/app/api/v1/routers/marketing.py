"""Marketing router — Στοχευμένη Προώθηση (ανεξάρτητο κύκλωμα, module `marketing`)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.deps import TenantContext, require
from app.services import marketing

router = APIRouter()
_MODULE = "marketing"


@router.get("/dashboard")
async def dashboard(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Βασικό dashboard: αποδοτικότητα καμπανιών + προτάσεις στοχευμένων ενεργειών."""
    return await marketing.dashboard(ctx.tenant_id, demo=ctx.demo)


@router.get("/categories")
async def categories(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Θεραπευτικές κατηγορίες με πλήθος & αξία ασθενών (για στόχευση 1-κλικ)."""
    return {"items": await marketing.category_sizes(ctx.tenant_id),
            "catalog": [{"key": c["key"], "label": c["label"], "icon": c["icon"], "offer": c["offer"]}
                        for c in marketing.THERAPY_CATEGORIES]}
