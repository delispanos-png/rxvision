"""JWT (access + rotating refresh) and password hashing."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from jose import JWTError, jwt

from app.core.config import settings

_ph = PasswordHasher()


def hash_password(raw: str) -> str:
    return _ph.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, raw)
    except VerifyMismatchError:
        return False


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def create_access_token(*, user_id: str, tenant_id: str, roles: list[str],
                        modules: dict[str, str], permissions: list[str] | None = None) -> str:
    payload = {
        "sub": user_id,
        "tid": tenant_id,
        "roles": roles,
        "modules": modules,
        "perms": permissions or [],
        "scope": "access",
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
        "iat": _now(),
        "exp": _now() + timedelta(seconds=settings.ACCESS_TOKEN_TTL_SECONDS),
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALG)


def create_platform_refresh_token(*, admin_id: str, version: int) -> str:
    payload = {
        "sub": admin_id,
        "ver": version,
        "padmin": True,
        "scope": "refresh",
        "iat": _now(),
        "exp": _now() + timedelta(seconds=settings.REFRESH_TOKEN_TTL_SECONDS),
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALG)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALG])
    except JWTError as exc:  # noqa: BLE001
        raise ValueError("invalid_token") from exc
