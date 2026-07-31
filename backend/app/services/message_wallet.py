"""Central message wallet — prepaid credits for patient communications.

Every pharmacy has a monetary balance (integer cents). Each email / SMS / Viber send is drawn down at
the platform's per-channel price; top-ups add credits. A ledger records every debit & credit for
metering and audit. Central provider credentials + prices live in `platform_settings._id="comms"`.

Money is integer cents everywhere (project convention). Channels: "email" | "sms" | "viber".
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from pymongo import ReturnDocument

from app.core.db import shared_db

# Default per-message prices (cents). Editable by the platform admin in platform_settings.comms.prices.
_DEFAULT_PRICES = {"email": 2, "sms": 6, "viber": 4}
CHANNELS = ("email", "sms", "viber")
# Χαμηλό υπόλοιπο: όταν πέσει κάτω από αυτό (cents) στέλνουμε ΜΙΑ ειδοποίηση email στο φαρμακείο
# (flag low_balance_alerted για να μη γίνεται spam· καθαρίζει με το επόμενο top-up). Editable στο comms.cfg.
_LOW_BALANCE_CENTS = 200


class InsufficientCredits(Exception):
    """Raised when the wallet can't cover a send — the caller surfaces «ανεπαρκές υπόλοιπο μηνυμάτων»."""


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _comms_cfg() -> dict:
    from app.services.platform_secrets import decrypt_doc
    return decrypt_doc("comms", await shared_db()["platform_settings"].find_one({"_id": "comms"})) or {}


async def prices() -> dict:
    p = (await _comms_cfg()).get("prices") or {}
    return {k: int(p.get(k, _DEFAULT_PRICES[k]) or 0) for k in _DEFAULT_PRICES}


async def price_of(channel: str) -> int:
    return (await prices()).get(channel, 0)


async def balance(tenant_id: str) -> int:
    w = await shared_db()["message_wallets"].find_one({"_id": tenant_id})
    return int((w or {}).get("balance_cents", 0) or 0)


async def can_send(tenant_id: str, channel: str, count: int = 1) -> bool:
    return await balance(tenant_id) >= (await price_of(channel)) * max(1, count)


async def charge(tenant_id: str, channel: str, count: int = 1, ref: str | None = None) -> dict:
    """Atomically debit the wallet for `count` messages on `channel`. Raises InsufficientCredits if the
    balance can't cover it (no partial charge). Returns {cost, unit, balance}."""
    db = shared_db()
    unit = await price_of(channel)
    cost = unit * max(1, int(count))
    if cost <= 0:                       # free channel (price 0) → allow, just log usage
        await _ledger(tenant_id, channel, "debit", count, unit, 0, ref, await balance(tenant_id))
        return {"cost": 0, "unit": unit, "balance": await balance(tenant_id)}
    doc = await db["message_wallets"].find_one_and_update(
        {"_id": tenant_id, "balance_cents": {"$gte": cost}},
        {"$inc": {"balance_cents": -cost}, "$set": {"updated_at": _now()}},
        return_document=ReturnDocument.AFTER)
    if not doc:
        raise InsufficientCredits(channel)
    await _ledger(tenant_id, channel, "debit", count, unit, -cost, ref, doc["balance_cents"])
    await _maybe_low_balance_alert(tenant_id, doc)
    return {"cost": cost, "unit": unit, "balance": doc["balance_cents"]}


async def _low_threshold() -> int:
    return int((await _comms_cfg()).get("low_balance_cents", _LOW_BALANCE_CENTS) or 0)


async def set_auto_recharge(tenant_id: str, enabled: bool, threshold_cents: int,
                            package_id: str | None) -> None:
    """Ρύθμιση αυτόματης αναπλήρωσης credits με κάρτα-on-file όταν πέσει το υπόλοιπο."""
    await shared_db()["message_wallets"].update_one(
        {"_id": tenant_id},
        {"$set": {"auto_recharge": {"enabled": bool(enabled),
                                    "threshold_cents": int(threshold_cents or 0),
                                    "package_id": package_id}}}, upsert=True)


async def _try_auto_recharge(tenant_id: str, ar: dict) -> bool:
    """Χρεώνει την κάρτα-on-file για ένα πακέτο credits & πιστώνει το wallet. Anti-double-charge με
    ατομικό claim. Best-effort — αποτυχία → False (θα σταλεί το κανονικό email alert)."""
    db = shared_db()
    thr = int(ar.get("threshold_cents") or 0)
    if thr > 0 and await balance(tenant_id) >= thr:
        return True   # ήδη επαρκές (race)
    claimed = await db["message_wallets"].find_one_and_update(
        {"_id": tenant_id, "auto_recharge_charging": {"$ne": True}},
        {"$set": {"auto_recharge_charging": True}})
    if not claimed:
        return False
    try:
        pkg = await db["credit_packages"].find_one({"_id": ar.get("package_id")})
        sub = await db["subscriptions"].find_one({"tenant_id": tenant_id})
        if not pkg or not sub or not (sub.get("viva_transaction_id") or sub.get("revolut_customer_id")):
            return False
        from app.services.billing_service import _charge_recurring
        res = await _charge_recurring(sub, int(pkg["price_cents"]), tenant_id)
        if not res.get("ok"):
            return False
        await credit(tenant_id, int(pkg["credits_cents"]), reason="auto_recharge", ref=res.get("order_id"))
        from app.services import invoice_service
        await invoice_service.create_for_payment(
            tenant_id=tenant_id, kind="topup", gross_cents=int(pkg["price_cents"]),
            description="Αυτόματη αναπλήρωση credits μηνυμάτων RxVision",
            item_key=f"credit:{pkg['_id']}",
            payment={"method": "card", "provider": res.get("provider"),
                     "transaction_id": res.get("order_id")})
        return True
    except Exception:  # noqa: BLE001
        return False
    finally:
        await db["message_wallets"].update_one(
            {"_id": tenant_id}, {"$unset": {"auto_recharge_charging": ""}})


async def _maybe_low_balance_alert(tenant_id: str, wallet_doc: dict) -> None:
    """Best-effort: ΜΙΑ ειδοποίηση email στο φαρμακείο όταν το υπόλοιπο πέσει κάτω από το κατώφλι.
    Δεν χρεώνει το πορτοφόλι (system mailer). Ποτέ δεν σπάει την αποστολή."""
    try:
        threshold = await _low_threshold()
        bal = int(wallet_doc.get("balance_cents", 0) or 0)
        if threshold <= 0 or bal >= threshold:
            return
        # 1) Αυτόματη αναπλήρωση (κάρτα) αν ενεργό → γέμισμα ΧΩΡΙΣ ειδοποίηση
        if (wallet_doc.get("auto_recharge") or {}).get("enabled"):
            if await _try_auto_recharge(tenant_id, wallet_doc.get("auto_recharge") or {}):
                return
        # 2) αλλιώς → email ειδοποίηση (idempotent)
        if wallet_doc.get("low_balance_alerted"):
            return
        # ατομικό set του flag → μόνο ένας sender στέλνει το email (idempotent)
        claimed = await shared_db()["message_wallets"].find_one_and_update(
            {"_id": tenant_id, "low_balance_alerted": {"$ne": True}},
            {"$set": {"low_balance_alerted": True, "updated_at": _now()}})
        if not claimed:
            return
        from app.services import comms, mailer
        ph = await comms._pharmacy(tenant_id)
        to = ph.get("email")
        if not to:
            return
        eur = f"€{bal / 100:.2f}"
        html = (f'<div style="font-family:Arial,sans-serif;font-size:15px;color:#0f172a;line-height:1.6">'
                f'<p>Το υπόλοιπο μηνυμάτων του φαρμακείου σας έπεσε στα <b>{eur}</b>.</p>'
                f'<p>Για να συνεχίσετε να στέλνετε SMS / Viber / email στους πελάτες σας χωρίς '
                f'διακοπή, αγοράστε credits από τις <b>Ρυθμίσεις → Επικοινωνία</b> στην εφαρμογή.</p>'
                f'<p style="color:#94a3b8;font-size:12px">RxVision</p></div>')
        await mailer.send_email(to, "RxVision — Χαμηλό υπόλοιπο μηνυμάτων", html)
    except Exception:  # noqa: BLE001 — η ειδοποίηση δεν πρέπει ΠΟΤΕ να σπάσει την αποστολή/χρέωση
        pass


async def refund(tenant_id: str, channel: str, cost: int, ref: str | None = None) -> None:
    """Give credits back when a send failed after being charged."""
    if cost <= 0:
        return
    db = shared_db()
    doc = await db["message_wallets"].find_one_and_update(
        {"_id": tenant_id}, {"$inc": {"balance_cents": cost}, "$set": {"updated_at": _now()}},
        upsert=True, return_document=ReturnDocument.AFTER)
    await _ledger(tenant_id, channel, "refund", 0, 0, cost, ref, doc["balance_cents"])


async def credit(tenant_id: str, amount_cents: int, *, reason: str = "topup", ref: str | None = None) -> dict:
    """Add credits (top-up / bonus / manual grant)."""
    db = shared_db()
    doc = await db["message_wallets"].find_one_and_update(
        {"_id": tenant_id},
        {"$inc": {"balance_cents": int(amount_cents)}, "$set": {"updated_at": _now()},
         "$unset": {"low_balance_alerted": ""}},  # top-up → επαναφορά, ώστε να ξαναειδοποιήσει αν ξαναπέσει
        upsert=True, return_document=ReturnDocument.AFTER)
    await _ledger(tenant_id, reason, "credit", 0, 0, int(amount_cents), ref, doc["balance_cents"])
    return {"balance": doc["balance_cents"]}


async def _ledger(tenant_id, channel, kind, count, unit, amount_cents, ref, balance_after):
    await shared_db()["message_ledger"].insert_one({
        "tenant_id": tenant_id, "channel": channel, "kind": kind,
        "count": int(count or 0), "unit_cents": int(unit or 0), "amount_cents": int(amount_cents or 0),
        "ref": ref, "balance_after": int(balance_after or 0), "ts": _now()})


async def usage_summary(tenant_id: str, days: int = 30) -> dict:
    """Sent counts + spend per channel over the last `days`, plus current balance."""
    db = shared_db()
    since = _now() - timedelta(days=days)
    out = {c: {"count": 0, "spent_cents": 0} for c in CHANNELS}
    cur = db["message_ledger"].aggregate([
        {"$match": {"tenant_id": tenant_id, "kind": "debit", "ts": {"$gte": since}}},
        {"$group": {"_id": "$channel", "count": {"$sum": "$count"}, "spent": {"$sum": "$amount_cents"}}},
    ])
    async for r in cur:
        if r["_id"] in out:
            out[r["_id"]] = {"count": int(r.get("count", 0)), "spent_cents": -int(r.get("spent", 0))}
    return {"balance_cents": await balance(tenant_id), "days": days, "by_channel": out,
            "prices": await prices()}


async def usage_by_tenant(days: int = 30) -> list[dict]:
    """Per-tenant consumption over the last `days` (counts + spend per channel) + current wallet balance
    + pharmacy name — for the admin «Κατανάλωση ανά πελάτη» view. Includes tenants with a wallet but no
    usage. Sorted by total spend desc."""
    db = shared_db()
    since = _now() - timedelta(days=days)
    empty = lambda: {c: {"count": 0, "spent_cents": 0} for c in CHANNELS}   # noqa: E731
    rows: dict[str, dict] = {}

    def _row(tid: str) -> dict:
        return rows.setdefault(tid, {"tenant_id": tid, "by_channel": empty(),
                                     "total_count": 0, "total_spent_cents": 0, "balance_cents": 0})
    async for r in db["message_ledger"].aggregate([
            {"$match": {"kind": "debit", "ts": {"$gte": since}}},
            {"$group": {"_id": {"t": "$tenant_id", "c": "$channel"},
                        "count": {"$sum": "$count"}, "spent": {"$sum": "$amount_cents"}}}]):
        tid, ch = r["_id"]["t"], r["_id"]["c"]
        g = _row(tid)
        cnt, spent = int(r.get("count", 0)), -int(r.get("spent", 0))   # debit amounts are negative
        if ch in g["by_channel"]:
            g["by_channel"][ch] = {"count": cnt, "spent_cents": spent}
            g["total_count"] += cnt
            g["total_spent_cents"] += spent
    # tenants that have a wallet (even with zero usage) + fill current balances
    async for w in db["message_wallets"].find({}):
        _row(w["_id"])["balance_cents"] = int(w.get("balance_cents", 0) or 0)
    # pharmacy names
    tids = list(rows.keys())
    names: dict = {}
    async for t in db["tenants"].find({"_id": {"$in": tids}}, {"name": 1, "pharmacy_name": 1}):
        names[t["_id"]] = t.get("name") or t.get("pharmacy_name")
    for tid, g in rows.items():
        g["name"] = names.get(tid) or tid
    return sorted(rows.values(), key=lambda x: (-x["total_spent_cents"], -x["balance_cents"]))


# ── Credit packages (prepaid top-up) ────────────────────────────────────────
# Seeded on first read. price_cents = what the pharmacy pays; credits_cents = what lands in the wallet
# (≥ price for a bonus). Editable by the platform admin.
_DEFAULT_PACKAGES = [
    {"_id": "c10", "name": "10€", "price_cents": 1000, "credits_cents": 1000, "active": True},
    {"_id": "c25", "name": "25€ (+2€ δώρο)", "price_cents": 2500, "credits_cents": 2700, "active": True},
    {"_id": "c50", "name": "50€ (+7€ δώρο)", "price_cents": 5000, "credits_cents": 5700, "active": True},
    {"_id": "c100", "name": "100€ (+20€ δώρο)", "price_cents": 10000, "credits_cents": 12000, "active": True},
]


async def _ensure_pkg_seed() -> None:
    db = shared_db()
    if await db["credit_packages"].count_documents({}) == 0:
        for p in _DEFAULT_PACKAGES:
            await db["credit_packages"].update_one({"_id": p["_id"]}, {"$setOnInsert": {**p, "updated_at": _now()}}, upsert=True)


async def packages(active_only: bool = True) -> list[dict]:
    await _ensure_pkg_seed()
    flt = {"active": True} if active_only else {}
    return [p async for p in shared_db()["credit_packages"].find(flt).sort("price_cents", 1)]


async def get_package(package_id: str) -> dict | None:
    await _ensure_pkg_seed()
    return await shared_db()["credit_packages"].find_one({"_id": package_id, "active": True})


async def record_pending_topup(tenant_id: str, pkg: dict, order_id: str) -> None:
    await shared_db()["wallet_topups"].insert_one({
        "order_id": order_id, "tenant_id": tenant_id, "package_id": pkg["_id"],
        "price_cents": int(pkg["price_cents"]), "credits_cents": int(pkg["credits_cents"]),
        "status": "pending", "created_at": _now()})


async def complete_topup(order_id: str) -> bool:
    """Called from the Revolut webhook on ORDER_COMPLETED. Credits the wallet exactly once (idempotent).
    Returns True if this order_id was a (pending) top-up we handled."""
    db = shared_db()
    doc = await db["wallet_topups"].find_one_and_update(
        {"order_id": order_id, "status": "pending"},
        {"$set": {"status": "completed", "completed_at": _now()}},
        return_document=ReturnDocument.AFTER)
    if not doc:
        return await db["wallet_topups"].count_documents({"order_id": order_id}) > 0
    await credit(doc["tenant_id"], int(doc["credits_cents"]), reason="topup", ref=order_id)
    # Παραστατικό top-up — χρεώθηκε το price_cents (όχι το credits_cents που μπορεί να έχει bonus).
    from app.services import invoice_service
    await invoice_service.create_for_payment(
        tenant_id=doc["tenant_id"], kind="topup", gross_cents=int(doc.get("price_cents", 0) or 0),
        description="Αγορά credits μηνυμάτων RxVision",
        item_key=f"credit:{doc.get('package_id')}",
        payment={"method": "card", "provider": doc.get("provider"), "transaction_id": order_id})
    return True


async def ledger(tenant_id: str, limit: int = 50) -> list[dict]:
    rows = [r async for r in shared_db()["message_ledger"].find({"tenant_id": tenant_id})
            .sort("ts", -1).limit(limit)]
    for r in rows:
        r["_id"] = str(r["_id"])
        r["ts"] = r["ts"].isoformat() if r.get("ts") else None
    return rows
