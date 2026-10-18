"""Ενεργοποίηση Revolut χωρίς παρενέργειες (18/10/2026).

1. Οι πελάτες με κάρτα Viva συνεχίζουν να χρεώνονται από τη Viva (ο πάροχος ζει ΣΤΗ συνδρομή).
2. Μισή αλλαγή κάρτας δεν αλλάζει πάροχο — μόνο η ΟΛΟΚΛΗΡΩΜΕΝΗ αποθήκευση.
3. Ο κλειδωμένος πελάτης ανανεώνει και μέσω Revolut (πριν: provider_not_viva → κλειδωμένος για πάντα).
4. «Πληρωμένο» στη Revolut = ό,τι επιβεβαιώνει η ίδια η Revolut· «σε εξέλιξη» ≠ πληρωμένο, ούτε ξαναχρέωση.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import app.services.billing_service as bs
import app.services.invoice_service as inv
import app.services.revolut_service as rv
from mongomock_motor import AsyncMongoMockClient

TID = "pharm-r"
DUE = datetime(2026, 10, 1, tzinfo=timezone.utc)


async def _db(monkeypatch, active="revolut"):
    db = AsyncMongoMockClient(tz_aware=True)["rev_switch"]
    monkeypatch.setattr(bs, "shared_db", lambda: db)
    monkeypatch.setattr(inv, "shared_db", lambda: db)
    import app.services.addon_service as addon_service
    import app.services.ai_credits as ai_credits
    import app.services.message_wallet as message_wallet
    for mod in (addon_service, ai_credits, message_wallet):
        monkeypatch.setattr(mod, "shared_db", lambda: db)
    await db["platform_settings"].insert_one({"_id": "billing", "active_provider": active})
    await db["tenants"].insert_one({"_id": TID, "name": "Φ", "billing_profile": {"email": "a@b.gr"}})
    await db["packages"].insert_one({"_id": "adv", "name": "Advanced", "price_monthly": 8900,
                                     "price_includes_vat": False, "included_users": 1})
    invoices: list[dict] = []

    async def create_for_payment(**k):
        invoices.append(k)
        return k
    monkeypatch.setattr(inv, "create_for_payment", create_for_payment)

    async def quiet(*a, **k):
        return None
    monkeypatch.setattr(bs, "_billing_email", quiet)
    monkeypatch.setattr(bs, "payment_rejected", quiet)
    import app.services.comms as comms
    import app.services.receipts as receipts
    monkeypatch.setattr(receipts, "record", quiet)
    monkeypatch.setattr(comms, "admin_alert", quiet)

    async def configured():
        return True
    monkeypatch.setattr(bs, "any_provider_configured", configured)

    async def no_sleep(_):
        return None
    monkeypatch.setattr(bs.asyncio, "sleep", no_sleep)
    return db, invoices


def _orders(monkeypatch, orders: dict):
    async def get_order(oid):
        return orders.get(oid)
    monkeypatch.setattr(rv, "get_order", get_order)


async def test_viva_customer_keeps_viva_after_switch(monkeypatch):
    db, _ = await _db(monkeypatch)
    calls = []

    async def viva_charge(**k):
        calls.append("viva")
        return {"ok": False, "error": "x"}

    async def rev_charge(**k):
        calls.append("revolut")
        return {"ok": False}
    monkeypatch.setattr(bs.viva_service, "charge_recurring", viva_charge)
    monkeypatch.setattr(rv, "charge_off_session", rev_charge)
    await bs._charge_recurring({"payment_provider": "viva", "viva_transaction_id": "t1"}, 100, TID)
    assert calls == ["viva"]


async def test_abandoned_card_change_keeps_working_card(monkeypatch):
    db, _ = await _db(monkeypatch)
    await db["subscriptions"].insert_one({"tenant_id": TID, "payment_provider": "viva",
                                          "viva_transaction_id": "t1", "payment_status": "card_saved"})

    async def save_order(**k):
        return {"ok": True, "token": "tok", "order_id": "o-save", "customer_id": "c-new"}

    async def cfg():
        return {"mode": "sandbox"}
    monkeypatch.setattr(rv, "create_save_card_order", save_order)
    monkeypatch.setattr(rv, "config", cfg)
    assert (await bs.start_card_capture(TID))["ok"]
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert sub["payment_provider"] == "viva" and sub["payment_status"] == "card_saved"
    assert await bs.card_on_file(TID)
    # εγκατάλειψη → ακύρωση από τη Revolut: καμία αλλαγή, κανένα past_due
    await bs.handle_webhook("ORDER_CANCELLED", {"id": "o-save", "state": "cancelled",
                                                "merchant_order_data": {"reference": TID}})
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert sub["payment_provider"] == "viva" and sub["payment_status"] == "card_saved"
    # ολοκλήρωση → ΤΩΡΑ γίνεται Revolut
    await bs.handle_webhook("ORDER_AUTHORISED", {"id": "o-save", "state": "authorised", "customer": {"id": "c-new"},
                                                 "merchant_order_data": {"reference": TID}})
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert sub["payment_provider"] == "revolut" and sub["revolut_customer_id"] == "c-new"


async def test_other_revolut_order_does_not_switch_provider(monkeypatch):
    db, _ = await _db(monkeypatch)
    await db["subscriptions"].insert_one({"tenant_id": TID, "payment_provider": "viva",
                                          "viva_transaction_id": "t1", "revolut_order_id": "o-save"})
    await bs.handle_webhook("ORDER_COMPLETED", {"id": "o-other", "state": "completed", "customer": {"id": "c"},
                                                "merchant_order_data": {"reference": TID}})
    assert (await db["subscriptions"].find_one({"tenant_id": TID}))["payment_provider"] == "viva"


async def test_locked_customer_renews_via_revolut(monkeypatch):
    db, invoices = await _db(monkeypatch)
    await db["subscriptions"].insert_one({"tenant_id": TID, "plan": "adv", "billing_cycle": "monthly",
                                          "status": "expired", "current_period_end": DUE, "unpaid_since": DUE,
                                          "payment_provider": "viva", "viva_transaction_id": "t1"})

    async def renewal_order(**k):
        assert k["redirect_url"] == bs.RENEWAL_RETURN_URL
        return {"ok": True, "order_id": "o-ren", "checkout_url": "https://checkout.revolut.com/x"}
    monkeypatch.setattr(rv, "create_renewal_order", renewal_order)
    r = await bs.start_renewal(TID, "adv", "monthly")
    assert r["ok"] and r["checkout_url"].startswith("https://checkout.revolut.com")
    amount = r["amount_cents"]
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert sub["pending_renewal"]["provider"] == "revolut" and sub["pending_renewal"]["order_id"] == "o-ren"

    # μη ολοκληρωμένη / άλλη παραγγελία → τίποτα
    _orders(monkeypatch, {"o-ren": {"id": "o-ren", "state": "pending", "amount": amount,
                                    "merchant_order_data": {"reference": TID}}})
    await bs.complete_renewal(TID, "o-ren", provider="revolut")
    await bs.complete_renewal(TID, "o-x", provider="revolut")
    assert (await db["subscriptions"].find_one({"tenant_id": TID}))["status"] == "expired" and not invoices

    _orders(monkeypatch, {"o-ren": {"id": "o-ren", "state": "completed", "amount": amount,
                                    "customer": {"id": "c-9"}, "merchant_order_data": {"reference": TID}}})
    await bs.handle_webhook("ORDER_COMPLETED", {"id": "o-ren", "state": "completed", "amount": amount,
                                                "customer": {"id": "c-9"}, "merchant_order_data": {"reference": TID}})
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert sub["status"] == "active" and sub["payment_provider"] == "revolut" and sub["revolut_customer_id"] == "c-9"
    assert sub["current_period_end"] == DUE + timedelta(days=30) and "unpaid_since" not in sub
    assert invoices[-1]["payment"]["provider"] == "revolut"


async def _due_revolut_sub(db):
    await db["subscriptions"].insert_one({
        "tenant_id": TID, "plan": "adv", "billing_cycle": "monthly", "status": "active",
        "current_period_end": DUE, "price_per_pharmacy": 8900,
        "payment_provider": "revolut", "revolut_customer_id": "c-1"})


async def test_pending_revolut_charge_neither_extends_nor_locks_nor_recharges(monkeypatch):
    db, invoices = await _db(monkeypatch)
    await _due_revolut_sub(db)
    charges = []

    async def charge(**k):
        charges.append(k["amount"])
        return {"ok": True, "order_id": "o-c", "state": "pending"}
    monkeypatch.setattr(rv, "charge_off_session", charge)
    orders = {"o-c": {"id": "o-c", "state": "processing", "amount": 0, "merchant_order_data": {"reference": TID}}}
    _orders(monkeypatch, orders)
    await bs.bill_due()
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert sub["pending_charge"]["order_id"] == "o-c" and "unpaid_since" not in sub and not invoices
    amount = sub["pending_charge"]["amount"]

    await bs.bill_due()                                  # ακόμη σε εξέλιξη → ΚΑΜΙΑ δεύτερη χρέωση
    assert len(charges) == 1

    orders["o-c"] = {**orders["o-c"], "state": "completed", "amount": amount}
    await bs.bill_due()
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert "pending_charge" not in sub and sub["current_period_end"] > DUE and len(charges) == 1
    assert invoices[-1]["payment"] == {"method": "card", "provider": "revolut", "transaction_id": "o-c"}


async def test_failed_revolut_charge_locks(monkeypatch):
    db, invoices = await _db(monkeypatch)
    await _due_revolut_sub(db)

    async def charge(**k):
        return {"ok": False, "order_id": "o-f", "state": "pending"}
    monkeypatch.setattr(rv, "charge_off_session", charge)
    _orders(monkeypatch, {"o-f": {"id": "o-f", "state": "failed", "amount": 0,
                                  "merchant_order_data": {"reference": TID}}})
    await bs.bill_due()
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert sub["unpaid_since"] == DUE and bs.effective_status(sub) == "expired" and not invoices
    assert "Revolut" in sub["lock_message"]


async def test_revolut_invoice_paid_only_when_revolut_confirms(monkeypatch):
    _orders(monkeypatch, {"ok": {"id": "ok", "state": "completed", "amount": 500, "merchant_order_data": {}},
                          "half": {"id": "half", "state": "completed", "amount": 100, "merchant_order_data": {}}})
    good = await inv.payment_proof("revolut", "ok", 500)
    bad = await inv.payment_proof("revolut", "half", 500)
    assert good["verified"] is True and bad["verified"] is False and bad["verify_reason"] == "amount_short"
    pay = {"provider": "revolut", "transaction_id": "half", **bad}
    assert inv.payment_status({"payment": pay}) == "unverified"
