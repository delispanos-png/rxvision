"""Subscription plan changes.

Two directions, different mechanics:

* **Upgrade** — takes effect after PAYMENT. Two payment methods the tenant chooses:
    - `card`  → Revolut checkout (instant); the plan is applied on the paid-order webhook.
    - `bank`  → bank-transfer to the platform account; surfaces as a **request in the admin panel**
                (`pending_change.status = "awaiting_payment"`), applied when the admin approves it.
* **Downgrade** — no payment; it is **scheduled to the end of the paid period** (monthly → current
    period end, yearly → yearly renewal) so the tenant keeps what they paid for until then. A daily
    beat task applies due downgrades.

State lives on `subscriptions.pending_change`. Money is integer cents (project convention).
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db
from app.services import revolut_service as rv
from app.services.billing_service import _period_end  # reuse the period math

CURRENCY = "EUR"


class PlanChangeError(Exception):
    """Business-rule violation (unknown/trial/same plan, provider error). Surfaced as 400."""


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else (v or None)


async def _pkg(plan: str | None) -> dict | None:
    if not plan:
        return None
    return await shared_db()["packages"].find_one({"_id": plan})


def _price(pkg: dict | None, yearly: bool) -> int:
    """Price (cents) of a package for the tenant's billing cycle (fallback to monthly)."""
    if not pkg:
        return 0
    v = pkg.get("price_yearly") if yearly else pkg.get("price_monthly")
    return int(v if v is not None else (pkg.get("price_monthly") or 0) or 0)


# ── bank account config (platform-level; shown to tenants for bank-transfer upgrades) ────────────
async def bank_details() -> dict:
    return await shared_db()["platform_settings"].find_one({"_id": "billing_bank"}) or {}


def bank_public(doc: dict) -> dict:
    return {k: doc.get(k) for k in ("beneficiary", "bank_name", "iban", "swift", "notes")}


async def set_bank_details(data: dict) -> dict:
    upd = {k: v for k, v in data.items() if v is not None}
    upd["updated_at"] = _now()
    await shared_db()["platform_settings"].update_one({"_id": "billing_bank"}, {"$set": upd}, upsert=True)
    return bank_public(await bank_details())


# ── classification ──────────────────────────────────────────────────────────────────────────────
async def _guard_target(sub: dict, plan: str) -> dict:
    pkg = await _pkg(plan)
    if not pkg or pkg.get("active") is False:
        raise PlanChangeError("unknown_plan")
    if int(pkg.get("price_monthly", 0) or 0) <= 0:
        raise PlanChangeError("trial_not_selectable")   # δωρεάν δοκιμή — όχι επιλέξιμο πακέτο
    if plan == sub.get("plan"):
        raise PlanChangeError("already_on_plan")
    return pkg


async def classify(tenant_id: str, plan: str) -> dict:
    db = shared_db()
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    pkg = await _guard_target(sub, plan)
    yearly = sub.get("billing_cycle") == "yearly"
    new_price = _price(pkg, yearly)
    cur_pkg = await _pkg(sub.get("plan"))
    cur_price = _price(cur_pkg, yearly) if cur_pkg else int(sub.get("price_per_pharmacy", 0) or 0)
    kind = "upgrade" if new_price > cur_price else "downgrade"
    return {"kind": kind, "new_price": new_price, "current_price": cur_price,
            "yearly": yearly, "pkg": pkg, "sub": sub}


# ── request a change ──────────────────────────────────────────────────────────────────────────────
async def request_change(tenant_id: str, plan: str, *, method: str | None = None,
                         by_email: str | None = None) -> dict:
    db = shared_db()
    c = await classify(tenant_id, plan)
    sub, pkg, yearly, kind, new_price = c["sub"], c["pkg"], c["yearly"], c["kind"], c["new_price"]
    cycle = sub.get("billing_cycle", "monthly")
    plan_name = pkg.get("name") or plan
    base = {"plan": plan, "plan_name": plan_name, "kind": kind, "billing_cycle": cycle,
            "new_price": new_price, "requested_at": _now(), "requested_by": by_email}

    # ── DOWNGRADE — schedule at period end / yearly renewal, no payment ──
    if kind == "downgrade":
        eff = sub.get("current_period_end") or _period_end(cycle, _now())
        pend = {**base, "status": "scheduled", "effective_at": eff}
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {"pending_change": pend}})
        return {"kind": "downgrade", "status": "scheduled", "effective_at": _iso(eff),
                "plan": plan, "plan_name": plan_name, "new_price": new_price, "billing_cycle": cycle}

    # ── UPGRADE — payment required (only via an ENABLED method) ──
    from app.services import payment_methods
    _method_key = {"card": "card_revolut", "alpha": "card_alpha", "bank": "bank_transfer"}.get(method or "")
    if not _method_key or not await payment_methods.is_enabled(_method_key):
        raise PlanChangeError("method_disabled")

    if method == "card":   # Revolut hosted checkout (instant)
        tenant = await db["tenants"].find_one({"_id": tenant_id}) or {}
        bp = tenant.get("billing_profile") or {}
        res = await rv.create_topup_order(
            amount=new_price, currency=CURRENCY,
            email=bp.get("email") or bp.get("billing_email") or "",
            name=bp.get("name") or tenant.get("name") or tenant_id,
            tenant_id=tenant_id, description=f"RxVision αναβάθμιση σε {plan_name}")
        if not res.get("ok"):
            raise PlanChangeError(res.get("error", "revolut_error"))
        pend = {**base, "status": "awaiting_payment", "method": "card",
                "revolut_order_id": res.get("order_id"), "effective_at": None}
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {"pending_change": pend}})
        return {"kind": "upgrade", "method": "card", "status": "awaiting_payment",
                "token": res.get("token"), "order_id": res.get("order_id"),
                "mode": (await rv.config()).get("mode", "sandbox"),
                "amount": new_price, "plan": plan, "plan_name": plan_name}

    if method == "alpha":  # Alpha Bank hosted payment page (redirect)
        from app.services import alphabank_service as ab
        order_id = f"{tenant_id}-{plan}-{int(_now().timestamp())}".upper()
        tenant = await db["tenants"].find_one({"_id": tenant_id}) or {}
        bp = tenant.get("billing_profile") or {}
        res = await ab.create_payment(
            amount_cents=new_price, currency=CURRENCY, order_id=order_id,
            description=f"RxVision αναβάθμιση σε {plan_name}",
            confirm_url="https://app.rxvision.gr/api/v1/subscription/alpha-callback",
            cancel_url="https://app.rxvision.gr/settings/modules",
            email=bp.get("email") or bp.get("billing_email") or "")
        if not res.get("ok"):
            raise PlanChangeError(res.get("error", "alphabank_error"))
        pend = {**base, "status": "awaiting_payment", "method": "alpha",
                "alpha_order_id": order_id, "effective_at": None}
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {"pending_change": pend}})
        return {"kind": "upgrade", "method": "alpha", "status": "awaiting_payment",
                "action": res["action"], "fields": res["fields"], "order_id": order_id,
                "amount": new_price, "plan": plan, "plan_name": plan_name}

    # bank transfer → admin request
    reference = f"{tenant_id}-{plan}".upper()
    pend = {**base, "status": "awaiting_payment", "method": "bank",
            "reference": reference, "effective_at": None}
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {"pending_change": pend}})
    return {"kind": "upgrade", "method": "bank", "status": "awaiting_payment",
            "amount": new_price, "reference": reference, "bank": bank_public(await bank_details()),
            "plan": plan, "plan_name": plan_name}


async def cancel_change(tenant_id: str) -> dict:
    """Cancel a not-yet-applied change (scheduled downgrade or awaiting-payment upgrade)."""
    await shared_db()["subscriptions"].update_one(
        {"tenant_id": tenant_id, "pending_change.status": {"$in": ["scheduled", "awaiting_payment"]}},
        {"$unset": {"pending_change": ""}})
    return {"ok": True}


async def get_pending(tenant_id: str) -> dict:
    """The tenant's current pending change (annotated for display) + bank details when relevant."""
    sub = await shared_db()["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    pend = sub.get("pending_change")
    if not pend:
        return {"pending": None}
    out = {**pend, "effective_at": _iso(pend.get("effective_at")),
           "requested_at": _iso(pend.get("requested_at"))}
    if pend.get("method") == "bank":
        out["bank"] = bank_public(await bank_details())
    return {"pending": out}


# ── apply (upgrade paid / downgrade due) ──────────────────────────────────────────────────────────
async def apply_change(tenant_id: str, *, source: str = "system") -> dict:
    """Apply the tenant's pending change: switch plan + price + included modules, clear pending."""
    db = shared_db()
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    pend = sub.get("pending_change")
    if not pend:
        return {"ok": False, "error": "no_pending"}
    pkg = await _pkg(pend["plan"])
    if not pkg:
        return {"ok": False, "error": "unknown_plan"}
    yearly = (pend.get("billing_cycle") or sub.get("billing_cycle")) == "yearly"
    upd: dict = {"plan": pend["plan"], "price_per_pharmacy": _price(pkg, yearly),
                 "modules_included": pkg.get("modules", []), "updated_at": _now(),
                 "last_plan_change": {"kind": pend.get("kind"), "at": _now(), "source": source,
                                      "from": sub.get("plan"), "to": pend["plan"]}}
    if pkg.get("sla"):
        upd["sla"] = pkg["sla"]
    # An upgrade is paid now → start a fresh paid period + mark active. A downgrade rolls at the
    # existing period boundary (bill_due advances the period), so we don't touch current_period_end.
    if pend.get("kind") == "upgrade":
        upd["current_period_end"] = _period_end(sub.get("billing_cycle", "monthly"), _now())
        upd["status"] = "active"
        upd["payment_status"] = "active"
    await db["subscriptions"].update_one({"tenant_id": tenant_id},
                                         {"$set": upd, "$unset": {"pending_change": ""}})
    # Παραστατικό αναβάθμισης (η υποβάθμιση δεν έχει πληρωμή).
    if pend.get("kind") == "upgrade":
        from app.services import receipts
        method = {"card": "card", "bank": "bank_transfer"}.get(pend.get("method"), pend.get("method"))
        provider = {"card": "revolut", "alpha": "alphabank"}.get(pend.get("method"))
        await receipts.record(tenant_id, "upgrade",
                              f"Αναβάθμιση σε {pend.get('plan_name') or pend['plan']}",
                              int(pend.get("new_price", 0) or 0), method=method, provider=provider,
                              provider_order_id=pend.get("revolut_order_id"))
        from app.services import invoice_service
        await invoice_service.create_for_payment(
            tenant_id=tenant_id, kind="upgrade", gross_cents=int(pend.get("new_price", 0) or 0),
            description=f"Αναβάθμιση σε {pend.get('plan_name') or pend['plan']}",
            payment={"method": method, "provider": provider,
                     "transaction_id": pend.get("revolut_order_id")})
    return {"ok": True, "plan": pend["plan"], "kind": pend.get("kind")}


async def apply_due_downgrades() -> dict:
    """Beat: apply scheduled downgrades whose effective date has arrived."""
    db = shared_db()
    now = _now()
    applied = 0
    cur = db["subscriptions"].find({"pending_change.kind": "downgrade",
                                    "pending_change.status": "scheduled",
                                    "pending_change.effective_at": {"$lte": now}})
    async for sub in cur:
        res = await apply_change(sub["tenant_id"], source="scheduled_downgrade")
        if res.get("ok"):
            applied += 1
    return {"applied": applied}


async def list_pending_admin() -> list[dict]:
    """All tenants with a pending change for the admin panel (bank-transfer upgrades to approve,
    plus scheduled downgrades & card payments in flight — read-only context)."""
    db = shared_db()
    out: list[dict] = []
    cur = db["subscriptions"].find({"pending_change": {"$exists": True}})
    async for sub in cur:
        pend = sub.get("pending_change") or {}
        tenant = await db["tenants"].find_one({"_id": sub["tenant_id"]}, {"name": 1}) or {}
        out.append({
            "tenant_id": sub["tenant_id"], "tenant_name": tenant.get("name"),
            "current_plan": sub.get("plan"), "billing_cycle": sub.get("billing_cycle"),
            "kind": pend.get("kind"), "method": pend.get("method"), "status": pend.get("status"),
            "plan": pend.get("plan"), "plan_name": pend.get("plan_name"),
            "new_price": int(pend.get("new_price", 0) or 0), "reference": pend.get("reference"),
            "requested_by": pend.get("requested_by"),
            "requested_at": _iso(pend.get("requested_at")),
            "effective_at": _iso(pend.get("effective_at")),
        })
    # bank-transfer upgrades awaiting approval first
    out.sort(key=lambda r: (not (r["method"] == "bank" and r["status"] == "awaiting_payment"),
                            r["requested_at"] or ""))
    return out
