"""Πέρασμα σε Revolut χωρίς να χαθεί καμία πληρωμή (05/11/2026).

Ο πελάτης της Viva συνεχίζει στη Viva μέχρι η ΙΔΙΑ η Revolut να δείξει κάρτα για αυτόματες χρεώσεις.
Παλιότερα ο κώδικας δημιουργούσε παραγγελία χωρίς πληρωμή της: η «αυτόματη χρέωση» δεν χρέωνε τίποτα.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest
from mongomock_motor import AsyncMongoMockClient

import app.services.billing_service as bs
import app.services.revolut_service as rv
import app.services.payment_methods as pm

TID = "ph-move"
ORDER = {"id": "o-save", "state": "authorised", "customer": {"id": "c-1"},
         "merchant_order_data": {"reference": TID}}


@pytest.fixture
async def db(monkeypatch):
    d = AsyncMongoMockClient(tz_aware=True)["card_move"]
    monkeypatch.setattr(bs, "shared_db", lambda: d)
    monkeypatch.setattr(pm, "shared_db", lambda: d)
    await d["platform_settings"].insert_one({"_id": "billing", "active_provider": "viva"})
    await d["subscriptions"].insert_one({
        "tenant_id": TID, "payment_provider": "viva", "viva_transaction_id": "v-1",
        "payment_status": "card_saved", "revolut_order_id": "o-save"})
    return d


def _method(monkeypatch, value):
    async def f(_):
        return value
    monkeypatch.setattr(rv, "merchant_method", f)


async def _sub(db):
    return await db["subscriptions"].find_one({"tenant_id": TID})


async def test_paid_without_saved_card_stays_on_viva(db, monkeypatch):
    _method(monkeypatch, None)
    await bs.handle_webhook("ORDER_AUTHORISED", ORDER)
    s = await _sub(db)
    assert s["payment_provider"] == "viva" and not s.get("revolut_customer_id")
    assert s["revolut_order_id"] == "o-save"            # το δίχτυ ξαναρωτά αργότερα


async def test_saved_card_moves_and_keeps_viva_as_backup(db, monkeypatch):
    _method(monkeypatch, {"id": "m-1", "type": "card"})
    await bs.handle_webhook("ORDER_AUTHORISED", ORDER)
    s = await _sub(db)
    assert s["payment_provider"] == "revolut" and s["revolut_customer_id"] == "c-1"
    assert s["viva_transaction_id"] == "v-1" and "revolut_order_id" not in s


async def test_someone_elses_order_never_moves_a_customer(db, monkeypatch):
    _method(monkeypatch, {"id": "m-1", "type": "card"})
    await bs.handle_webhook("ORDER_AUTHORISED", {**ORDER, "merchant_order_data": {"reference": "άλλο"}})
    assert (await _sub(db))["payment_provider"] == "viva"
    assert not await bs._save_card_from_order(TID, await _sub(db), {**ORDER, "id": "o-other"})


async def test_confirm_works_without_webhook_and_is_idempotent(db, monkeypatch):
    _method(monkeypatch, {"id": "m-1", "type": "card"})

    async def get_order(_):
        return ORDER
    monkeypatch.setattr(rv, "get_order", get_order)
    assert await bs.complete_card_save(TID) is True
    assert await bs.complete_card_save(TID) is True     # δεύτερη κλήση, π.χ. webhook + οθόνη μαζί


async def test_lost_revolut_card_falls_back_to_viva_without_order(db, monkeypatch):
    calls = []

    async def rev(**k):
        return {"ok": False, "error": "revolut_no_saved_card"}

    async def viva(**k):
        calls.append(k["original_transaction_id"])
        return {"ok": True, "transaction_id": "v-2"}

    async def verify(*a, **k):
        return {"ok": True}
    monkeypatch.setattr(rv, "charge_off_session", rev)
    monkeypatch.setattr(bs.viva_service, "charge_recurring", viva)
    monkeypatch.setattr(bs.viva_service, "verify_payment", verify)
    r = await bs._charge_recurring({"payment_provider": "revolut", "revolut_customer_id": "c-1",
                                    "viva_transaction_id": "v-1"}, 100, TID)
    assert r["ok"] and r["provider"] == "viva" and calls == ["v-1"]


async def test_provider_outage_does_not_lock_the_customer(db, monkeypatch):
    locked = []

    async def lock(*a, **k):
        locked.append(a)

    async def rev(**k):
        return {"ok": False, "retry": True, "error": "revolut_error:ConnectError"}

    async def yes():
        return True

    async def removals(*a, **k):
        return False

    async def extras(*a, **k):
        return {"total": 0}
    import app.services.addon_service as addons
    monkeypatch.setattr(addons, "apply_due_removals", removals)
    monkeypatch.setattr(bs, "any_provider_configured", yes)
    monkeypatch.setattr(bs, "recurring_extras", extras)
    monkeypatch.setattr(bs, "lock_unpaid", lock)
    monkeypatch.setattr(rv, "charge_off_session", rev)
    await db["subscriptions"].update_one({"tenant_id": TID}, {"$set": {
        "payment_provider": "revolut", "revolut_customer_id": "c-1", "status": "active", "price_per_pharmacy": 100,
        "current_period_end": datetime.now(timezone.utc) - timedelta(hours=1)}})
    assert (await bs.bill_due())["failed"] == 0 and not locked


async def test_manual_renewal_at_revolut_keeps_viva_card_if_no_card_saved(monkeypatch):
    _method(monkeypatch, None)
    card = await bs._renewal_card("revolut", {"payment_provider": "viva"}, {"customer_id": "c-1"}, "o-1")
    assert card["payment_provider"] == "viva" and "revolut_customer_id" not in card


async def test_card_capture_uses_owner_email_when_no_billing_profile(db, monkeypatch):
    # 2 από τους 7 πελάτες (Μπινίκος, Παπαγιαννόπουλος) δεν έχουν email χρέωσης: «δεν είναι διαθέσιμη»
    await db["platform_settings"].update_one({"_id": "billing"}, {"$set": {"revolut_pilot_tenants": [TID]}})
    await db["tenants"].insert_one({"_id": TID, "name": "Φ"})
    await db["users"].insert_one({"tenant_id": TID, "email": "owner@ph.gr", "created_at": datetime.now(timezone.utc)})
    seen = {}

    async def save_order(**k):
        seen.update(k)
        return {"ok": True, "token": "t", "order_id": "o-2"}

    async def cfg():
        return {"mode": "live"}
    monkeypatch.setattr(rv, "create_save_card_order", save_order)
    monkeypatch.setattr(rv, "config", cfg)
    assert (await bs.start_card_capture(TID))["ok"] and seen["email"] == "owner@ph.gr"


async def test_pilot_tenant_only(db):
    assert await bs.provider_for(TID) == "viva"
    await db["platform_settings"].update_one({"_id": "billing"}, {"$set": {"revolut_pilot_tenants": ["άλλο"]}})
    assert await bs.provider_for(TID) == "viva"
    await db["platform_settings"].update_one({"_id": "billing"}, {"$set": {"revolut_pilot_tenants": [TID]}})
    assert await bs.provider_for(TID) == "revolut"


async def test_signup_choice_must_be_enabled(db):
    await db["platform_settings"].insert_one({"_id": "payment_methods", "card_revolut": {"enabled": False},
                                              "card_viva": {"enabled": True}})
    assert await bs.signup_provider("revolut") == "viva"
    await db["platform_settings"].update_one({"_id": "payment_methods"}, {"$set": {"card_revolut.enabled": True}})
    assert await bs.signup_provider("revolut") == "revolut"
    assert await bs.signup_provider(None) == "viva"     # χωρίς επιλογή → ο ενεργός πάροχος


class _Http:
    """Ψεύτικη Revolut: καταγράφει τι στέλνουμε, απαντά ανά διαδρομή."""
    calls: list = []
    pay: object = None

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, headers=None):
        return httpx.Response(200, json=[
            {"id": "old", "type": "CARD", "saved_for": "MERCHANT", "created_at": "2026-01-01"},
            {"id": "new", "type": "CARD", "saved_for": "MERCHANT", "created_at": "2026-02-01"},
            {"id": "own", "type": "CARD", "saved_for": "CUSTOMER", "created_at": "2026-03-01"}],
            request=httpx.Request("GET", url))

    async def post(self, url, headers=None, json=None):
        _Http.calls.append((url, json))
        req = httpx.Request("POST", url)
        if url.endswith("/payments"):
            if isinstance(_Http.pay, Exception):
                raise _Http.pay
            return _Http.pay if isinstance(_Http.pay, httpx.Response) else httpx.Response(
                200, json=_Http.pay, request=req)
        return httpx.Response(201, json={"id": "o-1"}, request=req)


@pytest.fixture
def http(monkeypatch):
    _Http.calls = []
    monkeypatch.setattr(rv.httpx, "AsyncClient", _Http)

    async def client():
        return "https://rv/api", "key"
    monkeypatch.setattr(rv, "_client", client)

    async def no_location():
        return {}
    monkeypatch.setattr(rv, "config", no_location)
    return _Http


async def _charge():
    return await rv.charge_off_session(amount=500, currency="EUR", customer_id="c-1", tenant_id=TID, description="d")


async def test_charge_pays_the_order_with_the_newest_merchant_card(http):
    http.pay = {"state": "processing"}
    r = await _charge()
    assert r == {"ok": True, "order_id": "o-1", "state": "processing"}
    url, body = http.calls[1]
    assert url.endswith("/orders/o-1/payments")
    assert body == {"saved_payment_method": {"type": "card", "id": "new", "initiator": "merchant"}}


async def test_every_order_is_marked_as_rxvision_when_location_is_set(http, monkeypatch):
    async def cfg():
        return {"location_id": "loc-1"}
    monkeypatch.setattr(rv, "config", cfg)
    http.pay = {"state": "processing"}
    await _charge()
    assert http.calls[0][1]["location_id"] == "loc-1"


async def test_network_error_while_paying_is_unknown_not_a_retry(http):
    http.pay = httpx.ReadTimeout("x")
    r = await _charge()
    assert r["unknown"] and r["order_id"] == "o-1" and not r.get("retry")   # ΠΟΤΕ δεύτερη χρέωση


async def test_declined_card_is_a_failure(http):
    http.pay = {"state": "declined"}
    assert (await _charge())["ok"] is False


async def test_declined_payment_leaves_order_pending_but_counts_as_failed(monkeypatch):
    async def get_order(_):
        return {"state": "pending", "amount": 500, "payments": [{"state": "declined"}]}
    monkeypatch.setattr(rv, "get_order", get_order)
    assert (await rv.verify_payment("o-1"))["reason"] == "failed"


async def test_selected_provider_comes_first_when_both_are_open(db):
    await db["platform_settings"].insert_one({"_id": "payment_methods", "card_revolut": {"enabled": True},
                                              "card_viva": {"enabled": True}})
    assert [m["id"] for m in await pm.public_methods()][:2] == ["card_viva", "card_revolut"]
    await db["platform_settings"].update_one({"_id": "billing"}, {"$set": {"active_provider": "revolut"}})
    assert [m["id"] for m in await pm.public_methods()][:2] == ["card_revolut", "card_viva"]


async def _upgrade_env(db, monkeypatch):
    import app.services.plan_change_service as pcs
    monkeypatch.setattr(pcs, "shared_db", lambda: db)
    await db["platform_settings"].insert_one({"_id": "payment_methods", "card_viva": {"enabled": True},
                                              "card_revolut": {"enabled": False}})
    await db["tenants"].insert_one({"_id": TID, "name": "Φ"})
    await db["users"].insert_one({"tenant_id": TID, "email": "owner@ph.gr", "created_at": datetime.now(timezone.utc)})
    sub = await _sub(db)

    async def classify(*a):
        return {"sub": sub, "pkg": {"name": "Pro"}, "yearly": False, "kind": "upgrade", "new_price": 9000,
                "current_price": 0}
    monkeypatch.setattr(pcs, "classify", classify)
    return pcs


async def test_upgrade_pays_at_selected_provider_viva(db, monkeypatch):
    pcs = await _upgrade_env(db, monkeypatch)
    seen = {}

    async def viva_order(**k):
        seen.update(k)
        return {"ok": True, "order_code": "111", "checkout_url": "https://viva/111"}
    monkeypatch.setattr(bs.viva_service, "create_checkout_order", viva_order)
    r = await pcs.request_change(TID, "pro", method="card")
    assert r["checkout_url"] == "https://viva/111" and seen["allow_recurring"] is True
    s = await _sub(db)
    assert s["pending_change"]["method"] == "viva" and s["pending_change"]["order_code"] == "111"


async def test_viva_upgrade_applies_only_for_its_own_paid_order(db, monkeypatch):
    pcs = await _upgrade_env(db, monkeypatch)
    await db["subscriptions"].update_one({"tenant_id": TID}, {"$set": {"pending_change": {
        "method": "viva", "status": "awaiting_payment", "order_code": "111", "charge_amount": 5000}}})
    applied = []

    async def apply(tid, source):
        applied.append((await _sub(db))["pending_change"].get("viva_transaction_id"))
    monkeypatch.setattr(pcs, "apply_change", apply)

    async def verify(txn, **k):
        return {"ok": True, "amount_cents": 5000, "merchant_trns": TID, "order_code": {"t-other": "222"}.get(txn, "111")}
    monkeypatch.setattr(bs.viva_service, "verify_payment", verify)

    async def nope(*a, **k):
        return False
    import app.services.ai_credits as ai
    import app.services.message_wallet as mw
    monkeypatch.setattr(ai, "complete_topup", nope)
    monkeypatch.setattr(mw, "complete_topup", nope)
    await bs.handle_viva_webhook({"TransactionId": "t-other", "OrderCode": "222"})
    assert applied == []                                 # άλλη πληρωμή του ίδιου φαρμακείου
    await bs.handle_viva_webhook({"TransactionId": "t-up", "OrderCode": "111"})
    assert applied == ["t-up"]
