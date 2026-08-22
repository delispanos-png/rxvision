"""Ήπιο trickle φωτογραφιών από B2B προμηθευτή (Profarm) — ΕΝΑ-ΕΝΑ barcode, μικρό chunk κάθε λίγα
λεπτά, ώστε να μη δημιουργείται traffic burst / να μη «φλαγκάρεται» ο λογαριασμός. Idempotent &
resumable (markers `profarm_tried` στα είδη). Επιβιώνει restart/deploy (Celery beat).
"""

from __future__ import annotations

from app.workers.celery_app import celery_app
from app.workers.ingestion import _run_async

_CHUNK = 40   # είδη ανά tick (σειριακά, ένα-ένα, με per-request timeout & ήπιο ρυθμό)


@celery_app.task(name="app.workers.supplier_photos.profarm_sync_tick")
def profarm_sync_tick() -> dict:
    """Για κάθε tenant με creds Profarm, επεξεργάσου ένα μικρό chunk. Τρέχει κάθε λίγα λεπτά (beat)."""
    async def _run() -> dict:
        from app.core.db import shared_db
        from app.services import profarm_service
        db = shared_db()
        tids = await db["supplier_settings"].distinct(
            "tenant_id", {"key": "profarm", "password": {"$nin": [None, ""]}})
        out: dict = {}
        for t in tids:
            try:
                r = await profarm_service.sync_batch(str(t), batch=_CHUNK)
                if r.get("ok") and r.get("remaining", 0) > 0 or r.get("attached"):
                    out[str(t)] = {"attached": r.get("attached"), "matched": r.get("matched"),
                                   "remaining": r.get("remaining"), "throttled": r.get("throttled")}
            except Exception as e:  # noqa: BLE001
                out[str(t)] = {"error": str(e)[:100]}
        return out
    return _run_async(_run())


@celery_app.task(name="app.workers.supplier_photos.profarm_import_tick")
def profarm_import_tick() -> dict:
    """Εισαγωγή OTC/παραφαρμάκων από Profarm — προχωρά ΜΟΝΟ tenants με ΕΝΕΡΓΟ job (enumerating/importing)."""
    async def _run() -> dict:
        from app.core.db import shared_db
        from app.services import profarm_service
        db = shared_db()
        tids = await db["supplier_settings"].distinct(
            "tenant_id", {"key": "profarm_import", "status": {"$in": ["enumerating", "importing"]}})
        out: dict = {}
        for t in tids:
            try:
                r = await profarm_service.import_chunk(str(t), chunk=12)
                out[str(t)] = {k: r.get(k) for k in ("phase", "created", "enriched", "photos", "pos", "total")}
            except Exception as e:  # noqa: BLE001
                out[str(t)] = {"error": str(e)[:100]}
        return out
    return _run_async(_run())
