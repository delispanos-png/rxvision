"""Pharmacy gross-profit (διατίμηση) markup scale — PLATFORM-GLOBAL, editable in the admin panel
(`platform_settings._id="markup"`), applied to ALL tenants.

Bands = list of [upper_euro, pct]; for a unit retail price, profit% = first band whose upper ≥ price.
wholesale = retail × (1 − pct/100). Galenic/compounded preparations are excluded (Ν/Α) by the
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
        return round(retail * (1 - markup_pct(retail, bands) / 100)), "estimated"
    return 0, "unknown"


async def recompute(db, bands: list[list[float]], tenant_id: str | None = None) -> dict:
    """Re-apply the scale to stored items + executions (all tenants if tenant_id is None)."""
    tenants = [tenant_id] if tenant_id else await db["prescription_executions"].distinct("tenant_id")
    g_items = g_exec = g_na = 0
    for tid in tenants:
        async for it in db["prescription_items"].find({"tenant_id": tid}):
            w, src = item_wholesale(it, bands)
            retail = it.get("retail_price", 0) or 0
            margin = (retail - w) if src not in ("unavailable", "unknown") else 0
            await db["prescription_items"].update_one(
                {"_id": it["_id"]},
                {"$set": {"wholesale_price": w, "wholesale_source": src, "margin": margin}})
            g_items += 1
            if src == "unavailable":
                g_na += 1
        async for ex in db["prescription_executions"].find({"tenant_id": tid}, {"amount_total": 1}):
            items = [i async for i in db["prescription_items"].find(
                {"tenant_id": tid, "execution_id": ex["_id"]})]
            raw_retail = sum((i.get("retail_price", 0) or 0) * (i.get("quantity", 0) or 0) for i in items)
            raw_w = sum((i.get("wholesale_price", 0) or 0) * (i.get("quantity", 0) or 0) for i in items)
            amt = ex.get("amount_total", 0) or 0
            wc = round(raw_w * amt / raw_retail) if (amt > 0 and raw_retail > 0) else raw_w
            await db["prescription_executions"].update_one({"_id": ex["_id"]}, {"$set": {"wholesale_cost": wc}})
            g_exec += 1
    return {"tenants": len(tenants), "items": g_items, "na": g_na,
            "executions": g_exec, "at": datetime.now(tz=timezone.utc).isoformat()}
