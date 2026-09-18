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
