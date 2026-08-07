"""Beat dispatcher for Copilot Routines (Phase 1: scheduled read-only reports). Every ~10 minutes it
picks up routines whose next_run has passed, runs each (read-tool → report → in-app inbox / email),
and reschedules. One bad routine can't wedge the loop — it is caught and its next_run is bumped."""

from __future__ import annotations

from app.workers.celery_app import celery_app
from app.workers.ingestion import _run_async          # persistent per-process loop + Motor binding


@celery_app.task(name="app.workers.copilot_routines.run_due_routines")
def run_due_routines() -> int:
    """Run all enabled routines that are due. Returns how many fired."""
    async def _run() -> int:
        from app.core.db import shared_db
        from app.repositories.copilot_routines import CopilotRoutineRepository, next_run, _now
        db = shared_db()
        now = _now()
        due = [r async for r in db["copilot_routines"].find(
            {"enabled": True, "next_run": {"$lte": now}}).limit(200)]
        fired = 0
        for r in due:
            try:
                await CopilotRoutineRepository(tenant_id=r["tenant_id"]).execute(r, reschedule=True)
                fired += 1
            except Exception:  # noqa: BLE001 — never let one routine stall the whole batch
                await db["copilot_routines"].update_one(
                    {"_id": r["_id"]},
                    {"$set": {"next_run": next_run(r.get("schedule") or {}, now), "last_status": "error"}})
        return fired

    return _run_async(_run())
