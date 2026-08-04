"""Celery billing task — daily: charge subscriptions whose trial/period ended (Revolut),
auto-suspend tenants after repeated payment failure. No-op until Revolut is configured."""

from __future__ import annotations

import asyncio

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.billing.bill_subscriptions")
def bill_subscriptions() -> dict:
    """Ημερήσιο: (1) χρέωσε όσες έχουν κάρτα & έληξε η περίοδος (bill_due), μετά (2) λήξε ΟΠΟΙΑΔΗΠΟΤΕ
    συνδρομή πέρασε την περίοδό της χωρίς ανανέωση (expire_overdue) — ανεξάρτητα τρόπου πληρωμής."""
    from app.services.billing_service import bill_due, expire_overdue

    async def _run() -> dict:
        charged = await bill_due()
        expired = await expire_overdue()
        return {"bill_due": charged, "expire_overdue": expired}

    return asyncio.run(_run())


@celery_app.task(name="app.workers.billing.subscription_reminders")
def subscription_reminders() -> dict:
    """Ημερήσιο: προειδοποιητικά email πριν τη λήξη + καθημερινά «η συνδρομή σας έχει λήξει» μετά."""
    from app.services.billing_service import subscription_reminders as _run
    return asyncio.run(_run())


@celery_app.task(name="app.workers.billing.check_central_balance")
def check_central_balance() -> dict:
    """Έλεγχος κεντρικού υπολοίπου Apifon → ειδοποίηση admin αν πέσει κάτω από όριο (να μη στερέψει)."""
    from app.services.comms import check_central_balance as _run
    return asyncio.run(_run())


@celery_app.task(name="app.workers.billing.trial_feedback")
def trial_feedback() -> dict:
    """Email αξιολόγησης σε ληγμένα trials (10μ μετά, μη-ανανεωμένα). Idempotent."""
    from app.services.feedback_service import send_feedback_emails
    return asyncio.run(send_feedback_emails())


@celery_app.task(name="app.workers.billing.apply_scheduled_changes")
def apply_scheduled_changes() -> dict:
    """Apply plan downgrades whose scheduled effective date (period end / renewal) has arrived."""
    from app.services.plan_change_service import apply_due_downgrades
    return asyncio.run(apply_due_downgrades())


@celery_app.task(name="app.workers.billing.process_pending_invoices", bind=True,
                 max_retries=3, autoretry_for=(ConnectionError, TimeoutError),
                 retry_backoff=True, retry_backoff_max=1800, retry_jitter=True)
def process_pending_invoices(self) -> dict:
    """Κάθε λίγα λεπτά: pending παραστατικά → SoftOne (issue) → myDATA· retry/backoff ανά εγγραφή.
    No-op μέχρι να ενεργοποιηθεί το auto_invoicing στο adminpanel ΚΑΙ να ανέβει η JS του SoftOne."""
    from app.services.invoice_service import process_pending
    return asyncio.run(process_pending())


@celery_app.task(name="app.workers.billing.transmit_invoice", bind=True,
                 max_retries=3, autoretry_for=(ConnectionError, TimeoutError),
                 retry_backoff=True, retry_backoff_max=600, retry_jitter=True)
def transmit_invoice(self, invoice_id: str) -> dict:
    """Άμεση διαβίβαση ΕΝΟΣ παραστατικού στο SoftOne (μόλις δημιουργηθεί χειροκίνητα) — δεν περιμένει
    το batch. Σε αποτυχία η εγγραφή μπαίνει σε retry (κάθε 5' από το process_pending_invoices)."""
    from app.services.invoice_service import issue_invoice_by_id
    return asyncio.run(issue_invoice_by_id(invoice_id))
