"""Billing router — Revolut card capture, subscription status, and the Revolut webhook."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status

from app.core.deps import TenantContext, get_current_context
from app.services import billing_service, revolut_service

router = APIRouter()


@router.post("/card-capture")
async def card_capture(ctx: TenantContext = Depends(get_current_context)):
    """Start Revolut card capture for the current tenant → {ok, token} for the checkout widget."""
    return await billing_service.start_card_capture(ctx.tenant_id)


@router.get("/status")
async def billing_status(ctx: TenantContext = Depends(get_current_context)):
    """Subscription + payment status for the current tenant."""
    return await billing_service.status(ctx.tenant_id)


@router.post("/webhook/revolut")
async def revolut_webhook(
    request: Request,
    signature: str | None = Header(None, alias="Revolut-Signature"),
    timestamp: str | None = Header(None, alias="Revolut-Request-Timestamp"),
):
    """Public Revolut webhook — HMAC-verified; updates billing state / auto-suspends on failure."""
    raw = await request.body()
    cfg = await revolut_service.config()
    if not revolut_service.verify_webhook(cfg.get("webhook_secret"), raw, signature, timestamp):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad_signature")
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_payload")
    event = body.get("event")
    order_id = body.get("order_id") or (body.get("order") or {}).get("id")
    order = await revolut_service.get_order(order_id) if order_id else (body.get("order") or {})
    if order:
        await billing_service.handle_webhook(event, order)
    return {"ok": True}
