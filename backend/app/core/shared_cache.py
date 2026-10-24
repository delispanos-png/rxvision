"""Κοινή (Redis) αποθήκευση έτοιμων αποτελεσμάτων βαριών αναλύσεων — ΙΔΙΑ για όλους τους servers.

ΓΙΑΤΙ (22/10/2026): Patient Intelligence (Dashboard 4,9″ · Segments 10,5″ · Σήμερα 3,1″ σε φαρμακείο
95 χιλ. εκτελέσεων) ξαναϋπολόγιζε ΟΛΟ το ιστορικό σε κάθε άνοιγμα. Η μνήμη ανά διεργασία που υπήρχε
για τα Segments δεν βοηθούσε: 3 servers × 2 διεργασίες = 6 χωριστές μνήμες και ο LB μοιράζει τα
αιτήματα → σχεδόν πάντα «αστοχία». Εδώ το αποτέλεσμα γράφεται ΜΙΑ φορά και το βλέπουν όλοι.

Κανόνες:
  · ΑΠΟΤΥΓΧΑΝΕΙ ΑΝΟΙΧΤΑ: Redis κάτω/αργό → υπολογίζουμε όπως πριν. Ποτέ σφάλμα στον χρήστη.
  · Αποθηκεύεται η ΤΕΛΙΚΗ μορφή JSON (`jsonable_encoder`) → η απάντηση είναι ίδια με/χωρίς cache.
  · Κλειδιά ανά φαρμακείο — ΠΟΤΕ αποτέλεσμα ενός φαρμακείου σε άλλο (το tenant_id στο κλειδί).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import redis.asyncio as aioredis
from fastapi.encoders import jsonable_encoder

from app.core.config import settings

logger = logging.getLogger(__name__)

_client: aioredis.Redis | None = None
_TIMEOUT = 0.5   # δευτ. — ένα αργό Redis δεν πρέπει να γίνει ΤΟ αργό σημείο


def _redis() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(settings.REDIS_URL, decode_responses=True,
                                    socket_timeout=_TIMEOUT, socket_connect_timeout=_TIMEOUT)
    return _client


def key(tenant_id: str, name: str, *parts: Any) -> str:
    return ":".join(["rxc", str(tenant_id), name, *map(str, parts)])


async def get(k: str) -> Any | None:
    try:
        raw = await _redis().get(k)
    except Exception as exc:  # noqa: BLE001 — fail open
        logger.warning("shared_cache get %s: %s", k, type(exc).__name__)
        return None
    return json.loads(raw) if raw else None


async def put(k: str, value: Any, ttl: int) -> Any:
    """Γράφει και επιστρέφει την ΚΩΔΙΚΟΠΟΙΗΜΕΝΗ τιμή (ίδια με ό,τι θα έβγαζε το get)."""
    enc = jsonable_encoder(value)
    try:
        await _redis().set(k, json.dumps(enc, separators=(",", ":")), ex=ttl)
    except Exception as exc:  # noqa: BLE001 — fail open
        logger.warning("shared_cache put %s: %s", k, type(exc).__name__)
    return enc


async def cached(k: str, ttl: int, compute: Callable[[], Awaitable[Any]]) -> Any:
    hit = await get(k)
    if hit is not None:
        return hit
    return await put(k, await compute(), ttl)


async def claim(k: str, ttl: int) -> bool:
    """«Το παίρνω εγώ» για `ttl` δευτ. (SET NX) — φρένο ώστε μια δουλειά να μην τρέχει συχνότερα.
    Redis κάτω → False (καλύτερα να μη γίνει μια προετοιμασία παρά να γίνει χωρίς φρένο)."""
    try:
        return bool(await _redis().set(k, "1", nx=True, ex=ttl))
    except Exception:  # noqa: BLE001
        return False
