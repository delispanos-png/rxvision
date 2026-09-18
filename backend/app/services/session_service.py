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
# ΜΟΝΙΜΟ ΗΜΕΡΟΛΟΓΙΟ ΣΥΝΔΕΣΕΩΝ. Το `user_sessions` απαντά «ποιος είναι ΤΩΡΑ μέσα» και σβήνεται
# από TTL 15′ μετά την τελευταία κίνηση — άρα δεν αφήνει κανένα ίχνος. Για να απαντηθεί το
# «ποιος συνδέθηκε χθες και πόση ώρα έμεινε», η γραμμή γράφεται με το ΑΝΟΙΓΜΑ και κλείνει
# αργότερα· έτσι τίποτα δεν χάνεται ούτε αν ο browser κλείσει χωρίς αποσύνδεση.
LOG = "session_log"


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
            "ua": (ua or "")[:200]}
    if ip:
        setf["ip"] = ip[:64]
    # ⚠ Το `impersonation` ορίζεται ΜΟΝΟ στη ΓΕΝΝΗΣΗ της συνεδρίας ($setOnInsert) — ΠΟΤΕ σε revive/
    # refresh. Αλλιώς το πρώτο refresh του admin token (που καλεί open_session(sid=sid) χωρίς το flag)
    # θα «βάφτιζε» την impersonation ως ΚΑΝΟΝΙΚΗ → θα έπιανε seat → θα μπλόκαρε τον πραγματικό πελάτη.
    await shared_db()[SESSIONS].update_one(
        {"_id": sid},
        {"$set": setf, "$setOnInsert": {"created_at": now, "impersonation": bool(impersonation)}},
        upsert=True)
    await _log_open(sid, tenant_id, user_id, now, ua=ua, ip=ip, impersonation=impersonation)
    return sid


async def _log_open(sid: str, tenant_id: str, user_id: str, now, *, ua, ip, impersonation) -> None:
    """Γράψε τη γραμμή ιστορικού ΤΩΡΑ, στο άνοιγμα — όχι στο κλείσιμο.

    Αν την περιμέναμε στο κλείσιμο, κάθε συνεδρία που τελειώνει με «έκλεισα τον browser»
    (δηλαδή οι περισσότερες) δεν θα καταγραφόταν ποτέ.
    `$setOnInsert` στο `started_at`: σε revive/refresh η ίδια συνεδρία ΔΕΝ ξαναρχίζει.
    """
    try:
        await shared_db()[LOG].update_one({"_id": sid}, {
            "$set": {"tenant_id": tenant_id, "user_id": str(user_id),
                     "last_seen_at": now, "ua": (ua or "")[:200], **({"ip": ip[:64]} if ip else {})},
            "$setOnInsert": {"started_at": now, "impersonation": bool(impersonation),
                             "ended_at": None, "ended_reason": None},
        }, upsert=True)
    except Exception:  # noqa: BLE001 — το ιστορικό δεν πρέπει ΠΟΤΕ να εμποδίσει σύνδεση
        pass


async def _log_close(sid: str, reason: str) -> None:
    """Κλείσε τη γραμμή με τη ΔΙΑΡΚΕΙΑ. Ιδεμποτεντικό: ήδη κλεισμένη → δεν ξαναγράφεται."""
    try:
        db = shared_db()
        row = await db[LOG].find_one({"_id": sid})
        if not row or row.get("ended_at"):
            return
        # Τέλος = η τελευταία στιγμή που ΞΕΡΟΥΜΕ ότι ήταν μέσα. Στο logout είναι τώρα· στη λήξη
        # είναι η τελευταία κίνηση — όχι η ώρα που το πρόσεξε ο σαρωτής.
        end = _now() if reason == "logout" else (row.get("last_seen_at") or _now())
        start = row.get("started_at") or end
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        await db[LOG].update_one({"_id": sid, "ended_at": None}, {"$set": {
            "ended_at": end, "ended_reason": reason,
            "duration_seconds": max(0, int((end - start).total_seconds()))}})
    except Exception:  # noqa: BLE001
        pass


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
    await close_session(sid, reason="revoked")


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


async def close_session(sid: str | None, *, reason: str = "logout") -> None:
    """Free the seat immediately (explicit logout)."""
    if not sid:
        return
    await shared_db()[SESSIONS].delete_one({"_id": sid})
    await _log_close(sid, reason)


async def sweep() -> dict:
    """Συγχρόνισε το ιστορικό με την πραγματικότητα — τρέχει κάθε λίγα λεπτά.

    ΓΙΑΤΙ ΧΡΕΙΑΖΕΤΑΙ: οι περισσότερες συνεδρίες δεν τελειώνουν με «αποσύνδεση» — ο χρήστης
    κλείνει τον browser. Τότε κανείς δεν ειδοποιεί κανέναν: η συνεδρία απλώς παύει να στέλνει
    σήμα και μετά από 15′ το TTL τη σβήνει. Ο σαρωτής (α) κρατά ενήμερη την τελευταία κίνηση
    στο ιστορικό όσο η συνεδρία ζει και (β) κλείνει τις γραμμές που δεν έχουν πια συνεδρία.
    """
    db = shared_db()
    now = _now()
    live = {}
    async for s in db[SESSIONS].find({}, {"last_active_at": 1}):
        live[str(s["_id"])] = s.get("last_active_at")
    synced = closed = 0
    # (α) ενήμερη «τελευταία κίνηση» για τις ζωντανές — ώστε αν χαθεί η συνεδρία ανάμεσα σε δύο
    #     περάσματα, η διάρκεια να είναι το πολύ λίγα λεπτά λάθος, ποτέ μηδέν.
    for sid, la in live.items():
        if la:
            await db[LOG].update_one({"_id": sid, "ended_at": None},
                                     {"$set": {"last_seen_at": la}})
            synced += 1
    # (β) ανοιχτές γραμμές χωρίς ζωντανή συνεδρία → τελείωσαν
    async for row in db[LOG].find({"ended_at": None}, {"_id": 1}):
        sid = str(row["_id"])
        if sid in live:
            continue
        await _log_close(sid, "expired")
        closed += 1
    return {"synced": synced, "closed": closed, "at": now}


async def history(*, tenant_id: str | None = None, user_id: str | None = None,
                  days: int = 30, include_impersonation: bool = False,
                  limit: int = 500) -> list[dict]:
    """Ιστορικό συνδέσεων: ποιος, πότε μπήκε, πότε βγήκε, πόση ώρα έμεινε."""
    db = shared_db()
    q: dict = {"started_at": {"$gte": _now() - timedelta(days=max(1, days))}}
    if tenant_id:
        q["tenant_id"] = tenant_id
    if user_id:
        q["user_id"] = str(user_id)
    if not include_impersonation:
        q["impersonation"] = {"$ne": True}
    return [r async for r in db[LOG].find(q).sort("started_at", -1).limit(min(2000, limit))]


async def close_user_sessions(user_id: str) -> int:
    """Drop ALL of a user's sessions (password change / reset / admin revoke) → every device is
    logged out and its seat freed. Complements the refresh_token_version bump."""
    if not user_id:
        return 0
    sids = await shared_db()[SESSIONS].distinct("_id", {"user_id": str(user_id)})
    res = await shared_db()[SESSIONS].delete_many({"user_id": str(user_id)})
    for sid in sids:
        await _log_close(str(sid), "revoked")
    return res.deleted_count
