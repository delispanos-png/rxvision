"""Patient Intelligence router — unified patient-level BI (dashboard, analytics, compliance,
recall, win-back, VIP, risk, segmentation, AI insights). Consolidates capabilities that were
scattered across the advisor/patients modules."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.core.deps import TenantContext, require
from app.repositories.advisor import AdvisorRepository
from app.repositories.patient_intelligence import PatientIntelligenceRepository

router = APIRouter()
_MODULE = "patient_analytics"


def _repo(ctx: TenantContext) -> PatientIntelligenceRepository:
    return PatientIntelligenceRepository(tenant_id=ctx.tenant_id)


@router.get("/overview")
async def overview(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).overview()


@router.get("/patients")
async def patients(sort: str = Query("value"),
                   ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).patients_table(sort=sort)


@router.get("/compliance")
async def compliance(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).compliance()


@router.get("/recall")
async def recall(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await AdvisorRepository(tenant_id=ctx.tenant_id).recall()


@router.get("/winback")
async def winback(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).winback()


@router.get("/vip")
async def vip(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).vip()


@router.get("/risk")
async def risk(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).risk()


@router.get("/segments")
async def segments(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).segments()
