"""Subscriptions / billing router — current plan, usage, checkout."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import TenantContext, get_current_context, require
from app.repositories.subscriptions import SubscriptionRepository
from app.schemas.subscriptions import CheckoutIn, CheckoutOut

router = APIRouter()


@router.get("")
async def get_subscription(ctx: TenantContext = Depends(get_current_context)):
    repo = SubscriptionRepository(tenant_id=ctx.tenant_id)
    sub = await repo.current()
    if sub is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no_subscription")
    return sub


@router.get("/usage")
async def usage(ctx: TenantContext = Depends(get_current_context)):
    repo = SubscriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.usage()


@router.post("/checkout", response_model=CheckoutOut)
async def checkout(
    body: CheckoutIn,
    ctx: TenantContext = Depends(require("billing:manage")),
):
    repo = SubscriptionRepository(tenant_id=ctx.tenant_id)
    await repo.set_checkout_pending(plan=body.plan, seats=body.seats, addons=body.addons)
    # TODO: create a real payment-provider checkout session and return its URL.
    return CheckoutOut(
        checkout_url=f"https://billing.rxvision.gr/checkout/{ctx.tenant_id}",
        plan=body.plan,
        status="pending_checkout",
    )
