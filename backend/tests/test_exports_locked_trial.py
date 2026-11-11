"""Κλείδωμα εξαγωγών: το /auth/me δίνει exports_locked=True ΜΟΝΟ σε δοκιμαστική συνδρομή."""
from datetime import datetime, timedelta, timezone

from app.services.billing_service import effective_status

NOW = datetime.now(tz=timezone.utc)


def locked(sub):
    return effective_status(sub) == "trial"


def test_trial_running_locks_exports():
    assert locked({"status": "trial", "trial_ends_at": NOW + timedelta(days=5)})


def test_paid_active_does_not_lock():
    assert not locked({"status": "active", "current_period_end": NOW + timedelta(days=30)})


def test_complimentary_trial_flag_does_not_lock():
    assert not locked({"status": "trial", "complimentary": True})


def test_expired_trial_is_not_the_trial_lock():
    # ληγμένη δοκιμή → το κλείδωμα της συνδρομής (ingestion gate κτλ.) ισχύει ήδη αλλού
    assert not locked({"status": "trial", "trial_ends_at": NOW - timedelta(days=1)})


def test_no_subscription_does_not_lock():
    assert not locked(None)


def test_auth_me_exposes_flag():
    import inspect

    from app.api.v1.routers import auth
    src = inspect.getsource(auth.me)
    assert '"exports_locked": effective_status(sub) == "trial"' in src
