"""SessionService — concurrent-session (seat) tracking.

A tenant may hold at most `subscription.seats` LIVE sessions at once. Each login opens ONE
session (a distinct device/browser) — even the SAME username on two computers is two sessions,
so both count toward the seat cap. A session is "live" while it pinged within
SESSION_IDLE_SECONDS; stale ones free their seat and are TTL-reaped (see core/db.py INDEXES).

The seat check happens at login (and when a lapsed session is revived on refresh); an already-open
session is never re-counted, so a normal token refresh keeps the same `sid` and never blocks.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.core.config import settings
from app.core.db import shared_db

SESSIONS = "user_sessions"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _cutoff() -> datetime:
    return _now() - timedelta(seconds=settings.SESSION_IDLE_SECONDS)


def tenant_seats(sub: dict | None) -> int:
    """Licensed concurrent sessions for a tenant. Every provisioned subscription sets `seats`;
    fall back to limits.users/pharmacies, then a lenient 1 so a mis-configured sub is never
    treated as unlimited (the cap is the whole point)."""
    sub = sub or {}
    limits = sub.get("limits") or {}
    return int(sub.get("seats") or limits.get("users") or limits.get("pharmacies") or 1)


async def live_count(tenant_id: str, exclude_sid: str | None = None) -> int:
    """Distinct LIVE sessions of a tenant (excluding impersonation + optionally one sid)."""
    q: dict = {"tenant_id": tenant_id, "impersonation": {"$ne": True},
               "last_active_at": {"$gte": _cutoff()}}
    if exclude_sid:
        q["_id"] = {"$ne": exclude_sid}
    return await shared_db()[SESSIONS].count_documents(q)


async def has_free_seat(tenant_id: str, seats: int, exclude_sid: str | None = None) -> bool:
    if not settings.CONCURRENT_SESSION_LIMIT:
        return True
    return await live_count(tenant_id, exclude_sid=exclude_sid) < max(1, seats)


async def open_session(tenant_id: str, user_id: str, *, sid: str | None = None,
                       impersonation: bool = False, ua: str | None = None,
                       ip: str | None = None) -> str:
    """Create (or revive, when `sid` is given) a session and return its id."""
    sid = sid or uuid.uuid4().hex
    now = _now()
    setf = {"tenant_id": tenant_id, "user_id": user_id, "last_active_at": now,
            "impersonation": bool(impersonation), "ua": (ua or "")[:200]}
    if ip:
        setf["ip"] = ip[:64]
    await shared_db()[SESSIONS].update_one(
        {"_id": sid},
        {"$set": setf, "$setOnInsert": {"created_at": now}},
        upsert=True)
    return sid


# ── force-logout: access tokens are stateless JWT, so admin «Αποσύνδεση» sets a short-lived Redis
# flag that get_current_context checks per-request → ο token πεθαίνει ΑΜΕΣΩΣ (όχι σε 15').
_REVOKE_TTL = int(getattr(settings, "ACCESS_TOKEN_TTL_SECONDS", 900))


async def mark_revoked(sid: str | None) -> None:
    """Block this session's access token immediately + free its seat. Το flag λήγει μόνο του όταν
    θα έληγε ούτως ή άλλως το access token."""
    if not sid:
        return
    try:
        from app.core.ratelimit import _redis
        await _redis().setex(f"revoked:sess:{sid}", _REVOKE_TTL, "1")
    except Exception:  # noqa: BLE001 — Redis down → μένει η ανάκληση refresh/seat (εντός 15')
        pass
    await close_session(sid)


async def is_revoked(sid: str | None) -> bool:
    if not sid:
        return False
    try:
        from app.core.ratelimit import _redis
        return bool(await _redis().exists(f"revoked:sess:{sid}"))
    except Exception:  # noqa: BLE001 — fail-open: ποτέ μη κλειδώσεις τους πάντες σε Redis hiccup
        return False


async def is_live(sid: str | None) -> bool:
    if not sid:
        return False
    doc = await shared_db()[SESSIONS].find_one({"_id": sid, "last_active_at": {"$gte": _cutoff()}})
    return doc is not None


async def touch(sid: str | None) -> None:
    """Heartbeat — extend a session's life (throttled by the caller)."""
    if not sid:
        return
    await shared_db()[SESSIONS].update_one({"_id": sid}, {"$set": {"last_active_at": _now()}})


async def close_session(sid: str | None) -> None:
    """Free the seat immediately (explicit logout)."""
    if not sid:
        return
    await shared_db()[SESSIONS].delete_one({"_id": sid})


async def close_user_sessions(user_id: str) -> int:
    """Drop ALL of a user's sessions (password change / reset / admin revoke) → every device is
    logged out and its seat freed. Complements the refresh_token_version bump."""
    if not user_id:
        return 0
    res = await shared_db()[SESSIONS].delete_many({"user_id": str(user_id)})
    return res.deleted_count
