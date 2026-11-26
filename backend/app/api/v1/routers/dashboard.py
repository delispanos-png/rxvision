"""Dashboard module — KPIs and timeseries.

Demonstrates: permission+module gating via `require`, tenant-scoped repository,
and a real aggregation pipeline that starts with $match (tenant scope is forced
by BaseRepository.aggregate).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query

from app.core.deps import TenantContext, get_current_context, require
from app.repositories.prescriptions import PrescriptionRepository
from app.services.stats_exclusion import COUNTABLE_EXEC

router = APIRouter()
ATHENS = ZoneInfo("Europe/Athens")


@router.get("/data-start")
async def data_start(ctx: TenantContext = Depends(get_current_context)):
    """Η πρώτη ημέρα ΤΟΥ ΤΡΕΧΟΝΤΟΣ ΕΤΟΥΣ με συνταγές (ώρα Ελλάδας/Κύπρου) — η προεπιλεγμένη
    ημερομηνία «Από» του κοινού φίλτρου. Φαρμακείο που μπήκε τον Νοέμβριο δεν βλέπει δέκα κενούς
    μήνες στα γραφήματα (26/11/2026). Χωρίς συνταγές φέτος → None (μένει η 1η Ιανουαρίου)."""
    from app.repositories.cy import CyDispensingRepository
    from app.repositories.tenants import TenantRepository
    tenant = await TenantRepository(tenant_id=ctx.tenant_id).get() or {}
    now = datetime.now(ATHENS)
    year_start = datetime(now.year, 1, 1, tzinfo=ATHENS).astimezone(timezone.utc)
    if (tenant.get("country") or "GR").upper() == "CY":
        repo, field, match = CyDispensingRepository(tenant_id=ctx.tenant_id), "dispensed_at", {}
    else:
        repo, field, match = PrescriptionRepository(tenant_id=ctx.tenant_id), "executed_at", COUNTABLE_EXEC
    rows = await repo.aggregate([
        {"$match": {**match, field: {"$gte": year_start}}},
        {"$sort": {field: 1}}, {"$limit": 1},
        {"$project": {"_id": 0, "d": {"$dateToString": {"date": f"${field}", "format": "%Y-%m-%d",
                                                        "timezone": "Europe/Athens"}}}}])
    return {"first_date": rows[0]["d"] if rows else None, "year": now.year}


@router.get("/summary")
async def summary(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    fund_id: str | None = None,
    doctor_id: str | None = None,
    icd10: str | None = None,
    ctx: TenantContext = Depends(require("dashboard:read", module="dashboard")),
):
    """Τα φίλτρα της σελίδας (ταμείο/γιατρός/διάγνωση) ΙΣΧΥΟΥΝ και εδώ — πριν αγνοούνταν και οι
    κάρτες έδειχναν όλα τα ταμεία ενώ η λίστα που ανοίγουν ήταν φιλτραρισμένη (30/09/2026)."""
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.dashboard_summary(date_from, date_to, fund_id=fund_id,
                                        doctor_id=doctor_id, icd10=icd10)


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
