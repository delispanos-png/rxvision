"""Order suggestions router — demand + safety stock → suggested quantities."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.future import FuturePrescriptionRepository

router = APIRouter()

_MODULE = "order_suggestions"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


#: Προεπιλεγμένος ορίζοντας παραγγελίας (ημέρες) — ΙΔΙΟΣ σε «Παραγγελίες» και «Σύμβουλο Παραγγελίας».
DEFAULT_HORIZON_DAYS = 7


async def order_horizon(tenant_id: str) -> int:
    """Ο ορίζοντας παραγγελίας του φαρμακείου. Πριν: Παραγγελίες 3 ημέρες, Σύμβουλος Παραγγελίας 7
    — ο ίδιος φαρμακοποιός έβλεπε δύο διαφορετικές «προτάσεις παραγγελίας» (30/09/2026)."""
    from app.core.db import shared_db
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"order_horizon_days": 1})
    try:
        return max(1, min(60, int((t or {}).get("order_horizon_days") or DEFAULT_HORIZON_DAYS)))
    except (TypeError, ValueError):
        return DEFAULT_HORIZON_DAYS


class HorizonIn(BaseModel):
    days: int


@router.put("/settings/horizon")
async def set_horizon(body: HorizonIn,
                      ctx: TenantContext = Depends(require("orders:run", module=_MODULE))):
    from app.core.db import shared_db
    days = max(1, min(60, int(body.days)))
    await shared_db()["tenants"].update_one({"_id": ctx.tenant_id}, {"$set": {"order_horizon_days": days}})
    return {"ok": True, "days": days}


@router.get("/suggestions")
async def suggestions(
    lead_time_days: int | None = None,
    safety_stock_pct: float = 15.0,
    ctx: TenantContext = Depends(require("orders:read", module=_MODULE)),
):
    if not lead_time_days:
        lead_time_days = await order_horizon(ctx.tenant_id)
    repo = FuturePrescriptionRepository(tenant_id=ctx.tenant_id)
    today = _now()
    lead_horizon = today + timedelta(days=lead_time_days)
    # Το απόθεμα αποθήκης λαμβάνεται υπόψη ΜΟΝΟ αν η συνδρομή περιλαμβάνει το e-shop/αποθήκη.
    use_warehouse = ctx.modules.get("order_delivery", "locked") != "locked"
    items = await repo.order_suggestions(today=today, lead_horizon=lead_horizon,
                                         safety_stock_pct=safety_stock_pct, use_warehouse=use_warehouse)
    return {"lead_time_days": lead_time_days, "safety_stock_pct": safety_stock_pct,
            "warehouse_stock": use_warehouse, "items": items}


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
