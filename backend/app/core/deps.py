"""Auth/RBAC/tenant dependencies used by routers."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.security import decode_patient_token, decode_platform_token, decode_token

_bearer = HTTPBearer(auto_error=True)


@dataclass
class TenantContext:
    tenant_id: str
    user_id: str
    roles: list[str]
    modules: dict[str, str]          # module_key -> enabled|trial|locked
    permissions: set[str]            # resolved from roles (filled by middleware/service)
    demo: bool = False               # «πελάτης παρουσίασης» → απόκρυψη PII (επίθετο/ΑΜΚΑ)


@dataclass
class PlatformContext:
    """A CloudOn platform admin — no tenant, manages the whole platform."""

    admin_id: str
    email: str


@dataclass
class PatientContext:
    """A pharmacy customer (patient portal). `tenant_id` = the active pharmacy, `patient_ref` =
    that pharmacy's pseudonymised patient record. The API scopes STRICTLY to this patient's own data."""

    account_id: str
    tenant_id: str
    patient_ref: str


async def get_platform_admin(
    request: Request,
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> PlatformContext:
    """Gate for the back-office: requires a platform-admin token (`padmin`), NOT a
    tenant `owner`. A tenant token (different key + audience) is rejected here."""
    try:
        claims = decode_platform_token(creds.credentials)
    except ValueError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_token")
    if claims.get("scope") != "access" or not claims.get("padmin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "platform_admin_required")
    admin = PlatformContext(admin_id=claims["sub"], email=claims.get("email", ""))
    request.state.admin = admin  # so AuditMiddleware can log platform-admin actions
    return admin


async def get_patient_context(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> PatientContext:
    """Gate for the patient portal: requires a PATIENT token (`pat`, audience rxvision/patient).
    Tenant/admin tokens are rejected (separate key + audience)."""
    try:
        claims = decode_patient_token(creds.credentials)
    except ValueError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_token")
    if claims.get("scope") != "access" or not claims.get("pat"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "patient_token_required")
    tid, pref = claims.get("tid"), claims.get("pref")
    if not tid or not pref:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "incomplete_patient_token")
    return PatientContext(account_id=claims["sub"], tenant_id=tid, patient_ref=pref)


async def get_current_context(
    request: Request,
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> TenantContext:
    try:
        claims = decode_token(creds.credentials)
    except ValueError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_token")
    if claims.get("scope") != "access":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_token_scope")
    # Domain separation: a platform-admin token must never be accepted as a tenant
    # identity, even though both are signed with the same key (H1).
    if claims.get("padmin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "platform_token_not_allowed")
    tenant_id = claims.get("tid")
    if not tenant_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing_tenant")

    ctx = TenantContext(
        tenant_id=tenant_id,
        user_id=claims["sub"],
        roles=claims.get("roles", []),
        modules=claims.get("modules", {}),
        permissions=set(claims.get("perms", [])),
        demo=bool(claims.get("demo", False)),
    )
    request.state.tenant = ctx
    await _touch_activity(ctx.user_id)
    await _touch_serving(ctx.tenant_id)
    return ctx


# ── concurrent-users tracking: stamp users.last_active_at, throttled to ≤1 write/min/user ──
_ACTIVITY_SEEN: dict[str, float] = {}


async def _touch_activity(user_id: str) -> None:
    import time as _t

    now = _t.time()
    if now - _ACTIVITY_SEEN.get(user_id, 0.0) < 60:
        return
    _ACTIVITY_SEEN[user_id] = now
    try:
        from datetime import datetime, timezone

        from bson import ObjectId

        from app.core.db import shared_db
        oid = ObjectId(user_id) if ObjectId.is_valid(user_id) else user_id
        await shared_db()["users"].update_one(
            {"_id": oid}, {"$set": {"last_active_at": datetime.now(tz=timezone.utc)}})
    except Exception:  # noqa: BLE001 — activity stamping must never break a request
        pass


# ── load-visibility: which app node last served each tenant (throttled ≤1 write/min/tenant) ──
_SERVING_SEEN: dict[str, float] = {}


async def _touch_serving(tenant_id: str) -> None:
    import os
    import time as _t

    node = os.environ.get("NODE_NAME")
    if not node or not tenant_id:
        return
    now = _t.time()
    if now - _SERVING_SEEN.get(tenant_id, 0.0) < 60:
        return
    _SERVING_SEEN[tenant_id] = now
    try:
        from datetime import datetime, timezone

        from app.core.db import shared_db
        await shared_db()["tenant_serving"].update_one(
            {"_id": tenant_id},
            {"$set": {"node": node, "last_at": datetime.now(tz=timezone.utc)}, "$inc": {"hits": 1}},
            upsert=True)
    except Exception:  # noqa: BLE001 — must never break a request
        pass


def require(permission: str, module: str | list[str] | None = None):
    """Dependency factory: enforce permission AND (optionally) module access.

    `module` may be a single key or a list — a list passes if ANY of the modules is unlocked
    (enabled/trial), e.g. PharmaCat is reachable via either the `ai_assistant` bundle or the
    standalone `pharmacat` add-on."""

    async def _dep(ctx: TenantContext = Depends(get_current_context)) -> TenantContext:
        if module is not None:
            mods = [module] if isinstance(module, str) else list(module)
            if all(ctx.modules.get(m, "locked") == "locked" for m in mods):
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN,
                    detail={"error": "module_locked", "module": mods[0] if len(mods) == 1 else mods},
                )
        if permission not in ctx.permissions and "*" not in ctx.permissions:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "insufficient_permissions")
        return ctx

    return _dep
