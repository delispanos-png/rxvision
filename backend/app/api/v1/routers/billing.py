"""Billing router — Revolut card capture, subscription status, and the Revolut webhook."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pymongo.errors import DuplicateKeyError

from fastapi.responses import JSONResponse

from app.core.db import shared_db
from app.core.deps import TenantContext, get_current_context
from app.services import billing_service, revolut_service, viva_service

router = APIRouter()


@router.get("/webhook/viva")
async def viva_webhook_verify():
    """Viva GET-verification handshake — επιστρέφει {"Key": ...} από τον λογαριασμό Viva."""
    key = await viva_service.webhook_verification_key()
    return JSONResponse({"Key": key or ""})


@router.post("/webhook/viva")
async def viva_webhook(request: Request):
    """Viva event webhook (Transaction Payment Created) → επιβεβαίωση & αποθήκευση recurring seed.
    Δεν υπάρχει HMAC· εμπιστευόμαστε ΜΟΝΟ μετά από re-fetch της συναλλαγής (γίνεται στο service)."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return {"ok": True}
    ev = body.get("EventData") or body.get("eventData") or {}
    if ev:
        await billing_service.handle_viva_webhook(ev)
    return {"ok": True}


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
    # Replay protection: the HMAC signature is deterministic over (timestamp, body), so a replayed
    # delivery carries the IDENTICAL signature. Dedup on it (unique _id + 24h TTL) so replaying e.g. an
    # ORDER_PAYMENT_FAILED event can't repeatedly bump failed_attempts → auto-suspend the tenant (DoS).
    dedup_key = hashlib.sha256(f"{timestamp}:{signature}".encode()).hexdigest()
    try:
        await shared_db()["webhook_dedup"].insert_one(
            {"_id": dedup_key, "at": datetime.now(tz=timezone.utc)})
    except DuplicateKeyError:
        return {"ok": True, "replay_ignored": True}
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
