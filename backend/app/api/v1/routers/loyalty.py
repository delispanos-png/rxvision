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
    return await LoyaltyRepository(tenant_id=ctx.tenant_id).overview()


@router.get("/member/{patient_ref}")
async def member(patient_ref: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id).member(patient_ref) or {"ok": False}


# ── enrollment (opt-in) ────────────────────────────────────────────────────
@router.get("/candidates")
async def candidates(q: str = "", ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await LoyaltyRepository(tenant_id=ctx.tenant_id).candidates(q)}


class EnrollIn(BaseModel):
    patient_ref: str
    method: str = Field("physical", pattern="^(physical|electronic)$")
    name: str | None = None


@router.post("/enroll")
async def enroll(body: EnrollIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id).enroll(body.patient_ref, method=body.method, name=body.name)


@router.post("/unenroll")
async def unenroll(body: EnrollIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id).unenroll(body.patient_ref)


# ── redemptions log + reversal ─────────────────────────────────────────────
@router.get("/redemptions")
async def redemptions(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await LoyaltyRepository(tenant_id=ctx.tenant_id).redemptions()}


class ReverseIn(BaseModel):
    ledger_id: str


@router.post("/reverse")
async def reverse(body: ReverseIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id).reverse(body.ledger_id)


class ConfigIn(BaseModel):
    enabled: bool = True
    points_per_refill: int = Field(10, ge=0, le=1000)
    cents_per_point: int = Field(5, ge=0, le=1000)
    min_redeem_cents: int = Field(100, ge=0, le=100000)
    welcome_cents: int = Field(0, ge=0, le=100000)


@router.post("/config")
async def save_config(body: ConfigIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id).save_config(body.model_dump())


class RedeemIn(BaseModel):
    patient_ref: str
    cents: int = Field(..., ge=1)
    kind: str = Field("service", pattern="^(service|parapharma|other)$")
    reason: str | None = None


@router.post("/redeem")
async def redeem(body: RedeemIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id).redeem(
        body.patient_ref, body.cents, reason=body.reason or "", kind=body.kind)


class AdjustIn(BaseModel):
    patient_ref: str
    cents: int                      # may be negative (correction)
    reason: str | None = None


@router.post("/adjust")
async def adjust(body: AdjustIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id).adjust(
        body.patient_ref, body.cents, reason=body.reason or "")


# ── rewards catalogue ──────────────────────────────────────────────────────
@router.get("/rewards")
async def rewards(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await LoyaltyRepository(tenant_id=ctx.tenant_id).rewards()}


class RewardIn(BaseModel):
    title: str = Field(..., min_length=2, max_length=120)
    type: str = Field("product", pattern="^(product|service|percent|cash)$")
    cost_points: int = Field(100, ge=1, le=1000000)
    note: str | None = Field(None, max_length=200)
    active: bool = True


@router.post("/rewards", status_code=201)
async def add_reward(body: RewardIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"id": await LoyaltyRepository(tenant_id=ctx.tenant_id).add_reward(body.model_dump())}


@router.post("/rewards/{reward_id}")
async def update_reward(reward_id: str, body: RewardIn,
                        ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id).update_reward(reward_id, body.model_dump())


@router.delete("/rewards/{reward_id}")
async def delete_reward(reward_id: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id).delete_reward(reward_id)


class RedeemRewardIn(BaseModel):
    patient_ref: str
    reward_id: str


@router.post("/redeem-reward")
async def redeem_reward(body: RedeemRewardIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await LoyaltyRepository(tenant_id=ctx.tenant_id).redeem_reward(body.patient_ref, body.reward_id)
