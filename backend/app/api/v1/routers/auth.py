"""Auth router — login / refresh / me + self-service account actions."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field

from app.core.deps import TenantContext, get_current_context
from app.core.ratelimit import (
    account_locked, clear_login_failures, client_ip, rate_limit, record_login_failure,
)
from app.services import session_service as sessions
from app.services.account_service import AccountError, AccountService
from app.services.auth_service import AuthService

router = APIRouter()


class LoginIn(BaseModel):
    email: EmailStr
    password: str
    mfa_code: str | None = None


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int


class RefreshIn(BaseModel):
    refresh_token: str


class ProfileIn(BaseModel):
    full_name: str | None = Field(None, max_length=120)
    phone: str | None = Field(None, max_length=40)


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8, max_length=128)


class ForgotPasswordIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    token: str
    new_password: str = Field(..., min_length=8, max_length=128)


@router.post("/login", response_model=TokenOut,
             dependencies=[Depends(rate_limit("auth_login", limit=10, window_seconds=300))])
async def login(body: LoginIn, request: Request):
    locked = await account_locked(body.email)
    if locked:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"error": "account_locked", "retry_after": locked},
            headers={"Retry-After": str(locked)})
    result = await AuthService().login(
        body.email, body.password, body.mfa_code,
        user_agent=request.headers.get("user-agent"), ip=client_ip(request))
    if result is None:
        await record_login_failure(body.email)  # count only true credential failures
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")
    if result.get("access_blocked"):
        # Σωστός κωδικός, αλλά η συνδρομή/δοκιμαστική έχει λήξει ή ο λογαριασμός είναι σε αναστολή.
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail={"error": "access_blocked"})
    if result.get("mfa_required"):
        # Password OK but a valid TOTP code is required — client should prompt for it.
        # If a code WAS submitted and rejected, count it as a failure so TOTP guessing also
        # trips the per-account lockout (otherwise MFA bypasses brute-force protection).
        if body.mfa_code:
            await record_login_failure(body.email)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"error": "mfa_required"})
    if result.get("seat_limit"):
        # Correct credentials, but the tenant's concurrent-user (seat) cap is full.
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={"error": "seat_limit", "seats": result.get("seats")})
    await clear_login_failures(body.email)
    return result


@router.post("/refresh", response_model=TokenOut)
async def refresh(body: RefreshIn):
    tokens = await AuthService().refresh(body.refresh_token)
    if tokens is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_refresh")
    return tokens


@router.post("/logout")
async def logout(ctx: TenantContext = Depends(get_current_context)):
    """Close THIS session and free its seat immediately (client also drops its tokens)."""
    await sessions.close_session(ctx.sid)
    return {"ok": True}


class SelectTenantIn(BaseModel):
    tenant_id: str = Field(..., max_length=80)


@router.post("/select-tenant", response_model=TokenOut)
async def select_tenant(body: SelectTenantIn, ctx: TenantContext = Depends(get_current_context)):
    """Δίκτυο φαρμακείων: εναλλαγή ενεργού φαρμακείου — ΜΟΝΟ σε όσα έχουν δηλωθεί στον χρήστη."""
    res = await AuthService().select_tenant(ctx.user_id, body.tenant_id, sid=ctx.sid)
    if res is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no_access_to_pharmacy")
    if res.get("seat_limit"):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            detail={"error": "seat_limit", "seats": res.get("seats")})
    return res


@router.get("/me")
async def me(ctx: TenantContext = Depends(get_current_context)):
    profile = await AccountService().get_profile(ctx.user_id)
    # Δίκτυο φαρμακείων: τα φαρμακεία στα οποία επιτρέπεται να μπει ΑΥΤΟΣ ο χρήστης (>1 → επιλογέας).
    from app.core.db import shared_db
    from app.services.auth_service import _as_object_id
    u = await shared_db()["users"].find_one({"_id": _as_object_id(ctx.user_id)})
    pharmacies = await AuthService().accessible_pharmacies(u) if u else []
    return {
        "user_id": ctx.user_id,
        "tenant_id": ctx.tenant_id,
        "pharmacies": pharmacies,
        "roles": ctx.roles,
        "modules": ctx.modules,
        "demo": ctx.demo,                # «πελάτης παρουσίασης» → frontend κλειδώνει εκτυπώσεις ΗΔΥΚΑ/κουπονιών
        **profile,                       # full_name, email, phone, mfa_enabled
    }


@router.patch("/profile")
async def update_profile(body: ProfileIn, ctx: TenantContext = Depends(get_current_context)):
    return await AccountService().update_profile(
        ctx.user_id, full_name=body.full_name, phone=body.phone)


@router.post("/change-password")
async def change_password(body: ChangePasswordIn, ctx: TenantContext = Depends(get_current_context)):
    try:
        await AccountService().change_password(ctx.user_id, body.current_password, body.new_password)
    except AccountError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"error": str(e)})
    return {"ok": True}


@router.post("/forgot-password",
             dependencies=[Depends(rate_limit("auth_forgot", limit=5, window_seconds=900))])
async def forgot_password(body: ForgotPasswordIn):
    await AccountService().forgot_password(body.email)
    return {"ok": True}  # always ok — never leak whether the email exists


@router.post("/reset-password",
             dependencies=[Depends(rate_limit("auth_reset", limit=10, window_seconds=900))])
async def reset_password(body: ResetPasswordIn):
    try:
        await AccountService().reset_password(body.token, body.new_password)
    except AccountError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"error": str(e)})
    return {"ok": True}
