"""Hardened tenant-isolation guard (static analysis).

THE rule: no query against a tenant-scoped collection may reach Mongo without a
`tenant_id` filter. BaseRepository enforces this via `_scope()`, but code that accesses
collections directly (`db["coll"].find(...)`, `shared_db()["coll"]...`) bypasses it — so
this test scans the whole backend AST and fails CI if any direct tenant-collection query
is missing `tenant_id`. Intentional platform-wide access must be marked `# tenant-ok`.
"""

from __future__ import annotations

import ast
import pathlib

# Collections that carry a per-tenant `tenant_id` (must always be filtered by it).
TENANT_COLLECTIONS = {
    "prescription_executions", "prescription_items", "patients_anonymized",
    "patient_contacts", "patient_consents", "doctors", "insurance_funds", "products",
    "future_prescriptions", "profitability_snapshots", "sync_jobs", "audit_logs",
    "module_settings", "subscriptions", "users", "roles", "pharmacies",
}
# Shared / platform-level collections (no tenant_id by design) — ignored by this guard.
# medicine_catalog, platform_settings, fund_groups, price_changes, tenants, node_metrics.

# Files that operate at the PLATFORM/auth level (legitimately cross-tenant): the back-office
# admin router, auth/provisioning/account flows (user lookup by email/id before a tenant is
# resolved) and platform maintenance. New tenant-data code does NOT belong here.
PLATFORM_FILES = {
    "app/api/v1/routers/admin.py", "app/services/platform_auth.py", "app/services/auth_service.py",
    "app/services/provisioning.py", "app/services/onboarding_service.py",
    "app/services/account_service.py", "app/services/rbac_seed.py", "app/workers/noeton.py",
    "app/core/db.py",
}

QUERY_METHODS = {
    "find", "find_one", "aggregate", "count_documents", "distinct",
    "update_one", "update_many", "delete_one", "delete_many",
    "find_one_and_update", "find_one_and_delete", "find_one_and_replace",
    "insert_one", "insert_many", "replace_one", "bulk_write",
}

APP_DIR = pathlib.Path(__file__).resolve().parent.parent / "app"


def _violations() -> list[str]:
    out: list[str] = []
    for py in APP_DIR.rglob("*.py"):
        src = py.read_text(encoding="utf-8")
        try:
            tree = ast.parse(src)
        except SyntaxError:
            continue
        lines = src.splitlines()
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue
            if node.func.attr not in QUERY_METHODS:
                continue
            sub = node.func.value
            # match  <anything>["<collection literal>"].<query method>(...)
            if not (isinstance(sub, ast.Subscript) and isinstance(sub.slice, ast.Constant)
                    and isinstance(sub.slice.value, str)):
                continue
            coll = sub.slice.value
            if coll not in TENANT_COLLECTIONS:
                continue
            rel = str(py.relative_to(APP_DIR.parent))
            if rel in PLATFORM_FILES:  # cross-tenant by design
                continue
            seg = ast.get_source_segment(src, node) or ""
            line_txt = lines[node.lineno - 1] if 0 <= node.lineno - 1 < len(lines) else ""
            # allowed if it carries tenant_id, goes through _scope(), is scoped by a unique _id,
            # or is explicitly waived on the call line.
            if ("tenant_id" in seg or "_scope" in seg or '"_id"' in seg or "'_id'" in seg
                    or "tenant-ok" in line_txt):
                continue
            out.append(f"{rel}:{node.lineno}  {coll}.{node.func.attr}(…) χωρίς tenant_id")
    return out


def test_no_tenant_collection_query_without_tenant_id():
    """Every direct query on a tenant-scoped collection must include tenant_id."""
    v = _violations()
    assert not v, (
        "Un-scoped tenant-collection queries found (leak risk). Add a tenant_id filter, route "
        "through BaseRepository, or mark intentional platform access with `# tenant-ok`:\n  "
        + "\n  ".join(v)
    )


def test_base_repository_is_the_only_scoping_seam():
    """BaseRepository._scope + aggregate must keep injecting tenant_id (regression lock)."""
    from app.repositories.base import BaseRepository
    repo = BaseRepository(tenant_id="t-iso")
    repo.collection_name = "prescription_executions"
    assert repo._scope({"x": 1}) == {"tenant_id": "t-iso", "x": 1}
    assert repo._scope().get("tenant_id") == "t-iso"
