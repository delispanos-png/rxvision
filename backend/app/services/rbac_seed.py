"""RBAC seed — global permission catalog + default role templates.

`PERMISSIONS` mirrors the `permissions` collection (global reference, DATABASE.md §4):
each entry is `{_id: "resource:action", resource, action, description, module}`.
`module` ties a permission to a feature module so `require(perm, module)` can gate both.

`DEFAULT_ROLES` are the system role templates instantiated per-tenant on provisioning
(owner, manager, pharmacist, staff). `seed_rbac()` is idempotent and usable from a
seed script: it upserts the global permission catalog and, when given a tenant_id,
upserts that tenant's system roles.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


# ── Global permission catalog ──────────────────────────────────────────────
# (resource, action, module, description_el)
_PERMISSION_DEFS: list[tuple[str, str, str | None, str]] = [
    # Dashboard
    ("dashboard", "read", "dashboard", "Ανάγνωση dashboard / KPIs"),
    # Prescription analytics
    ("prescriptions", "read", "prescription_analytics", "Ανάγνωση συνταγών"),
    ("prescriptions", "export", "prescription_analytics", "Εξαγωγή συνταγών"),
    # Doctor analytics
    ("doctors", "read", "doctor_analytics", "Ανάγνωση στατιστικών ιατρών"),
    # Patient analytics
    ("patients", "read", "patient_analytics", "Ανάγνωση ανώνυμων στατιστικών ασθενών"),
    # ICD-10 analytics
    ("icd10", "read", "icd10_analytics", "Ανάγνωση στατιστικών ICD-10"),
    # Profitability
    ("profitability", "read", "profitability", "Ανάγνωση κερδοφορίας"),
    # Future prescriptions
    ("future", "read", "future_prescriptions", "Ανάγνωση μελλοντικών συνταγών / πρόβλεψης"),
    # Orders
    ("orders", "read", "order_suggestions", "Ανάγνωση προτάσεων παραγγελίας"),
    ("orders", "run", "order_suggestions", "Επανυπολογισμός προτάσεων παραγγελίας"),
    # Monthly closing
    ("closing", "read", "monthly_closing", "Ανάγνωση μηνιαίου κλεισίματος"),
    ("closing", "run", "monthly_closing", "Κλείδωμα περιόδου"),
    # Ingestion
    ("ingestion", "read", "ingestion", "Ανάγνωση εργασιών ingestion"),
    ("ingestion", "run", "ingestion", "Εκτέλεση sync / upload"),
    # PharmacyOne add-on
    ("pharmacyone", "read", "pharmacyone", "Ανάγνωση δεδομένων PharmacyOne"),
    # Settings / tenant
    ("settings", "read", None, "Ανάγνωση ρυθμίσεων tenant"),
    ("settings", "write", None, "Διαχείριση ρυθμίσεων tenant"),
    # Users / roles
    ("users", "manage", None, "Διαχείριση χρηστών & ρόλων"),
    # Billing
    ("billing", "manage", None, "Διαχείριση συνδρομής / billing"),
    # GDPR / data-subject rights (legal obligation — never module-locked)
    ("gdpr", "read", None, "Προβολή δεδομένων & συγκαταθέσεων GDPR"),
    ("gdpr", "export", None, "Εξαγωγή δεδομένων υποκειμένου (Άρθρο 15/20)"),
    ("gdpr", "rectify", None, "Διόρθωση/περιορισμός δεδομένων (Άρθρο 16/18/21)"),
    ("gdpr", "erase", None, "Διαγραφή/ανωνυμοποίηση δεδομένων (Άρθρο 17)"),
]

PERMISSIONS: list[dict] = [
    {
        "_id": f"{resource}:{action}",
        "resource": resource,
        "action": action,
        "module": module,
        "description": description,
    }
    for resource, action, module, description in _PERMISSION_DEFS
]

ALL_PERMISSION_KEYS: list[str] = [p["_id"] for p in PERMISSIONS]

# ── Default (system) role templates ────────────────────────────────────────
_READ_ALL: list[str] = [k for k in ALL_PERMISSION_KEYS if k.endswith(":read")]

DEFAULT_ROLES: list[dict] = [
    {
        "key": "owner",
        "name": "Ιδιοκτήτης",
        "is_system": True,
        # Owner gets everything, including the wildcard understood by require().
        "permissions": ["*"],
    },
    {
        "key": "manager",
        "name": "Διαχειριστής",
        "is_system": True,
        "permissions": sorted(set(
            _READ_ALL
            + [
                "prescriptions:export",
                "orders:run",
                "closing:run",
                "ingestion:run",
                "settings:read",
                "settings:write",
                "users:manage",
                "gdpr:export",
                "gdpr:rectify",
                "gdpr:erase",
            ]
        )),
    },
    {
        "key": "pharmacist",
        "name": "Φαρμακοποιός",
        "is_system": True,
        "permissions": sorted(set(
            _READ_ALL
            + [
                "prescriptions:export",
                "orders:run",
                "closing:run",
                "ingestion:run",
                "gdpr:export",
                "gdpr:rectify",
                "gdpr:erase",
            ]
        )),
    },
    {
        "key": "staff",
        "name": "Προσωπικό",
        "is_system": True,
        # Read-only on the day-to-day analytics modules.
        "permissions": sorted(set([
            "dashboard:read",
            "prescriptions:read",
            "doctors:read",
            "patients:read",
            "icd10:read",
            "future:read",
            "orders:read",
        ])),
    },
]


# ── Seed functions ─────────────────────────────────────────────────────────
async def seed_permissions() -> int:
    """Upsert the global permission catalog. Idempotent."""
    db = shared_db()
    for perm in PERMISSIONS:
        await db["permissions"].update_one(
            {"_id": perm["_id"]}, {"$set": perm}, upsert=True
        )
    return len(PERMISSIONS)


async def seed_roles_for_tenant(tenant_id: str) -> int:
    """Upsert the system role templates for a single tenant. Idempotent."""
    db = shared_db()
    for role in DEFAULT_ROLES:
        await db["roles"].update_one(
            {"tenant_id": tenant_id, "key": role["key"]},
            {
                "$set": {
                    "tenant_id": tenant_id,
                    "key": role["key"],
                    "name": role["name"],
                    "permissions": role["permissions"],
                    "is_system": role["is_system"],
                    "updated_at": _now(),
                },
                "$setOnInsert": {"created_at": _now()},
            },
            upsert=True,
        )
    return len(DEFAULT_ROLES)


async def seed_rbac(tenant_id: str | None = None) -> dict:
    """Seed the global permission catalog and, optionally, a tenant's system roles.

    Usable from a seed script:
        await seed_rbac()                 # permissions only
        await seed_rbac(tenant_id="...")  # permissions + that tenant's roles
    """
    perms = await seed_permissions()
    roles = await seed_roles_for_tenant(tenant_id) if tenant_id else 0
    return {"permissions": perms, "roles": roles, "tenant_id": tenant_id}
