"""ICD-10 analytics router — count / value / profit per diagnosis."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query

from app.core.deps import TenantContext, require
from app.repositories.icd10 import Icd10Repository

router = APIRouter()

_MODULE = "icd10_analytics"


@router.get("/aggregate")
async def aggregate(
    metric: Literal["count", "value", "profit"] = "count",
    limit: int = 50,
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("icd10:read", module=_MODULE)),
):
    repo = Icd10Repository(tenant_id=ctx.tenant_id)
    rows = await repo.aggregate_metric(metric=metric, date_from=date_from,
                                       date_to=date_to, limit=limit)
    return {"metric": metric, "items": rows}


@router.get("/hierarchy")
async def hierarchy(
    level: int = Query(3, ge=1, le=5, description="ICD-10 rollup depth (1=chapter..5=full)"),
    metric: Literal["count", "value", "profit"] = "count",
    limit: int = 50,
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("icd10:read", module=_MODULE)),
):
    """Concept doc §4 — diagnoses rolled up to a chosen hierarchy level (1-5)."""
    repo = Icd10Repository(tenant_id=ctx.tenant_id)
    rows = await repo.aggregate_hierarchy(level=level, metric=metric,
                                          date_from=date_from, date_to=date_to, limit=limit)
    return {"level": level, "metric": metric, "items": rows}
