"""MongoDB connection + index bootstrap + tenant database resolver.

The TenantDatabaseResolver is the seam that lets us move from the shared-DB model
(MVP) to database-per-tenant (Enterprise) without touching business code.
"""

from __future__ import annotations

import asyncio

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.core.config import settings

_client: AsyncIOMotorClient | None = None
_client_loop: object | None = None  # the event loop the cached client is bound to


def get_client() -> AsyncIOMotorClient:
    """Loop-aware Motor client. The API runs on one persistent event loop (client created once,
    reused). Celery workers run `asyncio.run()` PER TASK → a fresh loop each time; a Motor client
    bound to a previous (now-closed) loop raises 'Event loop is closed'. So when we're running on a
    different loop than the cached client, we recreate it bound to the current loop."""
    global _client, _client_loop
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if _client is None or (loop is not None and loop is not _client_loop):
        if _client is not None:
            try:
                _client.close()
            except Exception:  # noqa: BLE001 — old loop may already be closed; best-effort
                pass
        _client = AsyncIOMotorClient(settings.MONGODB_URI, tz_aware=True)
        _client_loop = loop
    return _client


class TenantDatabaseResolver:
    """Resolves which physical database a tenant's data lives in.

    Today: everyone shares `MONGODB_DB` and isolation is enforced by the
    tenant_id filter in BaseRepository. Tomorrow: dedicated-tier tenants get
    `tenant_<id>` and the resolver returns that DB instead — no other change.
    """

    def resolve(self, *, tenant_id: str, isolation_tier: str = "shared") -> AsyncIOMotorDatabase:
        client = get_client()
        if isolation_tier == "dedicated_db":
            return client[f"tenant_{tenant_id}"]
        return client[settings.MONGODB_DB]


db_resolver = TenantDatabaseResolver()


def shared_db() -> AsyncIOMotorDatabase:
    return get_client()[settings.MONGODB_DB]


# (collection_name, index_spec, options)
INDEXES: list[tuple[str, list[tuple[str, int]], dict]] = [
    ("users", [("tenant_id", 1), ("email", 1)], {"unique": True}),
    ("roles", [("tenant_id", 1), ("key", 1)], {"unique": True}),
    ("pharmacies", [("tenant_id", 1)], {}),
    ("prescription_executions", [("tenant_id", 1), ("source", 1), ("external_id", 1)], {"unique": True}),
    ("prescription_executions", [("tenant_id", 1), ("executed_at", -1)], {}),
    ("prescription_executions", [("tenant_id", 1), ("doctor_id", 1), ("executed_at", -1)], {}),
    ("prescription_executions", [("tenant_id", 1), ("fund_id", 1), ("executed_at", -1)], {}),
    ("prescription_executions", [("tenant_id", 1), ("icd10", 1)], {}),
    ("prescription_executions", [("tenant_id", 1), ("next_open_date", 1)], {}),
    ("prescription_executions", [("tenant_id", 1), ("patient_ref", 1)], {}),
    ("prescription_executions", [("tenant_id", 1), ("repeat_root", 1)], {}),
    ("prescription_items", [("tenant_id", 1), ("execution_id", 1)], {}),
    ("prescription_items", [("tenant_id", 1), ("product_id", 1), ("executed_at", -1)], {}),
    ("prescription_items", [("tenant_id", 1), ("category", 1), ("executed_at", -1)], {}),
    ("prescription_items", [("tenant_id", 1), ("executed_at", -1)], {}),
    ("prescription_items", [("tenant_id", 1), ("is_executed", 1)], {}),
    ("doctors", [("tenant_id", 1), ("full_name", 1)], {}),
    ("patients_anonymized", [("tenant_id", 1), ("pseudo_id", 1)], {"unique": True}),
    ("patients_anonymized", [("tenant_id", 1), ("lifecycle", 1)], {}),
    ("patients_anonymized", [("tenant_id", 1), ("full_name", 1)], {}),
    ("patients_anonymized", [("tenant_id", 1), ("amka", 1)], {}),
    ("patients_anonymized", [("tenant_id", 1), ("last_seen_at", -1)], {}),
    ("patient_contacts", [("tenant_id", 1), ("marketing_consent", 1)], {}),
    ("patient_contacts", [("tenant_id", 1), ("mobile", 1)], {}),
    ("patient_contacts", [("tenant_id", 1), ("email", 1)], {}),
    ("products", [("tenant_id", 1), ("barcode", 1)], {"unique": True}),
    ("products", [("tenant_id", 1), ("margin_pct", 1)], {}),
    ("products", [("tenant_id", 1), ("category", 1)], {}),
    ("price_changes", [("direction", 1), ("changed_at", -1)], {}),
    ("future_prescriptions", [("tenant_id", 1), ("expected_open_date", 1), ("status", 1)], {}),
    ("future_prescriptions", [("tenant_id", 1), ("patient_ref", 1)], {}),
    ("future_prescriptions", [("tenant_id", 1), ("source_execution_id", 1)], {}),
    ("profitability_snapshots", [("tenant_id", 1), ("period", 1), ("dimension", 1)], {}),
    ("sync_jobs", [("tenant_id", 1), ("source", 1), ("started_at", -1)], {}),
    ("audit_logs", [("tenant_id", 1), ("at", -1)], {}),
    ("module_settings", [("tenant_id", 1), ("module", 1)], {"unique": True}),
    ("subscriptions", [("tenant_id", 1)], {"unique": True}),
    ("tenants", [("slug", 1)], {"unique": True}),
]


async def ensure_indexes() -> None:
    """Idempotent — runs on startup so deploys keep indexes in sync."""
    db = shared_db()
    for coll, keys, opts in INDEXES:
        await db[coll].create_index(keys, **opts)


async def reap_orphan_jobs() -> int:
    """Delete sync_jobs stuck in 'running' with a stale heartbeat (>15min, no live worker).
    Worker restarts orphan in-flight Celery tasks, leaving dead 'running' records that are
    pure noise (the data they ingested stays). Removed entirely so the history stays clean."""
    from datetime import datetime, timedelta, timezone
    cutoff = datetime.now(tz=timezone.utc) - timedelta(minutes=15)
    res = await shared_db()["sync_jobs"].delete_many(
        {"status": "running", "$or": [
            {"updated_at": {"$lt": cutoff}},
            {"updated_at": {"$exists": False}, "started_at": {"$lt": cutoff}},
        ]})
    return res.deleted_count
