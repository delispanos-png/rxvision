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
