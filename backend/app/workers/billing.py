"""Celery billing task — daily: charge subscriptions whose trial/period ended (Revolut),
auto-suspend tenants after repeated payment failure. No-op until Revolut is configured."""

from __future__ import annotations

import asyncio

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.billing.bill_subscriptions")
def bill_subscriptions() -> dict:
    from app.services.billing_service import bill_due
    return asyncio.run(bill_due())
