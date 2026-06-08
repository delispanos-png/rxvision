"""Patient analytics router — anonymized aggregates + retention."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query

from app.core.deps import TenantContext, require
from app.repositories.patients import PatientExecutionsRepository, PatientRepository

router = APIRouter()

_MODULE = "patient_analytics"


@router.get("/aggregate")
async def aggregate(
    by: Literal["age_group", "sex", "area", "lifecycle"] = "age_group",
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    repo = PatientRepository(tenant_id=ctx.tenant_id)
    return {"by": by, "buckets": await repo.aggregate_by(by=by)}


@router.get("/retention")
async def retention(
    cohort: str | None = None,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    repo = PatientRepository(tenant_id=ctx.tenant_id)
    return {"cohort": cohort, "rows": await repo.retention(cohort=cohort)}


@router.get("/list")
async def per_patient(
    sort: Literal["value", "claimed", "profit", "rx"] = "value",
    limit: int = Query(100, ge=1, le=500),
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    """Concept doc §2 — per-patient rx/value/claimed/profit + «ενεργός από» (active_since)."""
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id)
    items = await repo.per_patient(date_from=date_from, date_to=date_to,
                                   sort=sort, limit=limit)
    return {"sort": sort, "items": items}
