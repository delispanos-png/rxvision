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
    )
    request.state.tenant = ctx
    return ctx


def require(permission: str, module: str | None = None):
    """Dependency factory: enforce permission AND (optionally) module access."""

    async def _dep(ctx: TenantContext = Depends(get_current_context)) -> TenantContext:
        if module is not None and ctx.modules.get(module, "locked") == "locked":
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={"error": "module_locked", "module": module},
            )
        if permission not in ctx.permissions and "*" not in ctx.permissions:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "insufficient_permissions")
        return ctx

    return _dep
