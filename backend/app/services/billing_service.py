"""Subscription billing orchestration over Revolut (self-managed recurring).

Trial → card saved at signup → daily task charges off-session when the period ends →
success advances the period; repeated failure suspends the tenant (auto-deactivate).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.services import revolut_service as rv
from app.services import viva_service

CURRENCY = "EUR"
MAX_ATTEMPTS = 3


async def active_provider() -> str:
    """Ποιος πάροχος χρεώνει τις συνδρομές: 'revolut' (default) ή 'viva'. Ρυθμίζεται στο adminpanel
    (platform_settings._id='billing'.active_provider). Default = revolut → διατηρεί την υπάρχουσα ροή."""
    doc = await shared_db()["platform_settings"].find_one({"_id": "billing"}) or {}
    p = doc.get("active_provider")
    return p if p in ("revolut", "viva") else "revolut"


async def any_provider_configured() -> bool:
    return await rv.is_configured() or await viva_service.is_configured()


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _period_end(cycle: str, frm: datetime) -> datetime:
    return frm + (timedelta(days=365) if cycle == "yearly" else timedelta(days=30))


async def start_card_capture(tenant_id: str) -> dict:
    """Ξεκίνα αποθήκευση κάρτας για τη συνδρομή, μέσω του ΕΝΕΡΓΟΥ παρόχου.
    Revolut → {ok, token, mode} (widget). Viva → {ok, checkout_url} (redirect· κάρτα ή IRIS)."""
    db = shared_db()
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id})
    if not sub:
        return {"ok": False, "error": "no_subscription"}
    tenant = await db["tenants"].find_one({"_id": tenant_id}) or {}
    bp = tenant.get("billing_profile") or {}
    email = bp.get("email") or bp.get("billing_email") or ""
    name = bp.get("name") or tenant.get("name") or tenant_id
    amount = sub.get("price_per_pharmacy", 0) or 100  # min auth if amount unknown
    prov = await active_provider()
    if prov == "viva":
        res = await viva_service.create_checkout_order(
            amount=amount, ref=tenant_id, description=f"RxVision {sub.get('billing_cycle', 'monthly')} — card setup",
            email=email, full_name=name, allow_recurring=True)
        if res.get("ok"):
            await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
                "payment_provider": "viva", "viva_order_code": res.get("order_code"),
                "payment_status": "card_pending"}})
        res["provider"] = "viva"
        return res
    res = await rv.create_save_card_order(
        amount=amount, currency=sub.get("currency", CURRENCY), email=email, name=name,
        tenant_id=tenant_id, description=f"RxVision {sub.get('billing_cycle', 'monthly')} — card setup")
    if res.get("ok"):
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
            "payment_provider": "revolut",
            "revolut_order_id": res.get("order_id"),
            "revolut_customer_id": res.get("customer_id"),
            "payment_status": "card_pending"}})
        res["mode"] = (await rv.config()).get("mode", "sandbox")
    res["provider"] = "revolut"
    return res


# Καταστάσεις πληρωμής που σημαίνουν «υπάρχει αποθηκευμένη κάρτα που μπορούμε να χρεώσουμε off-session».
CARD_ON_FILE_STATES = ("card_saved", "active", "past_due")


async def card_on_file(tenant_id: str) -> bool:
    """True αν το φαρμακείο έχει αποθηκευμένη κάρτα (ξεκλειδώνει τα χρεώσιμα extras).
    Single source of truth για το gate — δεκτό είτε Revolut customer είτε Viva recurring transaction."""
    if not tenant_id:
        return False
    sub = await shared_db()["subscriptions"].find_one(
        {"tenant_id": tenant_id},
        {"payment_status": 1, "revolut_customer_id": 1, "viva_transaction_id": 1}) or {}
    return (sub.get("payment_status") in CARD_ON_FILE_STATES
            and bool(sub.get("revolut_customer_id") or sub.get("viva_transaction_id")))


async def mark_card_saved(tenant_id: str, customer_id: str | None = None) -> None:
    upd = {"payment_status": "card_saved", "failed_attempts": 0}
    if customer_id:
        upd["revolut_customer_id"] = customer_id
    await shared_db()["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": upd})


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else (v or None)


async def status(tenant_id: str) -> dict:
    sub = await shared_db()["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    return {
        "plan": sub.get("plan"), "status": sub.get("status"),
        "billing_cycle": sub.get("billing_cycle"),
        "payment_status": sub.get("payment_status", "trial"),
        "trial_ends_at": _iso(sub.get("trial_ends_at")),
        "current_period_end": _iso(sub.get("current_period_end")),
        "amount": int(sub.get("price_per_pharmacy", 0) or 0) + int(sub.get("addons_total", 0) or 0),
        "base_amount": int(sub.get("price_per_pharmacy", 0) or 0),
        "addons_total": int(sub.get("addons_total", 0) or 0),
        "currency": sub.get("currency", CURRENCY),
        "card_on_file": (sub.get("payment_status") in CARD_ON_FILE_STATES
                         and bool(sub.get("revolut_customer_id") or sub.get("viva_transaction_id"))),
        "payment_provider": sub.get("payment_provider") or await active_provider(),
        "revolut_configured": await rv.is_configured(),
        "viva_configured": await viva_service.is_configured(),
    }


async def _suspend(tenant_id: str, reason: str) -> None:
    db = shared_db()
    await db["tenants"].update_one({"_id": tenant_id}, {"$set": {
        "status": "suspended", "suspended_reason": reason, "updated_at": _now()}})
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
        "status": "suspended", "payment_status": "failed"}})


async def _charge_recurring(sub: dict, amount: int, tid: str) -> dict:
    """Off-session χρέωση ανανέωσης μέσω του παρόχου της συνδρομής (Revolut ή Viva)."""
    prov = sub.get("payment_provider") or "revolut"
    desc = f"RxVision {sub.get('billing_cycle', 'monthly')} renewal"
    if prov == "viva":
        if not sub.get("viva_transaction_id"):
            return {"ok": False, "error": "no_viva_transaction"}
        r = await viva_service.charge_recurring(
            original_transaction_id=sub["viva_transaction_id"], amount=amount, description=desc)
        return {"ok": r.get("ok"), "order_id": r.get("transaction_id"), "provider": "viva"}
    if not sub.get("revolut_customer_id"):
        return {"ok": False, "error": "no_revolut_customer"}
    r = await rv.charge_off_session(
        amount=amount, currency=sub.get("currency", CURRENCY),
        customer_id=sub["revolut_customer_id"], tenant_id=tid, description=desc)
    return {"ok": r.get("ok"), "order_id": r.get("order_id"), "provider": "revolut"}


async def bill_due() -> dict:
    """Charge subscriptions whose trial/period has ended. Auto-suspend after MAX_ATTEMPTS."""
    db = shared_db()
    if not await any_provider_configured():
        return {"skipped": "no_provider_configured"}
    now = _now()
    charged = failed = suspended = 0
    cur = db["subscriptions"].find({"$and": [
        {"status": {"$in": ["trialing", "active"]}},
        {"current_period_end": {"$lte": now}},
        {"$or": [{"revolut_customer_id": {"$ne": None}}, {"viva_transaction_id": {"$ne": None}}]},
        {"$or": [{"price_per_pharmacy": {"$gt": 0}}, {"addons_total": {"$gt": 0}}]},
    ]})
    async for sub in cur:
        tid = sub["tenant_id"]
        # full recurring amount = base subscription + active à-la-carte add-ons
        amount = int(sub.get("price_per_pharmacy", 0) or 0) + int(sub.get("addons_total", 0) or 0)
        if amount <= 0:
            continue
        res = await _charge_recurring(sub, amount, tid)
        if res.get("ok"):
            await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
                "status": "active", "payment_status": "active", "failed_attempts": 0,
                "current_period_end": _period_end(sub.get("billing_cycle", "monthly"), now),
                "last_charged_at": now}})
            from app.services import receipts
            await receipts.record(tid, "subscription",
                                  f"Συνδρομή {sub.get('plan', '')} ({sub.get('billing_cycle', 'monthly')})",
                                  amount, method="card", provider=res.get("provider", "revolut"),
                                  provider_order_id=res.get("order_id"))
            charged += 1
        else:
            attempts = sub.get("failed_attempts", 0) + 1
            await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
                "payment_status": "past_due", "failed_attempts": attempts}})
            failed += 1
            if attempts >= MAX_ATTEMPTS:
                await _suspend(tid, "payment_failed")
                suspended += 1
    return {"charged": charged, "failed": failed, "suspended": suspended}


async def handle_viva_webhook(event_data: dict) -> None:
    """Viva «Transaction Payment Created» webhook → αποθήκευσε το transaction id (recurring seed) &
    μάρκαρε card_saved. tenant = MerchantTrns· επιβεβαίωση με re-fetch της συναλλαγής (StatusId 'F')."""
    db = shared_db()
    tid = event_data.get("MerchantTrns") or event_data.get("merchantTrns")
    order_code = str(event_data.get("OrderCode") or "")
    txn = event_data.get("TransactionId") or event_data.get("transactionId")
    if not tid and order_code:
        sub = await db["subscriptions"].find_one({"viva_order_code": order_code}, {"tenant_id": 1})
        tid = (sub or {}).get("tenant_id")
    if not tid or not txn:
        return
    # επιβεβαίωση: re-fetch της συναλλαγής από το Viva (source of truth) — μη εμπιστεύεσαι το payload
    info = await viva_service.get_transaction(str(txn))
    status_id = str((info or {}).get("StatusId") or event_data.get("StatusId") or "")
    if status_id and status_id != "F":       # F = Finished (επιτυχής)
        return
    await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
        "payment_provider": "viva", "viva_transaction_id": str(txn),
        "payment_status": "card_saved", "failed_attempts": 0}})
    from app.services import plan_change_service   # αναβάθμιση πληρωμένη με Viva → εφάρμοσε την
    sub = await db["subscriptions"].find_one({"tenant_id": tid}) or {}
    pend = sub.get("pending_change") or {}
    if pend.get("method") in ("card", "viva") and pend.get("status") == "awaiting_payment":
        await plan_change_service.apply_change(tid, source="viva")


async def handle_webhook(event: str, order: dict) -> None:
    """Update billing state from a Revolut order webhook (reference = tenant_id)."""
    db = shared_db()
    tid = (order.get("merchant_order_data") or {}).get("reference")
    if not tid:
        return
    # Wallet top-up orders: credit the message wallet (idempotent) and stop — not a subscription event.
    if event == "ORDER_COMPLETED" and order.get("id"):
        from app.services import message_wallet
        if await message_wallet.complete_topup(order["id"]):
            return
        # Plan-upgrade paid by card: apply the pending change when its Revolut order completes.
        sub = await db["subscriptions"].find_one({"tenant_id": tid}) or {}
        pend = sub.get("pending_change") or {}
        if (pend.get("method") == "card" and pend.get("status") == "awaiting_payment"
                and pend.get("revolut_order_id") == order["id"]):
            from app.services import plan_change_service
            await plan_change_service.apply_change(tid, source="revolut")
            return
    cust = (order.get("customer") or {}).get("id")
    if event in ("ORDER_COMPLETED", "ORDER_AUTHORISED"):
        upd = {"payment_status": "card_saved", "failed_attempts": 0}
        if cust:
            upd["revolut_customer_id"] = cust
        await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": upd})
    elif event in ("ORDER_PAYMENT_FAILED", "ORDER_CANCELLED"):
        sub = await db["subscriptions"].find_one({"tenant_id": tid}) or {}
        attempts = sub.get("failed_attempts", 0) + 1
        await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
            "payment_status": "past_due", "failed_attempts": attempts}})
        if attempts >= MAX_ATTEMPTS:
            await _suspend(tid, "payment_failed")
