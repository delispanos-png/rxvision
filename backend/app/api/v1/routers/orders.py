"""Order suggestions router — demand + safety stock → suggested quantities."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from app.core.deps import TenantContext, require
from app.repositories.future import FuturePrescriptionRepository

router = APIRouter()

_MODULE = "order_suggestions"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


@router.get("/suggestions")
async def suggestions(
    lead_time_days: int = 3,
    safety_stock_pct: float = 15.0,
    ctx: TenantContext = Depends(require("orders:read", module=_MODULE)),
):
    repo = FuturePrescriptionRepository(tenant_id=ctx.tenant_id)
    today = _now()
    lead_horizon = today + timedelta(days=lead_time_days)
    items = await repo.order_suggestions(today=today, lead_horizon=lead_horizon,
                                         safety_stock_pct=safety_stock_pct)
    return {"lead_time_days": lead_time_days, "safety_stock_pct": safety_stock_pct,
            "items": items}


@router.post("/suggestions/recompute", status_code=202)
async def recompute(
    ctx: TenantContext = Depends(require("orders:run", module=_MODULE)),
):
    # Enqueue an async recompute of the order-suggestion snapshot for this tenant.
    # The Celery worker reads pending future_prescriptions + demand history.
    try:
        from app.workers.snapshots import recompute_order_suggestions  # type: ignore

        recompute_order_suggestions.delay(ctx.tenant_id)
        status = "queued"
    except Exception:  # noqa: BLE001 — worker/task may not be wired yet
        status = "accepted"
    return {"status": status, "tenant_id": ctx.tenant_id}
