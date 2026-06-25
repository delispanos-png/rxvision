"""Pharmacy hours & availability router — weekly schedule, on-duty calendar, exceptions,
real-time status. Edit = settings:write (owner/manager); read = settings:read (staff)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.core.deps import TenantContext, require
from app.repositories.pharmacy_availability import PharmacyAvailabilityRepository

router = APIRouter()


def _repo(ctx: TenantContext) -> PharmacyAvailabilityRepository:
    return PharmacyAvailabilityRepository(tenant_id=ctx.tenant_id)


class Interval(BaseModel):
    start: str
    end: str


class DayIn(BaseModel):
    day: int = Field(..., ge=0, le=6)
    status: str = Field("closed", pattern="^(closed|continuous|split|custom)$")
    intervals: list[Interval] = Field(default_factory=list, max_length=8)


class ScheduleIn(BaseModel):
    week: list[DayIn] = Field(..., min_length=7, max_length=7)


class DutyIn(BaseModel):
    date: str
    start: str
    end: str
    kind: str = Field("duty", pattern="^(duty|overnight)$")
    note: str | None = None


class ExceptionIn(BaseModel):
    date: str
    type: str = Field(..., pattern="^(closed|holiday|local_holiday|vacation|inventory|renovation|emergency_close|custom)$")
    label: str | None = None
    intervals: list[Interval] = Field(default_factory=list, max_length=8)
    note: str | None = None


class IdIn(BaseModel):
    id: str


class ImportIn(BaseModel):
    text: str = Field(..., max_length=20000)
    commit: bool = False


# ── STATUS ──
@router.get("/status")
async def status(ctx: TenantContext = Depends(require("settings:read"))):
    return await _repo(ctx).status()


# ── WEEKLY SCHEDULE ──
@router.get("/schedule")
async def get_schedule(ctx: TenantContext = Depends(require("settings:read"))):
    return await _repo(ctx).get_schedule()


@router.put("/schedule")
async def put_schedule(body: ScheduleIn, ctx: TenantContext = Depends(require("settings:write"))):
    return await _repo(ctx).save_schedule([d.model_dump() for d in body.week], ctx.user_id)


# ── DUTIES (εφημερίες) ──
@router.get("/duties")
async def duties(year: int = Query(None), ctx: TenantContext = Depends(require("settings:read"))):
    return await _repo(ctx).list_duties(year)


@router.post("/duties")
async def add_duty(body: DutyIn, ctx: TenantContext = Depends(require("settings:write"))):
    return await _repo(ctx).add_duty(date=body.date, start=body.start, end=body.end,
                                     kind=body.kind, note=body.note, user_id=ctx.user_id)


@router.post("/duties/delete")
async def delete_duty(body: IdIn, ctx: TenantContext = Depends(require("settings:write"))):
    return await _repo(ctx).delete_duty(body.id)


# ── EXCEPTIONS ──
@router.get("/exceptions")
async def exceptions(year: int = Query(None), ctx: TenantContext = Depends(require("settings:read"))):
    return await _repo(ctx).list_exceptions(year)


@router.post("/exceptions")
async def add_exception(body: ExceptionIn, ctx: TenantContext = Depends(require("settings:write"))):
    return await _repo(ctx).add_exception(
        date=body.date, type=body.type, label=body.label,
        intervals=[i.model_dump() for i in body.intervals], note=body.note, user_id=ctx.user_id)


@router.post("/exceptions/delete")
async def delete_exception(body: IdIn, ctx: TenantContext = Depends(require("settings:write"))):
    return await _repo(ctx).delete_exception(body.id)


# ── BULK IMPORT (preview/commit) ──
@router.post("/import")
async def import_duties(body: ImportIn, ctx: TenantContext = Depends(require("settings:write"))):
    return await _repo(ctx).import_duties(body.text, commit=body.commit, user_id=ctx.user_id)
