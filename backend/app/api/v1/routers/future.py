"""Future prescriptions router — upcoming + demand forecast."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query

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


@router.get("/upcoming-list")
async def upcoming_list(
    days: int = 30,
    date: str | None = None,
    min_history: int = 0,
    ctx: TenantContext = Depends(require("future:read", module=_MODULE)),
):
    """Individual upcoming prescriptions. Either a rolling window (days from today)
    or a single calendar day (date=YYYY-MM-DD, e.g. the peak day)."""
    repo = FuturePrescriptionRepository(tenant_id=ctx.tenant_id)
    if date:
        start = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
        today, horizon = start, start + timedelta(days=1)
    else:
        today = _now()
        horizon = today + timedelta(days=days)
    return {"days": days, "date": date, "min_history": min_history,
            "items": await repo.upcoming_list(today=today, horizon=horizon,
                                              min_history=min_history)}


def _day(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(hour=0, minute=0, second=0, microsecond=0,
                                             tzinfo=timezone.utc)


@router.get("/daily-coverage")
async def daily_coverage(
    date: str | None = None,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    ctx: TenantContext = Depends(require("future:read", module=_MODULE)),
):
    """Κάλυψη περιόδου: ποσότητες ανά φάρμακο για τις επαναλαμβανόμενες συνταγές που
    ανοίγουν στο διάστημα. Δέχεται είτε μία μέρα (date) είτε εύρος (from..to, inclusive).
    Default = ΑΥΡΙΟ (το βλέπεις από σήμερα για να προλάβεις να παραγγείλεις)."""
    repo = FuturePrescriptionRepository(tenant_id=ctx.tenant_id)
    if from_ and to:
        start, end = _day(from_), _day(to) + timedelta(days=1)
    elif date:
        start = _day(date); end = start + timedelta(days=1)
    else:
        start = (_now() + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
    res = await repo.daily_coverage(day_start=start, day_end=end)
    return {"from": start.date().isoformat(),
            "to": (end - timedelta(days=1)).date().isoformat(), **res}


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
