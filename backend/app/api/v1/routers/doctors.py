"""Doctor analytics router — list, per-doctor stats, new patients."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query

from app.core.deps import TenantContext, require
from app.repositories.doctors import DoctorExecutionsRepository

router = APIRouter()

_MODULE = "doctor_analytics"


@router.get("")
async def list_doctors(
    search: str | None = None,
    sort: str = "value",
    date_from: datetime | None = Query(None),
    date_to: datetime | None = Query(None),
    page: int = 1,
    page_size: int = 500,
    ctx: TenantContext = Depends(require("doctors:read", module=_MODULE)),
):
    from datetime import timedelta, timezone
    now = datetime.now(tz=timezone.utc)
    df = date_from or (now - timedelta(days=365))
    dt = date_to or now
    repo = DoctorExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    items = await repo.doctors_with_stats(date_from=df, date_to=dt, search=search,
                                          skip=(page - 1) * page_size, limit=page_size, sort=sort)
    return {"page": page, "page_size": page_size, "items": items}


@router.get("/{doctor_id}/stats")
async def doctor_stats(
    doctor_id: str,
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("doctors:read", module=_MODULE)),
):
    repo = DoctorExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return await repo.stats(doctor_id=doctor_id, date_from=date_from, date_to=date_to)


@router.get("/{doctor_id}/new-patients")
async def doctor_new_patients(
    doctor_id: str,
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("doctors:read", module=_MODULE)),
):
    repo = DoctorExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    items = await repo.new_patients(doctor_id=doctor_id, date_from=date_from,
                                    date_to=date_to)
    return {"doctor_id": doctor_id, "count": len(items), "items": items}


@router.get("/{doctor_id}/prescriptions")
async def doctor_prescriptions(
    doctor_id: str,
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("doctors:read", module=_MODULE)),
):
    repo = DoctorExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return {"items": await repo.prescriptions(doctor_id=doctor_id,
                                              date_from=date_from, date_to=date_to)}


@router.get("/{doctor_id}/patients")
async def doctor_patients(
    doctor_id: str,
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("doctors:read", module=_MODULE)),
):
    repo = DoctorExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return {"items": await repo.patients(doctor_id=doctor_id,
                                         date_from=date_from, date_to=date_to)}
