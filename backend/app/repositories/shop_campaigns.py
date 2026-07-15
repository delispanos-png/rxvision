"""Εκπτωτικές καμπάνιες e-shop — έκπτωση σε ΟΜΑΔΑ ειδών (κατηγορίες ή/και ετικέτες).

PRICING RULE (ίδια με τον κατάλογο): τα ΣΥΝΤΑΓΟΓΡΑΦΟΥΜΕΝΑ (`rx_medicine`) ΔΕΝ παίρνουν ΠΟΤΕ
έκπτωση καμπάνιας — ακόμη κι αν ανήκουν στην κατηγορία/ετικέτα της καμπάνιας. Ο έλεγχος γίνεται
με `discount_allowed(type)` στη μηχανή τιμολόγησης (orders_delivery.create_order) — ΠΟΤΕ στον client.
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId

from app.repositories.base import BaseRepository, jsonsafe
from app.services.catalog_taxonomy import discount_allowed


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _clean_list(v) -> list[str]:
    if not isinstance(v, list):
        return []
    out, seen = [], set()
    for x in v:
        s = str(x or "").strip()[:80]
        if s and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out[:40]


class ShopCampaignRepository(BaseRepository):
    collection_name = "shop_campaigns"

    async def list(self) -> list[dict]:
        return jsonsafe(await self.find({}, sort=[("created_at", -1)], limit=200))

    async def active_now(self) -> list[dict]:
        """Καμπάνιες ενεργές ΤΩΡΑ (active + εντός τυχόν χρονικού παραθύρου)."""
        now = _now()
        rows = await self.find({"active": True}, limit=200)
        out = []
        for c in rows:
            if c.get("starts_at") and c["starts_at"] > now:
                continue
            if c.get("ends_at") and c["ends_at"] < now:
                continue
            out.append(c)
        return out

    async def upsert(self, data: dict) -> dict:
        doc = {
            "name": (data.get("name") or "").strip()[:120] or "Καμπάνια",
            "discount_pct": max(1, min(90, int(data.get("discount_pct") or 0))),
            "categories": _clean_list(data.get("categories")),
            "tags": _clean_list(data.get("tags")),
            "active": bool(data.get("active", True)),
            "starts_at": data.get("starts_at"),
            "ends_at": data.get("ends_at"),
            "updated_at": _now(),
        }
        cid = data.get("_id") or data.get("id")
        if cid:
            try:
                oid = ObjectId(str(cid))
            except Exception:  # noqa: BLE001
                return {"ok": False, "error": "bad_id"}
            await self.update_one({"_id": oid}, {"$set": doc})
            return {"ok": True, "id": str(oid)}
        res = await self.insert_one({**doc, "created_at": _now()})
        return {"ok": True, "id": str(res.inserted_id if hasattr(res, "inserted_id") else res)}

    async def delete(self, cid: str) -> dict:
        try:
            oid = ObjectId(str(cid))
        except Exception:  # noqa: BLE001
            return {"ok": False}
        await self.delete_many({"_id": oid})
        return {"ok": True}


def campaign_pct_for(product: dict, campaigns: list[dict]) -> int:
    """Καλύτερη (μέγιστη) έκπτωση καμπάνιας για το προϊόν — 0 αν καμία δεν ταιριάζει.

    Τα συνταγογραφούμενα εξαιρούνται ΠΑΝΤΑ. Καμπάνια χωρίς κατηγορίες & χωρίς ετικέτες
    θεωρείται «όλο το κατάστημα» (πάλι εκτός συνταγογραφούμενων).
    """
    if not discount_allowed(product.get("type") or ""):
        return 0
    cat = (product.get("category") or "").strip().lower()
    tags = {str(t).strip().lower() for t in (product.get("tags") or [])}
    best = 0
    for c in campaigns:
        cats = {s.lower() for s in (c.get("categories") or [])}
        ctags = {s.lower() for s in (c.get("tags") or [])}
        if not cats and not ctags:
            match = True                       # store-wide
        else:
            match = (cat in cats) or bool(tags & ctags)
        if match:
            best = max(best, int(c.get("discount_pct") or 0))
    return min(90, best)
