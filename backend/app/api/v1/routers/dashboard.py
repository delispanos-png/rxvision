"""Dashboard module — KPIs and timeseries.

Demonstrates: permission+module gating via `require`, tenant-scoped repository,
and a real aggregation pipeline that starts with $match (tenant scope is forced
by BaseRepository.aggregate).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query

from app.core.deps import TenantContext, require
from app.repositories.prescriptions import PrescriptionRepository

router = APIRouter()


@router.get("/summary")
async def summary(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("dashboard:read", module="dashboard")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.dashboard_summary(date_from, date_to)


@router.get("/timeseries")
async def timeseries(
    metric: Literal["executions", "value", "claimed"] = "executions",
    grain: Literal["day", "month"] = "day",
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("dashboard:read", module="dashboard")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.timeseries(metric=metric, grain=grain, date_from=date_from, date_to=date_to)


@router.get("/heatmap")
async def heatmap(
    metric: Literal["executions", "value", "claimed"] = "executions",
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("dashboard:read", module="dashboard")),
):
    """Busy-hours matrix: ISO weekday (1=Mon..7=Sun) × hour (0-23), Athens time."""
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.hourly_heatmap(metric=metric, date_from=date_from, date_to=date_to)


@router.get("/top")
async def top(
    dim: Literal["doctors", "icd10", "products"] = "doctors",
    limit: int = 10,
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("dashboard:read", module="dashboard")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.top(dim=dim, limit=limit, date_from=date_from, date_to=date_to)
