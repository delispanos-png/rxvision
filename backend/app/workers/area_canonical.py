"""Αυτο-συντηρούμενος βρόχος κανονικοποίησης περιοχής: κάθε εβδομάδα κανονικοποιεί ΜΟΝΟ τις νέες/
άγνωστες τιμές που εμφανίστηκαν (ασθενείς χωρίς residence_area_canonical + pending κλειδιά). Φθηνό —
πιάνει μόνο ό,τι νέο. Έτσι το πρόβλημα «λύθηκε & ξεχάστηκε» χωρίς χειροκίνητη παρακολούθηση."""

from __future__ import annotations

from app.workers.celery_app import celery_app
from app.workers.ingestion import _run_async


@celery_app.task(name="app.workers.area_canonical.refresh_area_canonical")
def refresh_area_canonical() -> dict:
    async def _run() -> dict:
        from app.services import area_canonical
        return await area_canonical.refresh()

    return _run_async(_run())
