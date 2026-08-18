"""Marketing router — Στοχευμένη Προώθηση (ανεξάρτητο κύκλωμα, module `marketing`)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.services import marketing

router = APIRouter()
_MODULE = "marketing"


class RedeemIn(BaseModel):
    code: str
    amount_cents: int = 0       # ποσό αγοράς στο ταμείο (προαιρετικό — για υπολογισμό έκπτωσης & αξίας)


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


@router.get("/campaigns")
async def campaigns(days: int = 90, ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Καμπάνιες με απόδοση: στάλθηκε → εξαργυρώθηκε → αξία (conversion %)."""
    return {"items": await marketing.campaigns_with_roi(ctx.tenant_id, days=days)}


@router.post("/coupons/redeem")
async def redeem(body: RedeemIn, ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Εξαργύρωση κουπονιού στο ταμείο — επιβεβαιώνει ισχύ, καταγράφει εξαργύρωση & αξία."""
    return await marketing.redeem_coupon(
        ctx.tenant_id, body.code, amount_cents=body.amount_cents,
        by=getattr(ctx, "user_id", None))
