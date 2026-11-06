"""Η δοκιμή δίνεται ΜΟΝΟ από εξουσιοδοτημένο άτομο (06/11/2026), με ημερομηνίες που ορίζει εκείνο.
Από τη δημόσια εγγραφή δεν υπάρχει καμία διαδρομή: ούτε στη λίστα πακέτων, ούτε με απευθείας αίτημα."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.routing import APIRoute
from mongomock_motor import AsyncMongoMockClient

import app.services.onboarding_service as ob
from app.api.v1.routers import onboarding as ob_router
from app.services.provisioning import ProvisioningError, trial_window

NOW = datetime(2026, 11, 6, 10, 0, tzinfo=timezone.utc)


def test_default_is_package_days_from_today():
    start, end = trial_window(None, None, 14, now=NOW)
    assert start.isoformat() == "2026-11-05T22:00:00+00:00"       # 00:00 ώρα Ελλάδας
    assert end.isoformat() == "2026-11-20T21:59:59+00:00"         # 23:59:59 της ημέρας λήξης


def test_chosen_dates_are_kept():
    _, end = trial_window("2026-11-06", "2026-12-31", 14, now=NOW)
    assert end.isoformat() == "2026-12-31T21:59:59+00:00"


@pytest.mark.parametrize("start,end", [
    ("2026-11-10", "2026-11-10"),   # ίδια ημέρα
    ("2026-11-10", "2026-11-09"),   # λήξη πριν την έναρξη
    ("2026-01-01", "2026-02-01"),   # ήδη έληξε
    ("2026-11-06", "2036-11-06"),   # λάθος έτος
    ("6/11/2026", "2026-12-01"),    # όχι ημερομηνία
])
def test_bad_dates_are_refused(start, end):
    with pytest.raises(ProvisioningError):
        trial_window(start, end, 14, now=NOW)


async def test_public_signup_cannot_take_a_trial(monkeypatch):
    db = AsyncMongoMockClient()["trial_inv"]
    monkeypatch.setattr(ob, "shared_db", lambda: db)
    await db["packages"].insert_one({"_id": "trial", "price_monthly": 0, "trial_days": 14})

    async def nobody(*a):
        return None
    monkeypatch.setattr(ob.OnboardingService, "reactivation_target", nobody)
    with pytest.raises(ob.OnboardingError, match="trial_by_invitation"):
        await ob.OnboardingService().create_pending(
            pharmacy_name="Φ", country="GR", owner_email="a@b.gr", owner_name="Α", company={"afm": "123456789"},
            package_code="trial", billing_cycle="monthly", sla=None, seats=1, addons=None, payment_method="card")


def test_no_public_route_opens_an_account_without_payment():
    paths = {r.path for r in ob_router.router.routes if isinstance(r, APIRoute)}
    assert not any(p.endswith("/register") for p in paths)
