"""Αυτο-συντηρούμενη κατηγοριοποίηση παραφαρμάκων.

Τρέχει κάθε βράδυ και πιάνει ΜΟΝΟ ό,τι νέο μπήκε. Τα ονόματα που έχουν ξαναταξινομηθεί παίρνουν
κατηγορία από το καθολικό μητρώο, χωρίς καμία κλήση AI — οπότε στη σταθερή κατάσταση η εργασία
είναι σχεδόν δωρεάν. Το `max_new` είναι φρένο κόστους για την πρώτη, μεγάλη σάρωση.
"""

from __future__ import annotations

from app.workers.celery_app import celery_app
from app.workers.ingestion import _run_async


@celery_app.task(name="app.workers.catalog_categories.classify_parapharmacy")
def classify_parapharmacy(max_new: int | None = 3000) -> dict:
    async def _run() -> dict:
        from app.services import parapharmacy_classifier
        return await parapharmacy_classifier.run(max_new=max_new)

    return _run_async(_run())


@celery_app.task(name="app.workers.catalog_categories.sync_catalogs")
def sync_catalogs() -> dict:
    """Καθημερινή ενημέρωση καταλόγου για όσους πληρώνουν το πρόσθετο."""
    async def _run() -> dict:
        from app.services import catalog_sync
        return await catalog_sync.run_all()

    return _run_async(_run())
