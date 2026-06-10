"""Prescription Analytics router."""

from __future__ import annotations

import re
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


@router.get("/repeats/{external_id}")
async def prescription_repeats(
    external_id: str,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """The repeat tree — all executions of this prescription's barcode + next expected."""
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.repeats(external_id)


@router.get("/idika/{barcode}")
async def idika_full_detail(
    barcode: str,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """Live, portal-equivalent detail straight from the ΗΔΙΚΑ CDA (on-demand): issue/
    deadline dates, exemption/opinion/surcharge flags, per-line lot/prices/dosage."""
    from fastapi.concurrency import run_in_threadpool
    from app.api.v1.routers.ingestion import _effective_hdika_creds
    from app.services.ingestion.hdika_client import HdikaClient

    creds = await _effective_hdika_creds(ctx.tenant_id)
    if not creds:
        raise HTTPException(status.HTTP_409_CONFLICT, "no_idika_credentials")

    bc = barcode.split(":")[0]  # external_id is "barcode:executionNo" → ΗΔΙΚΑ wants the bare barcode
    def _fetch() -> dict:
        client = HdikaClient(creds)
        try:
            return client.fetch_cda_full(bc)
        finally:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass

    data = await run_in_threadpool(_fetch)
    if not data:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "idika_fetch_failed")
    return data


@router.get("")
async def list_prescriptions(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    fund_id: str | None = None,
    doctor_id: str | None = None,
    icd10: str | None = None,
    barcode: str | None = None,
    sort: str = "executed_at",
    dir: int = -1,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
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
    if barcode and barcode.strip():
        # search by prescription barcode (prefix match); ignore the date window so a
        # known barcode is found regardless of the selected period.
        query.pop("executed_at", None)
        query["external_id"] = {"$regex": "^" + re.escape(barcode.strip())}
    items = await repo.list_executions(query, skip=(page - 1) * page_size, limit=page_size,
                                       sort=sort, direction=dir)
    return {"page": page, "page_size": page_size, "items": items}


@router.get("/by-fund")
async def by_fund(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return {"items": await repo.by_fund(date_from, date_to)}


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
    limit: int = Query(50, ge=1, le=500),
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """Concept doc §9 — ανεκτέλεστες δραστικές: μη-εκτελεσμένες γραμμές + χαμένη αξία."""
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.unexecuted_substances(date_from=date_from, date_to=date_to, limit=limit)
