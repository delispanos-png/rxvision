"""Monthly closing router — control, discrepancies, fund totals, lock."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import TenantContext, require
from app.repositories.closing import ClosingLockRepository, ClosingRepository

router = APIRouter()

_MODULE = "monthly_closing"


@router.get("/{period}/control")
async def control(
    period: str,
    ctx: TenantContext = Depends(require("closing:read", module=_MODULE)),
):
    repo = ClosingRepository(tenant_id=ctx.tenant_id)
    lock = ClosingLockRepository(tenant_id=ctx.tenant_id)
    result = await repo.control(period=period)
    result["locked"] = await lock.is_locked(period=period)
    return result


@router.get("/{period}/discrepancies")
async def discrepancies(
    period: str,
    ctx: TenantContext = Depends(require("closing:read", module=_MODULE)),
):
    repo = ClosingRepository(tenant_id=ctx.tenant_id)
    items = await repo.discrepancies(period=period)
    return {"period": period, "count": len(items), "items": items}


@router.get("/{period}/fund-totals")
async def fund_totals(
    period: str,
    ctx: TenantContext = Depends(require("closing:read", module=_MODULE)),
):
    repo = ClosingRepository(tenant_id=ctx.tenant_id)
    return {"period": period, "items": await repo.fund_totals(period=period)}


@router.post("/{period}/lock")
async def lock(
    period: str,
    ctx: TenantContext = Depends(require("closing:run", module=_MODULE)),
):
    lock_repo = ClosingLockRepository(tenant_id=ctx.tenant_id)
    if await lock_repo.is_locked(period=period):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            detail={"error": "period_already_locked", "period": period})
    return await lock_repo.lock(period=period, actor_user_id=ctx.user_id)
