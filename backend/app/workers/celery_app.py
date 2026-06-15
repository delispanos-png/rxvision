"""Celery app — ingestion sync, GDPR jobs, nightly snapshots."""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from app.core.config import settings

celery_app = Celery(
    "rxvision",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=["app.workers.ingestion", "app.workers.snapshots",
             "app.workers.billing", "app.workers.optical"],
)

celery_app.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_default_retry_delay=60,
    # Long backfills (>1h) were being redelivered by Redis' default 1h visibility timeout,
    # spawning duplicate concurrent runs that raced over the same window. Raise to 12h.
    broker_transport_options={"visibility_timeout": 43200},
    task_default_queue="celery",
    # Optical-audit scans (interactive, user-facing) get a DEDICATED queue so they never
    # wait behind heavy/slow background jobs (e.g. a 100s ΗΔΙΚΑ incremental sync).
    task_routes={"app.workers.optical.process_scan": {"queue": "optical"}},
)

# Periodic schedule (beat). Per-tenant incremental sync fans out from the dispatcher.
celery_app.conf.beat_schedule = {
    "hdika-incremental-dispatch": {
        "task": "app.workers.ingestion.dispatch_incremental_sync",
        "schedule": crontab(minute="*/5"),
    },
    "reap-stalled-sync": {  # watchdog: kill sync jobs with no progress >5min
        "task": "app.workers.ingestion.reap_stalled_sync",
        "schedule": crontab(minute="*/2"),
    },
    "nightly-snapshots": {
        "task": "app.workers.snapshots.compute_nightly",
        "schedule": crontab(hour=2, minute=30),
    },
    "retention-cleanup": {
        "task": "app.workers.snapshots.apply_retention",
        "schedule": crontab(hour=3, minute=0),
    },
    # Subscription billing — charge due trials/renewals; auto-suspend on failure (no-op w/o Revolut)
    "bill-subscriptions": {
        "task": "app.workers.billing.bill_subscriptions",
        "schedule": crontab(hour=6, minute=0),
    },
    # self-heal stuck optical scans (worker death/redeploy) — never leave one hanging
    "reap-stuck-scans": {
        "task": "app.workers.optical.reap_stuck_scans",
        "schedule": crontab(minute="*/2"),
    },
}
