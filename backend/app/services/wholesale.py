"""Pharmacy gross-profit (διατίμηση) markup scale — PLATFORM-GLOBAL, editable in the admin panel
(`platform_settings._id="markup"`), applied to ALL tenants.

Bands = list of [upper_euro, pct]; for a unit retail price, profit% = first band whose upper ≥ price.
The pct is the pharmacy gross-profit MARKUP on the χονδρική (wholesale), i.e. retail = wholesale × (1 + pct/100),
so wholesale = retail / (1 + pct/100) and profit = retail − wholesale. (NOT retail × (1 − pct/100): that would
treat the markup as a discount off retail and overstate the profit — e.g. 30% band → 30% of retail instead of
23.08%. Plavix proof: 12.77 / 1.30 = 9.82 → profit 2.95, exactly the real διατίμηση.)
Galenic/compounded preparations are excluded (Ν/Α) by the
ingestion engine separately. Falls back to the Ministry-of-Health default until an admin overrides it.
"""

from __future__ import annotations

from datetime import datetime, timezone

# Default κλίμακα Υπουργείου Υγείας — ισχύει μέχρι/εκτός αν ο platform admin την αλλάξει.
DEFAULT_BANDS: list[list[float]] = [
    [50, 30.0], [100, 20.0], [150, 16.0], [200, 14.0], [300, 12.0],
    [400, 10.0], [500, 9.0], [600, 8.0], [700, 7.0], [800, 6.5],
    [900, 6.0], [1000, 5.5], [1250, 5.0], [1500, 4.25], [1750, 3.75],
    [2000, 3.25], [2250, 3.0], [2500, 2.75], [2750, 2.5], [3000, 2.25],
]


def sanitize_bands(bands) -> list[list[float]]:
    out: list[list[float]] = []
    for b in bands or []:
        try:
            hi, pct = float(b[0]), float(b[1])
        except (TypeError, ValueError, IndexError):
            continue
        if hi > 0 and 0 <= pct <= 100:
            out.append([round(hi, 2), round(pct, 4)])
    out.sort(key=lambda x: x[0])
    return out


async def load_bands(db) -> list[list[float]]:
    doc = await db["platform_settings"].find_one({"_id": "markup"})
    bands = sanitize_bands((doc or {}).get("bands"))
    return bands or [list(b) for b in DEFAULT_BANDS]


def markup_pct(retail_cents: int, bands: list[list[float]]) -> float:
    """Μεικτό κέρδος φαρμακείου (%) βάσει της μοναδιαίας λιανικής τιμής."""
    euro = retail_cents / 100
    for hi, pct in bands:
        if euro <= hi:
            return pct
    return bands[-1][1] if bands else 2.25     # πάνω από το τελευταίο band → χαμηλότερο ποσοστό


def item_wholesale(it: dict, bands: list[list[float]]) -> tuple[int, str]:
    """(wholesale_cents, source) for a stored prescription_item-like dict."""
    src = it.get("wholesale_source")
    if src in ("source", "masterdata"):
        return it.get("wholesale_price", 0) or 0, src          # πραγματική τιμή → ως έχει
    if (it.get("details") or {}).get("galenic"):
        return 0, "unavailable"                                # γαληνικά → Ν/Α
    retail = it.get("retail_price", 0) or 0
    if retail > 0:
        # Το ποσοστό είναι μεικτό κέρδος ΠΑΝΩ στη χονδρική: λιανική = χονδρική × (1 + pct%)
        # → χονδρική = λιανική / (1 + pct%). (Όχι λιανική × (1 − pct%) — αυτό φουσκώνει το κέρδος.)
        return round(retail / (1 + markup_pct(retail, bands) / 100)), "estimated"
    return 0, "unknown"


def _markup_switch(bands: list[list[float]]) -> dict:
    """$switch that replicates markup_pct() server-side (pct by unit retail €)."""
    branches = [{"case": {"$lte": [{"$divide": ["$retail_price", 100]}, hi]}, "then": pct}
                for hi, pct in bands]
    return {"$switch": {"branches": branches, "default": (bands[-1][1] if bands else 2.25)}}


async def recompute(db, bands: list[list[float]], tenant_id: str | None = None) -> dict:
    """Re-apply the scale to stored items + executions (all tenants if tenant_id is None).

    Idempotent & server-side: estimated items are recomputed straight from retail via the band
    switch (wholesale = retail / (1 + pct/100)); each execution's wholesale_cost is rebuilt from the
    per-execution item sums. Real prices (source/masterdata) and galenic (Ν/Α) items are left as-is.
    Uses bulk ops so a full-history recompute runs in seconds, not hours.
    """
    from pymongo import UpdateOne

    item_flt: dict = {"wholesale_source": "estimated", "retail_price": {"$gt": 0}}
    if tenant_id:
        item_flt["tenant_id"] = tenant_id
    g_items = (await db["prescription_items"].update_many(item_flt, [
        {"$set": {"_pct": _markup_switch(bands)}},
        {"$set": {"wholesale_price": {"$round": [{"$divide": [
            {"$multiply": ["$retail_price", 100]}, {"$add": [100, "$_pct"]}]}, 0]}}},
        {"$set": {"margin": {"$subtract": ["$retail_price", "$wholesale_price"]}}},
        {"$unset": "_pct"},
    ])).modified_count

    tenants = [tenant_id] if tenant_id else await db["prescription_executions"].distinct("tenant_id")
    g_exec = 0
    for tid in tenants:
        sums: dict = {}
        async for r in db["prescription_items"].aggregate([
            {"$match": {"tenant_id": tid}},
            {"$group": {"_id": "$execution_id",
                        "raw_w": {"$sum": {"$multiply": [
                            {"$ifNull": ["$wholesale_price", 0]}, {"$ifNull": ["$quantity", 0]}]}},
                        "raw_retail": {"$sum": {"$multiply": [
                            {"$ifNull": ["$retail_price", 0]}, {"$ifNull": ["$quantity", 0]}]}}}},
        ]):
            sums[r["_id"]] = (r["raw_w"], r["raw_retail"])
        ops: list = []
        async for ex in db["prescription_executions"].find({"tenant_id": tid}, {"amount_total": 1}):
            rw, rr = sums.get(ex["_id"], (0, 0))
            amt = ex.get("amount_total", 0) or 0
            wc = round(rw * amt / rr) if (amt > 0 and rr > 0) else rw
            ops.append(UpdateOne({"_id": ex["_id"]}, {"$set": {"wholesale_cost": wc}}))
            if len(ops) >= 2000:
                await db["prescription_executions"].bulk_write(ops, ordered=False)
                g_exec += len(ops)
                ops = []
        if ops:
            await db["prescription_executions"].bulk_write(ops, ordered=False)
            g_exec += len(ops)
    return {"tenants": len(tenants), "items": g_items,
            "executions": g_exec, "at": datetime.now(tz=timezone.utc).isoformat()}
