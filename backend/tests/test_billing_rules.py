"""Κανόνες χρέωσης — ένας ορισμός ο καθένας (01/10/2026)."""

from __future__ import annotations

import app.services.billing_service as bs
from app.services.seats_service import _seat_price
from mongomock_motor import AsyncMongoMockClient


def test_monthly_value_is_monthly_and_ignores_seats_count():
    # πριν: τιμή × limits.pharmacies (=θέσεις) και ετήσια τιμή ως «μηνιαία»
    yearly = {"billing_cycle": "yearly", "price_per_pharmacy": 120000, "addons_total": 12000,
              "sla_price": 0, "limits": {"pharmacies": 4}}
    assert bs.monthly_value(yearly) == 11000
    assert bs.monthly_value({"billing_cycle": "monthly", "price_per_pharmacy": 5000, "sla_price": 1000}) == 6000
    assert bs.monthly_value({"complimentary": True, "price_per_pharmacy": 5000}) == 0


def test_vat_flag_comes_from_current_package():
    assert bs.includes_vat({"price_includes_vat": False}, {"price_includes_vat": True}) is False
    assert bs.includes_vat(None, {"price_includes_vat": True}) is True


def test_admin_seat_price_override_is_charged():
    pkg = {"extra_user_price": 1000, "extra_user_price_yearly": 10000}
    assert _seat_price(pkg, {}, False) == 1000
    assert _seat_price(pkg, {"extra_user_price": 700}, False) == 700
    assert _seat_price(pkg, {"extra_user_price_yearly": 8000}, True) == 8000


async def test_recurring_extras_include_seats_sla_and_skip_addons_in_plan(monkeypatch):
    db = AsyncMongoMockClient()["bill"]
    await db["addons"].insert_many([{"_id": "ai_assistant", "price_monthly": 3000, "price_yearly": 36000},
                                    {"_id": "eshop", "price_monthly": 2000, "price_yearly": 24000}])
    await db["sla_tiers"].insert_one({"_id": "pro", "price_monthly": 1500, "price_yearly": 15000})

    async def no_retention(_db, _tid):
        return 0
    monkeypatch.setattr("app.services.data_retention.retention_surcharge_monthly", no_retention)
    pkg = {"modules": ["eshop"], "included_users": 2, "extra_user_price": 1000}
    sub = {"tenant_id": "t", "addons": ["ai_assistant", "eshop"], "seats": 4, "sla": "pro"}
    ex = await bs.recurring_extras(db, sub, pkg, yearly=False)
    # eshop περιλαμβάνεται στο πακέτο → δεν χρεώνεται· 2 έξτρα χρήστες × 10 €· SLA 15 €
    assert ex == {"addons": 3000, "retention": 0, "seats": 2000, "extra_users": 2, "sla": 1500, "total": 6500}
