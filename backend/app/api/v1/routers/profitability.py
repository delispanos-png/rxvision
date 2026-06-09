"""Profitability engine router — summary, by-dimension, low-margin, unprofitable."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Query

from app.core.deps import TenantContext, require
from app.repositories.profitability import (
    ProductRepository,
    ProfitabilityLiveRepository,
    ProfitabilitySnapshotRepository,
    ReceivablesRepository,
    _month_range,
)

router = APIRouter()

_MODULE = "profitability"


@router.get("/summary")
async def summary(
    period: str = Query(..., description="YYYY-MM"),
    ctx: TenantContext = Depends(require("profitability:read", module=_MODULE)),
):
    repo = ProfitabilitySnapshotRepository(tenant_id=ctx.tenant_id)
    return await repo.summary(period=period)


@router.get("/by")
async def by_dimension(
    dim: Literal["fund", "doctor", "icd10", "product", "category"] = "fund",
    period: str = Query(..., description="YYYY-MM"),
    ctx: TenantContext = Depends(require("profitability:read", module=_MODULE)),
):
    start, end = _month_range(period)
    repo = ProfitabilityLiveRepository(tenant_id=ctx.tenant_id)
    rows = await repo.by_dimension_live(date_from=start, date_to=end, dim=dim)
    return {"period": period, "dim": dim, "rows": rows}


@router.get("/low-margin")
async def low_margin(
    threshold_pct: float = 10.0,
    limit: int = 50,
    ctx: TenantContext = Depends(require("profitability:read", module=_MODULE)),
):
    repo = ProductRepository(tenant_id=ctx.tenant_id)
    return {"threshold_pct": threshold_pct,
            "items": await repo.low_margin(threshold_pct=threshold_pct, limit=limit)}


@router.get("/unprofitable-categories")
async def unprofitable_categories(
    ctx: TenantContext = Depends(require("profitability:read", module=_MODULE)),
):
    repo = ProductRepository(tenant_id=ctx.tenant_id)
    return {"items": await repo.unprofitable_categories()}


@router.get("/aging")
async def aging(
    ctx: TenantContext = Depends(require("profitability:read", module=_MODULE)),
):
    """Concept doc §6 — receivables aging (cashflow): claimed amounts owed by funds,
    bucketed by days since execution (0-30 / 31-60 / 61-90 / 90+)."""
    repo = ReceivablesRepository(tenant_id=ctx.tenant_id)
    return await repo.aging(now=datetime.now(tz=timezone.utc))
