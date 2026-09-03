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
    """Παράθυρο κατεβάσματος Profarm: ΚΑΘΕ ΜΕΡΑ 07:00–00:00 Αθήνας (μεσάνυχτα). Νύχτα 00:00–07:00 = off.
    Τρέχει ΗΠΙΑ (μικρό chunk/tick) ώστε να μη γίνεται αντιληπτό & να μη φορτώνει το σύστημα τη μέρα."""
    return _athens_now().hour >= 7      # 07:00–23:59 ON · 00:00–06:59 OFF


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
            # Κατέβασμα: κάθε μέρα 07:00–00:00 Αθήνας· εξαίρεση «τώρα» μέσω day_grace_until (χειροκίνητο άνοιγμα).
            job = await db["supplier_settings"].find_one({"tenant_id": t, "key": "profarm_import"}, {"day_grace_until": 1})
            grace = (job or {}).get("day_grace_until")
            if grace and grace.tzinfo is None:
                grace = grace.replace(tzinfo=timezone.utc)
            if not in_win and not (grace and now_utc < grace):
                out[str(t)] = {"skipped": "out_of_window"}
                continue
            # ΗΠΙΟ trickle: μικρό time-budget (~25s) & μικρό chunk ανά tick (κάθε 2′) — δεν κρατά τον worker-slot
            # πολλή ώρα, δεν μπλοκάρει τους ΗΔΥΚΑ syncs, δεν γίνεται αντιληπτό. Idempotent/resumable → κάθε
            # deploy/restart απλώς συνεχίζει από εκεί που έμεινε στο επόμενο tick.
            import time as _time
            deadline = _time.time() + 25
            agg = {"created": 0, "enriched": 0, "photos": 0}
            r: dict = {}
            try:
                while _time.time() < deadline:
                    r = await profarm_service.import_chunk(str(t), chunk=15)
                    if not r.get("ok"):
                        break
                    for k in agg:
                        agg[k] += int(r.get(k) or 0)
                    if r.get("done") or r.get("cooldown") or r.get("pass_done"):
                        break   # ολοκληρώθηκε πέρασμα ή σε cooldown → σταμάτα αυτό το tick
                out[str(t)] = {"phase": r.get("phase"), **agg, "cat_i": r.get("cat_i"), "page": r.get("page")}
            except Exception as e:  # noqa: BLE001
                out[str(t)] = {"error": str(e)[:100], **agg}
        return out
    return _run_async(_run())
