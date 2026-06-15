"""JWT (access + rotating refresh) and password hashing."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from jose import JWTError, jwt

from app.core.config import settings

_ph = PasswordHasher()

# Audience claims give the two identity classes distinct, verified domains — a token
# minted for one is rejected when presented to the other (combined with separate keys). (H1)
AUD_TENANT = "rxvision/tenant"
AUD_PLATFORM = "rxvision/platform"
AUD_PATIENT = "rxvision/patient"   # 3rd identity: pharmacy customer (patient portal)


def hash_password(raw: str) -> str:
    return _ph.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, raw)
    except VerifyMismatchError:
        return False


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def verify_totp(secret: str, code: str) -> bool:
    """Verify a TOTP code against the user's secret (±1 step for clock skew).
    Lazy import keeps pyotp optional at module-import time."""
    if not secret or not code:
        return False
    try:
        import pyotp
        return pyotp.TOTP(secret).verify(code.strip(), valid_window=1)
    except Exception:  # noqa: BLE001
        return False


def create_access_token(*, user_id: str, tenant_id: str, roles: list[str],
                        modules: dict[str, str], permissions: list[str] | None = None) -> str:
    payload = {
        "sub": user_id,
        "tid": tenant_id,
        "roles": roles,
        "modules": modules,
        "perms": permissions or [],
        "scope": "access",
        "aud": AUD_TENANT,
        "iat": _now(),
        "exp": _now() + timedelta(seconds=settings.ACCESS_TOKEN_TTL_SECONDS),
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALG)


def create_refresh_token(*, user_id: str, tenant_id: str, version: int) -> str:
    payload = {
        "sub": user_id,
        "tid": tenant_id,
        "ver": version,            # bumped on logout / password change to revoke
        "scope": "refresh",
        "aud": AUD_TENANT,
        "iat": _now(),
        "exp": _now() + timedelta(seconds=settings.REFRESH_TOKEN_TTL_SECONDS),
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALG)


def create_platform_token(*, admin_id: str, email: str) -> str:
    """Access token for a CloudOn platform admin — NO tenant, marked `padmin`."""
    payload = {
        "sub": admin_id,
        "email": email,
        "padmin": True,
        "scope": "access",
        "aud": AUD_PLATFORM,
        "iat": _now(),
        "exp": _now() + timedelta(seconds=settings.ACCESS_TOKEN_TTL_SECONDS),
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.JWT_PLATFORM_SECRET, algorithm=settings.JWT_ALG)


def create_platform_refresh_token(*, admin_id: str, version: int) -> str:
    payload = {
        "sub": admin_id,
        "ver": version,
        "padmin": True,
        "scope": "refresh",
        "aud": AUD_PLATFORM,
        "iat": _now(),
        "exp": _now() + timedelta(seconds=settings.REFRESH_TOKEN_TTL_SECONDS),
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.JWT_PLATFORM_SECRET, algorithm=settings.JWT_ALG)


def create_patient_token(*, account_id: str, tenant_id: str, patient_ref: str) -> str:
    """Access token for a PATIENT (pharmacy customer). Carries the active pharmacy (`tid`) and
    that pharmacy's pseudonymised patient record (`pref`) so the API scopes to the patient's own
    data only. Signed with JWT_PATIENT_SECRET + audience rxvision/patient (isolated from tenant/admin)."""
    payload = {
        "sub": account_id,
        "pat": True,
        "tid": tenant_id,
        "pref": patient_ref,
        "scope": "access",
        "aud": AUD_PATIENT,
        "iat": _now(),
        "exp": _now() + timedelta(seconds=settings.ACCESS_TOKEN_TTL_SECONDS),
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.JWT_PATIENT_SECRET, algorithm=settings.JWT_ALG)


def create_patient_refresh_token(*, account_id: str, version: int) -> str:
    payload = {
        "sub": account_id,
        "ver": version,
        "pat": True,
        "scope": "refresh",
        "aud": AUD_PATIENT,
        "iat": _now(),
        "exp": _now() + timedelta(seconds=settings.REFRESH_TOKEN_TTL_SECONDS),
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.JWT_PATIENT_SECRET, algorithm=settings.JWT_ALG)


def decode_patient_token(token: str) -> dict:
    """Decode a PATIENT token (signed with JWT_PATIENT_SECRET, audience rxvision/patient)."""
    try:
        return jwt.decode(token, settings.JWT_PATIENT_SECRET, algorithms=[settings.JWT_ALG],
                          audience=AUD_PATIENT)
    except JWTError as exc:  # noqa: BLE001
        raise ValueError("invalid_token") from exc


def decode_token(token: str) -> dict:
    """Decode a TENANT token (signed with JWT_SECRET, audience rxvision/tenant)."""
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALG],
                          audience=AUD_TENANT)
    except JWTError as exc:  # noqa: BLE001
        raise ValueError("invalid_token") from exc


def decode_platform_token(token: str) -> dict:
    """Decode a PLATFORM-admin token (signed with JWT_PLATFORM_SECRET, audience
    rxvision/platform). A tenant token fails here on both key and audience."""
    try:
        return jwt.decode(token, settings.JWT_PLATFORM_SECRET, algorithms=[settings.JWT_ALG],
                          audience=AUD_PLATFORM)
    except JWTError as exc:  # noqa: BLE001
        raise ValueError("invalid_token") from exc
