"""Ειδικές προσφορές — Φάση 3 (20/11/2026): χορηγός (π.χ. φαρμακαποθήκη) πληρώνει όλη ή μέρος της
συνδρομής, δωρεάν προσφορά, εγγραφή χωρίς πληρωμή, παραστατικό στον χορηγό ΜΟΝΟ μετά την ΗΔΥΚΑ."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from mongomock_motor import AsyncMongoMockClient

import app.services.invoice_service as inv
import app.services.onboarding_service as ob
from app.services import promotions as svc
from app.services import sponsors

NOW = datetime(2026, 11, 27, 12, tzinfo=timezone.utc)


def _afm(prefix: str) -> str:
    s = sum(int(prefix[i]) * (2 ** (8 - i)) for i in range(8))
    return prefix + str((s % 11) % 10)


A1, A2, SP_AFM = _afm("80284565"), _afm("09912345"), _afm("99810737")


def special(**kw):
    now = datetime.now(tz=timezone.utc)
    base = {"_id": "sp", "name": "Μέλη Αποθήκης Χ", "active": True,
            "starts_at": now - timedelta(days=1), "ends_at": now + timedelta(days=30),
            "audience": "afm_list", "offer_months": 12, "packages": ["advanced"], "cycles": ["yearly"],
            "customer": "any", "code": None, "requires_referral": False, "exclusive": False,
            "max_redemptions": None, "effects": [{"type": "discount_pct", "value": 20}],
            "lock": {"kind": "months", "months": 12},
            "payer": "sponsor", "sponsor_id": "WH", "sponsor_pct": 100}
    return {**base, **kw}


CTX = {"package": "advanced", "cycle": "yearly", "returning": False, "promo_code": None, "referrer": None,
       "special_ids": {"sp"}}


# ── Ορισμός ──────────────────────────────────────────────────────────────────────────────
def _form(**kw):
    base = {"name": "Μέλη", "starts_on": "2026-11-23", "ends_on": "2026-12-31", "active": True,
            "audience": "afm_list", "offer_months": 12, "packages": ["advanced"], "cycles": ["yearly"],
            "effects": [{"type": "discount_pct", "value": 20}], "payer": "sponsor", "sponsor_id": "WH"}
    return {**base, **kw}


def test_sponsored_offer_validates():
    out = svc.validate(_form(), set(), {"advanced"}, {"WH"})
    assert out["payer"] == "sponsor" and out["sponsor_id"] == "WH" and out["sponsor_pct"] == 100


@pytest.mark.parametrize("change,error", [
    ({"sponsor_id": "NOPE"}, "sponsor_required"),
    ({"sponsor_id": None}, "sponsor_required"),
    ({"payer": "split", "sponsor_pct": 100}, "sponsor_pct_invalid"),
    ({"payer": "split", "sponsor_pct": 0}, "sponsor_pct_invalid"),
    ({"cycles": ["monthly"]}, "free_or_sponsored_yearly_12"),
    ({"cycles": []}, "free_or_sponsored_yearly_12"),
    ({"offer_months": 24}, "free_or_sponsored_yearly_12"),
    ({"payer": "pharmacy", "effects": [{"type": "discount_pct", "value": 100}], "cycles": ["monthly"]},
     "free_or_sponsored_yearly_12"),
])
def test_sponsored_offer_rejects(change, error):
    with pytest.raises(svc.PromotionError) as exc:
        svc.validate(_form(**change), set(), {"advanced"}, {"WH"})
    assert str(exc.value) == error


def test_free_special_allowed_but_public_promotion_capped_at_95():
    out = svc.validate(_form(payer="pharmacy", effects=[{"type": "discount_pct", "value": 100}]),
                       set(), {"advanced"}, set())
    assert out["payer"] == "pharmacy" and out["sponsor_id"] is None
    with pytest.raises(svc.PromotionError):
        svc.validate(_form(audience="all", effects=[{"type": "discount_pct", "value": 100}]),
                     set(), {"advanced"}, set())


def test_public_promotion_never_gets_a_sponsor():
    out = svc.validate(_form(audience="all", cycles=[], offer_months=None), set(), {"advanced"}, {"WH"})
    assert out["payer"] == "pharmacy" and out["sponsor_id"] is None


# ── Τιμή ─────────────────────────────────────────────────────────────────────────────────
def test_sponsor_pays_the_offer_price_of_the_package():
    # πακέτο 1000 €, −20% → 800 € τιμή προσφοράς· χορηγός 100% → φαρμακείο πληρώνει μόνο τα πρόσθετα
    res = svc.evaluate([special()], CTX, package_net=100000, total_net=112000, now=NOW)
    assert res["discount_net"] == 20000
    assert res["sponsor"] == {"sponsor_id": "WH", "promotion_id": "sp", "pct": 100, "net": 80000,
                              "package": "advanced", "cycle": "yearly"}
    assert res["price_lock"] is None                        # μία περίοδος = όλη η προσφορά


def test_split_sponsor():
    res = svc.evaluate([special(payer="split", sponsor_pct=60)], CTX, package_net=100000, total_net=100000, now=NOW)
    assert res["sponsor"]["net"] == 48000                   # 60% των 800 €· το φαρμακείο 320 €


def test_free_special_reaches_zero_but_public_keeps_one_euro():
    free = special(payer="pharmacy", sponsor_id=None, effects=[{"type": "discount_pct", "value": 100}])
    res = svc.evaluate([free], CTX, package_net=100000, total_net=100000, now=NOW)
    assert res["discount_net"] == 100000 and res["sponsor"] is None and res["price_lock"] is None
    public = {**free, "_id": "bf", "audience": "all"}
    res2 = svc.evaluate([public], {**CTX, "special_ids": set()}, package_net=100000, total_net=100000, now=NOW)
    assert res2["discount_net"] == 100000 - svc.MIN_PAYABLE_NET


# ── Βάση ─────────────────────────────────────────────────────────────────────────────────
@pytest.fixture
def db(monkeypatch):
    d = AsyncMongoMockClient(tz_aware=True)["sponsor"]
    for mod in (svc, sponsors, inv, ob):
        monkeypatch.setattr(mod, "shared_db", lambda: d)
    from app.services import addon_service
    monkeypatch.setattr(addon_service, "shared_db", lambda: d)

    async def cfg():
        return {"series": "7002", "mtrl_map": {"sponsor": "SPN", "default": "GEN"}}
    monkeypatch.setattr(inv.softone_service, "platform_config", cfg)

    async def _noop(red):
        return None
    monkeypatch.setattr(svc, "_thank_referrer", _noop)
    return d


async def _setup(db):
    await sponsors.save({"name": "Φαρμακαποθήκη Χ", "afm": SP_AFM, "email": "acc@wh.gr", "doy": "ΦΑΕ"}, by="t")
    sp = await db.sponsors.find_one({})
    await db.promotions.insert_one(special(sponsor_id=sp["_id"]))
    await db.packages.insert_one({"_id": "advanced", "name": "Advanced", "price_monthly": 10000,
                                  "price_yearly": 100000, "included_users": 3})
    await svc.add_special_afms("sp", [A1, A2], by="t")
    return sp


async def test_sponsor_afm_must_be_valid_and_unique(db):
    with pytest.raises(sponsors.SponsorError):
        await sponsors.save({"name": "X", "afm": "123456789"}, by="t")
    await sponsors.save({"name": "X", "afm": SP_AFM}, by="t")
    with pytest.raises(sponsors.SponsorError, match="afm_taken"):
        await sponsors.save({"name": "Y", "afm": SP_AFM}, by="t")


async def test_signup_without_payment_when_sponsor_covers_everything(db, monkeypatch):
    await _setup(db)

    async def nobody(*a):
        return None
    monkeypatch.setattr(ob.OnboardingService, "reactivation_target", nobody)
    res = await ob.OnboardingService().create_pending(
        pharmacy_name="Φ", country="GR", owner_email="a@b.gr", owner_name="Α", company={"afm": A1},
        package_code="advanced", billing_cycle="yearly", sla=None, seats=None, addons=None,
        payment_method="card")
    assert res["amount_cents"] == 0 and res["no_payment"] is True
    p = await db.pending_registrations.find_one({"_id": res["pending_id"]})
    assert p["sponsor"]["net"] == 80000 and p["status"] == "awaiting_payment"


async def test_not_listed_afm_pays_full_price(db, monkeypatch):
    await _setup(db)

    async def nobody(*a):
        return None
    monkeypatch.setattr(ob.OnboardingService, "reactivation_target", nobody)
    res = await ob.OnboardingService().create_pending(
        pharmacy_name="Φ", country="GR", owner_email="a@b.gr", owner_name="Α", company={"afm": _afm("11122233")},
        package_code="advanced", billing_cycle="yearly", sla=None, seats=None, addons=None,
        payment_method="card")
    assert res["amount_cents"] == 124000 and res["no_payment"] is False


def _pending(sp_id: str, afm: str = A1, pid: str = "p1") -> dict:
    return {"_id": pid, "package_code": "advanced", "billing_cycle": "yearly", "company": {"afm": afm},
            "amount_cents": 0,
            "sponsor": {"sponsor_id": sp_id, "promotion_id": "sp", "pct": 100, "net": 80000,
                        "package": "advanced", "cycle": "yearly"},
            "promotions": [{"id": "sp", "name": "Μέλη Αποθήκης Χ", "discount_net": 20000,
                            "audience": "afm_list", "offer_months": 12, "gifts": []}]}


async def test_sponsor_billed_once_only_after_hdika(db):
    sp = await _setup(db)
    await db.tenants.insert_one({"_id": "T1", "name": "Φαρμακείο Α"})
    await db.subscriptions.insert_one({"tenant_id": "T1", "current_period_end": NOW + timedelta(days=365)})
    await svc.redeem_signup(_pending(sp["_id"]), "T1")
    assert await db.sponsor_charges.count_documents({}) == 0          # όχι πριν την ΗΔΥΚΑ
    lock = (await db.subscriptions.find_one({"tenant_id": "T1"}))["offer_lock"]
    assert lock["sponsor_name"] == "Φαρμακαποθήκη Χ"

    await svc.verify_special_afm("T1", A1)
    [c] = [c async for c in db.sponsor_charges.find({})]
    assert (c["net"], c["vat"], c["gross"]) == (80000, 19200, 99200)
    i = await db.invoices.find_one({"_id": c["invoice_id"]})
    assert i["tenant_id"] is None and i["sponsor_id"] == sp["_id"] and i["kind"] == "sponsor"
    assert i["customer"]["afm"] == SP_AFM and i["total"] == 99200 and i["mtrl"] == "SPN"
    assert i["payment"]["transaction_id"] is None and i["status"] == "pending"
    # δεύτερη επιβεβαίωση / δεύτερη κλήση: ούτε δεύτερη χρέωση ούτε δεύτερο παραστατικό
    await svc.verify_special_afm("T1", A1)
    row = await db.special_offer_afms.find_one({"_id": f"sp:{A1}"})
    await sponsors.bill_activation(row)
    assert await db.sponsor_charges.count_documents({}) == 1 and await db.invoices.count_documents({}) == 1


async def test_revoked_sponsored_offer_ends_period_and_bills_nobody(db):
    sp = await _setup(db)
    await db.tenants.insert_one({"_id": "T1", "name": "Φαρμακείο Α"})
    await db.subscriptions.insert_one({"tenant_id": "T1", "current_period_end": NOW + timedelta(days=365)})
    await svc.redeem_signup(_pending(sp["_id"]), "T1")
    await svc.verify_special_afm("T1", A2)                             # η ΗΔΥΚΑ λέει άλλο ΑΦΜ
    sub = await db.subscriptions.find_one({"tenant_id": "T1"})
    assert sub["current_period_end"] <= datetime.now(tz=timezone.utc)
    assert sub["offer_revoked"]["period_ended"] is True
    assert await db.sponsor_charges.count_documents({}) == 0


async def test_revoked_paid_offer_keeps_paid_period(db):
    await _setup(db)
    await db.tenants.insert_one({"_id": "T2", "name": "Β"})
    end = datetime.now(tz=timezone.utc) + timedelta(days=365)
    await db.subscriptions.insert_one({"tenant_id": "T2", "current_period_end": end})
    pend = {**_pending("x", A2, "p2"), "sponsor": None, "amount_cents": 99000}
    await svc.redeem_signup(pend, "T2")
    await svc.verify_special_afm("T2", A1)
    sub = await db.subscriptions.find_one({"tenant_id": "T2"})
    assert sub["current_period_end"] > datetime.now(tz=timezone.utc)     # πλήρωσε: η περίοδος μένει


async def test_report_has_only_sponsor_list_data(db):
    sp = await _setup(db)
    await db.tenants.insert_one({"_id": "T1", "name": "Φαρμακείο Α"})
    await db.subscriptions.insert_one({"tenant_id": "T1", "current_period_end": NOW + timedelta(days=365)})
    await svc.redeem_signup(_pending(sp["_id"]), "T1")
    await svc.verify_special_afm("T1", A1)
    rows = await sponsors.charges(sp["_id"])
    csv = sponsors.report_csv(rows, sp)
    assert A1 in csv and "Φαρμακείο Α" in csv and "992,00" in csv
    assert "T1" not in csv                                             # κανένα εσωτερικό αναγνωριστικό
    [s] = await sponsors.list_all()
    assert (s["activations"], s["billed"], s["open"]) == (1, 99200, 99200)


async def test_sponsor_with_history_is_deactivated_not_deleted(db):
    sp = await _setup(db)
    assert (await sponsors.delete(sp["_id"]))["deactivated"]
    assert await db.sponsors.count_documents({}) == 1
