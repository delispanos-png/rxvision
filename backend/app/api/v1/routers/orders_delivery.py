"""Order & delivery circuit — pharmacist side (incoming orders worklist + delivery settings).
Gated by the `order_delivery` module."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core.deps import TenantContext, require
from app.repositories.orders_delivery import OrdersDeliveryRepository

router = APIRouter()
_MODULE = "order_delivery"
_PERM = "portal:manage"


def _repo(ctx: TenantContext) -> OrdersDeliveryRepository:
    return OrdersDeliveryRepository(tenant_id=ctx.tenant_id)


@router.get("")
async def list_orders(status: str | None = None,
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await _repo(ctx).list_orders(status=status)}


@router.get("/pending")
async def pending(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Count for the top-bar bell (new + preparing orders)."""
    return {"count": await _repo(ctx).pending_count()}


class StatusIn(BaseModel):
    status: str


@router.post("/{order_id}/status")
async def set_status(order_id: str, body: StatusIn,
                     ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).set_status(order_id, body.status)


@router.get("/settings")
async def get_settings(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).settings()


class SettingsIn(BaseModel):
    delivery_enabled: bool = True
    pickup_enabled: bool = True
    delivery_fee_cents: int = Field(250, ge=0)
    free_over_cents: int = Field(0, ge=0)
    min_order_cents: int = Field(0, ge=0)
    pps_cert: str = ""


@router.post("/settings")
async def save_settings(body: SettingsIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).save_settings(body.model_dump())
