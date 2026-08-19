"""Celery optical-audit task — runs the OCR pipeline on an uploaded scan off the request path."""

from __future__ import annotations

import asyncio

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.optical.process_scan", autoretry_for=(Exception,),
                 retry_backoff=True, retry_kwargs={"max_retries": 2})
def process_scan(tenant_id: str, scan_id: str) -> dict:
    async def _run() -> None:
        # construct the repo INSIDE the running loop so the Motor client binds to THIS loop
        from app.repositories.scans import ScanRepository
        await ScanRepository(tenant_id=tenant_id).process(scan_id)

    asyncio.run(_run())
    return {"tenant_id": tenant_id, "scan_id": scan_id, "status": "done"}


@celery_app.task(name="app.workers.optical.purge_old_scans")
def purge_old_scans() -> dict:
    """GDPR retention: οι σαρωμένες συνταγές (φωτο με PII/υγείας) κρατιούνται ΜΟΝΟ για τον τρέχοντα +
    τον προηγούμενο μήνα (παράθυρο κλεισίματος). Παλαιότερες διαγράφονται αυτόματα (doc + GridFS εικόνα)."""
    async def _run() -> int:
        from datetime import datetime, timedelta, timezone

        from motor.motor_asyncio import AsyncIOMotorGridFSBucket

        from app.core.db import shared_db
        db = shared_db()
        now = datetime.now(tz=timezone.utc)
        cur = now.strftime("%Y-%m")
        prev_last_day = now.replace(day=1) - timedelta(days=1)
        prev = prev_last_day.strftime("%Y-%m")                 # προηγούμενος μήνας
        prev_start = prev_last_day.replace(day=1)               # 1η προηγούμενου μήνα (cutoff για legacy)
        keep = [cur, prev]
        bucket = AsyncIOMotorGridFSBucket(db, bucket_name="scans")
        old = [s async for s in db["prescription_scans"].find(
            {"$or": [
                {"period": {"$nin": keep + [None, ""]}},                                   # period εκτός παραθύρου
                {"period": {"$in": [None, ""]}, "uploaded_at": {"$lt": prev_start}},        # legacy χωρίς period
            ]}, {"_id": 1, "image_id": 1})]
        n = 0
        for s in old:
            if s.get("image_id"):
                try:
                    await bucket.delete(s["image_id"])
                except Exception:  # noqa: BLE001 — image may already be gone
                    pass
            await db["prescription_scans"].delete_one({"_id": s["_id"]})
            n += 1
        return n

    return {"purged": asyncio.run(_run())}


@celery_app.task(name="app.workers.optical.reap_stuck_scans")
def reap_stuck_scans() -> dict:
    """Self-heal: re-dispatch any scan stuck in 'processing' for >3' (worker died, redeploy,
    etc.) so a scan NEVER hangs forever. Idempotent — process() just re-runs."""
    async def _run() -> int:
        from datetime import datetime, timedelta, timezone

        from app.core.db import shared_db
        cutoff = datetime.now(tz=timezone.utc) - timedelta(minutes=3)
        stuck = [s async for s in shared_db()["prescription_scans"].find(
            {"status": "processing", "uploaded_at": {"$lt": cutoff}})]
        for s in stuck:
            process_scan.delay(s["tenant_id"], str(s["_id"]))
        return len(stuck)

    return {"requeued": asyncio.run(_run())}
