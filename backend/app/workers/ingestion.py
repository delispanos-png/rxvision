"""Ingestion tasks — automated ΗΔΥΚΑ sync (GR), wired to the shared engine.

Celery runs sync code, while the engine is async (Motor). Each task spins a fresh
event loop + Motor client (clients are loop-bound) and runs the engine on it.

Beat fans `dispatch_incremental_sync` out to every GR tenant with ΗΔΥΚΑ credentials
configured; each runs an incremental sync. Idempotent via natural key + content hash.
"""

from __future__ import annotations

import asyncio
import re
from datetime import date, datetime, timedelta, timezone

import redis as _redis
from motor.motor_asyncio import AsyncIOMotorClient

from app.core.config import settings
from app.services.ingestion.engine import IngestionEngine
from app.services.ingestion.hdika import HdikaAdapter
from app.services.ingestion.hdika_client import HdikaAuthError
from app.services.vault_service import vault
from app.workers.celery_app import celery_app


async def _hdika_auth_paused(db, tenant_id: str) -> bool:
    """Re-check την παύση ΤΗ ΣΤΙΓΜΗ ΕΚΤΕΛΕΣΗΣ (όχι μόνο στο dispatch): αν ένα άλλο task μόλις μπήκε
    σε παύση λόγω λάθους κωδικού, τα υπόλοιπα δεν κάνουν ΚΑΜΙΑ κλήση στην ΗΔΥΚΑ → το πολύ ΜΙΑ
    αποτυχημένη σύνδεση συνολικά, ώστε να μη κλειδώσει ο λογαριασμός."""
    t = await db["tenants"].find_one({"_id": tenant_id}, {"ingestion_config.hdika.auth_paused": 1})
    return bool(((t or {}).get("ingestion_config", {}).get("hdika", {}) or {}).get("auth_paused"))


async def _pause_hdika_auth(db, tenant_id: str, message: str) -> dict:
    """ΗΔΥΚΑ credentials απορρίφθηκαν (λάθος/ληγμένος μηνιαίος κωδικός) ή lockout → ΠΑΥΣΗ αυτού του
    tenant: ο dispatcher τον εξαιρεί από ΚΑΘΕ επικοινωνία με την ΗΔΥΚΑ μέχρι να καταχωρηθεί νέος
    κωδικός (ώστε να μη κλειδωθεί ο λογαριασμός από επαναλαμβανόμενες αποτυχίες). Ειδοποιεί τον
    φαρμακοποιό μέσω του status στη σελίδα «Διασύνδεση ΗΔΥΚΑ»."""
    now = datetime.now(tz=timezone.utc)
    await db["tenants"].update_one({"_id": tenant_id}, {"$set": {
        "ingestion_config.hdika.auth_paused": True,
        "ingestion_config.hdika.auth_error_at": now,
        "ingestion_config.hdika.auth_error_msg": str(message)[:300]}})
    try:   # ίχνος στο sync-health (ΟΧΙ σαν επιτυχία) — ορατό και στο adminpanel
        await db["sync_jobs"].insert_one({
            "tenant_id": tenant_id, "source": "HDIKA", "type": "incremental",
            "status": "auth_error", "error": str(message)[:300],
            "stats": {"fetched": 0}, "started_at": now, "updated_at": now})
    except Exception:  # noqa: BLE001
        pass
    return {"tenant_id": tenant_id, "status": "auth_paused", "error": str(message)[:200]}


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
    """«Άντληση ιστορικού από» (per-tenant ρύθμιση) — parsed ή None."""
    s = (creds or {}).get("history_from")
    if not s:
        return None
    try:
        return datetime.strptime(str(s)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


async def _watermark(db, tenant_id: str) -> datetime:
    from app.services.data_retention import tenant_cutoff
    last = await db["prescription_executions"].find_one(
        {"tenant_id": tenant_id, "source": "HDIKA"}, sort=[("executed_at", -1)])
    creds_floor = _history_floor(vault.get_secret(f"tenants/{tenant_id}/hdika") or {})
    # ΠΟΤΕ πιο πίσω από το retention cutoff του ΦΑΡΜΑΚΕΙΟΥ — αλλιώς η ΗΔΥΚΑ ξανακατεβάζει ό,τι καθαρίσαμε.
    rc = await tenant_cutoff(db, tenant_id)
    floor = max(creds_floor, rc) if creds_floor else rc
    if last and last.get("executed_at"):
        wm = last["executed_at"] - timedelta(days=1)
        return max(wm, floor)
    return floor                        # νέος tenant → ξεκινά από το retention cutoff


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
                 "ingestion_config.hdika.sync_enabled": {"$ne": False},
                 "ingestion_config.hdika.auth_paused": {"$ne": True}},
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
                 "ingestion_config.hdika.sync_enabled": {"$ne": False},
                 "ingestion_config.hdika.auth_paused": {"$ne": True}}, {"_id": 1})]
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
            if await _hdika_auth_paused(db, tenant_id):   # παύση λόγω λάθους κωδικού → skip
                return {"tenant_id": tenant_id, "status": "skipped", "note": "auth_paused"}
            from app.services.ingestion.cancellations import reconcile_tenant
            return await reconcile_tenant(tenant_id, db=db, dry_run=False)
        except HdikaAuthError as e:   # λάθος/ληγμένος κωδικός → ΠΑΥΣΗ tenant (μη retry)
            return await _pause_hdika_auth(db, tenant_id, str(e))
        finally:
            client.close()
    return _run_async(_run())


def _gr_hdika_tenants(db):
    return db["tenants"].find(
        {"country": "GR", "status": {"$in": ["active", "trial"]},
         "credentials_ref.hdika": {"$ne": None},
         "ingestion_config.hdika.sync_enabled": {"$ne": False},
                 "ingestion_config.hdika.auth_paused": {"$ne": True}}, {"_id": 1})


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


@celery_app.task(name="app.workers.ingestion.reconcile_gaps",
                 bind=True, max_retries=2, autoretry_for=(ConnectionError, TimeoutError),
                 retry_backoff=True, retry_backoff_max=1800, retry_jitter=True)
def reconcile_gaps_task(self, tenant_id: str, days: int = 40) -> dict:
    """Εντοπίζει εκτελέσεις που ΥΠΑΡΧΟΥΝ στην ΗΔΥΚΑ αλλά ΛΕΙΠΟΥΝ τοπικά (late registrations ή
    στιγμιαίες αποτυχίες fetch — το forward-only sync δεν ξαναγυρίζει πίσω) και πυροδοτεί στοχευμένο
    backfill για να τις ανακτήσει. Φθηνό detection (μόνο search, ΧΩΡΙΣ CDA) με multi-pass για την
    ασταθή pagination. Κρατά `attempted` ανά external_id → ΤΟ ΠΟΛΥ ένα backfill ανά λείπον (χωρίς
    ατέρμονα retries για μη-ανακτήσιμα, π.χ. εκτελέσεις που κόβονται στο validation)."""
    async def _run() -> dict:
        _, db = _fresh_db()
        if await _hdika_auth_paused(db, tenant_id):
            return {"tenant_id": tenant_id, "status": "skipped", "note": "auth_paused"}
        from app.api.v1.routers.ingestion import _effective_hdika_creds
        from app.services.ingestion.hdika_client import HdikaClient
        from app.services.ingestion.reconcile import find_missing
        creds = await _effective_hdika_creds(tenant_id)
        if not creds or not creds.get("api_key") or not creds.get("pharmacy_id"):
            return {"tenant_id": tenant_id, "status": "skipped", "note": "no_creds_or_pharmacy_id"}
        client = HdikaClient(dict(creds, throttle=0.05))
        try:
            end = datetime.now(tz=timezone.utc).date()
            res = await find_missing(db, client, tenant_id, end - timedelta(days=days), end)
        except HdikaAuthError as e:
            return await _pause_hdika_auth(db, tenant_id, str(e))
        finally:
            client.close()
        missing: dict = res["missing"]          # {external_id -> ημέρα}
        now = datetime.now(tz=timezone.utc)
        alerts = db["ingestion_alerts"]
        prev = await alerts.find_one({"kind": "reconcile_gap", "tenant_id": tenant_id}) or {}
        attempted = set(prev.get("attempted", []))
        # ΜΟΝΟ όσα δεν έχουμε ξαναδοκιμάσει → ένα backfill ανά λείπον (bounds retries)
        to_recover = {ext: d for ext, d in missing.items() if ext not in attempted}
        recovered_window = None
        if to_recover:
            mdays = sorted(set(to_recover.values()))
            since_iso = mdays[0]
            until_iso = (date.fromisoformat(mdays[-1]) + timedelta(days=1)).isoformat()
            hdika_backfill.apply_async((tenant_id, since_iso, until_iso),
                                       kwargs={"throttle": 0.05}, queue="backfill")
            recovered_window = [since_iso, until_iso]
        await alerts.update_one(
            {"kind": "reconcile_gap", "tenant_id": tenant_id},
            {"$set": {"kind": "reconcile_gap", "tenant_id": tenant_id,
                      "count": len(missing), "external_ids": sorted(missing)[:100],
                      "days": sorted(set(missing.values())),
                      "resolved": not missing, "updated_at": now,
                      "last_backfill_window": recovered_window,
                      "attempted": sorted(attempted | set(missing))[:1000]},
             "$setOnInsert": {"created_at": now}}, upsert=True)
        return {"tenant_id": tenant_id, "status": "ok", "hdika": res["hdika"],
                "ours": res["ours"], "missing": len(missing),
                "triggered_backfill": bool(to_recover), "window": recovered_window}
    return _run_async(_run())


@celery_app.task(name="app.workers.ingestion.dispatch_reconcile_gaps")
def dispatch_reconcile_gaps() -> int:
    """Beat (daily): για κάθε GR/ΗΔΥΚΑ tenant, εντοπισμός & ανάκτηση εκτελέσεων που λείπουν τοπικά.
    Τρέχει στην ουρά backfill ώστε να μην κλέβει slots από τον incremental sync."""
    from app.services.ingestion.reconcile import RECONCILE_WINDOW_DAYS
    async def _run() -> list[str]:
        _, db = _fresh_db()
        return [str(t["_id"]) async for t in _gr_hdika_tenants(db)]
    ids = _run_async(_run())
    for tid in ids:
        reconcile_gaps_task.apply_async(args=[tid, RECONCILE_WINDOW_DAYS], queue="backfill")
    return len(ids)


@celery_app.task(name="app.workers.ingestion.dispatch_amount_audit")
def dispatch_amount_audit() -> int:
    """Beat-scheduled. Enqueue an amount-audit batch per GR tenant — verifies each execution's
    ποσά απέναντι στο ΕΝΤΥΠΟ (PDF) της ΗΔΥΚΑ (ground truth) & διορθώνει. Runs on the backfill queue
    so it never steals the incremental-sync slots; drains the historical backlog batch-by-batch and
    keeps up with new executions daily."""
    async def _run() -> list[str]:
        client, db = _fresh_db()
        try:
            return [str(t["_id"]) async for t in _gr_hdika_tenants(db)]
        finally:
            client.close()
    ids = _run_async(_run())
    for tid in ids:
        amount_audit_task.apply_async(args=[tid, settings.AMOUNT_AUDIT_BATCH], queue="backfill")
    return len(ids)


@celery_app.task(name="app.workers.ingestion.amount_audit",
                 bind=True, max_retries=2, autoretry_for=(ConnectionError, TimeoutError),
                 retry_backoff=True, retry_backoff_max=1800, retry_jitter=True)
def amount_audit_task(self, tenant_id: str, limit: int = 150) -> dict:
    """Audit one tenant's next batch of un-audited executions vs the ΗΔΥΚΑ printout & correct."""
    async def _run() -> dict:
        client, db = _fresh_db()
        try:
            from app.services.ingestion.amount_audit import audit_amounts_against_printout
            return await audit_amounts_against_printout(tenant_id, db=db, limit=limit)
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
                 "ingestion_config.hdika.sync_enabled": {"$ne": False},
                 "ingestion_config.hdika.auth_paused": {"$ne": True}}, {"_id": 1})]
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
            if await _hdika_auth_paused(db, tenant_id):   # μπήκε σε παύση από άλλο task → μη ξαναδοκιμάσεις
                return {"tenant_id": tenant_id, "status": "skipped", "note": "auth_paused"}
            from app.api.v1.routers.ingestion import _effective_hdika_creds
            # FULL effective creds — production ΚΛΗΡΟΝΟΜΕΙ platform api_key/integrator (test→sandbox).
            # ΚΡΙΣΙΜΟ (2026-07-02): το παλιό inline building ΔΕΝ κληρονομούσε το production api_key →
            # νέα φαρμακεία (μόνο username+password) έτρεχαν ΧΩΡΙΣ key → ΗΔΥΚΑ 911 → 0 records.
            creds = dict(await _effective_hdika_creds(tenant_id))
            creds.setdefault("throttle", 0.1)        # gentle on ΗΔΥΚΑ
            since = await _watermark(db, tenant_id)
            now = datetime.now(tz=timezone.utc)
            records = HdikaAdapter(creds).fetch(since=since)
            job = await IngestionEngine(tenant_id, db=db).ingest(
                source="HDIKA", job_type="incremental", records=records,
                window=(since, now), task_id=self.request.id)
            return {"tenant_id": tenant_id, "status": job["status"], "stats": job["stats"]}
        except HdikaAuthError as e:   # λάθος/ληγμένος κωδικός → ΠΑΥΣΗ tenant + ειδοποίηση (μη retry)
            return await _pause_hdika_auth(db, tenant_id, str(e))
        finally:
            client.close()

    try:
        return _run_async(_run())
    finally:
        _release_lock()


@celery_app.task(name="app.workers.ingestion.hdika_backfill", bind=True,
                 acks_late=False, max_retries=0)
def hdika_backfill(self, tenant_id: str, since_iso: str, until_iso: str | None = None,
                   throttle: float = 0.0, continue_floor_iso: str | None = None) -> dict:
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
            if await _hdika_auth_paused(db, tenant_id):   # παύση λόγω λάθους κωδικού → μη χτυπάς την ΗΔΥΚΑ
                return {"tenant_id": tenant_id, "status": "skipped", "note": "auth_paused"}
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
            from app.api.v1.routers.ingestion import _effective_hdika_creds
            # FULL effective creds — production ΚΛΗΡΟΝΟΜΕΙ platform api_key/integrator (test→sandbox).
            # ΚΡΙΣΙΜΟ (2026-07-02): το παλιό inline building ΔΕΝ κληρονομούσε το production api_key →
            # νέα φαρμακεία (μόνο username+password) το backfill έτρεχε ΧΩΡΙΣ key → 911 → 0 records.
            creds = dict(await _effective_hdika_creds(tenant_id))
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
        except HdikaAuthError as e:   # λάθος/ληγμένος κωδικός → ΠΑΥΣΗ tenant (μη retry/chain)
            return await _pause_hdika_auth(db, tenant_id, str(e))
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


@celery_app.task(name="app.workers.ingestion.dispatch_historical_continue")
def dispatch_historical_continue() -> int:
    """Self-heal (beat): re-trigger ιστορική συνέχιση για tenants με `history_from` που δεν έχουν
    ακόμη φτάσει εκεί — auto-resume αν ένα chunk σκοτώθηκε. Παραλείπει όσους τρέχουν ήδη backfill."""
    async def _run():
        client, db = _fresh_db()
        try:
            todo = []
            async for t in db["tenants"].find(
                    {"country": "GR", "status": {"$in": ["active", "trial"]},
                     "credentials_ref.hdika": {"$ne": None},
                     "ingestion_config.hdika.auth_paused": {"$ne": True}}, {"_id": 1}):
                tid = str(t["_id"])
                hf = (vault.get_secret(f"tenants/{tid}/hdika") or {}).get("history_from")
                if not hf:
                    continue
                try:
                    floor = datetime.strptime(str(hf)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
                # μη πας πιο πίσω από το retention παράθυρο του φαρμακείου (αλλιώς re-download καθαρισμένων)
                from app.services.data_retention import tenant_cutoff
                floor = max(floor, await tenant_cutoff(db, tid))
                d = await db["prescription_executions"].find_one(
                    {"tenant_id": tid}, sort=[("executed_at", 1)], projection={"executed_at": 1})
                oldest = d.get("executed_at") if d else None
                if oldest and oldest.date() > floor.date():
                    busy = await db["sync_jobs"].find_one(
                        {"tenant_id": tid, "type": "backfill", "status": "running",
                         "updated_at": {"$gte": datetime.now(tz=timezone.utc) - timedelta(minutes=12)}})
                    if not busy:
                        todo.append((tid, floor.isoformat()))
            return todo
        finally:
            client.close()

    todo = _run_async(_run())
    for tid, floor_iso in todo:
        hdika_backfill_continue.delay(tid, floor_iso)
    return len(todo)


@celery_app.task(name="app.workers.ingestion.reap_stalled_sync")
def reap_stalled_sync(stall_minutes: int = 10) -> dict:
    """Watchdog (beat). A healthy sync writes a heartbeat (`updated_at`) every 20 records.
    If a 'running' job hasn't progressed for >`stall_minutes`, its worker is stuck →
    KILL the Celery task (SIGKILL, no redelivery) and mark the job failed. 10min gives a heavy
    rate-limited backfill page room to finish before being (falsely) reaped."""
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


@celery_app.task(name="app.workers.ingestion.heal_missing_cda")
def heal_missing_cda(limit_per_tenant: int = 25) -> dict:
    """SELF-HEAL: εκτελέσεις που μπήκαν με ΠΑΛΙΟΤΕΡΟ parser δεν έχουν κάποια CDA-πεδία (π.χ.
    `details.intangible` «άυλη συνταγή» = 1.5.10). Ξανα-ανακτούμε την CDA & γεμίζουμε το πεδίο ΟΤΑΝ η
    ΗΔΥΚΑ είναι διαθέσιμη — best-effort & throttled: αν η CDA πέφτει (503) σταματάμε νωρίς και
    ξαναδοκιμάζουμε στο επόμενο run. Παύει για tenants σε auth-pause (μη χτυπάμε με λάθος κωδικό)."""
    from app.services.ingestion.hdika_client import HdikaClient

    async def _run() -> dict:
        client, db = _fresh_db()
        try:
            from app.api.v1.routers.ingestion import _effective_hdika_creds
            healed = scanned = 0
            tenants = [str(t["_id"]) async for t in db["tenants"].find(
                {"country": "GR", "status": {"$in": ["active", "trial"]},
                 "credentials_ref.hdika": {"$ne": None},
                 "ingestion_config.hdika.auth_paused": {"$ne": True}}, {"_id": 1})]
            for tid in tenants:
                seen, barcodes = set(), []
                async for e in db["prescription_executions"].find(
                        {"tenant_id": tid, "details.intangible": {"$exists": False}},
                        {"external_id": 1}).sort("executed_at", -1).limit(limit_per_tenant * 4):
                    bc = str(e["external_id"]).split(":")[0]
                    if bc not in seen:
                        seen.add(bc)
                        barcodes.append(bc)
                    if len(barcodes) >= limit_per_tenant:
                        break
                if not barcodes:
                    continue
                creds = dict(await _effective_hdika_creds(tid))
                creds.setdefault("throttle", 0.15)
                cl = HdikaClient(creds)
                fails = 0
                try:
                    for bc in barcodes:
                        scanned += 1
                        cda = await asyncio.to_thread(cl._fetch_cda, bc)  # sync → thread (best-effort)
                        # parse_cda_full βάζει το «άυλη» (1.5.10) στο cda["details"]["intangible"]
                        # — ΟΧΙ top-level. Διαβάζουμε τη ΣΩΣΤΗ (πραγματική) τιμή True/False από την CDA.
                        cda_det = (cda or {}).get("details") or {}
                        if cda and "intangible" in cda_det:
                            await db["prescription_executions"].update_many(
                                {"tenant_id": tid, "external_id": {"$regex": "^" + re.escape(bc)}},
                                {"$set": {"details.intangible": bool(cda_det.get("intangible"))}})
                            healed += 1
                            fails = 0
                        else:
                            fails += 1
                            if fails >= 5:      # η ΗΔΥΚΑ μάλλον down → σταμάτα, ξαναδοκίμασε αργότερα
                                break
                finally:
                    cl.close()
            return {"healed_barcodes": healed, "scanned": scanned}
        finally:
            client.close()

    return _run_async(_run())
