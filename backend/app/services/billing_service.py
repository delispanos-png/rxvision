"""Subscription billing orchestration over Revolut (self-managed recurring).

Trial → card saved at signup → daily task charges off-session when the period ends →
success advances the period; repeated failure suspends the tenant (auto-deactivate).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.services import revolut_service as rv

CURRENCY = "EUR"
MAX_ATTEMPTS = 3


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _period_end(cycle: str, frm: datetime) -> datetime:
    return frm + (timedelta(days=365) if cycle == "yearly" else timedelta(days=30))


async def start_card_capture(tenant_id: str) -> dict:
    """Create the Revolut save-card order for a tenant → token for the checkout widget."""
    db = shared_db()
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id})
    if not sub:
        return {"ok": False, "error": "no_subscription"}
    tenant = await db["tenants"].find_one({"_id": tenant_id}) or {}
    bp = tenant.get("billing_profile") or {}
    amount = sub.get("price_per_pharmacy", 0) or 100  # min auth if amount unknown
    res = await rv.create_save_card_order(
        amount=amount, currency=sub.get("currency", CURRENCY),
        email=bp.get("email") or bp.get("billing_email") or "",
        name=bp.get("name") or tenant.get("name") or tenant_id,
        tenant_id=tenant_id, description=f"RxVision {sub.get('billing_cycle', 'monthly')} — card setup")
    if res.get("ok"):
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
            "revolut_order_id": res.get("order_id"),
            "revolut_customer_id": res.get("customer_id"),
            "payment_status": "card_pending"}})
        res["mode"] = (await rv.config()).get("mode", "sandbox")
    return res


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
        "amount": sub.get("price_per_pharmacy", 0), "currency": sub.get("currency", CURRENCY),
        "card_on_file": sub.get("payment_status") in ("card_saved", "active", "past_due"),
        "revolut_configured": await rv.is_configured(),
    }


async def _suspend(tenant_id: str, reason: str) -> None:
    db = shared_db()
    await db["tenants"].update_one({"_id": tenant_id}, {"$set": {
        "status": "suspended", "suspended_reason": reason, "updated_at": _now()}})
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
        "status": "suspended", "payment_status": "failed"}})


async def bill_due() -> dict:
    """Charge subscriptions whose trial/period has ended. Auto-suspend after MAX_ATTEMPTS."""
    db = shared_db()
    if not await rv.is_configured():
        return {"skipped": "revolut_not_configured"}
    now = _now()
    charged = failed = suspended = 0
    # platform billing run — intentionally scans due subscriptions across ALL tenants.
    cur = db["subscriptions"].find({  # tenant-ok
        "status": {"$in": ["trialing", "active"]},
        "current_period_end": {"$lte": now},
        "revolut_customer_id": {"$ne": None},
        "price_per_pharmacy": {"$gt": 0},
    })
    async for sub in cur:
        tid = sub["tenant_id"]
        res = await rv.charge_off_session(
            amount=sub["price_per_pharmacy"], currency=sub.get("currency", CURRENCY),
            customer_id=sub["revolut_customer_id"], tenant_id=tid,
            description=f"RxVision {sub.get('billing_cycle', 'monthly')} renewal")
        if res.get("ok"):
            await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
                "status": "active", "payment_status": "active", "failed_attempts": 0,
                "current_period_end": _period_end(sub.get("billing_cycle", "monthly"), now),
                "last_charged_at": now}})
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


async def handle_webhook(event: str, order: dict) -> None:
    """Update billing state from a Revolut order webhook (reference = tenant_id)."""
    db = shared_db()
    tid = (order.get("merchant_order_data") or {}).get("reference")
    if not tid:
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
