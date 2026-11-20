"""Κύπρος ↔ PharmacyOne: λήψη εκτελέσεων ΓεΣΥ ανά φαρμακείο + κεντρικός κατάλογος ειδών.
Δρόμος `sync` (αργές εξωτερικές κλήσεις — κανείς δεν περιμένει μπροστά στην οθόνη)."""

from __future__ import annotations

from app.workers.celery_app import celery_app
from app.workers.ingestion import _run_async


@celery_app.task(name="app.workers.cy_pharmacyone.sync_executions_all")
def sync_executions_all() -> dict:
    async def _run() -> dict:
        from app.services.cy import pharmacyone as p1
        from app.services.cy.gate import cy_enabled
        if not await cy_enabled():
            return {"skipped": "cy_disabled"}
        out: dict = {}
        for tid in await p1.due_tenants():
            try:   # ένα φαρμακείο δεν ρίχνει τα υπόλοιπα· σειριακά (κανόνας του API)
                r = await p1.sync_executions(tid)
                out[tid] = {k: r.get(k) for k in ("fetched", "imported", "updated")}
            except Exception as exc:  # noqa: BLE001
                out[tid] = {"ok": False, "error": getattr(exc, "code", type(exc).__name__)}
        return out
    return _run_async(_run())


@celery_app.task(name="app.workers.cy_pharmacyone.sync_executions_one")
def sync_executions_one(tenant_id: str, full: bool = False) -> dict:
    """«Συγχρονισμός τώρα» από το adminpanel (ή η πρώτη πλήρης λήψη ιστορικού)."""
    async def _run() -> dict:
        from app.services.cy import pharmacyone as p1
        try:
            return await p1.sync_executions(tenant_id, full=full)
        except p1.PharmacyOneError as exc:
            return {"ok": False, "error": exc.code}
    return _run_async(_run())


@celery_app.task(name="app.workers.cy_pharmacyone.sync_items")
def sync_items(full: bool = False) -> dict:
    async def _run() -> dict:
        from app.services.cy import pharmacyone as p1
        from app.services.cy.gate import cy_enabled
        if not await cy_enabled():
            return {"skipped": "cy_disabled"}
        try:
            return await p1.sync_items(full=full)
        except p1.PharmacyOneError as exc:
            return {"ok": False, "error": exc.code}
    return _run_async(_run())


@celery_app.task(name="app.workers.cy_pharmacyone.load_tenant")
def load_tenant(tenant_id: str) -> dict:
    """«Φόρτωση τώρα» από το adminpanel: ο κατάλογος Κύπρου στην αποθήκη ενός φαρμακείου (ίδια
    διαδικασία με τη νυχτερινή — services/catalog_sync.run_for_tenant)."""
    async def _run() -> dict:
        from datetime import datetime, timezone

        from app.core.db import shared_db
        from app.services import catalog_sync
        db = shared_db()
        await db["tenants"].update_one({"_id": tenant_id}, {"$set": {"catalog_sync.loading_since": datetime.now(timezone.utc)}})
        try:
            # full: ξαναπερνά φωτογραφίες/προμηθευτές/κατηγορίες ΚΑΙ στα υπάρχοντα (ποτέ τιμή/απόθεμα του φαρμακοποιού)
            return await catalog_sync.run_for_tenant(tenant_id, full=True)
        finally:
            await db["tenants"].update_one({"_id": tenant_id}, {"$set": {"catalog_sync.loading_since": None}})
    return _run_async(_run())
