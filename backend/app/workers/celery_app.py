"""Celery app — ingestion sync, GDPR jobs, nightly snapshots."""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from app.core.config import settings

celery_app = Celery(
    "rxvision",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=["app.workers.ingestion", "app.workers.snapshots", "app.workers.noeton"],
)

celery_app.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_default_retry_delay=60,
)

# Periodic schedule (beat). Per-tenant incremental sync fans out from the dispatcher.
celery_app.conf.beat_schedule = {
    "hdika-incremental-dispatch": {
        "task": "app.workers.ingestion.dispatch_incremental_sync",
        "schedule": crontab(minute="*/15"),
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
    # Noeton outbound automation (no-op until Noeton is configured)
    "noeton-heartbeat": {
        "task": "app.workers.noeton.heartbeat",
        "schedule": crontab(minute="*/5"),
    },
    "noeton-subscription-sync": {
        "task": "app.workers.noeton.sync_subscriptions",
        "schedule": crontab(minute="*/30"),
    },
    "noeton-usage-report": {
        "task": "app.workers.noeton.report_usage",
        "schedule": crontab(hour=4, minute=0),
    },
}
