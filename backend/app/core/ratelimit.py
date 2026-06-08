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
    # Behind Caddy the real client is the left-most X-Forwarded-For entry.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
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
