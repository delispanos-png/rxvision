"""Ειδικές προσφορές ανά ΑΦΜ (20/11/2026, docs/special-offers-spec.md): μόνο τα ΑΦΜ της λίστας, ΜΙΑ
φορά ανά ΑΦΜ, σε ΕΝΑ πακέτο, και για όσο διαρκεί η προσφορά το πακέτο δεν αλλάζει — μόνο πρόσθετα."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from mongomock_motor import AsyncMongoMockClient

from app.services import promotions as svc
from app.utils.afm import is_valid

NOW = datetime(2026, 11, 27, 12, tzinfo=timezone.utc)
START, END = svc.window("2026-11-23", "2026-12-31")


def _afm(prefix: str) -> str:
    """Έγκυρο ΑΦΜ (αλγόριθμος ΑΑΔΕ) από 8 ψηφία."""
    s = sum(int(prefix[i]) * (2 ** (8 - i)) for i in range(8))
    return prefix + str((s % 11) % 10)


A1, A2, A3 = _afm("80284565"), _afm("09912345"), _afm("12345678")


def special(**kw):
    base = {"_id": "sp", "name": "Μέλη Αποθήκης Χ", "active": True, "starts_at": START, "ends_at": END,
            "audience": "afm_list", "offer_months": 12, "packages": ["advanced"], "cycles": [],
            "customer": "any", "code": None, "requires_referral": False, "exclusive": False,
            "max_redemptions": None, "effects": [{"type": "discount_pct", "value": 30}],
            "lock": {"kind": "months", "months": 12}}
    return {**base, **kw}


CTX = {"package": "advanced", "cycle": "monthly", "returning": False, "promo_code": None, "referrer": None}


def test_valid_afms_for_fixtures():
    assert all(is_valid(a) for a in (A1, A2, A3))


# ── Ποιος τη βλέπει ─────────────────────────────────────────────────────────────────────────
def test_special_matches_only_listed_afm():
    assert not svc.matches(special(), CTX, NOW)                               # κανένα ΑΦΜ
    assert not svc.matches(special(), {**CTX, "special_ids": {"other"}}, NOW)
    assert svc.matches(special(), {**CTX, "special_ids": {"sp"}}, NOW)
    assert not svc.matches(special(), {**CTX, "package": "basic", "special_ids": {"sp"}}, NOW)


def test_public_promotions_unaffected_by_special_ids():
    plain = special(_id="bf", audience="all")
    assert svc.matches(plain, CTX, NOW)


def test_special_keeps_price_and_package_for_offer_months():
    res = svc.evaluate([special()], {**CTX, "special_ids": {"sp"}}, package_net=10000, total_net=10000, now=NOW)
    assert res["discount_net"] == 3000
    assert res["price_lock"]["package_net"] == 7000
    assert res["price_lock"]["until"] == svc.add_months(NOW, 12)
    assert res["promotions"][0]["audience"] == "afm_list"
    assert res["promotions"][0]["offer_months"] == 12


def test_add_months_clamps_month_end():
    jan31 = datetime(2027, 1, 31, 10, tzinfo=timezone.utc)
    assert svc.add_months(jan31, 1).astimezone(svc.ATHENS).day == 28
    assert svc.add_months(jan31, 12).astimezone(svc.ATHENS).date().isoformat() == "2028-01-31"


# ── Ορισμός από το adminpanel ──────────────────────────────────────────────────────────────
def _form(**kw):
    base = {"name": "Μέλη", "starts_on": "2026-11-23", "ends_on": "2026-12-31", "active": True,
            "audience": "afm_list", "offer_months": 12, "packages": ["advanced"],
            "effects": [{"type": "discount_pct", "value": 30}], "lock": {"kind": "none"}}
    return {**base, **kw}


def test_validate_special_forces_its_own_rules():
    out = svc.validate(_form(code="ABC", show_on_site=True, requires_referral=True, customer="new"),
                       {"connect"}, {"advanced", "basic"})
    assert out["audience"] == "afm_list" and out["offer_months"] == 12
    assert out["code"] is None and out["show_on_site"] is False
    assert out["requires_referral"] is False and out["customer"] == "any"
    assert out["lock"] == {"kind": "months", "months": 12}


def test_validate_special_ignores_months_lock_sent_back_by_editor():
    out = svc.validate(_form(lock={"kind": "months", "months": 6}), set(), {"advanced"})
    assert out["lock"] == {"kind": "months", "months": 12}


@pytest.mark.parametrize("change,error", [
    ({"packages": []}, "special_one_package"),
    ({"packages": ["advanced", "basic"]}, "special_one_package"),
    ({"offer_months": 0}, "offer_months_invalid"),
    ({"offer_months": 37}, "offer_months_invalid"),
    ({"effects": [{"type": "free_module", "module": "connect", "days": 90, "to": "referrer"}]}, "special_buyer_only"),
])
def test_validate_special_rejects(change, error):
    with pytest.raises(svc.PromotionError) as exc:
        svc.validate(_form(**change), {"connect"}, {"advanced", "basic"})
    assert str(exc.value) == error


def test_months_lock_not_allowed_on_public_promotion():
    with pytest.raises(svc.PromotionError):
        svc.validate(_form(audience="all", lock={"kind": "months", "months": 3}), set(), {"advanced"})


# ── Βάση: λίστα ΑΦΜ, εξαργύρωση, κλείδωμα ─────────────────────────────────────────────────
@pytest.fixture
def db(monkeypatch):
    d = AsyncMongoMockClient(tz_aware=True)["special"]
    monkeypatch.setattr(svc, "shared_db", lambda: d)
    from app.services import addon_service
    monkeypatch.setattr(addon_service, "shared_db", lambda: d)
    monkeypatch.setattr(svc, "_thank_referrer", lambda red: _noop())
    return d


async def _noop():
    return None


async def test_add_afms_filters_invalid_and_duplicates(db):
    await db.promotions.insert_one(special())
    # 8ψήφιο από Excel (χάθηκε το αρχικό 0) → συμπληρώνεται
    res = await svc.add_special_afms("sp", f"{A1}\n{A1}, {A2[1:]} 123456789 ; EL{A3}", by="t")
    assert res["added"] == 3 and res["invalid"] == ["123456789"]
    again = await svc.add_special_afms("sp", [A1], by="t")
    assert again == {"added": 0, "existing": 1, "invalid": [], "with_email": 0}
    assert await svc.special_ids_for(A2) == {"sp"}


async def test_add_afms_only_on_special(db):
    await db.promotions.insert_one(special(_id="bf", audience="all"))
    with pytest.raises(svc.PromotionError):
        await svc.add_special_afms("bf", A1, by="t")


def _pending(pid: str, afm: str) -> dict:
    return {"_id": pid, "package_code": "advanced", "billing_cycle": "monthly",
            "company": {"afm": afm},
            "promotions": [{"id": "sp", "name": "Μέλη Αποθήκης Χ", "discount_net": 3000,
                            "audience": "afm_list", "offer_months": 12, "gifts": []}]}


async def test_redeem_once_per_afm_and_locks_package(db):
    await db.promotions.insert_one(special())
    await svc.add_special_afms("sp", A1, by="t")
    await db.subscriptions.insert_many([{"tenant_id": "T1"}, {"tenant_id": "T2"}])

    first = await svc.redeem_signup(_pending("p1", A1), "T1")
    assert first[0]["special_conflict"] is False
    row = await db.special_offer_afms.find_one({"_id": f"sp:{A1}"})
    assert row["status"] == "redeemed" and row["tenant_id"] == "T1"
    assert await svc.special_ids_for(A1) == set()                             # δεν την ξαναβλέπει

    sub = await db.subscriptions.find_one({"tenant_id": "T1"})
    assert sub["offer_lock"]["package"] == "advanced"
    assert svc.offer_lock_blocks(sub, "basic")
    assert svc.offer_lock_blocks(sub, "advanced") is None                     # ανανέωση στο ίδιο: ΟΚ

    # δεύτερη πληρωμένη εγγραφή του ΙΔΙΟΥ ΑΦΜ (κούρσα): καμία δεύτερη εξαργύρωση
    second = await svc.redeem_signup(_pending("p2", A1), "T2")
    assert second[0]["special_conflict"] is True
    assert "offer_lock" not in await db.subscriptions.find_one({"tenant_id": "T2"})


async def test_redeem_without_afm_in_list_is_conflict(db):
    await db.promotions.insert_one(special())
    await db.subscriptions.insert_one({"tenant_id": "T9"})
    out = await svc.redeem_signup(_pending("p9", A3), "T9")
    assert out[0]["special_conflict"] is True


def test_offer_lock_expires_by_itself():
    past = {"offer_lock": {"package": "advanced", "until": datetime.now(tz=timezone.utc) - timedelta(days=1)}}
    assert svc.offer_lock_active(past) is None and svc.offer_lock_blocks(past, "basic") is None
    assert svc.offer_lock_active({}) is None


async def test_special_offer_for_afm_hides_the_list(db, monkeypatch):
    now = datetime.now(tz=timezone.utc)
    await db.promotions.insert_one(special(starts_at=now - timedelta(days=1), ends_at=now + timedelta(days=5)))
    await db.packages.insert_one({"_id": "advanced", "name": "Advanced"})
    await svc.add_special_afms("sp", A1, by="t")
    got = await svc.special_offer_for_afm(A1)
    assert got["package"] == "advanced" and got["package_name"] == "Advanced" and got["offer_months"] == 12
    assert set(got) == {"name", "public_text", "package", "package_name", "cycles", "offer_months"}
    assert await svc.special_offer_for_afm(A2) is None


async def test_remove_only_unredeemed(db):
    await db.promotions.insert_one(special())
    await svc.add_special_afms("sp", [A1, A2], by="t")
    await db.special_offer_afms.update_one({"_id": f"sp:{A1}"}, {"$set": {"status": "redeemed"}})
    with pytest.raises(svc.PromotionError):
        await svc.remove_special_afm("sp", A1)
    assert (await svc.remove_special_afm("sp", A2))["ok"]


async def test_counts_on_list(db):
    await db.promotions.insert_one(special())
    await svc.add_special_afms("sp", [A1, A2], by="t")
    await db.special_offer_afms.update_one({"_id": f"sp:{A1}"}, {"$set": {"status": "redeemed"}})
    [p] = await svc.list_all()
    assert p["afm_counts"] == {"total": 2, "invited": 1, "redeemed": 1, "verified": 0}


# ── Φάση 2: πιστοποίηση ΑΦΜ από την ΗΔΥΚΑ ──────────────────────────────────────────────────
async def _redeemed(db, tid="T1", afm=A1, *, hdika=None):
    await db.promotions.insert_one(special())
    await svc.add_special_afms("sp", afm, by="t")
    await db.tenants.insert_one({"_id": tid, **({"hdika_afm": {"afm": hdika}} if hdika else {})})
    await db.subscriptions.insert_one({"tenant_id": tid, "price_lock": {"until": NOW, "promotions": ["sp"]}})
    await svc.redeem_signup(_pending(f"p-{tid}", afm), tid)


async def test_hdika_match_verifies(db):
    await _redeemed(db)
    assert await svc.verify_special_afm("T1", A1) == {"verified": 1, "revoked": 0}
    row = await db.special_offer_afms.find_one({"_id": f"sp:{A1}"})
    assert row["status"] == "verified" and row["verified_at"]
    assert await svc.special_ids_for(A1) == set()
    assert await svc.verify_special_afm("T1", A1) == {"verified": 0, "revoked": 0}   # ξανά: τίποτα


async def test_hdika_mismatch_revokes_and_frees_the_afm(db):
    await _redeemed(db)
    assert await svc.verify_special_afm("T1", A2) == {"verified": 0, "revoked": 1}
    row = await db.special_offer_afms.find_one({"_id": f"sp:{A1}"})
    assert row["status"] == "invited" and "tenant_id" not in row
    assert row["rejections"][0]["reason"] == "afm_mismatch" and row["rejections"][0]["hdika_afm"] == A2
    assert await svc.special_ids_for(A1) == {"sp"}                            # ο πραγματικός δικαιούχος
    sub = await db.subscriptions.find_one({"tenant_id": "T1"})
    assert "offer_lock" not in sub and "price_lock" not in sub
    assert sub["offer_revoked"]["reason"] == "afm_mismatch"
    red = await db.promotion_redemptions.find_one({"tenant_id": "T1"})
    assert red["revoked"]["reason"] == "afm_mismatch"


async def test_invalid_hdika_afm_does_nothing(db):
    await _redeemed(db)
    assert await svc.verify_special_afm("T1", "") == {"verified": 0, "revoked": 0}
    assert await svc.verify_special_afm("T1", "123456789") == {"verified": 0, "revoked": 0}
    assert (await db.special_offer_afms.find_one({"_id": f"sp:{A1}"}))["status"] == "redeemed"


async def test_already_connected_hdika_verifies_on_redeem(db):
    await _redeemed(db, hdika=A1)
    assert (await db.special_offer_afms.find_one({"_id": f"sp:{A1}"}))["status"] == "verified"


async def test_expire_unverified_after_30_days(db):
    await _redeemed(db, "T1", A1)
    await _redeemed_more(db, "T2", A2, hdika=A2)
    await _redeemed_more(db, "T3", A3)
    old = datetime.now(tz=timezone.utc) - timedelta(days=31)
    await db.special_offer_afms.update_many({"afm": {"$in": [A1, A2]}}, {"$set": {"redeemed_at": old}})
    # Τ2: συνδέθηκε στην ΗΔΥΚΑ αλλά δεν τρέξαμε επιβεβαίωση → την κάνει η τελευταία προσπάθεια
    await db.special_offer_afms.update_one({"_id": f"sp:{A2}"}, {"$set": {"status": "redeemed"}})
    res = await svc.expire_unverified()
    assert res == {"verified": 1, "revoked": 1}
    assert (await db.special_offer_afms.find_one({"_id": f"sp:{A1}"}))["rejections"][0]["reason"] == "not_verified"
    assert (await db.special_offer_afms.find_one({"_id": f"sp:{A2}"}))["status"] == "verified"
    assert (await db.special_offer_afms.find_one({"_id": f"sp:{A3}"}))["status"] == "redeemed"   # μόλις 0 ημέρες


async def _redeemed_more(db, tid, afm, *, hdika=None):
    await svc.add_special_afms("sp", afm, by="t")
    await db.tenants.insert_one({"_id": tid, **({"hdika_afm": {"afm": hdika}} if hdika else {})})
    await db.subscriptions.insert_one({"tenant_id": tid})
    await svc.redeem_signup(_pending(f"p-{tid}", afm), tid)


async def test_on_hdika_profile_trusts_only_what_hdika_returned(db, monkeypatch):
    from app.services import billing_identity as bi
    monkeypatch.setattr(bi, "shared_db", lambda: db)

    async def _no_fill(tid, merged):
        return {}
    monkeypatch.setattr(bi, "fill_from_hdika", _no_fill)
    await _redeemed(db)
    # ΑΦΜ γραμμένο με το χέρι στη φόρμα (merged) ταιριάζει, αλλά η ΗΔΥΚΑ δεν έδωσε ΑΦΜ → τίποτα
    await bi.on_hdika_profile("T1", {"afm": A1}, {"pharmacy_id": "x"})
    assert (await db.special_offer_afms.find_one({"_id": f"sp:{A1}"}))["status"] == "redeemed"
    # η ΗΔΥΚΑ λέει άλλο ΑΦΜ → ανάκληση, ό,τι κι αν γράφει η φόρμα
    await bi.on_hdika_profile("T1", {"afm": A1}, {"afm": A2})
    assert (await db.special_offer_afms.find_one({"_id": f"sp:{A1}"}))["status"] == "invited"
    assert (await db.tenants.find_one({"_id": "T1"}))["hdika_afm"]["afm"] == A2


async def test_integrity_findings_for_special_offers(db):
    from app.services import integrity_checks as ic
    await _redeemed(db)
    await svc.verify_special_afm("T1", A2)                                    # ανάκληση
    await _redeemed_more(db, "T3", A3)
    await db.special_offer_afms.update_one({"_id": f"sp:{A3}"}, {"$set": {
        "redeemed_at": datetime.now(tz=timezone.utc) - timedelta(days=15)}})
    await db.promotion_redemptions.insert_one({"_id": "x", "promotion_id": "sp", "tenant_id": "T9",
                                               "special_conflict": True, "at": datetime.now(tz=timezone.utc)})
    got = {f.check for f in await ic._special_offer_findings(db, datetime.now(tz=timezone.utc))}
    assert got == {"special_offer_revoked", "special_offer_unverified", "special_offer_conflict"}
