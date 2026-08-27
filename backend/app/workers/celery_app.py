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
             "app.workers.billing", "app.workers.optical", "app.workers.reminders",
             "app.workers.ops_health", "app.workers.copilot_routines",
             "app.workers.contacts_backfill", "app.workers.death_sweep",
             "app.workers.area_canonical", "app.workers.supplier_photos"],
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
    # Optical-audit scans (interactive) + heavy historical backfills get DEDICATED queues so they
    # never block the fast 5-min incrementals (and vice-versa).
    task_routes={
        "app.workers.optical.process_scan": {"queue": "optical"},
        "app.workers.ingestion.hdika_backfill": {"queue": "backfill"},
    },
)

# Periodic schedule (beat). Per-tenant incremental sync fans out from the dispatcher.
celery_app.conf.beat_schedule = {
    "hdika-incremental-dispatch": {
        "task": "app.workers.ingestion.dispatch_incremental_sync",
        "schedule": crontab(minute="*/5"),
    },
    "reap-stalled-sync": {  # watchdog: kill sync jobs with no progress >10min
        "task": "app.workers.ingestion.reap_stalled_sync",
        "schedule": crontab(minute="*/2"),
    },
    # (Απενεργοποιημένο) rx φωτο-σάρωση Profarm — σχεδόν μηδενική απόδοση (τα φάρμακα δεν έχουν φωτο).
    # Οι φωτο έρχονται από την «Εισαγωγή OTC/παραφαρμάκων» (profarm-import). Ξανα-ενεργοποίησε αν χρειαστεί.
    # "profarm-photo-sync": {
    #     "task": "app.workers.supplier_photos.profarm_sync_tick",
    #     "schedule": crontab(minute="*/2"),
    # },
    # Εισαγωγή προϊόντων OTC/παραφαρμάκων από Profarm — ήπιο chunk κάθε 2 λεπτά (μόνο με ενεργό job).
    "profarm-import": {
        "task": "app.workers.supplier_photos.profarm_import_tick",
        "schedule": crontab(minute="*/2"),
    },
    # AI-ταξινόμηση κατηγοριών εισαγμένων Profarm προϊόντων — κάθε 10 λεπτά (σταματά όταν μηδενιστούν).
    "profarm-classify": {
        "task": "app.workers.supplier_photos.profarm_classify_tick",
        "schedule": crontab(minute="*/10"),
    },
    # self-heal: resume historical backfill for tenants with a history_from not yet reached
    # (a killed/stalled chunk → auto-continue from the current oldest record).
    "historical-continue-dispatch": {
        "task": "app.workers.ingestion.dispatch_historical_continue",
        "schedule": crontab(minute="*/20"),
    },
    "nightly-snapshots": {
        "task": "app.workers.snapshots.compute_nightly",
        "schedule": crontab(hour=2, minute=30),
    },
    "purge-old-scans": {  # GDPR retention: σαρώσεις συνταγών μόνο τρέχων + προηγούμενος μήνας
        "task": "app.workers.optical.purge_old_scans",
        "schedule": crontab(hour=4, minute=20),
    },
    "retention-cleanup": {
        "task": "app.workers.snapshots.apply_retention",
        "schedule": crontab(hour=3, minute=0),
    },
    # Προμήθειες συναλλαγής e-shop — τρέχει ΚΑΘΕ μέρα 04:40 UTC (~07:40 Αθήνα)· το task χρεώνει ΜΟΝΟ
    # την ρυθμισμένη ημέρα (charge_weekday) & όσους έχουν δεδουλευμένα ≥ κατώφλι (roll-over αλλιώς).
    "charge-eshop-fees": {
        "task": "app.workers.billing.charge_eshop_fees",
        "schedule": crontab(hour=4, minute=40),
    },
    # Έλεγχος ΑΚΥΡΩΣΕΩΝ — καθημερινά ΜΕΤΑ ΤΟ ΩΡΑΡΙΟ (19:00 UTC = 22:00 Αθήνα, μετά το κλείσιμο των
    # φαρμακείων & πριν το ΗΔΥΚΑ maintenance ~23:00). Ελαφρύ: βλέπει 15 μέρες πίσω τι επιστρέφει η ΗΔΥΚΑ
    # και ακυρώνει όσες δικές μας ΔΕΝ εμφανίζονται πλέον (η ΗΔΥΚΑ δεν δίνει λίστα ακυρωμένων). Χωρίς
    # re-download → φθηνό ώστε να τρέχει κάθε βράδυ για όλα τα φαρμακεία.
    "cancellation-reconcile-daily": {
        "task": "app.workers.ingestion.dispatch_cancellation_reconcile",
        "schedule": crontab(hour=19, minute=0),
    },
    # Deep reconciliation — re-download the window (correct cancelled-&-re-executed-differently:
    # changed lines/quantities/amounts) + cancel ones ΗΔΥΚΑ no longer returns. Daily over today,
    # weekly over 35 days back. 05:00 UTC = 07:00/08:00 Athens, clear of ΗΔΥΚΑ post-23:00 maintenance.
    "deep-reconcile-daily": {
        "task": "app.workers.ingestion.dispatch_deep_reconcile_daily",
        "schedule": crontab(hour=5, minute=0),
    },
    "deep-reconcile-weekly": {
        "task": "app.workers.ingestion.dispatch_deep_reconcile_weekly",
        "schedule": crontab(hour=4, minute=0, day_of_week=0),  # Sunday
    },
    # Gap-finder (daily): φθηνός έλεγχος 40 ημερών — εντοπίζει εκτελέσεις που ΥΠΑΡΧΟΥΝ στην ΗΔΥΚΑ αλλά
    # ΛΕΙΠΟΥΝ τοπικά (late registrations που το forward-only sync δεν ξαναπιάνει) & στοχευμένο recovery.
    "reconcile-gaps-daily": {
        "task": "app.workers.ingestion.dispatch_reconcile_gaps",
        "schedule": crontab(hour=6, minute=15),
    },
    # GDPR: ΔΙΑΡΡΟΕΣ cross-tenant — εκτελέσεις που ανήκουν στον tenant (scoped feed) αλλά κάθονται σε
    # ΑΛΛΟΝ (raw ΑΜΚΑ σε λάθος φαρμακείο). Καθημερινή σάρωση + ΑΥΤΟΜΑΤΗ μεταφορά στον σωστό.
    "cross-tenant-leaks-daily": {
        "task": "app.workers.ingestion.dispatch_cross_tenant_leaks",
        "schedule": crontab(hour=6, minute=45),
    },
    # Amount audit vs ΗΔΥΚΑ printout (ground truth) — verify each execution's ποσά & correct any
    # ±λεπτό drift (repeats/partials). Hourly batch per tenant on the backfill queue: keeps up with
    # new executions & drains the historical backlog gradually. Minute 20 = offset from the syncs.
    "amount-audit": {
        "task": "app.workers.ingestion.dispatch_amount_audit",
        "schedule": crontab(minute=20),
    },
    # Seasonal-flu vaccinations sync (ΗΔΥΚΑ Influenza Registry) — daily 04:30 UTC.
    "influenza-sync": {
        "task": "app.workers.ingestion.dispatch_influenza_sync",
        "schedule": crontab(hour=4, minute=30),
    },
    # Self-heal ΗΔΥΚΑ CDA-πεδία που έλειψαν από παλιότερο parser (π.χ. «άυλη»/intangible) — κάθε 2 ώρες,
    # best-effort/throttled (σταματά αν η CDA είναι 503· ξαναδοκιμάζει). Offset από τους syncs.
    "heal-missing-cda": {
        "task": "app.workers.ingestion.heal_missing_cda",
        "schedule": crontab(minute=40, hour="*/2"),
    },
    # Κανονικοποίηση περιοχής — εβδομαδιαίο AI πέρασμα για νέες/άγνωστες τιμές (Κυριακή 04:10 UTC)
    "refresh-area-canonical": {
        "task": "app.workers.area_canonical.refresh_area_canonical",
        "schedule": crontab(hour=4, minute=10, day_of_week=0),
    },
    # Death-sweep ΗΔΥΚΑ — έλεγχος θανόντων (ΚΑΘΗΜΕΡΙΝΑ 03:20 UTC για γρήγορη αρχική κάλυψη· rotation
    # με death_checked_at → μετά την κάλυψη απλώς επανελέγχει τους πιο παλιά ελεγμένους/νέους θανόντες)
    "dispatch-death-sweep": {
        "task": "app.workers.death_sweep.dispatch_death_sweep",
        "schedule": crontab(hour=3, minute=20),
    },
    # Subscription billing — charge due trials/renewals; auto-suspend on failure (no-op w/o Revolut)
    "bill-subscriptions": {
        "task": "app.workers.billing.bill_subscriptions",
        "schedule": crontab(hour=6, minute=0),
    },
    # Ειδοποιήσεις συνδρομής — προειδοποίηση πριν τη λήξη + καθημερινά «έχει λήξει» μετά (08:00 UTC)
    "subscription-reminders": {
        "task": "app.workers.billing.subscription_reminders",
        "schedule": crontab(hour=8, minute=0),
    },
    # Κεντρικό υπόλοιπο Apifon — έλεγχος & ειδοποίηση admin αν πέσει χαμηλά (κάθε 6 ώρες)
    "check-central-balance": {
        "task": "app.workers.billing.check_central_balance",
        "schedule": crontab(minute=10, hour="*/6"),
    },
    # Εφαρμογή προγραμματισμένων υποβαθμίσεων πακέτου στο τέλος περιόδου/ανανέωση (καθημερινά 05:30 UTC)
    "apply-scheduled-plan-changes": {
        "task": "app.workers.billing.apply_scheduled_changes",
        "schedule": crontab(hour=5, minute=30),
    },
    # Email αξιολόγησης σε ληγμένα trials (10μ μετά, μη-ανανεωμένα) — καθημερινά 09:00 UTC
    "trial-feedback": {
        "task": "app.workers.billing.trial_feedback",
        "schedule": crontab(hour=9, minute=0),
    },
    # Καθαρισμός ληγμένων trials >20 ημ. → αρχειοθέτηση ΑΦΜ στη βάση leads + διαγραφή (καθημερινά 05:45 UTC)
    "purge-expired-trials": {
        "task": "app.workers.billing.purge_expired_trials",
        "schedule": crontab(hour=5, minute=45),
    },
    # Αυτόματη έκδοση παραστατικών: pending → SoftOne → myDATA (κάθε 5′· off χωρίς auto_invoicing)
    "process-pending-invoices": {
        "task": "app.workers.billing.process_pending_invoices",
        "schedule": crontab(minute="*/5"),
    },
    # Μετασχηματισμός: προτιμολόγιο → τελικό Τ.Π.Υ. → ΑΑΔΕ. Έλεγχος τελικής κατάστασης/MARK (κάθε 15′)
    "check-invoice-transformations": {
        "task": "app.workers.billing.check_invoice_transformations",
        "schedule": crontab(minute="*/15"),
    },
    # self-heal stuck optical scans (worker death/redeploy) — never leave one hanging
    "reap-stuck-scans": {
        "task": "app.workers.optical.reap_stuck_scans",
        "schedule": crontab(minute="*/2"),
    },
    # RxVision Loop — patient med-intake reminders (each hour, matches the therapy slot times)
    "med-reminders": {
        "task": "app.workers.reminders.dispatch_med_reminders",
        "schedule": crontab(minute=0),
    },
    # RxVision Loop — refill run-out radar (daily 07:00 UTC = 09:00/10:00 Athens)
    "refill-radar": {
        "task": "app.workers.reminders.dispatch_refill_radar",
        "schedule": crontab(hour=7, minute=0),
    },
    # Loyalty — «έχεις πόντους, εξαργύρωσε» εβδομαδιαία υπενθύμιση (Δευτέρα 08:00 UTC)
    "loyalty-rewards-nudge": {
        "task": "app.workers.reminders.dispatch_loyalty_rewards",
        "schedule": crontab(hour=8, minute=0, day_of_week=1),
    },
    # Loyalty — δώρο γενεθλίων (καθημερινά 08:10 UTC· dedup ανά έτος στον repo)
    "loyalty-birthday-bonus": {
        "task": "app.workers.reminders.dispatch_birthday_bonus",
        "schedule": crontab(hour=8, minute=10),
    },
    # Recurring order subscriptions — create the next order when due (daily 06:00 UTC)
    "order-subscriptions": {
        "task": "app.workers.reminders.dispatch_order_subscriptions",
        "schedule": crontab(hour=6, minute=0),
    },
    # Ξεχασμένο καλάθι — έλεγχος κάθε 30′ (το «πόσες ώρες» το ορίζει κάθε φαρμακείο)
    "abandoned-carts": {
        "task": "app.workers.reminders.dispatch_abandoned_carts",
        "schedule": crontab(minute="0,30"),
    },
    # Auto-cancel αιτημάτων πελατών που δεν αποδέχτηκε ο φαρμακοποιός εντός του ορίου (κάθε λεπτό)
    "auto-cancel-stale-requests": {
        "task": "app.workers.reminders.auto_cancel_stale_requests",
        "schedule": crontab(minute="*"),
    },
    # Copilot Routines — προγραμματισμένες αναφορές (Φάση 1)· due-check κάθε 10′ (ώρα Αθήνας ανά ρουτίνα)
    "copilot-routines": {
        "task": "app.workers.copilot_routines.run_due_routines",
        "schedule": crontab(minute="*/10"),
    },
    # Ops watchdog — email admins on backup-fail / stale-backup / node-down (launch safety net)
    "ops-health-check": {
        "task": "app.workers.ops_health.check",
        "schedule": crontab(minute="*/30"),
    },
    # Ανανέωση Vault token (periodic) — να μη λήξει & σταματήσουν σιωπηλά οι ΗΔΥΚΑ syncs (01:00 UTC)
    "renew-vault-token": {
        "task": "app.workers.reminders.renew_vault_token",
        "schedule": crontab(hour=1, minute=0),
    },
    # Διατήρηση δεδομένων — 1η κάθε μήνα 03:30 UTC καθαρίζει ό,τι βγήκε εκτός παραθύρου ανά φαρμακείο
    "data-retention-purge": {
        "task": "app.workers.reminders.purge_old_data",
        "schedule": crontab(day_of_month=1, hour=3, minute=30),
    },
}
