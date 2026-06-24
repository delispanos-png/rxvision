"""TenantProvisioningService — «άνοιγμα» tenant από πακέτο.

ONE service, meant to be driven by TWO entry points (now: the admin console; later:
the admin API). Opening a tenant creates: tenant + RBAC roles + owner user +
subscription with the package's modules/price/trial.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.core.security import hash_password
from app.services.rbac_seed import seed_rbac


_ALL_MODULES = ["dashboard", "prescription_analytics", "doctor_analytics", "patient_analytics",
                "icd10_analytics", "profitability", "future_prescriptions", "order_suggestions",
                "monthly_closing", "ingestion", "pharmacyone"]
# Opt-in capabilities — NOT granted by default; the platform admin enables them per pharmacy
# (tenant module override). Pharmacists without them don't see them at all.
_OPT_IN_MODULES = ["pharmacat", "patient_portal", "loyalty"]
# External role → RxVision tenant role key
_NOETON_ROLE_MAP = {"admin": "owner", "owner": "owner", "manager": "manager",
                    "pharmacist": "pharmacist", "user": "staff", "staff": "staff"}



def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _slugify(name: str) -> str:
    base = "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")[:24] or "tenant"
    return f"{base}-{uuid.uuid4().hex[:6]}"


class ProvisioningError(Exception):
    pass


class TenantProvisioningService:
    async def open_tenant(self, *, name: str, owner_email: str, package_code: str,
                          owner_password: str | None = None, owner_name: str | None = None,
                          tenant_id: str | None = None, external_ref: str | None = None,
                          source: str = "admin", billing_cycle: str | None = None,
                          sla: str | None = None, company: dict | None = None,
                          modules: list[str] | None = None, seats: int | None = None,
                          payment_method: str | None = None) -> dict:
        db = shared_db()

        package = await db["packages"].find_one({"_id": package_code})
        if not package:
            raise ProvisioningError(f"unknown_package:{package_code}")
        if await db["users"].find_one({"email": owner_email}):
            raise ProvisioningError("email_in_use")

        tid = tenant_id or _slugify(name)
        if await db["tenants"].find_one({"_id": tid}):
            raise ProvisioningError("tenant_exists")

        # capability overrides: the admin's selected modules vs the package's base set.
        # Only diffs are stored as overrides → resolve_modules(base, overrides) == selected.
        base = set(package.get("modules") or [])
        mod_overrides: dict[str, str] = {}
        if modules is not None:
            selected = set(modules)
            mod_overrides = {**{m: "enabled" for m in selected - base},
                             **{m: "locked" for m in base - selected}}

        # tenant
        await db["tenants"].insert_one({
            "_id": tid, "name": name, "slug": tid, "country": "GR", "status": "active",
            "isolation_tier": "shared",
            "settings": {"locale": "el-GR", "timezone": "Europe/Athens", "currency": "EUR"},
            "modules": mod_overrides, "credentials_ref": {"hdika": None, "gesy": None},
            "billing_profile": company or {},
            "external_ref": external_ref, "opened_via": source,
            "created_at": _now(), "updated_at": _now()})

        # RBAC roles for the tenant, then the owner user
        await seed_rbac(tenant_id=tid)
        owner_role = await db["roles"].find_one({"tenant_id": tid, "key": "owner"})
        temp_password = owner_password or secrets.token_urlsafe(9)
        await db["users"].insert_one({
            "tenant_id": tid, "email": owner_email,
            "password_hash": hash_password(temp_password),
            "full_name": owner_name or name, "role_ids": [owner_role["_id"]],
            "pharmacy_ids": [], "status": "active", "mfa_enabled": False,
            "refresh_token_version": 0, "must_change_password": owner_password is None,
            "created_at": _now(), "updated_at": _now()})

        # subscription from the package (billing cycle drives the price; SLA is admin-chosen)
        trial_days = package.get("trial_days", 0)
        cycle = billing_cycle or "monthly"
        yearly = cycle == "yearly"
        price = package.get("price_yearly", 0) if yearly else package.get("price_monthly", 0)
        # seats & cost breakdown: base package + chosen SLA tier + extra concurrent users
        sla_code = sla or package.get("sla")
        included_seats = int(package.get("seats", 1) or 1)
        chosen_seats = max(int(seats or included_seats), included_seats)
        extra_users = max(0, chosen_seats - included_seats)
        extra_rate = int(package.get("extra_user_price_yearly" if yearly else "extra_user_price", 0) or 0)
        sla_doc = await db["sla_tiers"].find_one({"_id": sla_code}) if sla_code else None
        sla_price = int((sla_doc or {}).get("price_yearly" if yearly else "price_monthly", 0) or 0)
        extra_total = extra_users * extra_rate
        price_total = int(price) + sla_price + extra_total
        await db["subscriptions"].insert_one({
            "tenant_id": tid, "plan": package_code,
            "status": "trial" if trial_days else "active", "seats": chosen_seats,
            "billing_cycle": cycle, "sla": sla_code,
            "price_per_pharmacy": price, "currency": "EUR",
            "sla_price": sla_price, "extra_users": extra_users, "extra_user_rate": extra_rate,
            "extra_users_total": extra_total, "price_total": price_total,
            "payment_method": payment_method or "card",
            "modules_included": package.get("modules", []),
            "limits": {"pharmacies": chosen_seats},
            "trial_ends_at": (_now() + timedelta(days=trial_days)) if trial_days else None,
            "current_period_end": _now() + timedelta(days=trial_days or 30),
            "external_ref": external_ref, "created_at": _now(), "updated_at": _now()})

        return {
            "tenant_id": tid, "name": name, "owner_email": owner_email,
            "package": package_code,
            # surfaced only when WE generated the password (so it can be delivered)
            "temp_password": None if owner_password else temp_password,
        }

    
    async def apply_subscription(self, *, tenant_code: str, subscription: dict) -> dict:
        """Upsert the tenant's subscription from an external subscription payload and map
        plan → enabled modules."""
        db = shared_db()
        plan_code = subscription.get("plan_code") or ""
        pkg_code = plan_code.split("-")[-1] if "-" in plan_code else plan_code
        package = await db["packages"].find_one({"_id": pkg_code})
        modules = package["modules"] if package else _ALL_MODULES
        status = subscription.get("status", "active")
        price_monthly = subscription.get("price_monthly", 0)
        if not price_monthly and package:
            price_monthly = package.get("price_monthly", 0)
        seats = subscription.get("limits", {}).get("users") or (package.get("seats") if package else 1) or 1
        await db["subscriptions"].update_one(
            {"tenant_id": tenant_code},
            {"$set": {
                "tenant_id": tenant_code, "plan": plan_code or "default", "status": status,
                "plan_name": subscription.get("plan_name"),
                "features": subscription.get("features", {}),
                "limits": subscription.get("limits", {}),
                "seats": seats,
                "price_per_pharmacy": price_monthly,
                "modules_included": modules,
                "product_code": "rxvision",
                "billing_cycle": subscription.get("billing_cycle"),
                "trial_ends_at": subscription.get("trial_ends_at"),
                "current_period_end": subscription.get("expires_at"),
                "external_ref": tenant_code, "source": "platform", "updated_at": _now()},
             "$setOnInsert": {"created_at": _now()}},
            upsert=True)
        # tenant status follows subscription (active/suspended/expired/cancelled)
        tstatus = "active" if status in ("active", "trial") else "suspended"
        await db["tenants"].update_one({"_id": tenant_code},
                                       {"$set": {"status": tstatus, "updated_at": _now()}})
        return {"tenant_code": tenant_code, "status": status, "modules": modules}

    async def provision_user(self, *, tenant_code: str, user: dict) -> dict:
        """Create/update a user in the tenant from an external source. Returns external_user_id."""
        db = shared_db()
        if not await db["tenants"].find_one({"_id": tenant_code}):
            raise ProvisioningError("tenant_not_found")
        role_key = _NOETON_ROLE_MAP.get(user.get("role", "user"), "staff")
        role = await db["roles"].find_one({"tenant_id": tenant_code, "key": role_key})
        existing = await db["users"].find_one({"tenant_id": tenant_code, "email": user["email"]})
        full_name = f"{user.get('first_name','')} {user.get('last_name','')}".strip() or user["email"]
        if existing:
            await db["users"].update_one({"_id": existing["_id"]}, {"$set": {
                "full_name": full_name, "role_ids": [role["_id"]] if role else existing.get("role_ids", []),
                "status": "active" if user.get("is_active", True) else "suspended",
                "updated_at": _now()}})
            return {"external_user_id": str(existing["_id"]), "created": False}
        res = await db["users"].insert_one({
            "tenant_id": tenant_code, "email": user["email"],
            "password_hash": hash_password(secrets.token_urlsafe(9)),
            "full_name": full_name, "role_ids": [role["_id"]] if role else [],
            "pharmacy_ids": [], "status": "active" if user.get("is_active", True) else "suspended",
            "mfa_enabled": False, "refresh_token_version": 0, "must_change_password": True,
            "source": "platform", "created_at": _now(), "updated_at": _now()})
        return {"external_user_id": str(res.inserted_id), "created": True}

    async def list_users(self, *, tenant_code: str, since: datetime | None = None) -> list[dict]:
        db = shared_db()
        owner_roles = {r["_id"]: r.get("key") async for r in
                       db["roles"].find({"tenant_id": tenant_code})}
        query: dict = {"tenant_id": tenant_code}
        if since is not None:
            query["updated_at"] = {"$gte": since}   # incremental pull (?since=)
        out = []
        async for u in db["users"].find(query):
            role = next((owner_roles.get(rid) for rid in u.get("role_ids", [])
                         if owner_roles.get(rid)), "user")
            name = (u.get("full_name") or "").split()
            out.append({
                "external_user_id": str(u["_id"]), "email": u.get("email"),
                "first_name": name[0] if name else "", "last_name": name[-1] if len(name) > 1 else "",
                "role": role, "is_active": u.get("status") == "active",
                "last_login_at": u.get("last_login_at")})
        return out

    async def set_status(self, *, tenant_id: str, status: str) -> dict:
        if status not in {"active", "suspended"}:
            raise ProvisioningError("bad_status")
        db = shared_db()
        t = await db["tenants"].find_one({"_id": tenant_id})
        if not t:
            raise ProvisioningError("tenant_not_found")
        await db["tenants"].update_one({"_id": tenant_id},
                                       {"$set": {"status": status, "updated_at": _now()}})
        await db["subscriptions"].update_one({"tenant_id": tenant_id},
                                             {"$set": {"status": status, "updated_at": _now()}})
        return {"tenant_id": tenant_id, "status": status}
