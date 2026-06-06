"""Future prescriptions router — upcoming + demand forecast."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from app.core.deps import TenantContext, require
from app.repositories.future import FuturePrescriptionRepository

router = APIRouter()

_MODULE = "future_prescriptions"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


@router.get("/upcoming")
async def upcoming(
    days: int = 14,
    min_history: int = 0,
    ctx: TenantContext = Depends(require("future:read", module=_MODULE)),
):
    repo = FuturePrescriptionRepository(tenant_id=ctx.tenant_id)
    today = _now()
    horizon = today + timedelta(days=days)
    return {"days": days, "min_history": min_history,
            "items": await repo.upcoming(today=today, horizon=horizon,
                                         min_history=min_history)}


@router.get("/forecast")
async def forecast(
    product_id: str | None = None,
    horizon_days: int = 30,
    ctx: TenantContext = Depends(require("future:read", module=_MODULE)),
):
    repo = FuturePrescriptionRepository(tenant_id=ctx.tenant_id)
    today = _now()
    horizon = today + timedelta(days=horizon_days)
    return {"horizon_days": horizon_days,
            "items": await repo.forecast(today=today, horizon=horizon,
                                         product_id=product_id)}
