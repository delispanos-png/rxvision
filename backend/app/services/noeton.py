"""Noeton integration — config, webhook HMAC verification, outbound client.

Noeton is the Master Controller; RxVision is a Slave product. Two directions:
  • Noeton → us: REST push (X-API-Key = inbound_key) + webhooks (HMAC-SHA256).
  • us → Noeton: REST calls with X-API-Key = api_key, to base_url.

Config (base_url, api_key, inbound_key, webhook_secret) lives in platform_settings
_id="noeton"; secrets never leave via GET.
"""

from __future__ import annotations

import hashlib
import hmac
import time

import httpx

from app.core.db import shared_db

_DEFAULT_BASE = "https://admin.noeton.eu/api/v1/external"
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
PRODUCT_CODE = "rxvision"   # we only ever sync THIS product (a tenant may own others)


async def get_config() -> dict:
    return await shared_db()["platform_settings"].find_one({"_id": "noeton"}) or {}


def verify_webhook(body: bytes, secret: str, signature_header: str, timestamp_header: str) -> bool:
    """HMAC-SHA256 webhook verification (per Noeton spec): fresh timestamp (<5min)
    + constant-time signature compare over the raw body."""
    if not secret or not signature_header or not timestamp_header:
        return False
    try:
        ts = int(timestamp_header)
    except (TypeError, ValueError):
        return False
    if abs(time.time() - ts) > 300:
        return False
    provided = signature_header.replace("sha256=", "")
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(provided, expected)


def verify_inbound_key(provided: str | None, inbound_key: str) -> bool:
    """Validate the X-API-Key Noeton sends when calling our REST push endpoints."""
    if not inbound_key or not provided:
        return False
    return hmac.compare_digest(provided, inbound_key)


class NoetonClient:
    """Outbound calls RxVision → Noeton (X-API-Key auth)."""

    def __init__(self, config: dict) -> None:
        self.base = (config.get("base_url") or _DEFAULT_BASE).rstrip("/")
        self.api_key = config.get("api_key", "")

    def _headers(self) -> dict:
        return {"X-API-Key": self.api_key, "Content-Type": "application/json"}

    async def _request(self, method: str, path: str, **kw) -> dict:
        if not self.api_key:
            raise RuntimeError("noeton_not_configured")
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.request(method, f"{self.base}{path}", headers=self._headers(), **kw)
            r.raise_for_status()
            return r.json() if r.content else {}

    async def validate_subscription(self, tenant_code: str) -> dict | None:
        """Returns the tenant's RxVision subscription (None if inactive). Scoped to our
        product — if Noeton ever returns another product_code, we ignore it."""
        data = await self._request("GET", "/subscription/validate",
                                    params={"tenant_code": tenant_code})
        if data.get("product_code") and data["product_code"] != PRODUCT_CODE:
            return None
        return data.get("subscription")

    async def heartbeat(self) -> dict:
        return await self._request("POST", "/heartbeat")

    async def register_user(self, *, tenant_code: str, email: str, first_name: str,
                            last_name: str, role: str, external_user_id: str | None = None) -> dict:
        return await self._request("POST", "/users/register", json={
            "tenant_code": tenant_code, "email": email, "first_name": first_name,
            "last_name": last_name, "role": role, "external_user_id": external_user_id})

    async def sync_users(self, users: list[dict]) -> dict:
        return await self._request("POST", "/users/sync", json=users)

    async def usage_report(self, *, tenant_code: str, period_start: str, period_end: str,
                           metrics: dict) -> dict:
        return await self._request("POST", "/usage/report", json={
            "tenant_code": tenant_code, "period_start": period_start,
            "period_end": period_end, "metrics": metrics})

    async def send_event(self, *, event_type: str, tenant_code: str | None = None,
                         severity: str = "info", message: str = "", data: dict | None = None) -> dict:
        return await self._request("POST", "/events", json={
            "event_type": event_type, "tenant_code": tenant_code, "severity": severity,
            "message": message, "data": data or {}})

    async def get_product_config(self, *, product_code: str, tenant_code: str) -> dict:
        return await self._request("GET", f"/products/{product_code}/config",
                                   params={"tenant_code": tenant_code})
