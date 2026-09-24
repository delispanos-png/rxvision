"""RxVision Connect — ο υπολογισμός διαθεσιμότητας (σενάρια 9–13 της προδιαγραφής).

Καθαρή συνάρτηση, χωρίς βάση: τρέχει πάντα στο CI. Αν κάποιος αλλάξει τη σειρά των ορίων
(ποσοστό → απόθεμα ασφαλείας → κρατήσεις), ένα φαρμακείο θα υποσχεθεί τεμάχια που δεν έχει.
"""

from app.services.connect_availability import available_qty, policy_for


def test_percentage_of_stock():
    assert available_qty(100, {"global_pct": 30}) == 30


def test_availability_follows_stock_down():
    """Η πολιτική είναι ΠΟΣΟΣΤΟ, όχι αποθηκευμένος αριθμός: 100→30, μετά 60→18."""
    assert available_qty(60, {"global_pct": 30}) == 18


def test_safety_stock_wins_over_percentage():
    assert available_qty(100, {"global_pct": 100, "safety_qty": 20}) == 80


def test_global_limit_caps_a_more_generous_group():
    p = {"global_pct": 40, "per_group": {"g1": 90}}
    assert available_qty(100, p, group_id="g1") == 40


def test_group_limit_below_global_is_respected():
    p = {"global_pct": 40, "per_group": {"g1": 10}}
    assert available_qty(100, p, group_id="g1") == 10


def test_reservations_are_global_not_per_group():
    """Δύο ομάδες δεν καταναλώνουν το ίδιο τεμάχιο δύο φορές (σενάριο 13)."""
    assert available_qty(100, {"global_pct": 30}, reserved=10) == 20


def test_unknown_stock_is_none_not_zero():
    """None = «δεν ξέρουμε, ρώτα τον φαρμακοποιό». Μηδέν = «δεν έχω». Δεν είναι το ίδιο."""
    assert available_qty(None, {"global_pct": 30}) is None
    assert available_qty(0, {"global_pct": 30}) == 0


def test_never_negative():
    assert available_qty(10, {"global_pct": 100, "safety_qty": 50}) == 0
    assert available_qty(10, {"global_pct": 100}, reserved=999) == 0


def test_policy_defaults_and_clamping():
    p = policy_for({"global_pct": 500}, None)
    assert p["global_pct"] == 100
    assert policy_for({}, None)["safety_qty"] == 0
    # Άκυρο ποσοστό ομάδας → πέφτει πίσω στο καθολικό, δεν σκάει και δεν γίνεται 0.
    fallback = policy_for({}, None)["global_pct"]
    assert policy_for({"per_group": {"g": "χ"}}, "g")["group_pct"] == fallback
