"""«Πληρώθηκε;» = ό,τι επιβεβαιώνει η ΙΔΙΑ η Viva (viva_service.verify_payment) — 02/10/2026.

Αναπαράγει το περιστατικό Helthea (29/09/2026): η επαλήθευση κάρτας 0,10 € πέρασε ως «ανανέωση 110,36 €»,
βγήκε «πληρωμένο» παραστατικό και δόθηκε μήνας χωρίς πληρωμή.
"""

from __future__ import annotations

from datetime import datetime, timezone

import app.services.billing_service as bs
import app.services.invoice_service as inv
import app.services.viva_service as viva
from mongomock_motor import AsyncMongoMockClient

TID = "pharm-1"
CARD_SAVE = {"StatusId": "F", "Amount": 0.10, "MerchantTrns": TID, "OrderCode": "111"}
RENEWAL = {"StatusId": "F", "Amount": 110.36, "MerchantTrns": f"renew:{TID}", "OrderCode": "222"}


def _viva(monkeypatch, txns: dict):
    async def get_transaction(tid, creds=None):
        return txns.get(tid)

    async def order_paid(code, creds=None):
        return None
    monkeypatch.setattr(viva, "get_transaction", get_transaction)
    monkeypatch.setattr(viva, "order_paid_transaction", order_paid)


async def test_verify_payment_rules(monkeypatch):
    _viva(monkeypatch, {"card": CARD_SAVE, "ren": RENEWAL, "open": {**RENEWAL, "StatusId": "A"}})
    assert (await viva.verify_payment("ren", merchant_trns=f"renew:{TID}", expected_cents=11036))["ok"]
    assert (await viva.verify_payment("card", merchant_trns=f"renew:{TID}"))["reason"] == "other_payment"
    assert (await viva.verify_payment("card", expected_cents=11036))["reason"] == "amount_short"
    assert (await viva.verify_payment("open"))["reason"] == "not_finished"
    assert (await viva.verify_payment("missing"))["reason"] == "not_found"
    assert (await viva.verify_payment("ren", order_code="999"))["reason"] == "other_order"


async def _renewal_db(monkeypatch):
    db = AsyncMongoMockClient()["viva_v"]
    monkeypatch.setattr(bs, "shared_db", lambda: db)
    monkeypatch.setattr(inv, "shared_db", lambda: db)

    async def no_alert(*a, **k):
        return None
    monkeypatch.setattr(bs, "payment_rejected", no_alert)
    end = datetime(2026, 9, 30, tzinfo=timezone.utc)
    await db["subscriptions"].insert_one({
        "tenant_id": TID, "plan": "adv", "billing_cycle": "monthly", "status": "active",
        "current_period_end": end,
        "pending_renewal": {"plan": "adv", "billing_cycle": "monthly", "amount": 11036, "order_code": "222"}})
    return db, end


async def test_card_save_never_completes_renewal(monkeypatch):
    _viva(monkeypatch, {"card": CARD_SAVE})
    db, end = await _renewal_db(monkeypatch)
    await bs.complete_renewal(TID, "card")
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert sub["current_period_end"].replace(tzinfo=timezone.utc) == end      # καμία επέκταση
    assert sub.get("pending_renewal")                                          # εκκρεμεί ακόμη
    assert await db["invoices"].count_documents({}) == 0                       # κανένα παραστατικό


async def test_invoice_paid_only_when_viva_confirms_amount(monkeypatch):
    _viva(monkeypatch, {"card": CARD_SAVE, "ren": RENEWAL})
    db = AsyncMongoMockClient()["viva_inv"]
    monkeypatch.setattr(inv, "shared_db", lambda: db)

    async def cfg():
        return {"series": "7002", "mtrl_map": {}}
    monkeypatch.setattr(inv.softone_service, "platform_config", cfg)
    await db["tenants"].insert_one({"_id": TID, "name": "Φ", "billing_profile": {"afm": "1", "email": "a@b.gr"}})
    await db["subscriptions"].insert_one({"tenant_id": TID, "plan": "adv", "billing_cycle": "monthly"})
    bad = await inv.create_for_payment(tenant_id=TID, kind="renewal", gross_cents=11036,
                                       payment={"provider": "viva", "transaction_id": "card"})
    good = await inv.create_for_payment(tenant_id=TID, kind="renewal", gross_cents=11036,
                                        payment={"provider": "viva", "transaction_id": "ren"})
    assert bad["payment"]["verified"] is False and bad["payment"]["verify_reason"] == "amount_short"
    assert good["payment"]["verified"] is True

    from app.api.v1.routers.admin import _payment_status
    assert _payment_status(bad) == "unverified" and _payment_status(good) == "paid"
    unpaid = await inv.reverify_viva_invoices(db)
    assert [u["paid"] for u in unpaid] == [10]


async def test_recurring_charge_uses_web_host_and_needs_status_f(monkeypatch):
    calls = []

    async def creds(_):
        return {"mode": "live", "merchant_id": "m", "api_key": "k", "source_code": "s"}

    class R:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"StatusId": "E", "TransactionId": None, "Success": False, "ErrorCode": 403,
                    "ErrorText": "The specified api action is disabled"}

    class C:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, **k):
            calls.append(url)
            return R()
    monkeypatch.setattr(viva, "_creds", creds)
    monkeypatch.setattr(viva.httpx, "AsyncClient", C)
    r = await viva.charge_recurring(original_transaction_id="x", amount=11036, description="d")
    assert calls == ["https://www.vivapayments.com/api/transactions/x"]
    assert r["ok"] is False and "403" in r["error"]


async def _lock_db(monkeypatch):
    db = AsyncMongoMockClient(tz_aware=True)["viva_lock"]
    monkeypatch.setattr(bs, "shared_db", lambda: db)
    monkeypatch.setattr(inv, "shared_db", lambda: db)

    async def no_email(*a, **k):
        return None
    monkeypatch.setattr(bs, "_billing_email", no_email)
    return db


async def test_failed_charge_locks_and_renewal_starts_from_due_date(monkeypatch):
    """Αποτυχία αυτόματης χρέωσης → κλείδωμα + μήνυμα· η πληρωμή ξεκινά την περίοδο από τη λήξη που χρωστούσε."""
    db = await _lock_db(monkeypatch)
    due = datetime(2026, 9, 30, tzinfo=timezone.utc)
    await db["subscriptions"].insert_one({"tenant_id": TID, "plan": "adv", "billing_cycle": "monthly",
                                          "status": "active", "current_period_end": due})
    assert await bs.lock_unpaid(TID, due_from=due, amount=11036, reason="test")
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert bs.effective_status(sub) == "expired" and bs.UNPAID_MESSAGE in sub["lock_message"] and "30/09/2026 – 30/10/2026" in sub["lock_message"]
    assert not await bs.lock_unpaid(TID, due_from=due)                         # idempotent

    _viva(monkeypatch, {"ren": RENEWAL})
    await db["subscriptions"].update_one({"tenant_id": TID}, {"$set": {"pending_renewal": {
        "plan": "adv", "billing_cycle": "monthly", "amount": 11036}}})
    await db["packages"].insert_one({"_id": "adv", "name": "Advanced", "price_monthly": 8900})
    await bs.complete_renewal(TID, "ren")
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert sub["current_period_end"].replace(tzinfo=timezone.utc) == datetime(2026, 10, 30, tzinfo=timezone.utc)
    assert "lock_message" not in sub and "unpaid_since" not in sub


async def test_unverified_renewal_invoice_locks_subscription(monkeypatch):
    db = await _lock_db(monkeypatch)
    await db["subscriptions"].insert_one({"tenant_id": TID, "plan": "adv", "billing_cycle": "monthly",
                                          "status": "active",
                                          "current_period_end": datetime(2099, 10, 30, tzinfo=timezone.utc)})
    doc = {"tenant_id": TID, "kind": "renewal", "total": 11036, "created_at": datetime(2026, 9, 29),
           "payment": {"provider": "viva", "transaction_id": "card", "verified": False}}
    doc["_id"] = (await db["invoices"].insert_one(doc)).inserted_id
    assert await bs.lock_for_unverified_invoice(doc)
    sub = await db["subscriptions"].find_one({"tenant_id": TID})
    assert sub["unpaid_since"].replace(tzinfo=timezone.utc) == datetime(2099, 9, 30, tzinfo=timezone.utc)
    assert bs.effective_status(sub) == "expired"


async def test_customer_sees_only_own_invoices_with_payment_info(monkeypatch):
    """Ρυθμίσεις → Χρέωση: τα ΙΔΙΑ παραστατικά με το adminpanel, ΜΟΝΟ του φαρμακείου, χωρίς προτιμολόγιο ως αριθμό."""
    db = AsyncMongoMockClient()["viva_cust"]
    monkeypatch.setattr(inv, "shared_db", lambda: db)
    await db["invoices"].insert_many([
        {"tenant_id": TID, "kind": "renewal", "total": 11036, "net_amount": 8900, "vat_amount": 2136,
         "softone_number": "ΠΡΤΙΜ00007", "transformed_number": "ΤΠΥ0000200", "aade_qr": "https://q",
         "payment": {"method": "card", "provider": "viva", "transaction_id": "t", "verified": True},
         "created_at": datetime(2026, 9, 29)},
        {"tenant_id": TID, "kind": "renewal", "total": 11036, "softone_number": "ΠΡΤΙΜ00009",
         "payment": {}, "created_at": datetime(2026, 10, 2)},
        {"tenant_id": "other", "kind": "renewal", "total": 1, "payment": {}, "created_at": datetime(2026, 10, 2)}])
    rows = await inv.list_for_tenant(TID)
    assert len(rows) == 2
    paid, pending = rows[1], rows[0]
    assert paid["number"] == "ΤΠΥ0000200" and paid["payment_status"] == "paid"
    assert paid["payment_method"] == "Κάρτα (Viva)" and paid["aade_qr"] == "https://q"
    assert pending["number"] is None and pending["payment_status"] == "unpaid"   # ΠΡΤΙΜ δεν εμφανίζεται
    assert await inv.list_for_tenant("") == []
