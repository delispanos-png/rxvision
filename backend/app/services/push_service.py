"""Web Push (VAPID) for the patient portal — phone notifications even when the app is closed.

Best-effort: every function swallows errors so a push failure never breaks the request that
triggered it. Subscriptions are GLOBAL (keyed by the patient's account_id, which spans pharmacies),
stored in `patient_push_subs` {account_id, endpoint(unique), p256dh, auth}.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time

from bson import ObjectId

from app.core.config import settings
from app.core.db import shared_db

log = logging.getLogger(__name__)


def _oid(v):
    try:
        return v if isinstance(v, ObjectId) else ObjectId(str(v))
    except Exception:
        return None


_vapid_cache = None


def _vapid():
    """Cached Vapid instance from the base64-encoded PEM. pywebpush needs a Vapid INSTANCE
    (its str path calls from_string, which won't parse a PKCS8 PEM)."""
    global _vapid_cache
    if _vapid_cache is not None:
        return _vapid_cache
    if not settings.VAPID_PRIVATE_KEY_B64:
        return None
    try:
        from py_vapid import Vapid
        _vapid_cache = Vapid.from_pem(base64.b64decode(settings.VAPID_PRIVATE_KEY_B64))
        return _vapid_cache
    except Exception:  # noqa: BLE001
        return None


def enabled() -> bool:
    return bool(settings.VAPID_PUBLIC_KEY and _vapid() is not None)


async def save_subscription(account_id, sub: dict) -> bool:
    keys = (sub or {}).get("keys") or {}
    endpoint = (sub or {}).get("endpoint")
    if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        return False
    await shared_db()["patient_push_subs"].update_one(  # tenant-ok: global patient push sub
        {"endpoint": endpoint},
        {"$set": {"account_id": _oid(account_id), "endpoint": endpoint,
                  "p256dh": keys["p256dh"], "auth": keys["auth"], "updated_at": time.time()}},
        upsert=True)
    return True


async def remove_subscription(endpoint: str) -> None:
    if endpoint:
        await shared_db()["patient_push_subs"].delete_one({"endpoint": endpoint})  # tenant-ok: global


async def send_to_account(account_id, *, title: str, body: str, url: str = "/portal") -> int:
    """Push a notification to ALL of this patient account's devices. Returns #delivered.
    Runs the blocking webpush call in a thread; prunes expired (404/410) subscriptions."""
    vv = _vapid()
    oid = _oid(account_id)
    if vv is None or oid is None:
        return 0
    try:
        from pywebpush import WebPushException, webpush
    except Exception:  # noqa: BLE001 — library missing ⇒ silently disabled
        return 0
    db = shared_db()
    payload = json.dumps({"title": title, "body": body, "url": url})
    sent, dead = 0, []
    async for s in db["patient_push_subs"].find({"account_id": oid}):  # tenant-ok: global by account
        info = {"endpoint": s["endpoint"], "keys": {"p256dh": s.get("p256dh"), "auth": s.get("auth")}}
        # fresh claims per endpoint (pywebpush sets `aud` from the endpoint origin)
        claims = {"sub": settings.VAPID_SUBJECT, "exp": int(time.time()) + 12 * 3600}
        try:
            await asyncio.to_thread(webpush, subscription_info=info, data=payload,
                                    vapid_private_key=vv, vapid_claims=claims, timeout=10)
            sent += 1
        except WebPushException as exc:  # noqa: PERF203
            code = getattr(getattr(exc, "response", None), "status_code", None)
            if code in (404, 410):
                dead.append(s["endpoint"])
        except Exception:  # noqa: BLE001 — never let a bad push break the caller
            pass
    if dead:
        await db["patient_push_subs"].delete_many({"endpoint": {"$in": dead}})
    return sent
