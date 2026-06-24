"""AuthService — login / refresh with role→permission resolution."""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId

from app.core.db import shared_db
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    verify_password,
    verify_totp,
)


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


# Core modules are tenant-admin surfaces (settings: users/roles, plan, billing,
# ΗΔΥΚΑ connection) — always available regardless of subscription plan. Actual
# access is still enforced per-request by RBAC permissions (settings:read/write).
_CORE_MODULES = {"settings"}


def resolve_modules(included: set[str], overrides: dict[str, str]) -> dict[str, str]:
    """Merge plan modules + core modules, then apply tenant overrides (override wins)."""
    keys = set(included) | _CORE_MODULES
    modules = {m: overrides.get(m, "enabled") for m in keys}
    modules.update(overrides)
    return modules


def _as_object_id(value):
    try:
        return ObjectId(value)
    except Exception:  # noqa: BLE001
        return value


class AuthService:
    async def login(self, email: str, password: str, mfa_code: str | None) -> dict | None:
        db = shared_db()
        user = await db["users"].find_one({"email": email, "status": "active"})
        if not user or not verify_password(password, user["password_hash"]):
            return None
        # Enforce subscription/tenant access (kept fresh locally) —
        # a suspended/expired tenant cannot log in, no external call at login time.
        if not await self._tenant_access_ok(user["tenant_id"]):
            return None
        # MFA: if enabled, require a valid TOTP code (previously the code was ignored).
        # Distinct signal so the client can prompt for the code after a correct password.
        if user.get("mfa_enabled") and not verify_totp(user.get("mfa_secret", ""), mfa_code or ""):
            return {"mfa_required": True}
        await db["users"].update_one({"_id": user["_id"]},
                                     {"$set": {"last_login_at": _utcnow()}})  
        modules, roles, perms, demo = await self._resolve(user)
        return self._issue(user, roles, modules, perms, demo)

    async def _tenant_access_ok(self, tenant_id) -> bool:
        db = shared_db()
        tenant = await db["tenants"].find_one({"_id": tenant_id})
        if tenant and tenant.get("status") == "suspended":
            return False
        sub = await db["subscriptions"].find_one({"tenant_id": tenant_id})
        if sub and sub.get("status") in ("suspended", "cancelled", "expired"):
            return False
        return True

    async def refresh(self, refresh_token: str) -> dict | None:
        try:
            claims = decode_token(refresh_token)
        except ValueError:
            return None
        if claims.get("scope") != "refresh":
            return None
        db = shared_db()
        user = await db["users"].find_one({"_id": _as_object_id(claims["sub"])})
        if not user or user.get("refresh_token_version") != claims.get("ver"):
            return None  # revoked
        modules, roles, perms, demo = await self._resolve(user)
        return self._issue(user, roles, modules, perms, demo)

    async def issue_for_user(self, user: dict) -> dict:
        """Mint tokens for a user WITHOUT a password check or last_login update — used
        for admin impersonation. Reuses the user's own identity (no new seat/license)."""
        modules, roles, perms, demo = await self._resolve(user)
        return self._issue(user, roles, modules, perms, demo)

    async def _resolve(self, user: dict) -> tuple[dict, list[str], list[str], bool]:
        db = shared_db()
        tenant = await db["tenants"].find_one({"_id": user["tenant_id"]})
        sub = await db["subscriptions"].find_one({"tenant_id": user["tenant_id"]})

        # modules: plan + core modules, with tenant overrides applied
        modules = resolve_modules(
            set((sub or {}).get("modules_included", [])),
            (tenant or {}).get("modules", {}),
        )

        # permissions: union of the user's roles. role_ids may be stored as strings
        # (created via the API) — coerce to ObjectId so the $in actually matches.
        role_ids = [_as_object_id(r) for r in (user.get("role_ids") or [])]
        roles: list[str] = []
        perms: set[str] = set()
        # SECURITY: scope role lookup to the user's OWN tenant — otherwise a role_id from
        # another tenant (smuggled in via the users API) unions foreign permissions into
        # this token = cross-tenant privilege escalation.
        async for role in db["roles"].find(
            {"_id": {"$in": role_ids}, "tenant_id": user["tenant_id"]}):
            roles.append(role.get("key", str(role["_id"])))
            perms.update(role.get("permissions", []))
        # PII masking applies when EITHER the tenant is a «πελάτης παρουσίασης» (demo) OR this
        # specific user is GDPR-restricted (mask_pii) — e.g. a health advisor at the counter who
        # may operate but must not see patients' surname/ΑΜΚΑ/contact details.
        demo = bool((tenant or {}).get("demo")) or bool(user.get("mask_pii"))
        return modules, roles, sorted(perms), demo

    def _issue(self, user: dict, roles: list[str], modules: dict, perms: list[str],
               demo: bool = False) -> dict:
        uid, tid = str(user["_id"]), str(user["tenant_id"])
        return {
            "access_token": create_access_token(
                user_id=uid, tenant_id=tid, roles=roles, modules=modules, permissions=perms,
                demo=demo),
            "refresh_token": create_refresh_token(
                user_id=uid, tenant_id=tid, version=user.get("refresh_token_version", 0)),
            "expires_in": 900,
        }
