"""Celery billing task — daily: charge subscriptions whose trial/period ended (Revolut),
auto-suspend tenants after repeated payment failure. No-op until Revolut is configured."""

from __future__ import annotations

import asyncio

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.billing.bill_subscriptions")
def bill_subscriptions() -> dict:
    from app.services.billing_service import bill_due
    return asyncio.run(bill_due())


@celery_app.task(name="app.workers.billing.apply_scheduled_changes")
def apply_scheduled_changes() -> dict:
    """Apply plan downgrades whose scheduled effective date (period end / renewal) has arrived."""
    from app.services.plan_change_service import apply_due_downgrades
    return asyncio.run(apply_due_downgrades())
