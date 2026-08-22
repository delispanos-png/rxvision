"""Shopify-style ΑΥΤΟΜΑΤΕΣ προσφορές καλαθιού e-shop:
  • `order`         → έκπτωση % ή € σε ΟΛΟ το καλάθι (βάση = ΜΟΝΟ μη-συνταγογραφούμενα)
  • `free_shipping` → δωρεάν μεταφορικά άνω ποσού

Κοινοί κανόνες (όπως Shopify): ελάχιστο ποσό/ποσότητα, προγραμματισμός (start/end), όριο χρήσεων,
κατάσταση (Ενεργή/Προγραμματισμένη/Έληξε). Οι εκπτώσεις με ΚΩΔΙΚΟ καλύπτονται από τα «Κουπόνια».

ΚΑΝΟΝΑΣ: τα συνταγογραφούμενα (rx_medicine) ΔΕΝ παίρνουν ΠΟΤΕ έκπτωση — η βάση της order-έκπτωσης
είναι πάντα το non-rx subtotal (επιβάλλεται στη μηχανή τιμολόγησης create_order).
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId

from app.repositories.base import BaseRepository, jsonsafe

TYPES = ("order", "free_shipping")


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


class ShopOrderDiscountRepository(BaseRepository):
    collection_name = "shop_order_discounts"

    async def list(self) -> list[dict]:
        rows = await self.find({}, sort=[("created_at", -1)], limit=200)
        now = _now()
        for r in rows:
            r["status"] = _status(r, now)
        return jsonsafe(rows)

    async def active_now(self) -> list[dict]:
        """Ενεργές ΤΩΡΑ (active + εντός παραθύρου + κάτω από όριο χρήσεων)."""
        now = _now()
        rows = await self.find({"active": True}, limit=200)
        out = []
        for c in rows:
            if c.get("starts_at") and _as_utc(c["starts_at"]) and now < _as_utc(c["starts_at"]):
                continue
            if c.get("ends_at") and _as_utc(c["ends_at"]) and now > _as_utc(c["ends_at"]):
                continue
            lim = int(c.get("usage_limit") or 0)
            if lim and int(c.get("used_count") or 0) >= lim:
                continue
            out.append(c)
        return out

    async def upsert(self, data: dict) -> dict:
        dtype = data.get("discount_type") if data.get("discount_type") in TYPES else "order"
        doc = {
            "name": (data.get("name") or "").strip()[:120] or "Προσφορά",
            "discount_type": dtype,
            "value_type": "fixed" if data.get("value_type") == "fixed" else "pct",
            "value": max(1, int(data.get("value") or 0)),         # pct(1-90) ή cents (fixed)
            "min_cents": max(0, int(data.get("min_cents") or 0)),
            "min_qty": max(0, int(data.get("min_qty") or 0)),
            "usage_limit": max(0, int(data.get("usage_limit") or 0)),
            "active": bool(data.get("active", True)),
            "starts_at": data.get("starts_at"),
            "ends_at": data.get("ends_at"),
            "updated_at": _now(),
        }
        if doc["value_type"] == "pct" and dtype == "order":
            doc["value"] = max(1, min(90, doc["value"]))
        cid = data.get("_id") or data.get("id")
        if cid:
            try:
                oid = ObjectId(str(cid))
            except Exception:  # noqa: BLE001
                return {"ok": False, "error": "bad_id"}
            await self.update_one({"_id": oid}, {"$set": doc})
            return {"ok": True, "id": str(oid)}
        new_id = await self.insert_one({**doc, "used_count": 0, "created_at": _now()})
        return {"ok": True, "id": str(new_id)}

    async def delete(self, cid: str) -> dict:
        try:
            oid = ObjectId(str(cid))
        except Exception:  # noqa: BLE001
            return {"ok": False}
        await self.delete_many({"_id": oid})
        return {"ok": True}

    async def consume(self, cid) -> None:
        """Αύξηση μετρητή χρήσεων (μετά από επιτυχή παραγγελία)."""
        oid = cid if isinstance(cid, ObjectId) else ObjectId(str(cid))
        await self.update_one({"_id": oid}, {"$inc": {"used_count": 1}})


def _as_utc(v):
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str) and v:
        try:
            d = datetime.fromisoformat(v.replace("Z", "+00:00"))
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def _status(c: dict, now: datetime) -> str:
    if not c.get("active"):
        return "inactive"
    s, e = _as_utc(c.get("starts_at")), _as_utc(c.get("ends_at"))
    if s and now < s:
        return "scheduled"
    if e and now > e:
        return "expired"
    lim = int(c.get("usage_limit") or 0)
    if lim and int(c.get("used_count") or 0) >= lim:
        return "used_up"
    return "active"


def best_order_discount(discounts: list[dict], *, base_cents: int, qty: int) -> dict | None:
    """Καλύτερη ΑΥΤΟΜΑΤΗ order-έκπτωση για βάση = non-rx subtotal. Σέβεται min ποσό/ποσότητα.
    Επιστρέφει {id, name, value_type, value, discount_cents} ή None."""
    best = None
    for c in discounts:
        if c.get("discount_type") != "order":
            continue
        if base_cents < int(c.get("min_cents") or 0):
            continue
        if qty < int(c.get("min_qty") or 0):
            continue
        if c.get("value_type") == "fixed":
            disc = min(base_cents, int(c.get("value") or 0))
        else:
            disc = round(base_cents * max(1, min(90, int(c.get("value") or 0))) / 100)
        if disc > 0 and (best is None or disc > best["discount_cents"]):
            best = {"id": c.get("_id"), "name": c.get("name"), "value_type": c.get("value_type"),
                    "value": int(c.get("value") or 0), "discount_cents": disc}
    return best


def free_shipping_threshold(discounts: list[dict], *, qty: int) -> int | None:
    """Ελάχιστο κατώφλι δωρεάν μεταφορικών από ενεργές free_shipping προσφορές (min ικανοποιήσιμο qty).
    Επιστρέφει το ΜΙΚΡΟΤΕΡΟ min_cents, ή None αν καμία."""
    thresholds = [int(c.get("min_cents") or 0) for c in discounts
                  if c.get("discount_type") == "free_shipping" and qty >= int(c.get("min_qty") or 0)]
    return min(thresholds) if thresholds else None
