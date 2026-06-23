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
    observations: str | None = None   # «Παρατηρήσεις» — ελεύθερο κείμενο φαρμακοποιού
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
    return {"items": await PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).search(q)}


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
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    detail = await repo.patient_detail(patient_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    return detail


@router.get("/aggregate")
async def aggregate(
    by: Literal["age_group", "sex", "area", "lifecycle"] = "age_group",
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    repo = PatientRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    buckets = await repo.aggregate_by(by=by)
    # rows: {label, value=patient count} — shape the Ασφαλισμένοι charts expect
    rows = [{"label": b.get("key") or "—", "value": b.get("patients", 0)} for b in buckets]
    return {"by": by, "rows": rows}


@router.get("/retention")
async def retention(
    cohort: str | None = None,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    repo = PatientRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    rows = await repo.retention(cohort=cohort)
    points = [{"period": r.get("lifecycle") or "—", "retained_pct": r.get("pct", 0.0)} for r in rows]
    return {"cohort": cohort, "points": points}


@router.get("/list")
async def per_patient(
    sort: Literal["value", "claimed", "profit", "rx"] = "value",
    limit: int = Query(100, ge=1, le=500),
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    sex: str | None = Query(None, description="M|F"),
    age_groups: str | None = Query(None, description="comma-separated age groups"),
    area: str | None = Query(None),
    lifecycle: str | None = Query(None, description="active|new|inactive"),
    rx_min: int | None = Query(None, ge=0),
    value_min: float | None = Query(None, description="euros"),
    profit_min: float | None = Query(None, description="euros"),
    status_filter: str | None = Query(None, alias="status", description="active|inactive"),
    reason: str | None = Query(None, description="deceased|moved|stopped|other"),
    has_contact: bool | None = Query(None),
    consent: bool | None = Query(None),
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    """Concept doc §2 — per-patient rx/value/claimed/profit + «ενεργός από», με πλήρη φίλτρα."""
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    filters = {
        "sex": sex or None,
        "age_groups": [a for a in (age_groups or "").split(",") if a.strip()] or None,
        "area": area or None,
        "lifecycle": lifecycle or None,
        "rx_min": rx_min,
        "value_min": int(round(value_min * 100)) if value_min is not None else None,
        "profit_min": int(round(profit_min * 100)) if profit_min is not None else None,
        "status": status_filter or None,
        "reason": reason or None,
        "has_contact": has_contact or None,
        "consent": consent or None,
    }
    items = await repo.per_patient(date_from=date_from, date_to=date_to,
                                   sort=sort, limit=limit, filters=filters)
    return {"sort": sort, "items": items}
