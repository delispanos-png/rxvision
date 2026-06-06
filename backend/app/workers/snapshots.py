"""Nightly precompute + retention tasks."""

from __future__ import annotations

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.snapshots.compute_nightly")
def compute_nightly() -> dict:
    """Recompute profitability_snapshots & daily KPI docs for invalidated periods."""
    # TODO: for each tenant with dirty periods -> run aggregation -> upsert snapshots.
    return {"status": "stub"}


@celery_app.task(name="app.workers.snapshots.apply_retention")
def apply_retention() -> dict:
    """Delete/archive data beyond each tenant's subscription history window."""
    # TODO: per tenant: drop executions older than limits.history_months.
    return {"status": "stub"}
