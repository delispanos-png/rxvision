"""Ingestion tasks — automated ΗΔΙΚΑ sync (GR), wired to the shared engine.

Celery runs sync code, while the engine is async (Motor). Each task spins a fresh
event loop + Motor client (clients are loop-bound) and runs the engine on it.

Beat fans `dispatch_incremental_sync` out to every GR tenant with ΗΔΙΚΑ credentials
configured; each runs an incremental sync. Idempotent via natural key + content hash.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorClient

from app.core.config import settings
from app.services.ingestion.engine import IngestionEngine
from app.services.ingestion.hdika import HdikaAdapter
from app.services.vault_service import vault
from app.workers.celery_app import celery_app


def _fresh_db():
    """A Motor client bound to the current (per-task) event loop."""
    client = AsyncIOMotorClient(settings.MONGODB_URI, tz_aware=True)
    return client, client[settings.MONGODB_DB]


async def _watermark(db, tenant_id: str) -> datetime:
    last = await db["prescription_executions"].find_one(
        {"tenant_id": tenant_id, "source": "HDIKA"}, sort=[("executed_at", -1)])
    if last and last.get("executed_at"):
        return last["executed_at"] - timedelta(days=1)
    return datetime(2024, 1, 1, tzinfo=timezone.utc)


@celery_app.task(name="app.workers.ingestion.dispatch_incremental_sync")
def dispatch_incremental_sync() -> int:
    """Beat-scheduled. Enqueue an incremental sync per GR tenant with ΗΔΙΚΑ creds."""
    async def _run() -> list[str]:
        client, db = _fresh_db()
        try:
            ids: list[str] = []
            cursor = db["tenants"].find(
                {"country": "GR", "status": {"$in": ["active", "trial"]},
                 "credentials_ref.hdika": {"$ne": None},
                 "ingestion_config.hdika.sync_enabled": {"$ne": False}},
                {"_id": 1})
            async for t in cursor:
                ids.append(str(t["_id"]))
            return ids
        finally:
            client.close()

    tenant_ids = asyncio.run(_run())
    for tid in tenant_ids:
        hdika_incremental_sync.delay(tid)
    return len(tenant_ids)


@celery_app.task(
    name="app.workers.ingestion.hdika_incremental_sync",
    bind=True, max_retries=5, autoretry_for=(ConnectionError, TimeoutError),
    retry_backoff=True, retry_backoff_max=3600, retry_jitter=True,
)
def hdika_incremental_sync(self, tenant_id: str) -> dict:
    """Pull new ΗΔΙΚΑ executions since the last watermark; idempotent."""
    async def _run() -> dict:
        client, db = _fresh_db()
        try:
            creds = dict(vault.get_secret(f"tenants/{tenant_id}/hdika") or {})
            # merge platform ΗΔΙΚΑ config (production base_url; shared sandbox in test)
            plat = await db["platform_settings"].find_one({"_id": "idika"})
            if plat:
                env = plat.get("active_environment", "test")
                envcfg = plat.get(env) or {}
                if envcfg.get("base_url"):
                    creds["base_url"] = envcfg["base_url"]
                creds["environment"] = env
                if env == "test":
                    for src, dst in (("integrator_username", "username"),
                                     ("integrator_password", "password"),
                                     ("api_key", "api_key"), ("pharmacy_id", "pharmacy_id")):
                        if envcfg.get(src):
                            creds[dst] = envcfg[src]
            creds.setdefault("throttle", 0.1)        # gentle on ΗΔΙΚΑ
            since = await _watermark(db, tenant_id)
            now = datetime.now(tz=timezone.utc)
            records = HdikaAdapter(creds).fetch(since=since)
            job = await IngestionEngine(tenant_id, db=db).ingest(
                source="HDIKA", job_type="incremental", records=records,
                window=(since, now))
            return {"tenant_id": tenant_id, "status": job["status"], "stats": job["stats"]}
        finally:
            client.close()

    return asyncio.run(_run())


@celery_app.task(name="app.workers.ingestion.gesy_xml_ingest")
def gesy_xml_ingest(tenant_id: str, object_ref: str) -> dict:
    """ΓΕΣΥ (CY) — step 2. Parse stored XML via the same engine. Placeholder."""
    return {"tenant_id": tenant_id, "status": "stub", "note": "GESY automation = step 2"}
