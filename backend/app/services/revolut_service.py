"""Revolut Merchant API — subscription billing for RxVision.

Model (self-managed recurring, so we control trial + dunning):
  1. signup → save the card (tokenize, no charge) → store customer_id on the subscription;
  2. a daily Celery task charges off-session when trial/period ends (€45/mo or €380/yr);
  3. webhooks confirm results; repeated failure → auto-deactivate the tenant.

Credentials live in platform_settings._id='revolut' (api_key, mode=sandbox|live, webhook_secret) —
entered in admin like the cloud tokens, never in git/logs.
"""

from __future__ import annotations

import hashlib
import hmac

import httpx

from app.core.db import shared_db

API_VERSION = "2024-09-01"
_LIVE = "https://merchant.revolut.com/api"
_SANDBOX = "https://sandbox-merchant.revolut.com/api"


async def config() -> dict:
    return await shared_db()["platform_settings"].find_one({"_id": "revolut"}) or {}


async def _client() -> tuple[str | None, str | None]:
    cfg = await config()
    key = cfg.get("api_key")
    if not key:
        return None, None
    base = _LIVE if cfg.get("mode") == "live" else _SANDBOX
    return base, key


def _headers(key: str) -> dict:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json",
            "Revolut-Api-Version": API_VERSION}


async def is_configured() -> bool:
    base, key = await _client()
    return bool(base and key)


async def create_save_card_order(*, amount: int, currency: str, email: str, name: str,
                                 tenant_id: str, description: str) -> dict:
    """Create an order that tokenizes the customer's card for future off-session charges.
    Returns {ok, token, order_id} (token → Revolut Checkout widget) or {ok: False, error}."""
    base, key = await _client()
    if not base:
        return {"ok": False, "error": "revolut_not_configured"}
    payload = {
        "amount": int(amount), "currency": currency, "capture_mode": "manual",
        "description": description,
        "merchant_order_data": {"reference": tenant_id},
        "customer": {"email": email, "full_name": name},
        "save_payment_method_for": "merchant",
    }
    try:
        async with httpx.AsyncClient(timeout=20) as cl:
            r = await cl.post(f"{base}/orders", headers=_headers(key), json=payload)
            r.raise_for_status()
            d = r.json()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"revolut_error:{type(e).__name__}"}
    return {"ok": True, "token": d.get("token"), "order_id": d.get("id"),
            "customer_id": (d.get("customer") or {}).get("id")}


async def charge_off_session(*, amount: int, currency: str, customer_id: str,
                             tenant_id: str, description: str) -> dict:
    """Charge a saved customer off-session (renewal). Returns {ok, order_id, state} / {ok: False}."""
    base, key = await _client()
    if not base:
        return {"ok": False, "error": "revolut_not_configured"}
    payload = {
        "amount": int(amount), "currency": currency, "capture_mode": "automatic",
        "customer": {"id": customer_id}, "off_session": True,
        "merchant_order_data": {"reference": tenant_id},
        "description": description,
    }
    try:
        async with httpx.AsyncClient(timeout=25) as cl:
            r = await cl.post(f"{base}/orders", headers=_headers(key), json=payload)
            r.raise_for_status()
            d = r.json()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"revolut_error:{type(e).__name__}"}
    state = d.get("state")
    return {"ok": state in ("completed", "authorised", "pending"), "order_id": d.get("id"), "state": state}


async def get_order(order_id: str) -> dict | None:
    base, key = await _client()
    if not base:
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as cl:
            r = await cl.get(f"{base}/orders/{order_id}", headers=_headers(key))
            r.raise_for_status()
            return r.json()
    except Exception:  # noqa: BLE001
        return None


def verify_webhook(secret: str | None, payload: bytes, signature: str | None, timestamp: str | None) -> bool:
    """Revolut webhook HMAC-SHA256 over `v1.{timestamp}.{raw-body}` → `v1=<hex>`."""
    if not secret or not signature or not timestamp:
        return False
    msg = f"v1.{timestamp}.".encode() + payload
    expected = "v1=" + hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
