"""Reimbursement Intelligence router — executive dashboard, monthly closing, claim forecast,
risk engine, expected cuts (digital ΕΟΠΥΥ auditor). Optical/OCR audit lives in a sibling module."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.reimbursement import ReimbursementRepository

router = APIRouter()
_MODULE = "monthly_closing"


class StatusIn(BaseModel):
    batch_id: str
    status: str


class PaymentIn(BaseModel):
    batch_id: str
    paid_amount: int  # cents


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
