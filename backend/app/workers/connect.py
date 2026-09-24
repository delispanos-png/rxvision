"""RxVision Connect — περιοδικές εργασίες.

Μία μόνο: η λήξη κρατήσεων. Τρέχει συχνά γιατί ο φαρμακοποιός στην άλλη άκρη περιμένει να του
ξαναγίνει διαθέσιμο το απόθεμα — άνθρωπος περιμένει, άρα ουρά `fast` (προεπιλογή του module).
"""

from __future__ import annotations

import asyncio

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.connect.expire_reservations")
def expire_reservations() -> dict:
    """Λήγουν οι κρατήσεις που δεν έγιναν παράδοση· το απόθεμα ξαναγίνεται διαθέσιμο."""
    from app.repositories.connect import expire_reservations as _run
    return asyncio.run(_run())
