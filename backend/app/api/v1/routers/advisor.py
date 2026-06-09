"""Intelligent advisor router — Business & Order. One screen of prioritised insights."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query

from app.core.deps import TenantContext, require
from app.repositories.advisor import AdvisorRepository

router = APIRouter()


@router.get("/business")
async def business(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    return await AdvisorRepository(tenant_id=ctx.tenant_id).business(date_from, date_to)


@router.get("/orders")
async def orders(
    lead_days: int = 7,
    safety_pct: float = 15.0,
    ctx: TenantContext = Depends(require("orders:read", module="order_suggestions")),
):
    return await AdvisorRepository(tenant_id=ctx.tenant_id).orders(
        lead_days=lead_days, safety_pct=safety_pct)
