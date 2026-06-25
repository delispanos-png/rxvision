"""Ingestion tasks — automated ΗΔΥΚΑ sync (GR), wired to the shared engine.

Celery runs sync code, while the engine is async (Motor). Each task spins a fresh
event loop + Motor client (clients are loop-bound) and runs the engine on it.

Beat fans `dispatch_incremental_sync` out to every GR tenant with ΗΔΥΚΑ credentials
configured; each runs an incremental sync. Idempotent via natural key + content hash.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import redis as _redis
from motor.motor_asyncio import AsyncIOMotorClient

from app.core.config import settings
from app.services.ingestion.engine import IngestionEngine
from app.services.ingestion.hdika import HdikaAdapter
from app.services.vault_service import vault
from app.workers.celery_app import celery_app


# ── Pool reuse: ΕΝΑ persistent event loop + ΕΝΑΣ Motor client ΑΝΑ worker process ──────────────
# Πριν: κάθε task έφτιαχνε νέο loop (asyncio.run) + νέο Motor pool → connection churn με πολλούς
# tenants. Τώρα: persistent loop ανά process· ο Motor client δένεται σε αυτό & επαναχρησιμοποιείται.
_LOOP = None
_MOTOR = None


def _run_async(coro):
    """Τρέξε coroutine σε persistent per-process loop (αντί asyncio.run που φτιάχνει/κλείνει loop)."""
    global _LOOP, _MOTOR
    if _LOOP is None or _LOOP.is_closed():
        _LOOP = asyncio.new_event_loop()
        asyncio.set_event_loop(_LOOP)
        _MOTOR = None        # ο Motor client δένεται στο loop — νέο loop ⇒ νέος client
    return _LOOP.run_until_complete(coro)


class _NoClose:
    """Proxy ώστε τα υπάρχοντα `client.close()` στα tasks να μη κλείνουν τον ΚΟΙΝΟ client."""
    def close(self):
        pass


def _fresh_db():
    """Επιστρέφει τον ΚΟΙΝΟ (persistent) Motor client + db. Ο client δένεται στο persistent loop
    την πρώτη φορά και επαναχρησιμοποιείται — όχι νέο pool ανά task."""
    global _MOTOR
    if _MOTOR is None:
        _MOTOR = AsyncIOMotorClient(settings.MONGODB_URI, tz_aware=True)
    return _NoClose(), _MOTOR[settings.MONGODB_DB]


def _sync_lock(key: str, ttl: int):
    """Best-effort per-tenant lock (Redis SET NX EX) so the 5-min beat never stacks two
    concurrent syncs for the SAME tenant. Returns (acquired: bool, release: callable). If Redis
    is unreachable we fail OPEN (allow the sync) — availability over the optimisation."""
    try:
        r = _redis.from_url(settings.REDIS_URL)
        got = bool(r.set(key, "1", nx=True, ex=ttl))
    except Exception:  # noqa: BLE001
        return True, (lambda: None)

    def _release():
        try:
            r.delete(key)
            r.close()
        except Exception:  # noqa: BLE001
            pass

    if not got:
        try:
            r.close()
        except Exception:  # noqa: BLE001
            pass
    return got, _release


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

    tenant_ids = _run_async(_run())
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

    tenant_ids = _run_async(_run())
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
    return _run_async(_run())


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
    ids = _run_async(_run())
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
    return _run_async(_run())


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
    tenant_ids = _run_async(_run())
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
    return _run_async(_run())


@celery_app.task(
    name="app.workers.ingestion.hdika_incremental_sync",
    bind=True, max_retries=5, autoretry_for=(ConnectionError, TimeoutError),
    retry_backoff=True, retry_backoff_max=3600, retry_jitter=True,
    # Backstop: ένα incremental είναι πλέον λεπτά (parallel CDA). Αν ξεπεράσει 30′ κάτι πάει στραβά →
    # σκοτώνεται (το lock ελευθερώνεται στο finally) & ξανατρέχει στο επόμενο beat. Τα backfills ΔΕΝ
    # έχουν αυτό το όριο (τρέχουν στο δικό τους task/queue).
    soft_time_limit=1800, time_limit=2100,
)
def hdika_incremental_sync(self, tenant_id: str) -> dict:
    """Pull new ΗΔΥΚΑ executions since the last watermark; idempotent."""
    # Per-tenant lock: if a previous sync for this tenant is still running (slow ΗΔΥΚΑ / big
    # window), SKIP this beat instead of stacking a duplicate concurrent sync.
    acquired, _release_lock = _sync_lock(f"hdika:sync:lock:{tenant_id}", ttl=7200)
    if not acquired:
        return {"tenant_id": tenant_id, "status": "skipped", "note": "sync already running"}

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

    try:
        return _run_async(_run())
    finally:
        _release_lock()


@celery_app.task(name="app.workers.ingestion.hdika_backfill", bind=True,
                 acks_late=False, max_retries=0)
def hdika_backfill(self, tenant_id: str, since_iso: str, until_iso: str | None = None,
                   throttle: float = 0.08, continue_floor_iso: str | None = None) -> dict:
    """Historical ΗΔΥΚΑ ingest for the window [`since_iso`, `until_iso`] (until defaults
    to today), recent-first, in the worker's own Celery process so it survives. Idempotent.

    If `continue_floor_iso` is set, the backfill SELF-CHAINS: after this 400-day chunk it checks
    whether older data was fetched and, if there is still history above the floor, re-enqueues the
    next older chunk. The «resume cursor» is min(executed_at) — re-triggering always continues from
    where it stopped, even after an interruption. Stops when no older data exists or the floor is hit."""
    from app.services.ingestion.hdika_catalog import load_catalog_map

    async def _oldest(db) -> datetime | None:
        d = await db["prescription_executions"].find_one(
            {"tenant_id": tenant_id}, sort=[("executed_at", 1)], projection={"executed_at": 1})
        return d.get("executed_at") if d else None

    async def _run() -> dict:
        client, db = _fresh_db()
        try:
            before_min = await _oldest(db)
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
            result = {"tenant_id": tenant_id, "status": job["status"], "stats": job["stats"]}
            # AUTO-CHAIN: αν ζητήθηκε ιστορική συνέχιση & κατεβάσαμε παλαιότερα δεδομένα και υπάρχει
            # ακόμη ιστορία πάνω από το floor → enqueue το επόμενο (παλαιότερο) chunk.
            if continue_floor_iso:
                floor = datetime.fromisoformat(continue_floor_iso)
                if floor.tzinfo is None:
                    floor = floor.replace(tzinfo=timezone.utc)
                new_min = await _oldest(db)
                progressed = (before_min is None) or (new_min and new_min < before_min)
                if (progressed and new_min and new_min.date() > floor.date()
                        and since.date() > floor.date()):
                    nxt_until = new_min
                    nxt_since = max(floor, nxt_until - timedelta(days=395))
                    hdika_backfill.apply_async(
                        (tenant_id, nxt_since.isoformat(), nxt_until.isoformat()),
                        kwargs={"throttle": throttle, "continue_floor_iso": continue_floor_iso})
                    result["continuing_from"] = nxt_since.date().isoformat()
                else:
                    result["historical_complete"] = True
            return result
        finally:
            client.close()

    return _run_async(_run())


@celery_app.task(name="app.workers.ingestion.hdika_backfill_continue", bind=True, max_retries=0)
def hdika_backfill_continue(self, tenant_id: str, floor_iso: str | None = None) -> dict:
    """Συνέχιση ιστορικής άντλησης από εκεί που σταμάτησε: κατεβάζει τα ΠΑΛΑΙΟΤΕΡΑ από όσα έχουμε,
    μέχρι το floor (default = history_from ή 01/01/2024). Resumable — ξεκινά πάντα από το τρέχον
    min(executed_at), οπότε ένα re-trigger μετά από διακοπή συνεχίζει χωρίς να ξαναρχίζει."""
    async def _seed():
        client, db = _fresh_db()
        try:
            floor = None
            if floor_iso:
                floor = datetime.fromisoformat(floor_iso)
            if floor is None:
                hf = (vault.get_secret(f"tenants/{tenant_id}/hdika") or {}).get("history_from")
                if hf:
                    floor = datetime.strptime(str(hf)[:10], "%Y-%m-%d")
            if floor is None:
                floor = datetime(2024, 1, 1)
            if floor.tzinfo is None:
                floor = floor.replace(tzinfo=timezone.utc)
            d = await db["prescription_executions"].find_one(
                {"tenant_id": tenant_id}, sort=[("executed_at", 1)], projection={"executed_at": 1})
            until = d.get("executed_at") if d else datetime.now(tz=timezone.utc)
            return floor, until
        finally:
            client.close()

    floor, until = _run_async(_seed())
    if until.date() <= floor.date():
        return {"tenant_id": tenant_id, "status": "already_complete",
                "note": f"data already reaches {floor.date().isoformat()}"}
    since = max(floor, until - timedelta(days=395))
    hdika_backfill.apply_async(
        (tenant_id, since.isoformat(), until.isoformat()),
        kwargs={"continue_floor_iso": floor.isoformat()})
    return {"tenant_id": tenant_id, "status": "started",
            "floor": floor.date().isoformat(), "first_chunk_from": since.date().isoformat(),
            "until": until.date().isoformat()}


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
                # Release the per-tenant lock — a SIGKILL/worker-restart never runs the task's
                # `finally`, so the lock (2h TTL) would otherwise block this tenant's syncs.
                ten = j.get("tenant_id")
                if ten:
                    try:
                        rr = _redis.from_url(settings.REDIS_URL)
                        rr.delete(f"hdika:sync:lock:{ten}")
                        rr.close()
                    except Exception:  # noqa: BLE001
                        pass
                await db["sync_jobs"].update_one(
                    {"_id": j["_id"]},
                    {"$set": {"status": "failed", "finished_at": datetime.now(tz=timezone.utc),
                              "error": f"stalled (no progress >{stall_minutes}min) — killed by watchdog"}})
                killed.append(str(j["_id"]))
            return {"killed": killed, "count": len(killed)}
        finally:
            client.close()

    return _run_async(_run())


@celery_app.task(name="app.workers.ingestion.gesy_xml_ingest")
def gesy_xml_ingest(tenant_id: str, object_ref: str) -> dict:
    """ΓΕΣΥ (CY) — step 2. Parse stored XML via the same engine. Placeholder."""
    return {"tenant_id": tenant_id, "status": "stub", "note": "GESY automation = step 2"}
