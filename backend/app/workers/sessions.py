"""Συγχρονισμός ιστορικού συνδέσεων.

Οι περισσότερες συνεδρίες δεν τελειώνουν με «αποσύνδεση» — ο χρήστης κλείνει τον browser.
Χωρίς αυτόν τον σαρωτή, η γραμμή ιστορικού θα έμενε ανοιχτή για πάντα και η διάρκεια δεν θα
υπολογιζόταν ποτέ.
"""

from __future__ import annotations

import asyncio

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.sessions.sweep")
def sweep() -> dict:
    from app.services import session_service as sessions

    async def _run() -> dict:
        return await sessions.sweep()

    return asyncio.run(_run())


@celery_app.task(name="app.workers.sessions.aggregate_access")
def aggregate_access() -> int:
    """Πολιτική πρόσβασης (Φάση 0): μεταφέρει τους μετρητές αιτημάτων/λεπτό από το Redis στη Mongo."""
    import redis.asyncio as aioredis

    from app.core.config import settings
    from app.services.access_policy import aggregate
    from app.workers.ingestion import _fresh_db, _run_async

    async def _run() -> int:
        _, db = _fresh_db()
        r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        try:
            return await aggregate(db, r=r)
        finally:
            await r.aclose()

    return _run_async(_run())
