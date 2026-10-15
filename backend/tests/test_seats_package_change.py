"""Αλλαγή πακέτου: μεταφέρονται ΜΟΝΟ οι αγορασμένες θέσεις (12/10/2026 — Κολέλης Advanced→Growth)."""

from __future__ import annotations

from app.services.billing_service import seats_for_package

ADV = {"_id": "adv", "included_users": 6}
GROWTH = {"_id": "pro", "included_users": 3}
ESS = {"_id": "ess", "included_users": 1}


def test_downgrade_drops_seats_that_were_included_in_old_package():
    # είχε 6 που ήταν ΟΛΕΣ μέσα στο Advanced → στο Growth παίρνει τις 3 του Growth, όχι 6
    assert seats_for_package(GROWTH, current=6, prev_pkg=ADV) == 3


def test_purchased_extra_seats_carry_over():
    # Advanced 6 μέσα + 2 αγορασμένες = 8 → Growth: 3 + 2 αγορασμένες = 5
    assert seats_for_package(GROWTH, current=8, prev_pkg=ADV) == 5


def test_upgrade_gets_new_package_included_plus_bought():
    assert seats_for_package(ADV, current=1, prev_pkg=ESS) == 6
    assert seats_for_package(ADV, current=3, prev_pkg=ESS) == 8   # 2 αγορασμένες + 6


def test_same_package_or_explicit_request_unchanged():
    assert seats_for_package(GROWTH, current=5, prev_pkg=GROWTH) == 5
    assert seats_for_package(GROWTH, current=6, prev_pkg=ADV, requested=4) == 4
    assert seats_for_package(GROWTH, current=6) == 6            # χωρίς αλλαγή πακέτου: ό,τι είχε
