"""Celery optical-audit task — runs the OCR pipeline on an uploaded scan off the request path."""

from __future__ import annotations

import asyncio

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.optical.process_scan")
def process_scan(tenant_id: str, scan_id: str) -> dict:
    from app.repositories.scans import ScanRepository
    asyncio.run(ScanRepository(tenant_id=tenant_id).process(scan_id))
    return {"tenant_id": tenant_id, "scan_id": scan_id, "status": "done"}
