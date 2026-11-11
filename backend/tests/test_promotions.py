"""Προωθητικές ενέργειες (10/11/2026): ποια ισχύει, πόση έκπτωση, ποια δώρα σε ποιον, και ότι η
εγγραφή χρεώνει ό,τι έδειξε η προσφορά. Παράδειγμα ιδιοκτήτη: Black Friday στο μεγάλο πακέτο,
δωρεάν Connect σε όποιον σύστησε και σε όποιον αγόρασε."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from mongomock_motor import AsyncMongoMockClient

from app.services import promotions as svc

NOW = datetime(2026, 11, 27, 12, tzinfo=timezone.utc)
START, END = svc.window("2026-11-23", "2026-11-30")


def promo(**kw):
    base = {"_id": "bf", "name": "Black Friday", "active": True, "starts_at": START, "ends_at": END,
            "packages": [], "cycles": [], "customer": "any", "code": None, "requires_referral": False,
            "exclusive": False, "max_redemptions": None, "effects": [{"type": "discount_pct", "value": 20}]}
    return {**base, **kw}


CTX = {"package": "rxvisionadvanced", "cycle": "yearly", "returning": False, "promo_code": None, "referrer": None}


def test_window_is_whole_days_in_athens_time():
    assert START == datetime(2026, 11, 22, 22, tzinfo=timezone.utc)
    assert END == datetime(2026, 11, 30, 21, 59, 59, tzinfo=timezone.utc)
    with pytest.raises(svc.PromotionError):
        svc.window("2026-11-30", "2026-11-23")


@pytest.mark.parametrize("change,ok", [
    ({}, True),
    ({"active": False}, False),
    ({"packages": ["standard"]}, False),
    ({"packages": ["rxvisionadvanced"]}, True),
    ({"cycles": ["monthly"]}, False),
    ({"customer": "returning"}, False),
    ({"code": "BF26"}, False),
    ({"requires_referral": True}, False),
    ({"max_redemptions": 3, "redeemed": 3}, False),
    ({"max_redemptions": 3, "redeemed": 2}, True),
])
def test_conditions(change, ok):
    assert svc.matches(promo(**change), CTX, NOW) is ok


def test_outside_the_window_nothing_applies():
    assert not svc.matches(promo(), CTX, datetime(2026, 12, 1, 9, tzinfo=timezone.utc))


def test_code_is_case_insensitive():
    assert svc.matches(promo(code="BF26"), {**CTX, "promo_code": " bf26 "}, NOW)


def test_black_friday_referral_gives_connect_to_both():
    p = promo(requires_referral=True, packages=["rxvisionadvanced"],
              effects=[{"type": "free_module", "module": "connect", "days": 365, "to": "both"}])
    res = svc.evaluate([p], {**CTX, "referrer": "T-REF"}, package_net=97000, total_net=97000, now=NOW)
    assert res["discount_net"] == 0
    gift = res["promotions"][0]["gifts"][0]
    assert svc.gift_targets(gift, "T-NEW", "T-REF") == [("T-NEW", "buyer"), ("T-REF", "referrer")]
    assert svc.evaluate([p], CTX, package_net=97000, total_net=97000, now=NOW)["promotions"] == []


def test_discounts_combine_and_never_make_it_free():
    a = promo(_id="a", effects=[{"type": "discount_pct", "value": 60}])
    b = promo(_id="b", effects=[{"type": "discount_amount", "value": 50000}])
    res = svc.evaluate([a, b], CTX, package_net=97000, total_net=97000, now=NOW)
    assert res["discount_net"] == 97000 - svc.MIN_PAYABLE_NET
    assert sum(p["discount_net"] for p in res["promotions"]) == res["discount_net"]


def test_exclusive_takes_the_best_deal_for_the_customer():
    small = promo(_id="small", effects=[{"type": "discount_pct", "value": 10}])
    big = promo(_id="big", exclusive=True, effects=[{"type": "discount_pct", "value": 30}])
    res = svc.evaluate([small, big], CTX, package_net=10000, total_net=10000, now=NOW)
    assert [p["id"] for p in res["promotions"]] == ["big"] and res["discount_net"] == 3000
    weak = promo(_id="weak", exclusive=True, effects=[{"type": "discount_pct", "value": 5}])
    res = svc.evaluate([small, weak], CTX, package_net=10000, total_net=10000, now=NOW)
    assert [p["id"] for p in res["promotions"]] == ["small"]


def test_discount_on_package_or_on_total():
    p = promo(effects=[{"type": "discount_pct", "value": 50, "on": "package"}])
    assert svc.evaluate([p], CTX, package_net=10000, total_net=16000, now=NOW)["discount_net"] == 5000
    p = promo(effects=[{"type": "discount_pct", "value": 50, "on": "total"}])
    assert svc.evaluate([p], CTX, package_net=10000, total_net=16000, now=NOW)["discount_net"] == 8000


VALID = {"name": "BF", "starts_on": "2026-11-23", "ends_on": "2026-11-30",
         "effects": [{"type": "free_module", "module": "connect", "days": 90, "to": "both"}],
         "requires_referral": True}


@pytest.mark.parametrize("change,error", [
    ({"name": " "}, "name_required"),
    ({"packages": ["nope"]}, "unknown_package"),
    ({"effects": []}, "effects_required"),
    ({"effects": [{"type": "free_module", "module": "nope", "days": 9}]}, "unknown_module"),
    ({"effects": [{"type": "discount_pct", "value": 100}]}, "pct_invalid"),
    ({"code": "μπλα"}, "code_invalid"),
])
def test_validation(change, error):
    with pytest.raises(svc.PromotionError, match=error):
        svc.validate({**VALID, **change}, {"connect"}, {"rxvisionadvanced"})


def test_validation_normalises():
    out = svc.validate({**VALID, "code": " bf26 "}, {"connect"}, {"rxvisionadvanced"})
    assert out["code"] == "BF26" and out["effects"][0]["to"] == "both"
    assert out["effects"][0]["referral_only"] is False


@pytest.fixture
def db(monkeypatch):
    d = AsyncMongoMockClient(tz_aware=True)["promotions"]
    monkeypatch.setattr(svc, "shared_db", lambda: d)
    from app.services import addon_service
    monkeypatch.setattr(addon_service, "shared_db", lambda: d)
    return d


async def test_referral_code_is_stable_and_resolves_only_active_others(db, monkeypatch):
    await db.tenants.insert_many([{"_id": "T1", "billing_profile": {"afm": "111"}}, {"_id": "T2"}])
    await db.subscriptions.insert_one({"tenant_id": "T1", "status": "active", "current_period_end": datetime(2030, 1, 1, tzinfo=timezone.utc)})
    code = await svc.referral_code_for("T1")
    assert code.startswith("RX-") and await svc.referral_code_for("T1") == code
    assert await svc.resolve_referrer(code.lower()) == "T1"
    assert await svc.resolve_referrer(code, buyer_tenant="T1") is None        # όχι στον εαυτό του
    assert await svc.resolve_referrer(code, buyer_afm="111") is None          # ούτε με το ίδιο ΑΦΜ
    other = await svc.referral_code_for("T2")
    assert await svc.resolve_referrer(other) is None                          # χωρίς ενεργή συνδρομή
    assert await svc.resolve_referrer("RX-NOPE00") is None


async def test_redeem_gives_gifts_once(db, monkeypatch):
    await db.tenants.insert_many([{"_id": "NEW", "modules": {}}, {"_id": "REF", "modules": {}}])
    monkeypatch.setattr(svc, "_thank_referrer", lambda red: _noop())
    pending = {"_id": "p1", "package_code": "rxvisionadvanced", "billing_cycle": "yearly",
               "referrer_tenant_id": "REF",
               "promotions": [{"id": "bf", "name": "BF", "discount_net": 0,
                               "gifts": [{"module": "connect", "days": 365, "to": "both"}]}]}
    out = await svc.redeem_signup(pending, "NEW")
    assert [g["status"] for g in out[0]["grants"]] == ["ok", "ok"]
    for tid in ("NEW", "REF"):
        t = await db.tenants.find_one({"_id": tid})
        assert t["modules"]["connect"] == "trial"
    assert await svc.redeem_signup(pending, "NEW") == []                     # δεύτερη κλήση: τίποτα
    assert await db.promotion_redemptions.count_documents({}) == 1


async def _noop():
    return None


def test_price_lock_years_and_until():
    p = promo(lock={"kind": "years", "years": 2}, effects=[{"type": "discount_pct", "value": 20}])
    res = svc.evaluate([p], CTX, package_net=97000, total_net=97000, now=NOW)
    lock = res["price_lock"]
    assert lock["package_net"] == 77600 and lock["list_package_net"] == 97000
    assert lock["until"].astimezone(svc.ATHENS).date().isoformat() == "2028-11-27"
    until = svc.validate({**VALID, "lock": {"kind": "until", "until_on": "2027-12-31"}},
                         {"connect"}, {"rxvisionadvanced"})["lock"]
    p = promo(lock=until)
    assert svc.evaluate([p], CTX, package_net=1000, total_net=1000, now=NOW)["price_lock"]["until"] == until["until_at"]
    with pytest.raises(svc.PromotionError, match="lock_until_invalid"):
        svc.validate({**VALID, "lock": {"kind": "until", "until_on": "2026-11-01"}}, {"connect"}, {"rxvisionadvanced"})
    assert svc.evaluate([promo()], CTX, package_net=1000, total_net=1000, now=NOW)["price_lock"] is None


def test_renewal_price_follows_the_lock():
    from datetime import timedelta

    from app.services.billing_service import package_price
    pkg = {"_id": "rxvisionadvanced", "price_yearly": 97000, "price_monthly": 8900}
    sub = {"plan": "rxvisionadvanced", "billing_cycle": "yearly", "price_per_pharmacy": 77600,
           "price_lock": {"until": NOW + timedelta(days=400), "package_net": 77600,
                          "package": "rxvisionadvanced", "cycle": "yearly"}}
    assert package_price(sub, pkg, "yearly", NOW + timedelta(days=365)) == 77600   # μέσα στο κλείδωμα
    assert package_price(sub, pkg, "yearly", NOW + timedelta(days=401)) == 97000   # μετά: τιμοκατάλογος
    assert package_price(sub, pkg, "monthly", NOW) == 8900                          # άλλος κύκλος
    plain = {"plan": "rxvisionadvanced", "billing_cycle": "yearly", "price_per_pharmacy": 90000}
    assert package_price(plain, pkg, "yearly", NOW) == 90000                        # χωρίς κλείδωμα: ως πριν


CONNECT_20 = {"type": "addon_discount", "module": "connect", "value": 20, "months": 5, "to": "both"}


def test_addon_discount_for_both_counts_only_if_bought_at_signup():
    p = promo(requires_referral=True, effects=[CONNECT_20])
    ctx = {**CTX, "referrer": "T-REF"}
    res = svc.evaluate([p], ctx, package_net=97000, total_net=97000, now=NOW)
    assert res["discount_net"] == 0                                  # δεν αγοράζει Connect τώρα
    assert res["promotions"][0]["gifts"] == [{"kind": "discount", "module": "connect", "pct": 20, "months": 5,
                                              "to": "both", "referral_only": False}]
    res = svc.evaluate([p], {**ctx, "addon_prices": {"connect": 30000}}, package_net=97000, total_net=127000, now=NOW)
    assert res["discount_net"] == 6000                               # 20% του Connect στην πρώτη πληρωμή
    assert res["price_lock"] is None


def test_gift_texts():
    assert svc.gift_text({"kind": "discount", "pct": 20, "months": 5}, "Connect") == "Connect με έκπτωση 20% για 5 μήνες"
    assert svc.gift_text({"kind": "discount", "pct": 100, "months": 1}, "Connect") == "Connect δωρεάν για 1 μήνα"
    assert svc.gift_text({"kind": "free", "days": 150}, "Connect") == "Connect δωρεάν για 5 μήνες"
    assert svc.gift_text({"kind": "free", "days": 10}, "Connect") == "Connect δωρεάν για 10 ημέρες"


def test_addon_discount_validation_and_window():
    out = svc.validate({**VALID, "effects": [CONNECT_20]}, {"connect"}, {"rxvisionadvanced"})
    assert out["effects"][0] == {"type": "addon_discount", "module": "connect", "value": 20, "months": 5, "to": "both",
                                 "referral_only": False}
    with pytest.raises(svc.PromotionError, match="months_invalid"):
        svc.validate({**VALID, "effects": [{**CONNECT_20, "months": 0}]}, {"connect"}, {"rxvisionadvanced"})
    from datetime import timedelta
    sub = {"addon_discounts": [{"module": "connect", "pct": 20, "until": NOW + timedelta(days=150)},
                               {"module": "connect", "pct": 50, "until": NOW - timedelta(days=1)}]}
    assert svc.addon_discount_pct(sub, "connect", NOW) == 20          # η ληγμένη δεν μετρά
    assert svc.addon_discount_pct(sub, "connect", NOW + timedelta(days=151)) == 0
    assert svc.addon_discount_pct(sub, "loyalty", NOW) == 0


async def test_redeem_gives_addon_discount_to_both(db, monkeypatch):
    await db.tenants.insert_many([{"_id": "NEW"}, {"_id": "REF"}])
    await db.subscriptions.insert_many([{"tenant_id": "NEW"}, {"tenant_id": "REF"}])
    monkeypatch.setattr(svc, "_thank_referrer", lambda red: _noop())
    pending = {"_id": "p2", "referrer_tenant_id": "REF", "promotions": [{"id": "c20", "name": "Connect −20%",
               "discount_net": 0, "gifts": [{"kind": "discount", "module": "connect", "pct": 20, "months": 5, "to": "both"}]}]}
    out = await svc.redeem_signup(pending, "NEW")
    assert [g["status"] for g in out[0]["grants"]] == ["ok", "ok"]
    for tid in ("NEW", "REF"):
        sub = await db.subscriptions.find_one({"tenant_id": tid})
        assert svc.addon_discount_pct(sub, "connect", svc._now()) == 20


def test_discount_for_everyone_connect_only_with_referral():
    """Παράδειγμα ιδιοκτήτη 10/11: −15% για όλους, δωρεάν Connect μόνο με σύσταση, στην ίδια ενέργεια."""
    p = promo(code="BF2026", max_redemptions=150, effects=[
        {"type": "discount_pct", "value": 15, "on": "package"},
        {"type": "free_module", "module": "connect", "days": 360, "to": "both", "referral_only": True}])
    plain = svc.evaluate([p], {**CTX, "promo_code": "BF2026"}, package_net=10000, total_net=10000, now=NOW)
    assert plain["discount_net"] == 1500 and plain["promotions"][0]["gifts"] == []
    ref = svc.evaluate([p], {**CTX, "promo_code": "BF2026", "referrer": "T-REF"}, package_net=10000, total_net=10000, now=NOW)
    assert ref["discount_net"] == 1500 and ref["promotions"][0]["gifts"][0]["module"] == "connect"


def test_referral_only_benefit_alone_shows_nothing_without_referral():
    p = promo(effects=[{"type": "free_module", "module": "connect", "days": 30, "to": "both", "referral_only": True}])
    assert svc.evaluate([p], CTX, package_net=1000, total_net=1000, now=NOW)["promotions"] == []
    hint = svc.referral_window_hint([p], NOW)
    assert hint and hint[0]["gifts"][0]["referral_only"] is True


def test_referral_brings_the_offer_code_along():
    """Ο συνάδελφος με σύσταση δεν χρειάζεται και τον κωδικό BF2026."""
    bf = promo(_id="bf", code="BF2026", effects=[
        {"type": "discount_pct", "value": 15, "on": "package"},
        {"type": "free_module", "module": "connect", "days": 360, "to": "referrer", "referral_only": True}])
    other = promo(_id="x", name="Άλλη", code="XMAS", effects=[{"type": "discount_pct", "value": 5}])
    assert svc.referral_promo_code([bf, other], NOW) == "BF2026"
    assert svc.referral_promo_code([other], NOW) is None


async def test_gift_is_banked_for_whoever_already_pays_the_addon(db, monkeypatch):
    """11/11/2026: όποιος πληρώνει ήδη το Connect δεν χάνει το δώρο — ισχύει από την επόμενη ανανέωση."""
    from datetime import timedelta
    renew = svc._now() + timedelta(days=40)
    await db.tenants.insert_many([{"_id": "NEW", "modules": {}}, {"_id": "REF", "modules": {"connect": "enabled"}}])
    await db.subscriptions.insert_many([
        {"tenant_id": "NEW"},
        {"tenant_id": "REF", "addons": ["connect"], "billing_cycle": "monthly", "current_period_end": renew}])
    monkeypatch.setattr(svc, "_thank_referrer", lambda red: _noop())
    pending = {"_id": "p3", "referrer_tenant_id": "REF", "promotions": [{"id": "bf", "name": "BF", "discount_net": 0,
               "gifts": [{"kind": "free", "module": "connect", "days": 360, "to": "both"}]}]}
    out = await svc.redeem_signup(pending, "NEW")
    statuses = {g["role"]: g["status"] for g in out[0]["grants"]}
    assert statuses == {"buyer": "ok", "referrer": "banked"}
    sub = await db.subscriptions.find_one({"tenant_id": "REF"})
    assert svc.addon_discount_pct(sub, "connect", svc._now(), 30) == 0            # τρέχουσα περίοδος: πληρωμένη
    assert svc.addon_discount_pct(sub, "connect", renew, 30) == 100               # η ανανέωση: δωρεάν
    assert svc.addon_discount_pct(sub, "connect", renew + timedelta(days=361), 30) == 0


async def test_gift_inside_the_package_gives_nothing(db, monkeypatch):
    await db.tenants.insert_one({"_id": "REF"})
    await db.subscriptions.insert_one({"tenant_id": "REF", "modules_included": ["connect"]})
    from app.services import addon_service
    status, start = await svc._give(db, addon_service, "REF", {"kind": "free", "module": "connect", "days": 30}, "bf")
    assert status == "included_in_plan" and start is None


def test_short_gift_on_a_yearly_renewal_is_prorated():
    from datetime import timedelta
    sub = {"addon_discounts": [{"module": "connect", "pct": 100, "from": NOW, "until": NOW + timedelta(days=150)}]}
    assert svc.addon_discount_pct(sub, "connect", NOW, 365) == 41                  # 150/365 της ετήσιας
    assert svc.addon_discount_pct(sub, "connect", NOW, 30) == 100                  # μηνιαία μέσα στο παράθυρο
    assert svc.addon_discount_pct(sub, "connect", NOW - timedelta(days=10), 30) == 67   # ξεκινά στη μέση της περιόδου
