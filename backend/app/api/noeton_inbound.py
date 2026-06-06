"""Inbound endpoints Noeton → RxVision (mounted at app root, not under /api/v1).

REST push endpoints are gated by X-API-Key (== configured inbound_key); the webhook
receiver verifies HMAC-SHA256. Deactivation = suspend (never deletes data).
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status

from app.services import noeton
from app.services.provisioning import ProvisioningError, TenantProvisioningService

router = APIRouter()


async def require_noeton_key(x_api_key: str | None = Header(None)) -> None:
    cfg = await noeton.get_config()
    if not noeton.verify_inbound_key(x_api_key, cfg.get("inbound_key", "")):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_api_key")


# ── Noeton → us (REST push) ────────────────────────────────
@router.post("/api/noeton/subscription", dependencies=[Depends(require_noeton_key)])
async def receive_subscription(body: dict):
    tenant = body.get("tenant_code")
    sub = body.get("subscription") or {}
    if not tenant:
        raise HTTPException(422, "tenant_code_required")
    await TenantProvisioningService().apply_subscription(tenant_code=tenant, subscription=sub)
    return {"ok": True, "message": "Subscription updated"}


@router.post("/api/noeton/tenant/activate", dependencies=[Depends(require_noeton_key)])
async def activate_tenant(body: dict):
    tenant = body.get("tenant_code")
    if not tenant:
        raise HTTPException(422, "tenant_code_required")
    res = await TenantProvisioningService().activate_from_noeton(
        tenant_code=tenant,
        subscription=body.get("subscription") or {},
        name=body.get("name"),
        contact_email=body.get("contact_email", ""),
        contact_phone=body.get("contact_phone", ""),
        country=body.get("country", "GR"),
        language=body.get("language", "el"),
        timezone=body.get("timezone", "Europe/Athens"),
        currency=body.get("currency", "EUR"),
        company=body.get("company"),
        store=body.get("store"),
    )
    return {"ok": True, "data": res}


@router.post("/api/noeton/tenant/deactivate", dependencies=[Depends(require_noeton_key)])
async def deactivate_tenant(body: dict):
    tenant = body.get("tenant_code")
    if not tenant:
        raise HTTPException(422, "tenant_code_required")
    try:
        await TenantProvisioningService().set_status(tenant_id=tenant, status="suspended")
    except ProvisioningError as e:
        raise HTTPException(404, str(e))
    return {"ok": True, "message": "Tenant deactivated"}


@router.post("/api/noeton/users", dependencies=[Depends(require_noeton_key)])
async def provision_user(body: dict):
    tenant = body.get("tenant_code")
    user = body.get("user") or {}
    if not tenant or not user.get("email"):
        raise HTTPException(422, "tenant_code_and_user_email_required")
    try:
        res = await TenantProvisioningService().provision_user(tenant_code=tenant, user=user)
    except ProvisioningError as e:
        raise HTTPException(404, str(e))
    return {"ok": True, "data": res}


@router.get("/api/noeton/users", dependencies=[Depends(require_noeton_key)])
async def pull_users(tenant_code: str, since: str | None = None):
    since_dt = None
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(422, "bad_since")
    users = await TenantProvisioningService().list_users(tenant_code=tenant_code, since=since_dt)
    return {"ok": True, "data": {"users": users, "total": len(users)}}


# ── webhook receiver (HMAC) ────────────────────────────────
@router.post("/api/noeton/webhooks")
async def webhooks(request: Request,
                   x_noeton_signature: str | None = Header(None),
                   x_timestamp: str | None = Header(None)):
    body = await request.body()
    cfg = await noeton.get_config()
    if not noeton.verify_webhook(body, cfg.get("webhook_secret", ""),
                                 x_noeton_signature or "", x_timestamp or ""):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_signature")
    event = await request.json()
    etype = event.get("event_type")
    data = event.get("data") or {}
    svc = TenantProvisioningService()
    # authoritative state arrives via the push endpoints; webhooks are notifications.
    # We act on the unambiguous lifecycle ones for resilience.
    tenant = data.get("tenant_code")
    if tenant and etype in ("SubscriptionSuspended", "SubscriptionCancelled", "SubscriptionExpired"):
        try:
            await svc.set_status(tenant_id=tenant, status="suspended")
        except ProvisioningError:
            pass
    elif tenant and etype in ("SubscriptionReactivated", "SubscriptionActivated", "SubscriptionRenewed"):
        try:
            await svc.set_status(tenant_id=tenant, status="active")
        except ProvisioningError:
            pass
    return {"ok": True, "event_type": etype}
