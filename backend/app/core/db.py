"""MongoDB connection + index bootstrap + tenant database resolver.

The TenantDatabaseResolver is the seam that lets us move from the shared-DB model
(MVP) to database-per-tenant (Enterprise) without touching business code.
"""

from __future__ import annotations

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.core.config import settings

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    global _client
    if _client is None:
        _client = AsyncIOMotorClient(settings.MONGODB_URI, tz_aware=True)
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
    ("prescription_items", [("tenant_id", 1), ("execution_id", 1)], {}),
    ("prescription_items", [("tenant_id", 1), ("product_id", 1), ("executed_at", -1)], {}),
    ("prescription_items", [("tenant_id", 1), ("category", 1), ("executed_at", -1)], {}),
    ("doctors", [("tenant_id", 1), ("full_name", 1)], {}),
    ("patients_anonymized", [("tenant_id", 1), ("pseudo_id", 1)], {"unique": True}),
    ("patients_anonymized", [("tenant_id", 1), ("lifecycle", 1)], {}),
    ("products", [("tenant_id", 1), ("barcode", 1)], {"unique": True}),
    ("products", [("tenant_id", 1), ("margin_pct", 1)], {}),
    ("future_prescriptions", [("tenant_id", 1), ("expected_open_date", 1), ("status", 1)], {}),
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
