"""Lightweight Redis-backed fixed-window rate limiting for auth endpoints.

Uses the existing Redis (shared with Celery/cache) so limits hold across all API
workers/instances. Fails OPEN on Redis errors — a Redis outage must never lock everyone
out of login. Keyed by client IP per endpoint.
"""

from __future__ import annotations

import logging

import redis.asyncio as aioredis
from fastapi import HTTPException, Request, status

from app.core.config import settings

logger = logging.getLogger(__name__)

_client: aioredis.Redis | None = None


def _redis() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    return _client


def _client_ip(request: Request) -> str:
    # SECURITY: Cloudflare sets CF-Connecting-IP to the TRUE client and overwrites any
    # client-supplied value, so it's authoritative. We do NOT trust the left-most
    # X-Forwarded-For entry — a client can spoof it to rotate the key and bypass the limit.
    cf = request.headers.get("cf-connecting-ip")
    if cf:
        return cf.strip()
    return request.client.host if request.client else "unknown"


async def _safe_ttl(key: str) -> int:
    try:
        ttl = await _redis().ttl(key)
        return ttl if ttl and ttl > 0 else 0
    except Exception:  # noqa: BLE001
        return 0


def rate_limit(name: str, *, limit: int, window_seconds: int):
    """FastAPI dependency: allow at most `limit` requests per `window_seconds` per client
    IP for endpoint `name`. Raises 429 (with Retry-After) when exceeded."""

    async def _dep(request: Request) -> None:
        key = f"rl:{name}:{_client_ip(request)}"
        try:
            count = await _redis().incr(key)
            # Set the window only on the first hit (nx) so it can't slide forever.
            await _redis().expire(key, window_seconds, nx=True)
        except Exception as exc:  # noqa: BLE001 — never let a Redis hiccup block auth
            logger.warning("rate-limit check skipped (redis error: %s)", exc)
            return
        if count > limit:
            ttl = await _safe_ttl(key)
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                detail={"error": "rate_limited", "retry_after": ttl},
                headers={"Retry-After": str(ttl)},
            )

    return _dep


# ── Per-account login lockout (complements the IP limit) ────────────────────────
# Keyed by email: after _LOCK_THRESHOLD failures within _LOCK_WINDOW, the account is
# locked for _LOCK_DURATION. Fails OPEN on Redis errors. NB: an email-keyed lock allows
# a targeted lock-out (DoS) of a known account — kept moderate (threshold + short TTL) to
# bound that. Always pair with the IP rate limit on the login route.
_LOCK_THRESHOLD = 8
_LOCK_WINDOW = 900
_LOCK_DURATION = 900


async def account_locked(email: str) -> int:
    """Remaining lock seconds (>0 if currently locked), else 0."""
    return await _safe_ttl(f"lock:{email.strip().lower()}")


async def record_login_failure(email: str) -> None:
    e = email.strip().lower()
    try:
        r = _redis()
        n = await r.incr(f"fail:{e}")
        await r.expire(f"fail:{e}", _LOCK_WINDOW, nx=True)
        if n >= _LOCK_THRESHOLD:
            await r.set(f"lock:{e}", "1", ex=_LOCK_DURATION)
            await r.delete(f"fail:{e}")
    except Exception as exc:  # noqa: BLE001 — never let Redis block auth
        logger.warning("login-failure tracking skipped (redis error: %s)", exc)


async def clear_login_failures(email: str) -> None:
    e = email.strip().lower()
    try:
        await _redis().delete(f"fail:{e}", f"lock:{e}")
    except Exception:  # noqa: BLE001
        pass
