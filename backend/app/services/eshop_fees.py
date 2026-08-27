"""E-shop transaction fees — προμήθεια συναλλαγής ανά e-shop παραγγελία.

Μοντέλο: flat προμήθεια (φ) ανά παραγγελία (default €0,50), ρυθμιζόμενη ΑΝΑ φαρμακείο, με δυνατότητα
ΕΞΑΙΡΕΣΗΣ. Κάθε παραγγελία → εγγραφή στο ledger `eshop_transaction_fees`. ΕΒΔΟΜΑΔΙΑΙΑ χρεώνουμε τα
δεδουλευμένα (άθροισμα) στην κάρτα του φαρμακείου (card-on-file, +ΦΠΑ) — ΜΕ ΚΑΤΩΦΛΙ + roll-over
(κάτω από το κατώφλι μεταφέρονται στην επόμενη εβδομάδα, για αποφυγή ανοίκονομων μικρο-χρεώσεων).
Ο φαρμακοποιός βλέπει live report στο e-shop κύκλωμα· ο platform admin ρυθμίζει global + per-tenant.

Config: `platform_settings._id="eshop_fees"`. Per-tenant override/exempt: στη `subscriptions`
(`eshop_fee_cents`, `eshop_fee_exempt`) — admin-controlled. Ledger + ιστορικό χρεώσεων: δικές τους collections.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db

_CFG_ID = "eshop_fees"
DEFAULTS = {
    "enabled": False,          # off μέχρι να το ενεργοποιήσει ο admin
    "default_cents": 50,       # €0,50 / παραγγελία (σταθερό)
    "min_order_cents": 500,    # ΕΛΑΧΙΣΤΗ αξία παραγγελίας για να χρεωθεί φ (€5,00)· κάτω → δωρεάν
    "cap_pct": 10,             # ΠΛΑΦΟΝ: το φ δεν ξεπερνά X% της αξίας παραγγελίας (0=χωρίς πλαφόν)
    "min_charge_cents": 200,   # κατώφλι εβδομαδιαίας χρέωσης (€2,00) — κάτω απ' αυτό → roll-over
    "charge_weekday": 0,       # 0=Δευτέρα … 6=Κυριακή (πότε τρέχει η εβδομαδιαία χρέωση)
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def get_config() -> dict:
    doc = await shared_db()["platform_settings"].find_one({"_id": _CFG_ID}) or {}
    return {**DEFAULTS, **{k: doc[k] for k in DEFAULTS if k in doc}}


async def set_config(patch: dict) -> dict:
    clean = {}
    if "enabled" in patch:
        clean["enabled"] = bool(patch["enabled"])
    for k in ("default_cents", "min_charge_cents", "min_order_cents"):
        if k in patch and patch[k] is not None:
            clean[k] = max(0, int(patch[k]))
    if "cap_pct" in patch and patch["cap_pct"] is not None:
        clean["cap_pct"] = max(0, min(100, int(patch["cap_pct"])))
    if "charge_weekday" in patch and patch["charge_weekday"] is not None:
        clean["charge_weekday"] = int(patch["charge_weekday"]) % 7
    if clean:
        await shared_db()["platform_settings"].update_one(
            {"_id": _CFG_ID}, {"$set": clean}, upsert=True)
    return await get_config()


async def _tenant_fee(tid: str, cfg: dict, sub: dict | None = None) -> tuple[int, bool]:
    """(fee_cents, exempt) για έναν tenant — per-tenant override ή global default."""
    if sub is None:
        sub = await shared_db()["subscriptions"].find_one(
            {"tenant_id": tid}, {"eshop_fee_cents": 1, "eshop_fee_exempt": 1}) or {}
    if sub.get("eshop_fee_exempt"):
        return 0, True
    override = sub.get("eshop_fee_cents")
    cents = int(override) if override is not None else int(cfg["default_cents"])
    return max(0, cents), False


def effective_fee(base_cents: int, amount_total: int | None, cfg: dict) -> int:
    """Πραγματικό φ για μια παραγγελία: 0 κάτω από ελάχιστη αξία· αλλιώς min(σταθερό, X% της αξίας)."""
    if base_cents <= 0:
        return 0
    if amount_total is not None:
        if amount_total < int(cfg.get("min_order_cents", 0)):
            return 0                                   # κάτω από ελάχιστη αξία → δωρεάν
        cap = int(cfg.get("cap_pct", 0))
        if cap > 0:
            return min(base_cents, round(amount_total * cap / 100))   # πλαφόν % της αξίας
    return base_cents


async def accrue(tenant_id: str, order_id, *, order_no: str | None = None,
                 amount_total: int | None = None) -> None:
    """Κλήση σε ΚΑΘΕ νέα e-shop παραγγελία → εγγραφή προμήθειας στο ledger (no-op αν off/εξαίρεση/φ=0/
    κάτω από ελάχιστη αξία). Το ποσό αποθηκεύεται ΗΔΗ ισορροπημένο (ελάχιστη αξία + πλαφόν %)."""
    cfg = await get_config()
    if not cfg["enabled"]:
        return
    base, exempt = await _tenant_fee(tenant_id, cfg)
    if exempt:
        return
    cents = effective_fee(base, amount_total, cfg)
    if cents <= 0:
        return
    db = shared_db()
    # idempotency: μία προμήθεια ανά order_id
    if await db["eshop_transaction_fees"].find_one({"tenant_id": tenant_id, "order_id": order_id}):
        return
    await db["eshop_transaction_fees"].insert_one({
        "tenant_id": tenant_id, "order_id": order_id, "order_no": order_no,
        "cents": cents, "order_cents": amount_total, "created_at": _now(),
        "billed": False, "billed_at": None, "charge_id": None})


async def set_tenant(tenant_id: str, *, fee_cents: int | None = None,
                     exempt: bool | None = None) -> dict:
    """Admin: per-tenant override του φ + εξαίρεση (στη subscription)."""
    upd: dict = {}
    if fee_cents is not None:
        upd["eshop_fee_cents"] = None if fee_cents < 0 else max(0, int(fee_cents))
    if exempt is not None:
        upd["eshop_fee_exempt"] = bool(exempt)
    if upd:
        await shared_db()["subscriptions"].update_one(
            {"tenant_id": tenant_id}, {"$set": upd}, upsert=True)
    return upd


async def _unbilled(tenant_id: str) -> tuple[int, int]:
    """(count, cents) δεδουλευμένων ά-χρέωτων προμηθειών."""
    rows = shared_db()["eshop_transaction_fees"].aggregate([
        {"$match": {"tenant_id": tenant_id, "billed": False}},
        {"$group": {"_id": None, "n": {"$sum": 1}, "cents": {"$sum": "$cents"}}}])
    async for r in rows:
        return r["n"], r["cents"]
    return 0, 0


async def tenant_report(tenant_id: str, *, limit: int = 50) -> dict:
    """Live report για τον φαρμακοποιό: φ, εξαίρεση, δεδουλευμένα (τρέχουσα περίοδος), πρόσφατες
    προμήθειες ανά παραγγελία, ιστορικό χρεώσεων, εκτιμώμενη επόμενη χρέωση."""
    db = shared_db()
    cfg = await get_config()
    cents, exempt = await _tenant_fee(tenant_id, cfg)
    n_un, c_un = await _unbilled(tenant_id)
    recent = [r async for r in db["eshop_transaction_fees"]
              .find({"tenant_id": tenant_id}, {"order_no": 1, "cents": 1, "created_at": 1,
                                               "billed": 1, "billed_at": 1})
              .sort("created_at", -1).limit(limit)]
    charges = [c async for c in db["eshop_fee_charges"]
               .find({"tenant_id": tenant_id}).sort("charged_at", -1).limit(24)]
    from app.repositories.base import jsonsafe
    return {
        "enabled": cfg["enabled"], "fee_cents": cents, "exempt": exempt,
        "min_charge_cents": cfg["min_charge_cents"], "charge_weekday": cfg["charge_weekday"],
        "min_order_cents": cfg["min_order_cents"], "cap_pct": cfg["cap_pct"],
        "unbilled": {"count": n_un, "cents": c_un},
        "will_charge": (not exempt) and c_un >= cfg["min_charge_cents"],
        "recent": jsonsafe(recent), "charges": jsonsafe(charges),
    }


async def admin_overview() -> list[dict]:
    """Ανά φαρμακείο: φ (override/default), εξαίρεση, δεδουλευμένα, τελευταία χρέωση."""
    db = shared_db()
    cfg = await get_config()
    # δεδουλευμένα ανά tenant
    accrued: dict[str, dict] = {}
    async for r in db["eshop_transaction_fees"].aggregate([
        {"$match": {"billed": False}},
        {"$group": {"_id": "$tenant_id", "n": {"$sum": 1}, "cents": {"$sum": "$cents"}}}]):
        accrued[r["_id"]] = {"count": r["n"], "cents": r["cents"]}
    last_charge: dict[str, dict] = {}
    async for c in db["eshop_fee_charges"].aggregate([
        {"$sort": {"charged_at": -1}},
        {"$group": {"_id": "$tenant_id", "at": {"$first": "$charged_at"},
                    "gross": {"$first": "$gross_cents"}, "status": {"$first": "$status"}}}]):
        last_charge[c["_id"]] = c
    from app.services.auth_service import resolve_modules, tenant_has
    from app.services.billing_service import effective_status
    out = []
    async for sub in db["subscriptions"].find({}):
        tid = sub["tenant_id"]
        if effective_status(sub) != "active":       # ΜΟΝΟ κατάσταση «Ενεργός» — όχι trial/ληγμένη/αναστολή
            continue
        t = await db["tenants"].find_one(
            {"_id": tid}, {"company.name": 1, "name": 1, "modules": 1})
        mods = resolve_modules(set(sub.get("modules_included", [])), (t or {}).get("modules", {}))
        if not tenant_has(mods, "order_delivery"):  # ΜΟΝΟ όσοι έχουν το module e-shop
            continue
        name = ((t or {}).get("company") or {}).get("name") or (t or {}).get("name") or tid
        cents, exempt = await _tenant_fee(tid, cfg, sub)
        lc = last_charge.get(tid) or {}
        out.append({
            "tenant_id": tid, "name": name,
            "fee_cents": cents, "override": sub.get("eshop_fee_cents"), "exempt": exempt,
            "accrued": accrued.get(tid, {"count": 0, "cents": 0}),
            "last_charged_at": lc.get("at").isoformat() if lc.get("at") else None,
            "last_charged_cents": lc.get("gross"), "last_status": lc.get("status"),
        })
    out.sort(key=lambda x: x["accrued"]["cents"], reverse=True)
    return out


async def charge_tenant(tenant_id: str, *, force: bool = False) -> dict:
    """Χρέωσε τα δεδουλευμένα ενός φαρμακείου στην κάρτα (+ΦΠΑ) → παραστατικό + απόδειξη + ιστορικό.
    force=True αγνοεί το κατώφλι (χειροκίνητο «χρέωσε τώρα»). Roll-over αν κάτω από κατώφλι."""
    db = shared_db()
    cfg = await get_config()
    n_un, net = await _unbilled(tenant_id)
    if net <= 0:
        return {"ok": False, "reason": "nothing_to_charge"}
    if not force and net < cfg["min_charge_cents"]:
        return {"ok": False, "reason": "below_threshold", "cents": net, "rolled_over": True}

    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    if sub.get("eshop_fee_exempt"):
        return {"ok": False, "reason": "exempt"}
    from app.services import billing_service, invoice_service, receipts
    if not (sub.get("revolut_customer_id") or sub.get("viva_transaction_id")):
        return {"ok": False, "reason": "no_card"}

    t = await db["tenants"].find_one({"_id": tenant_id}, {"company.country": 1})
    country = ((t or {}).get("company") or {}).get("country") or "GR"
    gross = invoice_service.gross_from_price(net, False, country)   # net → +ΦΠΑ
    desc = f"RxVision e-shop transaction fees × {n_un}"
    res = await billing_service._charge_recurring(sub, gross, tenant_id)
    now = _now()
    rec = {"tenant_id": tenant_id, "count": n_un, "net_cents": net, "gross_cents": gross,
           "charged_at": now, "provider": res.get("provider"), "order_ref": res.get("order_id"),
           "status": "ok" if res.get("ok") else "failed", "error": res.get("error")}
    ins = await db["eshop_fee_charges"].insert_one(rec)
    if res.get("ok"):
        await db["eshop_transaction_fees"].update_many(
            {"tenant_id": tenant_id, "billed": False},
            {"$set": {"billed": True, "billed_at": now, "charge_id": ins.inserted_id}})
        try:
            await receipts.record(tenant_id, "eshop_fees", desc, amount_cents=gross,
                                  provider=res.get("provider"), meta={"count": n_un, "net_cents": net})
        except Exception:  # noqa: BLE001
            pass
        try:
            await invoice_service.create_for_payment(
                tenant_id=tenant_id, kind="eshop_fees", gross_cents=gross,
                description=desc)
        except Exception:  # noqa: BLE001
            pass
    return {"ok": bool(res.get("ok")), "count": n_un, "net_cents": net, "gross_cents": gross,
            "provider": res.get("provider"), "error": res.get("error")}


async def charge_weekly() -> dict:
    """Εβδομαδιαίο task: χρέωσε ΟΛΑ τα φαρμακεία με δεδουλευμένα ≥ κατώφλι & κάρτα."""
    cfg = await get_config()
    if not cfg["enabled"]:
        return {"skipped": "disabled"}
    db = shared_db()
    tids = await db["eshop_transaction_fees"].distinct("tenant_id", {"billed": False})
    charged = rolled = failed = 0
    for tid in tids:
        r = await charge_tenant(tid)
        if r.get("ok"):
            charged += 1
        elif r.get("reason") == "below_threshold":
            rolled += 1
        elif r.get("reason") not in ("exempt", "nothing_to_charge"):
            failed += 1
    return {"charged": charged, "rolled_over": rolled, "failed": failed,
            "tenants": len(tids), "at": _now().isoformat()}
