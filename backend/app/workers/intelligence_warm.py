"""Προετοιμασία Patient Intelligence στο παρασκήνιο — ο φαρμακοποιός βρίσκει τις οθόνες ΕΤΟΙΜΕΣ.

ΓΙΑΤΙ (22/10/2026): Dashboard/Segments/Σήμερα κοστίζουν 3–10″ το καθένα (υπολογισμός όλου του
ιστορικού). Η κοινή αποθήκευση (`core.shared_cache`) κάνει γρήγορο το ΔΕΥΤΕΡΟ άνοιγμα· αυτή η
εργασία κάνει γρήγορο και το ΠΡΩΤΟ: μόλις ένας συγχρονισμός φέρει νέες συνταγές, ξαναγράφει τα
αποτελέσματα πριν τα ζητήσει κανείς.

ΦΡΕΝΟ: το πολύ ΜΙΑ φορά ανά 30′ ανά φαρμακείο (`schedule_after_ingest`). Ο συγχρονισμός τρέχει
ανά λίγα λεπτά — χωρίς φρένο θα ξαναϋπολογίζαμε ~18″ ιστορικού ανά φαρμακείο κάθε 5′ πάνω στον
primary της Mongo. Δρόμος `maintenance`: κανείς δεν περιμένει μπροστά στην οθόνη.
"""

from __future__ import annotations

import logging

from app.workers.celery_app import celery_app
from app.workers.ingestion import _run_async

logger = logging.getLogger(__name__)

WARM_EVERY = 1800   # δευτ. — φρένο ανά φαρμακείο
_MODULE = "patient_analytics"


async def schedule_after_ingest(tenant_id: str) -> bool:
    """Καλείται μετά από εισαγωγή με νέες/αλλαγμένες εκτελέσεις. Ποτέ δεν ρίχνει τον συγχρονισμό."""
    try:
        from app.core import shared_cache
        if not await shared_cache.claim(shared_cache.key(tenant_id, "pi-warm"), WARM_EVERY):
            return False
        celery_app.send_task("app.workers.intelligence_warm.warm_tenant", args=[tenant_id])
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("intelligence warm schedule failed for %s: %s", tenant_id, exc)
        return False


@celery_app.task(name="app.workers.intelligence_warm.warm_tenant",
                 soft_time_limit=300, time_limit=360)
def warm_tenant(tenant_id: str) -> dict:
    async def _run() -> dict:
        from app.repositories.patient_intelligence import PatientIntelligenceRepository
        from app.services.auth_service import resolve_tenant_modules
        mods = await resolve_tenant_modules(tenant_id) or {}
        if mods.get(_MODULE) not in ("enabled", "trial"):
            return {"tenant_id": tenant_id, "skipped": "module_off"}
        repo = PatientIntelligenceRepository(tenant_id=tenant_id)
        done = []
        for name in repo.CACHED_VIEWS:
            try:
                await repo.cached_view(name, refresh=True)
                done.append(name)
            except Exception as exc:  # noqa: BLE001 — μία οθόνη δεν ρίχνει τις άλλες
                logger.warning("warm %s/%s failed: %s", tenant_id, name, exc)
        return {"tenant_id": tenant_id, "warmed": done}

    return _run_async(_run())
