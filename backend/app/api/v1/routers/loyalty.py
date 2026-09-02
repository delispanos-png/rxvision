"""Pharmacist-side loyalty circuit (under «Λειτουργίες»). Gated by the patient_portal module
(the patient wallet lives in my.rxvision.gr) + portal:manage."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core.deps import TenantContext, require
from app.repositories.loyalty import LoyaltyRepository

router = APIRouter()
_MODULE = "loyalty"          # opt-in module — ενεργοποιείται ανά φαρμακείο
_PERM = "portal:manage"


@router.get("")
async def overview(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    data = await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).overview()
    # Όνομα φαρμακείου → τυπώνεται πάνω στη φυσική κάρτα πιστότητας.
    from app.core.db import shared_db
    t = await shared_db()["tenants"].find_one({"_id": ctx.tenant_id}) or {}   # tenant-ok: own tenant
    data["pharmacy_name"] = (t.get("company") or {}).get("name") or t.get("name") or ""
    return data


@router.get("/member/{patient_ref}")
async def member(patient_ref: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).member(patient_ref) or {"ok": False}


# ── enrollment (opt-in) ────────────────────────────────────────────────────
@router.get("/candidates")
async def candidates(q: str = "", ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).candidates(q)}


class EnrollIn(BaseModel):
    patient_ref: str
    method: str = Field("physical", pattern="^(physical|electronic)$")
    name: str | None = None
    referred_by_code: str | None = Field(None, max_length=16)


@router.post("/enroll")
async def enroll(body: EnrollIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).enroll(
        body.patient_ref, method=body.method, name=body.name, referred_by_code=body.referred_by_code)


@router.post("/unenroll")
async def unenroll(body: EnrollIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).unenroll(body.patient_ref)


# ── redemptions log + reversal ─────────────────────────────────────────────
@router.get("/redemptions")
async def redemptions(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).redemptions()}


class ReverseIn(BaseModel):
    ledger_id: str


@router.post("/reverse")
async def reverse(body: ReverseIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).reverse(body.ledger_id)


class ConfigIn(BaseModel):
    enabled: bool = True
    points_per_refill: int = Field(10, ge=0, le=1000)
    cents_per_point: int = Field(5, ge=0, le=1000)
    min_redeem_cents: int = Field(100, ge=0, le=100000)
    redeem_cart_policy: str = Field("any", pattern="^(any|non_rx_only|off)$")   # πολιτική εξαργύρωσης στο καλάθι
    welcome_cents: int = Field(0, ge=0, le=100000)
    # Πόντοι για συνεπή λήψη αγωγής (med-intake streak) — ΑΠΟΚΛΕΙΣΤΙΚΗ απόφαση του φαρμακοποιού,
    # OFF by default (οι πόντοι κοστίζουν € στο wallet). Το calendar/σερί δουλεύουν ούτως ή άλλως.
    adherence_points_enabled: bool = False
    adherence_rule: str = Field("per_day", pattern="^(per_med|per_day|full_day)$")  # συνθήκη κέρδισης
    points_per_adherence: int = Field(1, ge=0, le=100)        # πόντοι ανά γεγονός κέρδισης
    adherence_streak_bonus: int = Field(5, ge=0, le=1000)     # bonus κάθε 7-μερο σερί
    # Tier multipliers (percent, 100 = ×1.0) — υψηλότερα tiers κερδίζουν περισσότερους πόντους/εκτέλεση
    tier_multipliers_enabled: bool = False
    tier_multipliers: dict[str, int] | None = None
    # Καμπάνιες διπλών πόντων + λήξη πόντων (κυλιόμενο παράθυρο μηνών, 0 = ποτέ)
    campaigns: list[dict] | None = None
    points_expire_months: int = Field(0, ge=0, le=120)
    # Referral «σύστησε φίλο» + δώρο γενεθλίων
    referral_enabled: bool = False
    referral_referrer_cents: int = Field(500, ge=0, le=100000)
    referral_referred_cents: int = Field(300, ge=0, le=100000)
    birthday_enabled: bool = False
    birthday_bonus_cents: int = Field(500, ge=0, le=100000)


@router.post("/config")
async def save_config(body: ConfigIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).save_config(body.model_dump())


class RedeemIn(BaseModel):
    patient_ref: str
    cents: int = Field(..., ge=1)
    kind: str = Field("service", pattern="^(service|parapharma|other)$")
    reason: str | None = None


@router.post("/redeem")
async def redeem(body: RedeemIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).redeem(
        body.patient_ref, body.cents, reason=body.reason or "", kind=body.kind)


class AdjustIn(BaseModel):
    patient_ref: str
    cents: int                      # may be negative (correction)
    reason: str | None = None


@router.post("/adjust")
async def adjust(body: AdjustIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).adjust(
        body.patient_ref, body.cents, reason=body.reason or "")


# ── rewards catalogue ──────────────────────────────────────────────────────
@router.get("/rewards")
async def rewards(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).rewards()}


class RewardIn(BaseModel):
    title: str = Field(..., min_length=2, max_length=120)
    type: str = Field("product", pattern="^(product|service|percent|cash)$")
    cost_points: int = Field(100, ge=1, le=1000000)
    note: str | None = Field(None, max_length=200)
    active: bool = True


@router.post("/rewards", status_code=201)
async def add_reward(body: RewardIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"id": await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).add_reward(body.model_dump())}


@router.post("/rewards/{reward_id}")
async def update_reward(reward_id: str, body: RewardIn,
                        ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).update_reward(reward_id, body.model_dump())


@router.delete("/rewards/{reward_id}")
async def delete_reward(reward_id: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).delete_reward(reward_id)


class RedeemRewardIn(BaseModel):
    patient_ref: str
    reward_id: str


@router.post("/redeem-reward")
async def redeem_reward(body: RedeemRewardIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).redeem_reward(body.patient_ref, body.reward_id)


class ConfirmCodeIn(BaseModel):
    code: str


@router.get("/pending")
async def pending_redemptions(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ενεργές δεσμεύσεις δώρων που έκαναν οι πελάτες από την πύλη (self-redeem) — προς επιβεβαίωση."""
    return {"items": await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).pending_redemptions()}


@router.post("/confirm-redeem")
async def confirm_redeem(body: ConfirmCodeIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ο φαρμακοποιός επιβεβαιώνει δέσμευση με τον 6ψήφιο κωδικό → οριστική εξαργύρωση."""
    return await LoyaltyRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).confirm_reward(body.code)
