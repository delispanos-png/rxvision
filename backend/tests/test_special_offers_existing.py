"""Ειδικές προσφορές — Φάση 4 (20/11/2026): υπάρχοντες πελάτες (αποδοχή → ισχύει από την επόμενη
ανανέωση) και email προσκλήσεων."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from mongomock_motor import AsyncMongoMockClient

import app.services.billing_service as bs
import app.services.invoice_service as inv
from app.services import promotions as svc
from app.services import sponsors


def _afm(prefix: str) -> str:
    s = sum(int(prefix[i]) * (2 ** (8 - i)) for i in range(8))
    return prefix + str((s % 11) % 10)


A1, A2, SP_AFM = _afm("80284565"), _afm("09912345"), _afm("99810737")
NOW = datetime.now(tz=timezone.utc)


def special(**kw):
    base = {"_id": "sp", "name": "Μέλη Αποθήκης Χ", "active": True, "public_text": "",
            "starts_at": NOW - timedelta(days=1), "ends_at": NOW + timedelta(days=30),
            "audience": "afm_list", "offer_months": 12, "packages": ["advanced"], "cycles": ["yearly"],
            "customer": "any", "code": None, "requires_referral": False, "exclusive": False,
            "max_redemptions": None, "effects": [{"type": "discount_pct", "value": 20}],
            "lock": {"kind": "months", "months": 12}, "payer": "pharmacy", "sponsor_id": None}
    return {**base, **kw}


@pytest.fixture
def db(monkeypatch):
    d = AsyncMongoMockClient(tz_aware=True)["existing"]
    from app.services import addon_service
    for mod in (svc, sponsors, inv, bs, addon_service):
        monkeypatch.setattr(mod, "shared_db", lambda: d)

    async def cfg():
        return {"series": "7002", "mtrl_map": {}}
    monkeypatch.setattr(inv.softone_service, "platform_config", cfg)
    return d


async def _tenant(db, tid="T1", afm=A1, *, plan="growth", status="active", days_left=40, hdika=None,
                  cycle="yearly"):
    await db.tenants.insert_one({"_id": tid, "name": f"Φαρμακείο {tid}", "billing_profile": {"afm": afm, "email": f"{tid}@x.gr"},
                                 **({"hdika_afm": {"afm": hdika}} if hdika else {})})
    await db.subscriptions.insert_one({"tenant_id": tid, "plan": plan, "status": status, "billing_cycle": cycle,
                                       "price_per_pharmacy": 60000, "seats": 3, "payment_status": "card_saved",
                                       "current_period_end": NOW + timedelta(days=days_left)})


async def _setup(db, **kw):
    await db.packages.insert_many([
        {"_id": "growth", "name": "Growth", "price_monthly": 6000, "price_yearly": 60000, "included_users": 3},
        {"_id": "advanced", "name": "Advanced", "price_monthly": 10000, "price_yearly": 100000,
         "included_users": 6, "modules": ["a", "b"]}])
    await db.promotions.insert_one(special(**kw))
    await svc.add_special_afms("sp", [A1, A2], by="t")


# ── Ποιος τη βλέπει ─────────────────────────────────────────────────────────────────────────
async def test_active_customer_sees_offer_with_next_renewal_price(db):
    await _setup(db)
    await _tenant(db)
    o = await svc.offer_for_tenant("T1")
    assert o["package"] == "advanced" and o["package_changes"] is True and o["cycle"] == "yearly"
    assert (o["list_net"], o["offer_net"], o["pharmacy_net"]) == (100000, 80000, 80000)


@pytest.mark.parametrize("kw", [{"status": "trialing", "plan": "free_trial"}, {"days_left": -30, "status": "expired"}])
async def test_trial_or_expired_use_the_signup_page(db, kw):
    await _setup(db)
    await _tenant(db, **kw)
    assert await svc.offer_for_tenant("T1") is None


async def test_not_listed_sees_nothing(db):
    await _setup(db)
    await _tenant(db, afm=_afm("11122233"))
    assert await svc.offer_for_tenant("T1") is None


# ── Αποδοχή ─────────────────────────────────────────────────────────────────────────────────
async def test_accept_schedules_offer_from_next_renewal(db):
    await _setup(db)
    await _tenant(db)
    res = await svc.accept_for_tenant("T1", by="owner@x.gr")
    sub = await db.subscriptions.find_one({"tenant_id": "T1"})
    assert sub["plan"] == "growth"                                     # τίποτα δεν αλλάζει ακόμη
    assert sub["offer_lock"]["pending_start"] is True and sub["offer_lock"]["package"] == "advanced"
    assert sub["offer_lock"]["since"] == res["starts_at"] == sub["current_period_end"]
    assert sub["price_lock"]["package_net"] == 80000
    # η ΜΙΑ πηγή τιμής ανανέωσης δίνει ήδη την τιμή της προσφοράς για το πακέτο της
    pkg = await db.packages.find_one({"_id": "advanced"})
    assert bs.package_price(sub, pkg, "yearly", NOW) == 80000
    # κλείδωμα: μόνο το πακέτο της προσφοράς
    assert svc.offer_lock_blocks(sub, "growth") and svc.offer_lock_blocks(sub, "advanced") is None
    with pytest.raises(svc.PromotionError, match="no_offer"):
        await svc.accept_for_tenant("T1")                              # δεύτερη φορά: τίποτα
    row = await db.special_offer_afms.find_one({"_id": f"sp:{A1}"})
    assert row["status"] == "redeemed" and row["mode"] == "existing"


async def test_accept_refused_when_hdika_shows_other_afm(db):
    await _setup(db)
    await _tenant(db, hdika=A2)
    with pytest.raises(svc.PromotionError, match="afm_mismatch"):
        await svc.accept_for_tenant("T1")
    assert (await db.special_offer_afms.find_one({"_id": f"sp:{A1}"}))["status"] == "invited"


async def test_accept_with_matching_hdika_is_verified_at_once(db):
    await _setup(db)
    await _tenant(db, hdika=A1)
    await svc.accept_for_tenant("T1")
    assert (await db.special_offer_afms.find_one({"_id": f"sp:{A1}"}))["status"] == "verified"


# ── Έναρξη στην ανανέωση ───────────────────────────────────────────────────────────────────
async def test_start_switches_package_and_price_at_renewal(db):
    await _setup(db)
    await _tenant(db)
    await svc.accept_for_tenant("T1")
    assert (await svc.start_due_offers(NOW))["started"] == 0           # πριν την ανανέωση: τίποτα
    later = NOW + timedelta(days=41)
    assert (await svc.start_due_offers(later))["started"] == 1
    sub = await db.subscriptions.find_one({"tenant_id": "T1"})
    assert sub["plan"] == "advanced" and sub["price_per_pharmacy"] == 80000 and sub["seats"] == 6
    assert sub["modules_included"] == ["a", "b"] and sub["offer_lock"]["pending_start"] is False
    assert sub["current_period_end"] < later                           # την πληρώνει: χρέωση από bill_due
    assert (await svc.start_due_offers(later))["started"] == 0         # idempotent


async def test_sponsored_start_opens_period_without_charge_and_bills_sponsor(db):
    await sponsors.save({"name": "Αποθήκη Χ", "afm": SP_AFM}, by="t")
    sp = await db.sponsors.find_one({})
    await _setup(db, payer="sponsor", sponsor_id=sp["_id"])
    await _tenant(db, hdika=A1)
    o = await svc.offer_for_tenant("T1")
    assert o["pharmacy_net"] == 0 and o["sponsor_net"] == 80000 and o["sponsor_name"] == "Αποθήκη Χ"
    await svc.accept_for_tenant("T1")
    assert await db.sponsor_charges.count_documents({}) == 0           # επιβεβαιώθηκε, αλλά δεν ξεκίνησε
    later = NOW + timedelta(days=41)
    await svc.start_due_offers(later)
    sub = await db.subscriptions.find_one({"tenant_id": "T1"})
    assert sub["current_period_end"] > later + timedelta(days=360)     # νέα χρονιά χωρίς χρέωση
    assert sub["payment_source"] == "sponsor"
    assert await db.sponsor_charges.count_documents({}) == 1


async def test_revocation_before_start_keeps_the_paid_period(db):
    await sponsors.save({"name": "Αποθήκη Χ", "afm": SP_AFM}, by="t")
    sp = await db.sponsors.find_one({})
    await _setup(db, payer="sponsor", sponsor_id=sp["_id"])
    await _tenant(db)
    before = (await db.subscriptions.find_one({"tenant_id": "T1"}))["current_period_end"]
    await svc.accept_for_tenant("T1")
    await svc.verify_special_afm("T1", A2)                             # η ΗΔΥΚΑ δείχνει άλλο ΑΦΜ
    sub = await db.subscriptions.find_one({"tenant_id": "T1"})
    assert sub["current_period_end"] == before                         # η πληρωμένη περίοδος μένει
    assert "offer_lock" not in sub and "price_lock" not in sub
    assert (await svc.start_due_offers(NOW + timedelta(days=41)))["started"] == 0


# ── Προσκλήσεις ─────────────────────────────────────────────────────────────────────────────
def test_parse_lines_with_emails():
    pairs, invalid = svc.parse_afm_lines(f"{A1};fa@x.gr\n{A2[1:]}  EL{_afm('12345678')}\n1234567890\n123456789")
    d = dict(pairs)
    assert d[A1] == "fa@x.gr" and d[A2] is None and _afm("12345678") in d
    assert "1234567890" in invalid and "123456789" in invalid


async def test_invitations_go_once_with_the_right_link(db, monkeypatch):
    sent: list[tuple[str, str]] = []

    async def fake_send(to, subject, html):
        sent.append((to, html))
    from app.services import mailer
    monkeypatch.setattr(mailer, "send_email", fake_send)
    await _setup(db)
    await svc.add_special_afms("sp", f"{A2};new@x.gr\n{_afm('11122233')}", by="t")
    await _tenant(db, "T1", A1)                                         # υπάρχων πελάτης, email χρέωσης
    res = await svc.send_invitations("sp")
    assert res == {"sent": 2, "skipped_no_email": 1, "failed": 0}
    by_to = dict(sent)
    assert "settings/modules" in by_to["T1@x.gr"]
    assert f"register?afm={A2}" in by_to["new@x.gr"]
    assert (await svc.send_invitations("sp"))["sent"] == 0             # δεύτερο πάτημα: κανένα διπλό
    assert (await svc.send_invitations("sp", resend=True))["sent"] == 2
