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


class SettingsIn(BaseModel):
    frequency_cap: int = 0      # μέγιστα προωθητικά μηνύματα/ασθενή/μήνα (0 = ανενεργό)


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
async def redeem(body: RedeemIn, ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Εξαργύρωση κουπονιού στο ταμείο — επιβεβαιώνει ισχύ, καταγράφει εξαργύρωση & αξία."""
    return await marketing.redeem_coupon(
        ctx.tenant_id, body.code, amount_cents=body.amount_cents,
        by=getattr(ctx, "user_id", None))


# ── Διαχείριση κουπονιών (κεντρικά, μέσα στην Προώθηση) ──────────────────────────────────────
class CouponCreateIn(BaseModel):
    reward_type: str = "discount"        # "discount" (€/%) | "service" (δωρεάν/εκπτωτική υπηρεσία)
    discount_type: str = "pct"           # pct | fixed (cents)
    discount_value: int = 0              # % ή cents
    valid_days: int = 30
    max_redemptions: int = 0             # 0 = χωρίς όριο
    note: str | None = None
    service_id: str | None = None
    service_name: str | None = None
    service_free: bool = False           # δωρεάν/δοκιμαστική υπηρεσία


class CouponStatusIn(BaseModel):
    active: bool = True


@router.get("/coupons")
async def coupons(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Όλα τα κουπόνια του φαρμακείου + κατάσταση + απόδοση (κεντρική διαχείριση)."""
    return {"items": await marketing.list_coupons(ctx.tenant_id)}


@router.post("/coupons")
async def coupon_create(body: CouponCreateIn, ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Δημιουργία ΑΥΤΟΝΟΜΟΥ κουπονιού (χωρίς αποστολή) — έκπτωση Ή δωρεάν/εκπτωτική υπηρεσία."""
    return await marketing.create_standalone_coupon(
        ctx.tenant_id, reward_type=body.reward_type, discount_type=body.discount_type,
        discount_value=body.discount_value, valid_days=body.valid_days,
        max_redemptions=body.max_redemptions, note=body.note, service_id=body.service_id,
        service_name=body.service_name, service_free=body.service_free)


@router.post("/coupons/{code}/status")
async def coupon_status(code: str, body: CouponStatusIn,
                        ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Ενεργοποίηση/απενεργοποίηση κουπονιού."""
    return await marketing.set_coupon_status(ctx.tenant_id, code, body.active)


@router.get("/services")
async def services(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Ενεργές υπηρεσίες φαρμακείου (για επιλογή στο κουπόνι υπηρεσίας)."""
    from app.repositories.patient_portal import PharmacyServiceRepository
    rows = await PharmacyServiceRepository(tenant_id=ctx.tenant_id).list_active()
    return {"items": [{"id": str(s["_id"]), "name": s.get("name")} for s in rows]}


@router.get("/settings")
async def get_settings(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await marketing.get_settings(ctx.tenant_id)


@router.put("/settings")
async def set_settings(body: SettingsIn, ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Anti-fatigue: όριο προωθητικών μηνυμάτων ανά ασθενή/μήνα."""
    return await marketing.set_settings(ctx.tenant_id, frequency_cap=body.frequency_cap)
