"""Prescription Analytics router."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query

from fastapi import HTTPException, status

from app.core.deps import TenantContext, require
from app.repositories.prescriptions import PrescriptionRepository

router = APIRouter()


@router.get("/detail/{external_id}")
async def execution_detail(
    external_id: str,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    detail = await repo.execution_detail(external_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "execution_not_found")
    return detail


@router.get("")
async def list_prescriptions(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    fund_id: str | None = None,
    doctor_id: str | None = None,
    icd10: str | None = None,
    page: int = 1,
    page_size: int = 50,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    query: dict = {"executed_at": {"$gte": date_from, "$lt": date_to}}
    if fund_id:
        query["fund_id"] = fund_id
    if doctor_id:
        query["doctor_id"] = doctor_id
    if icd10:
        query["icd10"] = icd10
    items = await repo.list_executions(query, skip=(page - 1) * page_size, limit=page_size)
    return {"page": page, "page_size": page_size, "items": items}


@router.get("/aggregate")
async def aggregate(
    group_by: Literal["fund", "doctor", "icd10", "product"] = "fund",
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    dim = {"fund": "doctors", "doctor": "doctors", "icd10": "icd10", "product": "products"}
    # reuse top() shape for fund/doctor/icd10/product groupings
    return await repo.top(dim=dim.get(group_by, "doctors"), limit=100,
                          date_from=date_from, date_to=date_to)


@router.get("/unexecuted")
async def unexecuted(
    limit: int = 50,
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """Concept doc §9 — ανεκτέλεστες δραστικές: μη-εκτελεσμένες γραμμές + χαμένη αξία."""
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.unexecuted_substances(date_from=date_from, date_to=date_to, limit=limit)
