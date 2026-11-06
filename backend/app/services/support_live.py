"""Ζωντανή υποστήριξη: ο supporter βλέπει την οθόνη του φαρμακοποιού από το adminpanel.

Δύο είσοδοι: ο πελάτης δίνει 6ψήφιο κωδικό, ή ο supporter διαλέγει ενεργή σύνδεση και μπαίνει χωρίς
κωδικό (απόφαση ιδιοκτήτη 06/11/2026, υπάρχει σύμβαση εχεμύθειας). Και στις δύο ο πελάτης βλέπει
μόνιμη μπάρα με το όνομα του supporter και τερματίζει όποτε θέλει, και η εφαρμογή δεν στέλνει τίποτα
πριν μπει ο supporter. Ο supporter δεν ανοίγει συνεδρία χρήστη, άρα δεν πιάνει θέση. Οι αλλαγές της οθόνης περνούν μόνο από το Redis, κρυπτογραφημένες,
και σβήνονται τη στιγμή που τις διαβάζει ο supporter: δεν υπάρχει εγγραφή για μετά.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from datetime import datetime, timedelta, timezone

import redis.asyncio as aioredis
from bson import ObjectId

from app.core.config import settings
from app.core.db import shared_db
from app.services.platform_secrets import pdec, penc

CODE_TTL = 600                # 10′ για να δοθεί ο κωδικός
SESSION_TTL = 3600            # σκληρό όριο συνεδρίας
ENDED_TTL = 120               # να προλάβουν και οι δύο πλευρές να δουν το τέλος
MAX_BATCH_CHARS = 6_000_000   # κάτω από το όριο 8MB του Caddy, μετά την κρυπτογράφηση
MAX_QUEUE = 120               # αργός supporter: ξαναρχίζουμε από νέα εικόνα, δεν μαζεύουμε δεδομένα
PULL_BATCHES = 40

_client: aioredis.Redis | None = None


def _redis() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(settings.REDIS_URL, decode_responses=True,
                                    socket_timeout=5, socket_connect_timeout=2)
    return _client


def _s(sid: str) -> str:
    return f"sl:s:{sid}"


def _q(sid: str) -> str:
    return f"sl:q:{sid}"


def _c(code: str) -> str:
    return f"sl:c:{code}"


def _u(tenant_id: str, user_id: str) -> str:
    return f"sl:u:{tenant_id}:{user_id}"


def _t(login_sid: str) -> str:
    return f"sl:t:{login_sid}"


def _now() -> float:
    return time.time()


async def _audit(action: str, tenant_id: str, **extra) -> None:
    await shared_db()["audit_logs"].insert_one({  # tenant-ok: platform audit record
        "tenant_id": tenant_id, "action": action, "at": datetime.now(tz=timezone.utc), **extra})


async def _new_code(r) -> str:
    for _ in range(20):
        code = f"{secrets.randbelow(900000) + 100000}"
        if await r.set(_c(code), "", ex=CODE_TTL, nx=True):
            return code
    raise RuntimeError("support_live_no_code")


async def start(tenant_id: str, user_id: str, user_label: str, tenant_name: str) -> dict:
    """Νέα συνεδρία πελάτη. Μία ανά χρήστη: νέο ξεκίνημα κλείνει την προηγούμενη."""
    r = _redis()
    old = await r.get(_u(tenant_id, user_id))
    if old:
        await end(old, by="customer")
    sid, code = secrets.token_urlsafe(18), await _new_code(r)
    await r.set(_c(code), sid, ex=CODE_TTL)
    await r.hset(_s(sid), mapping={
        "tenant_id": tenant_id, "user_id": user_id, "user_label": user_label,
        "tenant_name": tenant_name, "status": "waiting", "code": code, "started_at": _now(),
        "customer_seen": _now(), "pointer_seq": 0})
    await r.expire(_s(sid), SESSION_TTL)
    await r.set(_u(tenant_id, user_id), sid, ex=SESSION_TTL)
    await _audit("support_live_started", tenant_id, actor_user_id=user_id)
    return {"sid": sid, "code": code, "status": "waiting", "code_ttl": CODE_TTL}


async def online_sessions() -> list[dict]:
    """Ποιοι είναι μέσα τώρα, χωρίς τις δικές μας συνδέσεις «ως πελάτης»."""
    db = shared_db()
    cutoff = datetime.now(tz=timezone.utc) - timedelta(seconds=settings.SESSION_IDLE_SECONDS)
    sessions = [s async for s in db["user_sessions"].find(  # tenant-ok: platform support view
        {"last_active_at": {"$gte": cutoff}, "impersonation": {"$ne": True}}).sort("last_active_at", -1)]
    tids = list({s.get("tenant_id") for s in sessions})
    names = {t["_id"]: t.get("name") async for t in db["tenants"].find({"_id": {"$in": tids}}, {"name": 1})}
    uids = [ObjectId(s["user_id"]) for s in sessions if ObjectId.is_valid(s.get("user_id"))]
    users = {str(u["_id"]): u.get("full_name") or u.get("email")
             async for u in db["users"].find(  # tenant-ok: platform support view
                 {"_id": {"$in": uids}}, {"full_name": 1, "email": 1})}
    return [{"login_sid": s["_id"], "tenant_id": s.get("tenant_id"),
             "tenant_name": names.get(s.get("tenant_id")) or s.get("tenant_id"),
             "user_label": users.get(str(s.get("user_id"))) or "—",
             "user_id": str(s.get("user_id")), "last_active_at": s.get("last_active_at")}
            for s in sessions]


async def connect(login: dict, admin_id: str, admin_label: str, admin_email: str) -> dict:
    """Είσοδος χωρίς κωδικό σε ενεργή σύνδεση: η εφαρμογή του πελάτη τη βρίσκει με το `claim`."""
    r = _redis()
    tenant_id, user_id, login_sid = login["tenant_id"], login["user_id"], login["login_sid"]
    old = await r.get(_u(tenant_id, user_id))
    if old:
        await end(old, by="supporter")
    sid = secrets.token_urlsafe(18)
    await r.hset(_s(sid), mapping={
        "tenant_id": tenant_id, "user_id": user_id, "user_label": login["user_label"],
        "tenant_name": login["tenant_name"], "status": "live", "login_sid": login_sid,
        "started_at": _now(), "joined_at": _now(), "customer_seen": _now(), "admin_seen": _now(),
        "admin_id": admin_id, "admin_email": admin_email, "supporter": admin_label, "pointer_seq": 0})
    await r.expire(_s(sid), SESSION_TTL)
    await r.set(_u(tenant_id, user_id), sid, ex=SESSION_TTL)
    await r.set(_t(login_sid), sid, ex=SESSION_TTL)
    await _audit("support_live_joined", tenant_id, by=admin_email, as_user=login["user_label"],
                 without_code=True)
    return {"sid": sid, "tenant_name": login["tenant_name"], "user_label": login["user_label"],
            "tenant_id": tenant_id}


async def claim(login_sid: str | None) -> str | None:
    """Μία καρτέλα παίρνει τη συνεδρία: δύο που στέλνουν μαζί χαλούν την εικόνα."""
    return await _redis().getdel(_t(login_sid)) if login_sid else None


async def _meta(sid: str) -> dict | None:
    return (await _redis().hgetall(_s(sid))) or None


async def customer_session(sid: str, tenant_id: str, user_id: str) -> dict | None:
    """Μόνο ο χρήστης που την ξεκίνησε βλέπει ή στέλνει στη συνεδρία του."""
    m = await _meta(sid)
    if not m or m.get("tenant_id") != tenant_id or m.get("user_id") != user_id:
        return None
    return m


async def admin_session(sid: str, admin_id: str) -> dict | None:
    """Μόνο ο supporter που έδωσε τον κωδικό: κανένας δεύτερος δεν μπαίνει με το id."""
    m = await _meta(sid)
    if not m or m.get("admin_id") != admin_id:
        return None
    return m


async def customer_state(sid: str, m: dict) -> dict:
    r = _redis()
    await r.hset(_s(sid), "customer_seen", _now())
    snapshot = await r.hdel(_s(sid), "need_snapshot")
    pointer = None
    if m.get("pointer"):
        x, y = m["pointer"].split(",")
        pointer = {"x": float(x), "y": float(y), "seq": int(m.get("pointer_seq") or 0)}
    return {"status": m.get("status"), "code": m.get("code") if m.get("status") == "waiting" else None,
            "supporter": m.get("supporter"), "need_snapshot": bool(snapshot), "pointer": pointer}


async def join(code: str, admin_id: str, admin_label: str, admin_email: str) -> dict | None:
    """Ο κωδικός χρησιμοποιείται μία φορά: μετά την πρώτη είσοδο δεν ανοίγει δεύτερος θεατής."""
    r = _redis()
    sid = await r.getdel(_c(code))
    m = await _meta(sid) if sid else None
    if not m or m.get("status") != "waiting":
        return None
    await r.hset(_s(sid), mapping={"status": "live", "admin_id": admin_id, "admin_email": admin_email,
                                   "supporter": admin_label, "joined_at": _now(),
                                   "admin_seen": _now()})
    await r.hdel(_s(sid), "code")
    await _audit("support_live_joined", m["tenant_id"], by=admin_email, as_user=m.get("user_label"))
    return {"sid": sid, "tenant_name": m.get("tenant_name"), "user_label": m.get("user_label"),
            "tenant_id": m["tenant_id"]}


async def push(sid: str, m: dict, data: str) -> bool:
    """Δέχεται δεδομένα ΜΟΝΟ όταν έχει μπει supporter."""
    if m.get("status") != "live":
        return False
    r = _redis()
    enc = await asyncio.to_thread(penc, data)
    size = await r.rpush(_q(sid), enc)
    if size > MAX_QUEUE:
        await r.delete(_q(sid))
        await r.hset(_s(sid), "need_snapshot", 1)
    else:
        await r.expire(_q(sid), max(1, await r.ttl(_s(sid))))
    return True


async def pull(sid: str, m: dict) -> dict:
    r = _redis()
    await r.hset(_s(sid), "admin_seen", _now())
    raw = await r.lpop(_q(sid), PULL_BATCHES) or []
    batches = await asyncio.to_thread(lambda: [pdec(x) for x in raw])
    return {"status": m.get("status"), "batches": batches,
            "customer_idle": int(_now() - float(m.get("customer_seen") or 0))}


async def request_snapshot(sid: str) -> None:
    await _redis().hset(_s(sid), "need_snapshot", 1)


async def set_pointer(sid: str, x: float, y: float) -> None:
    r = _redis()
    await r.hset(_s(sid), "pointer", f"{round(x, 1)},{round(y, 1)}")
    await r.hincrby(_s(sid), "pointer_seq", 1)


async def end(sid: str, *, by: str) -> None:
    r = _redis()
    m = await _meta(sid)
    await r.delete(_q(sid))
    if not m or m.get("status") == "ended":
        return
    if m.get("code"):
        await r.delete(_c(m["code"]))
    if m.get("login_sid"):
        await r.delete(_t(m["login_sid"]))
    await r.delete(_u(m["tenant_id"], m["user_id"]))
    await r.hset(_s(sid), "status", "ended")
    await r.expire(_s(sid), ENDED_TTL)
    joined = float(m.get("joined_at") or 0)
    await _audit("support_live_ended", m["tenant_id"], by=m.get("admin_email"), ended_by=by,
                 as_user=m.get("user_label"), seconds=int(_now() - joined) if joined else 0)
