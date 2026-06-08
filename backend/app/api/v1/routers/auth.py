"""Auth router — login / refresh / me + self-service account actions."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from app.core.deps import TenantContext, get_current_context
from app.core.ratelimit import rate_limit
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
async def login(body: LoginIn):
    result = await AuthService().login(body.email, body.password, body.mfa_code)
    if result is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")
    if result.get("mfa_required"):
        # Password OK but a valid TOTP code is required — client should prompt for it.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"error": "mfa_required"})
    return result


@router.post("/refresh", response_model=TokenOut)
async def refresh(body: RefreshIn):
    tokens = await AuthService().refresh(body.refresh_token)
    if tokens is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_refresh")
    return tokens


@router.get("/me")
async def me(ctx: TenantContext = Depends(get_current_context)):
    profile = await AccountService().get_profile(ctx.user_id)
    return {
        "user_id": ctx.user_id,
        "tenant_id": ctx.tenant_id,
        "roles": ctx.roles,
        "modules": ctx.modules,
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
