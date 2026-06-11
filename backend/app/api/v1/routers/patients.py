"""Patient analytics router — anonymized aggregates + retention."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from pydantic import BaseModel, Field

from app.core.deps import TenantContext, require
from app.repositories.contacts import PatientContactRepository
from app.repositories.patients import PatientExecutionsRepository, PatientRepository

router = APIRouter()

_MODULE = "patient_analytics"


class ContactIn(BaseModel):
    phone: str | None = None
    mobile: str | None = None
    email: str | None = None
    address: str | None = None
    city: str | None = None
    postal_code: str | None = None
    notes: str | None = None
    marketing_consent: bool = False
    preferred_channel: str | None = Field(default=None, description="email|sms|phone")
    active: bool = True
    inactive_reason: str | None = Field(default=None, description="deceased|moved|stopped|other")
    reactivation_reason: str | None = None
    discontinuation_reason: str | None = None


@router.get("/search")
async def search_patients(
    q: str = Query(..., min_length=2),
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    return {"items": await PatientExecutionsRepository(tenant_id=ctx.tenant_id).search(q)}


@router.get("/{patient_id}/contact")
async def get_contact(
    patient_id: str,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    return await PatientContactRepository(tenant_id=ctx.tenant_id).get(patient_id) or {}


@router.put("/{patient_id}/contact")
async def put_contact(
    patient_id: str,
    body: ContactIn,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    saved = await PatientContactRepository(tenant_id=ctx.tenant_id).upsert(patient_id, body.model_dump())
    if saved is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    return saved


@router.get("/detail/{patient_id}")
async def patient_detail(
    patient_id: str,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    """Drill-down: one patient's profile + therapeutic categories / ICD-10 / medicines."""
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id)
    detail = await repo.patient_detail(patient_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    return detail


@router.get("/aggregate")
async def aggregate(
    by: Literal["age_group", "sex", "area", "lifecycle"] = "age_group",
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    repo = PatientRepository(tenant_id=ctx.tenant_id)
    buckets = await repo.aggregate_by(by=by)
    # rows: {label, value=patient count} — shape the Ασφαλισμένοι charts expect
    rows = [{"label": b.get("key") or "—", "value": b.get("patients", 0)} for b in buckets]
    return {"by": by, "rows": rows}


@router.get("/retention")
async def retention(
    cohort: str | None = None,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    repo = PatientRepository(tenant_id=ctx.tenant_id)
    rows = await repo.retention(cohort=cohort)
    points = [{"period": r.get("lifecycle") or "—", "retained_pct": r.get("pct", 0.0)} for r in rows]
    return {"cohort": cohort, "points": points}


@router.get("/list")
async def per_patient(
    sort: Literal["value", "claimed", "profit", "rx"] = "value",
    limit: int = Query(100, ge=1, le=500),
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    """Concept doc §2 — per-patient rx/value/claimed/profit + «ενεργός από» (active_since)."""
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id)
    items = await repo.per_patient(date_from=date_from, date_to=date_to,
                                   sort=sort, limit=limit)
    return {"sort": sort, "items": items}
