"""Reimbursement Intelligence router — executive dashboard, monthly closing, claim forecast,
risk engine, expected cuts (digital ΕΟΠΥΥ auditor). Optical/OCR audit lives in a sibling module."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.reimbursement import ReimbursementRepository
from app.repositories.scans import ScanRepository

router = APIRouter()
_MODULE = "monthly_closing"


class StatusIn(BaseModel):
    batch_id: str
    status: str


class PaymentIn(BaseModel):
    batch_id: str
    paid_amount: int  # cents


class BarcodeIn(BaseModel):
    barcode: str


def _repo(ctx: TenantContext) -> ReimbursementRepository:
    return ReimbursementRepository(tenant_id=ctx.tenant_id)


def _cur() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m")


@router.get("/executive")
async def executive(period: str | None = Query(None, description="YYYY-MM"),
                    ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).executive(period)


@router.get("/closing")
async def closing(period: str = Query(None),
                  ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).monthly_closing(period or _cur())


@router.get("/forecast")
async def forecast(ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).forecast()


@router.get("/risk")
async def risk(period: str = Query(None),
               ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).risk(period or _cur())


@router.get("/cuts")
async def cuts(period: str = Query(None),
               ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).expected_cuts(period or _cur())


@router.get("/submission")
async def submission(period: str = Query(None),
                     ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).submission(period or _cur())


@router.post("/submission/status")
async def set_status(body: StatusIn, period: str = Query(None),
                     ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).set_status(period or _cur(), body.batch_id, body.status)


@router.post("/submission/payment")
async def set_payment(body: PaymentIn, period: str = Query(None),
                      ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).set_payment(period or _cur(), body.batch_id, body.paid_amount)


@router.get("/reconciliation")
async def reconciliation(period: str = Query(None),
                         ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).reconciliation(period or _cur())


# ── Physical barcode check (digital vs physical) ────────────────────────────
@router.get("/physical")
async def physical(period: str = Query(None),
                   ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).physical_check(period or _cur())


@router.post("/physical/scan")
async def physical_scan(body: BarcodeIn, period: str = Query(None),
                        ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).physical_scan(period or _cur(), body.barcode)


@router.post("/physical/reset")
async def physical_reset(period: str = Query(None),
                         ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).physical_reset(period or _cur())


# ── Optical Audit (OCR scans) ───────────────────────────────────────────────
@router.post("/scans")
async def upload_scan(file: UploadFile = File(...), doc_type: str = Form("prescription"),
                      ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    content = await file.read()
    repo = ScanRepository(tenant_id=ctx.tenant_id)
    scan_id = await repo.create(filename=file.filename or "scan.jpg", content=content,
                                content_type=file.content_type or "image/jpeg", doc_type=doc_type)
    from app.workers.optical import process_scan
    process_scan.delay(ctx.tenant_id, scan_id)
    return {"scan_id": scan_id, "status": "processing"}


@router.get("/scans")
async def scan_queue(ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return {"items": await ScanRepository(tenant_id=ctx.tenant_id).queue()}


@router.get("/scans/{scan_id}/image")
async def scan_image(scan_id: str,
                     ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    content, ctype = await ScanRepository(tenant_id=ctx.tenant_id).image(scan_id)
    if content is None:
        return Response(status_code=404)
    return Response(content=content, media_type=ctype or "image/jpeg")
