"""PharmacyOne add-on router — POS sales analytics. Gated on module "pharmacyone"."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query

from app.core.deps import TenantContext, require
from app.repositories.pharmacyone import PharmacyOneRepository

router = APIRouter()

_MODULE = "pharmacyone"


@router.get("/sales")
async def sales(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("pharmacyone:read", module=_MODULE)),
):
    repo = PharmacyOneRepository(tenant_id=ctx.tenant_id)
    return await repo.sales(date_from=date_from, date_to=date_to)


@router.get("/by-seller")
async def by_seller(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("pharmacyone:read", module=_MODULE)),
):
    repo = PharmacyOneRepository(tenant_id=ctx.tenant_id)
    return {"items": await repo.by_seller(date_from=date_from, date_to=date_to)}


@router.get("/by-user")
async def by_user(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("pharmacyone:read", module=_MODULE)),
):
    repo = PharmacyOneRepository(tenant_id=ctx.tenant_id)
    return {"items": await repo.by_user(date_from=date_from, date_to=date_to)}


@router.get("/unexecuted")
async def unexecuted(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    page: int = 1,
    page_size: int = 100,
    ctx: TenantContext = Depends(require("pharmacyone:read", module=_MODULE)),
):
    repo = PharmacyOneRepository(tenant_id=ctx.tenant_id)
    items = await repo.unexecuted(date_from=date_from, date_to=date_to,
                                  skip=(page - 1) * page_size, limit=page_size)
    return {"page": page, "page_size": page_size, "items": items}
