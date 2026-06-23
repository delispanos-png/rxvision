"""Ingestion tasks — automated ΗΔΥΚΑ sync (GR), wired to the shared engine.

Celery runs sync code, while the engine is async (Motor). Each task spins a fresh
event loop + Motor client (clients are loop-bound) and runs the engine on it.

Beat fans `dispatch_incremental_sync` out to every GR tenant with ΗΔΥΚΑ credentials
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


def _history_floor(creds: dict):
    """Earliest allowed sync date (Άντληση ιστορικού από) — caps how far back we pull."""
    s = (creds or {}).get("history_from")
    if not s:
        return None
    try:
        return datetime.strptime(str(s)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


async def _watermark(db, tenant_id: str) -> datetime:
    last = await db["prescription_executions"].find_one(
        {"tenant_id": tenant_id, "source": "HDIKA"}, sort=[("executed_at", -1)])
    floor = _history_floor(vault.get_secret(f"tenants/{tenant_id}/hdika") or {})
    if last and last.get("executed_at"):
        wm = last["executed_at"] - timedelta(days=1)
        return max(wm, floor) if floor else wm
    return floor or datetime(2024, 1, 1, tzinfo=timezone.utc)


@celery_app.task(name="app.workers.ingestion.dispatch_incremental_sync")
def dispatch_incremental_sync() -> int:
    """Beat-scheduled. Enqueue an incremental sync per GR tenant with ΗΔΥΚΑ creds."""
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


@celery_app.task(name="app.workers.ingestion.dispatch_cancellation_reconcile")
def dispatch_cancellation_reconcile() -> int:
    """Beat-scheduled (daily). Enqueue a cancelled-prescriptions reconciliation per GR tenant."""
    async def _run() -> list[str]:
        client, db = _fresh_db()
        try:
            return [str(t["_id"]) async for t in db["tenants"].find(
                {"country": "GR", "status": {"$in": ["active", "trial"]},
                 "credentials_ref.hdika": {"$ne": None},
                 "ingestion_config.hdika.sync_enabled": {"$ne": False}}, {"_id": 1})]
        finally:
            client.close()

    tenant_ids = asyncio.run(_run())
    for tid in tenant_ids:
        reconcile_cancellations_task.delay(tid)
    return len(tenant_ids)


@celery_app.task(name="app.workers.ingestion.reconcile_cancellations",
                 bind=True, max_retries=3, autoretry_for=(ConnectionError, TimeoutError),
                 retry_backoff=True, retry_backoff_max=1800, retry_jitter=True)
def reconcile_cancellations_task(self, tenant_id: str) -> dict:
    """Reconcile one tenant's cancelled prescriptions vs ΗΔΥΚΑ (real run, guarded)."""
    async def _run() -> dict:
        client, db = _fresh_db()
        try:
            from app.services.ingestion.cancellations import reconcile_tenant
            return await reconcile_tenant(tenant_id, db=db, dry_run=False)
        finally:
            client.close()
    return asyncio.run(_run())


def _gr_hdika_tenants(db):
    return db["tenants"].find(
        {"country": "GR", "status": {"$in": ["active", "trial"]},
         "credentials_ref.hdika": {"$ne": None},
         "ingestion_config.hdika.sync_enabled": {"$ne": False}}, {"_id": 1})


def _dispatch_deep(days: int) -> int:
    async def _run() -> list[str]:
        client, db = _fresh_db()
        try:
            return [str(t["_id"]) async for t in _gr_hdika_tenants(db)]
        finally:
            client.close()
    ids = asyncio.run(_run())
    for tid in ids:
        deep_reconcile_task.delay(tid, days)
    return len(ids)


@celery_app.task(name="app.workers.ingestion.dispatch_deep_reconcile_daily")
def dispatch_deep_reconcile_daily() -> int:
    """Beat (daily): deep-reconcile a short window — re-download today's executions + cancel gone ones."""
    return _dispatch_deep(2)


@celery_app.task(name="app.workers.ingestion.dispatch_deep_reconcile_weekly")
def dispatch_deep_reconcile_weekly() -> int:
    """Beat (weekly): deep-reconcile 35 days back — catches late cancellations/re-executions."""
    return _dispatch_deep(35)


@celery_app.task(name="app.workers.ingestion.deep_reconcile",
                 bind=True, max_retries=2, autoretry_for=(ConnectionError, TimeoutError),
                 retry_backoff=True, retry_backoff_max=1800, retry_jitter=True)
def deep_reconcile_task(self, tenant_id: str, days: int) -> dict:
    """Re-download the window (correct changed lines/amounts) + cancel ones ΗΔΥΚΑ no longer returns."""
    async def _run() -> dict:
        client, db = _fresh_db()
        try:
            from app.services.ingestion.cancellations import deep_reconcile_tenant
            return await deep_reconcile_tenant(tenant_id, db=db, days=days, dry_run=False)
        finally:
            client.close()
    return asyncio.run(_run())


@celery_app.task(name="app.workers.ingestion.dispatch_influenza_sync")
def dispatch_influenza_sync() -> int:
    """Beat-scheduled (daily). Enqueue a flu-vaccination sync per GR tenant with ΗΔΥΚΑ creds."""
    async def _run() -> list[str]:
        client, db = _fresh_db()
        try:
            return [str(t["_id"]) async for t in db["tenants"].find(
                {"country": "GR", "status": {"$in": ["active", "trial"]},
                 "credentials_ref.hdika": {"$ne": None},
                 "ingestion_config.hdika.sync_enabled": {"$ne": False}}, {"_id": 1})]
        finally:
            client.close()
    tenant_ids = asyncio.run(_run())
    for tid in tenant_ids:
        influenza_sync_task.delay(tid)
    return len(tenant_ids)


@celery_app.task(name="app.workers.ingestion.influenza_sync",
                 bind=True, max_retries=3, autoretry_for=(ConnectionError, TimeoutError),
                 retry_backoff=True, retry_backoff_max=1800, retry_jitter=True)
def influenza_sync_task(self, tenant_id: str) -> dict:
    """Sync one tenant's seasonal-flu vaccinations from the ΗΔΥΚΑ Influenza Registry."""
    async def _run() -> dict:
        client, db = _fresh_db()
        try:
            from app.services.ingestion.influenza import sync_influenza
            return await sync_influenza(tenant_id, db=db, dry_run=False)
        finally:
            client.close()
    return asyncio.run(_run())


@celery_app.task(
    name="app.workers.ingestion.hdika_incremental_sync",
    bind=True, max_retries=5, autoretry_for=(ConnectionError, TimeoutError),
    retry_backoff=True, retry_backoff_max=3600, retry_jitter=True,
)
def hdika_incremental_sync(self, tenant_id: str) -> dict:
    """Pull new ΗΔΥΚΑ executions since the last watermark; idempotent."""
    async def _run() -> dict:
        client, db = _fresh_db()
        try:
            creds = dict(vault.get_secret(f"tenants/{tenant_id}/hdika") or {})
            # merge platform ΗΔΥΚΑ config (production base_url; shared sandbox in test)
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
            creds.setdefault("throttle", 0.1)        # gentle on ΗΔΥΚΑ
            since = await _watermark(db, tenant_id)
            now = datetime.now(tz=timezone.utc)
            records = HdikaAdapter(creds).fetch(since=since)
            job = await IngestionEngine(tenant_id, db=db).ingest(
                source="HDIKA", job_type="incremental", records=records,
                window=(since, now), task_id=self.request.id)
            return {"tenant_id": tenant_id, "status": job["status"], "stats": job["stats"]}
        finally:
            client.close()

    return asyncio.run(_run())


@celery_app.task(name="app.workers.ingestion.hdika_backfill", bind=True,
                 acks_late=False, max_retries=0)
def hdika_backfill(self, tenant_id: str, since_iso: str, until_iso: str | None = None,
                   throttle: float = 0.08) -> dict:
    """Historical ΗΔΥΚΑ ingest for the window [`since_iso`, `until_iso`] (until defaults
    to today), recent-first, in the worker's own Celery process so it survives. Idempotent."""
    from app.services.ingestion.hdika_catalog import load_catalog_map

    async def _run() -> dict:
        client, db = _fresh_db()
        try:
            # Guard: never run two backfills for one tenant at once (they'd race over the
            # same window). Skip if one is already running with a live heartbeat (<10min).
            from datetime import datetime as _dt
            fresh = _dt.now(tz=timezone.utc) - timedelta(minutes=10)
            busy = await db["sync_jobs"].find_one(
                {"tenant_id": tenant_id, "type": "backfill", "status": "running",
                 "updated_at": {"$gte": fresh}})
            if busy:
                return {"tenant_id": tenant_id, "status": "skipped",
                        "note": "backfill already running"}
            creds = dict(vault.get_secret(f"tenants/{tenant_id}/hdika") or {})
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
            creds["throttle"] = throttle
            cat = await load_catalog_map(db)
            since = datetime.fromisoformat(since_iso)
            if since.tzinfo is None:
                since = since.replace(tzinfo=timezone.utc)
            until = datetime.now(tz=timezone.utc)
            if until_iso:
                until = datetime.fromisoformat(until_iso)
                if until.tzinfo is None:
                    until = until.replace(tzinfo=timezone.utc)
            records = HdikaAdapter(creds, catalog=cat).fetch(since=since, until=until)
            job = await IngestionEngine(tenant_id, db=db).ingest(
                source="HDIKA", job_type="backfill", records=records, window=(since, until),
                task_id=self.request.id)
            return {"tenant_id": tenant_id, "status": job["status"], "stats": job["stats"]}
        finally:
            client.close()

    return asyncio.run(_run())


@celery_app.task(name="app.workers.ingestion.reap_stalled_sync")
def reap_stalled_sync(stall_minutes: int = 5) -> dict:
    """Watchdog (beat). A healthy sync writes a heartbeat (`updated_at`) every 20 records.
    If a 'running' job hasn't progressed for >`stall_minutes`, its worker is stuck →
    KILL the Celery task (SIGKILL, no redelivery) and mark the job failed."""
    async def _run() -> dict:
        client, db = _fresh_db()
        try:
            cutoff = datetime.now(tz=timezone.utc) - timedelta(minutes=stall_minutes)
            killed: list[str] = []
            cursor = db["sync_jobs"].find(  # tenant-ok: platform stalled-job watchdog (all tenants)
                {"status": "running", "$or": [
                    {"updated_at": {"$lt": cutoff}},
                    {"updated_at": {"$exists": False}, "started_at": {"$lt": cutoff}}]})
            async for j in cursor:
                tid = j.get("task_id")
                if tid:
                    # terminate the running task + revoke so acks_late can't redeliver it
                    celery_app.control.revoke(tid, terminate=True, signal="SIGKILL")
                await db["sync_jobs"].update_one(
                    {"_id": j["_id"]},
                    {"$set": {"status": "failed", "finished_at": datetime.now(tz=timezone.utc),
                              "error": f"stalled (no progress >{stall_minutes}min) — killed by watchdog"}})
                killed.append(str(j["_id"]))
            return {"killed": killed, "count": len(killed)}
        finally:
            client.close()

    return asyncio.run(_run())


@celery_app.task(name="app.workers.ingestion.gesy_xml_ingest")
def gesy_xml_ingest(tenant_id: str, object_ref: str) -> dict:
    """ΓΕΣΥ (CY) — step 2. Parse stored XML via the same engine. Placeholder."""
    return {"tenant_id": tenant_id, "status": "stub", "note": "GESY automation = step 2"}
