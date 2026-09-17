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


@celery_app.task(name="app.workers.billing.charge_eshop_fees")
def charge_eshop_fees() -> dict:
    """Εβδομαδιαία χρέωση προμηθειών συναλλαγής e-shop. Το beat τρέχει ΚΑΘΕ μέρα· εδώ ελέγχουμε αν
    σήμερα είναι η ρυθμισμένη ημέρα (charge_weekday) — έτσι η ημέρα αλλάζει live από τον admin."""
    from datetime import datetime, timezone

    from app.services import eshop_fees

    async def _run() -> dict:
        cfg = await eshop_fees.get_config()
        if not cfg["enabled"]:
            return {"skipped": "disabled"}
        if datetime.now(tz=timezone.utc).weekday() != cfg["charge_weekday"]:
            return {"skipped": "not_charge_day"}
        return await eshop_fees.charge_weekly()

    return asyncio.run(_run())


@celery_app.task(name="app.workers.billing.purge_expired_trials")
def purge_expired_trials() -> dict:
    """Ημερήσιο: διαγράφει δοκιμαστικές συνδρομές που έληξαν >N ημέρες (default 20) & δεν μετατράπηκαν,
    αφού πρώτα αρχειοθετήσει ΑΦΜ/επικοινωνία στη βάση leads (μπλοκ επανα-trial + προσφορές)."""
    from app.services.billing_service import purge_expired_trials as _purge

    async def _run() -> dict:
        return await _purge()

    return asyncio.run(_run())


@celery_app.task(name="app.workers.billing.purge_orphan_data")
def purge_orphan_data() -> dict:
    """Ημερήσιο self-healing: καθαρίζει ΟΡΙΣΤΙΚΑ δεδομένα tenant που έμειναν χωρίς tenants doc (ορφανά),
    ώστε μετά τη διαγραφή ενός δοκιμαστικού να μη μένει ΤΙΠΟΤΑ πίσω. Ασφαλές (μόνο πλήρως εγκαταλελειμμένα)."""
    from app.services.billing_service import purge_orphan_data as _purge

    async def _run() -> dict:
        return await _purge()

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
    """Apply plan downgrades + seat decreases whose scheduled date (period end / renewal) has arrived."""
    from app.services.plan_change_service import apply_due_downgrades
    from app.services.seats_service import apply_due_seat_changes

    async def _run() -> dict:
        return {"plan_downgrades": await apply_due_downgrades(),
                "seat_changes": await apply_due_seat_changes()}
    return asyncio.run(_run())


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


@celery_app.task(name="app.workers.billing.check_invoice_transformations", bind=True,
                 max_retries=3, autoretry_for=(ConnectionError, TimeoutError),
                 retry_backoff=True, retry_backoff_max=1800, retry_jitter=True)
def check_invoice_transformations(self) -> dict:
    """ΜΕΤΑΣΧΗΜΑΤΙΣΜΟΣ: τα προτιμολόγια που ρίξαμε μετασχηματίζονται σε τελικά Τ.Π.Υ. στο SoftOne και
    διαβιβάζονται στην ΑΑΔΕ. Περιοδικά ρωτάμε αν έγινε ο μετασχηματισμός → αποθηκεύουμε τελικό MARK/κατάσταση."""
    from app.services.invoice_service import check_transformations
    return asyncio.run(check_transformations())


@celery_app.task(name="app.workers.billing.reconcile_viva_payments")
def reconcile_viva_payments() -> dict:
    """ΔΙΧΤΥ ΑΣΦΑΛΕΙΑΣ: ρωτά την ΙΔΙΑ τη Viva ποιες εκκρεμείς παραγγελίες πληρώθηκαν.

    ΓΙΑΤΙ ΥΠΑΡΧΕΙ: η ενεργοποίηση εξαρτιόταν ΑΠΟΚΛΕΙΣΤΙΚΑ από το webhook της Viva. Όταν αυτό δεν
    φτάσει (λάθος ρύθμιση, δίκτυο, downtime) ο πελάτης **πληρώνει και δεν γίνεται τίποτα** —
    σιωπηλά, χωρίς να το μάθει κανείς. Εδώ ρωτάμε εμείς, οπότε το webhook γίνεται επιτάχυνση,
    όχι προϋπόθεση.

    Καλύπτει και τις δύο ροές: ανανέωση (`pending_renewal`) και νέα εγγραφή (`pending_registrations`).
    """
    async def _run() -> dict:
        from app.services import billing_service, viva_service
        from app.services.onboarding_service import OnboardingService
        from app.core.db import shared_db
        db = shared_db()
        renewed = signups = 0
        if True:
            # (1) ανανεώσεις: συνδρομή με εκκρεμή ανανέωση + order code
            async for sub in db["subscriptions"].find({
                    "pending_renewal": {"$ne": None},
                    "viva_order_code": {"$nin": [None, ""]}}):
                t = await viva_service.order_paid_transaction(str(sub["viva_order_code"]))
                if t:
                    await billing_service.complete_renewal(sub["tenant_id"], str(t["TransactionId"]))
                    renewed += 1
            # (2) εγγραφές «πληρωμή-πρώτα» που περιμένουν πληρωμή
            async for p in db["pending_registrations"].find({
                    "status": "awaiting_payment", "viva_order_code": {"$nin": [None, ""]}}):
                t = await viva_service.order_paid_transaction(str(p["viva_order_code"]))
                if t:
                    await OnboardingService().mark_pending_paid(str(p["_id"]), str(t["TransactionId"]))
                    signups += 1
        # Αφού ρωτήσαμε την ίδια τη Viva, ό,τι έμεινε απλήρωτο πέρα από το παράθυρό του είναι
        # όντως εγκαταλελειμμένο ταμείο — όχι «εκκρεμής εγγραφή».
        expired = await OnboardingService().expire_stale()
        if renewed or signups:
            try:   # ο ιδιοκτήτης ΠΡΕΠΕΙ να μάθει ότι το webhook δεν δούλεψε
                from app.services.comms import admin_alert
                await admin_alert(f"⚠️ RxVision: {renewed + signups} πληρωμή/ές Viva εντοπίστηκαν από "
                                  f"το reconcile (το webhook ΔΕΝ έφτασε). Έλεγξε τη ρύθμιση webhook.")
            except Exception:  # noqa: BLE001
                pass
        return {"renewed": renewed, "signups": signups, "abandoned": expired}
    return asyncio.run(_run())
