"""Noeton outbound automation — heartbeat, subscription sync, usage reporting.

All tasks no-op silently if Noeton isn't configured (no api_key). Subscription sync
keeps local status fresh from Noeton (so login uses local state, never blocks on an
external call). Per-call failures are swallowed so one bad tenant can't stall the batch.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.services.noeton import NoetonClient, get_config
from app.services.provisioning import TenantProvisioningService
from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.noeton.heartbeat")
def heartbeat() -> str:
    async def _run() -> str:
        cfg = await get_config()
        if not cfg.get("api_key"):
            return "noeton_not_configured"
        await NoetonClient(cfg).heartbeat()
        return "ok"
    return asyncio.run(_run())


@celery_app.task(name="app.workers.noeton.sync_subscriptions")
def sync_subscriptions() -> int:
    """Validate each Noeton-sourced tenant's subscription and apply locally."""
    async def _run() -> int:
        cfg = await get_config()
        if not cfg.get("api_key"):
            return 0
        client, svc, db = NoetonClient(cfg), TenantProvisioningService(), shared_db()
        n = 0
        async for sub in db["subscriptions"].find({"source": "noeton"}):
            code = sub["tenant_id"]
            try:
                remote = await client.validate_subscription(code)
                if remote:
                    await svc.apply_subscription(tenant_code=code, subscription=remote)
                else:
                    await svc.set_status(tenant_id=code, status="suspended")
                n += 1
            except Exception:  # noqa: BLE001 — one tenant must not stall the batch
                continue
        return n
    return asyncio.run(_run())


@celery_app.task(name="app.workers.noeton.report_usage")
def report_usage() -> int:
    """Send daily usage metrics per Noeton tenant (active users, rx processed)."""
    async def _run() -> int:
        cfg = await get_config()
        if not cfg.get("api_key"):
            return 0
        client, db = NoetonClient(cfg), shared_db()
        now = datetime.now(tz=timezone.utc)
        start = now - timedelta(days=1)
        n = 0
        async for sub in db["subscriptions"].find({"source": "noeton"}):
            code = sub["tenant_id"]
            users = await db["users"].count_documents({"tenant_id": code, "status": "active"})
            rx = await db["prescription_executions"].count_documents(
                {"tenant_id": code, "executed_at": {"$gte": start}})
            try:
                await client.usage_report(
                    tenant_code=code, period_start=start.isoformat(), period_end=now.isoformat(),
                    metrics={"active_users": users, "prescriptions_processed": rx})
                n += 1
            except Exception:  # noqa: BLE001
                continue
        return n
    return asyncio.run(_run())
