"""Ήπιο trickle φωτογραφιών από B2B προμηθευτή (Profarm) — ΕΝΑ-ΕΝΑ barcode, μικρό chunk κάθε λίγα
λεπτά, ώστε να μη δημιουργείται traffic burst / να μη «φλαγκάρεται» ο λογαριασμός. Idempotent &
resumable (markers `profarm_tried` στα είδη). Επιβιώνει restart/deploy (Celery beat).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.workers.celery_app import celery_app
from app.workers.ingestion import _run_async

_CHUNK = 40   # είδη ανά tick (σειριακά, ένα-ένα, με per-request timeout & ήπιο ρυθμό)


def _athens_now() -> datetime:
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Athens"))
    except Exception:  # noqa: BLE001 — fallback EEST (θέρος) αν λείπει tzdata
        return datetime.now(timezone.utc) + timedelta(hours=3)


def _in_download_window() -> bool:
    """Παράθυρο κατεβάσματος Profarm: ΚΑΘΗΜΕΡΙΝΕΣ 20:00–06:00 Αθήνας· ΣΑΒΒΑΤΟ & ΚΥΡΙΑΚΗ όλη μέρα."""
    now = _athens_now()
    if now.weekday() >= 5:      # 5=Σάββατο, 6=Κυριακή → όλο το 24ωρο
        return True
    h = now.hour
    return h >= 20 or h < 6


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


@celery_app.task(name="app.workers.supplier_photos.profarm_classify_tick")
def profarm_classify_tick() -> dict:
    """AI-ταξινόμηση κατηγοριών εισαγμένων Profarm προϊόντων (haiku) — μόνο όσο υπάρχουν ατα ξινόμητα."""
    async def _run() -> dict:
        from app.core.db import shared_db
        from app.services import profarm_service
        db = shared_db()
        tids = await db["supplier_settings"].distinct("tenant_id", {"key": "profarm_import"})
        out: dict = {}
        for t in tids:
            try:
                r = await profarm_service.classify_new_products(str(t), limit=200)
                if r.get("classified") or r.get("remaining"):
                    out[str(t)] = {"classified": r.get("classified"), "remaining": r.get("remaining")}
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
        in_win = _in_download_window()
        now_utc = datetime.now(timezone.utc)
        for t in tids:
            # Κατέβασμα: καθημερινές 20:00–06:00 Αθήνας, Σαβ/Κυρ όλη μέρα· εξαίρεση «σήμερα» μέσω day_grace_until.
            job = await db["supplier_settings"].find_one({"tenant_id": t, "key": "profarm_import"}, {"day_grace_until": 1})
            grace = (job or {}).get("day_grace_until")
            if grace and grace.tzinfo is None:
                grace = grace.replace(tzinfo=timezone.utc)
            if not in_win and not (grace and now_utc < grace):
                out[str(t)] = {"skipped": "out_of_window"}
                continue
            try:
                r = await profarm_service.import_chunk(str(t), chunk=12)
                out[str(t)] = {k: r.get(k) for k in ("phase", "created", "enriched", "photos", "pos", "total")}
            except Exception as e:  # noqa: BLE001
                out[str(t)] = {"error": str(e)[:100]}
        return out
    return _run_async(_run())
