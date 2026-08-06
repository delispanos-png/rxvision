"""Προσφορές ΥΠΗΡΕΣΙΩΝ φαρμακείου (π.χ. «−30% σπιρομέτρηση», «δωρεάν μέτρηση πίεσης»).

Ξεχωριστές από τον κατάλογο προϊόντων: δεν μπαίνουν στο καλάθι — ο πελάτης τις «κλείνει» ως
ΡΑΝΤΕΒΟΥ (reuse του υπάρχοντος κυκλώματος appointments). Εμφανίζονται στο κύκλωμα «Προσφορές»
της πύλης (my.rxvision.gr) δίπλα στις προσφορές προϊόντων.
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId

from app.repositories.base import BaseRepository, jsonsafe


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


class ShopServiceOffersRepository(BaseRepository):
    collection_name = "shop_service_offers"

    async def list(self) -> list[dict]:
        return jsonsafe(await self.find({}, sort=[("created_at", -1)], limit=200))

    async def active_now(self) -> list[dict]:
        """Προσφορές ενεργές ΤΩΡΑ (active + εντός τυχόν χρονικού παραθύρου)."""
        now = _now()
        out = []
        for o in await self.find({"active": True}, sort=[("created_at", -1)], limit=200):
            if o.get("starts_at") and o["starts_at"] > now:
                continue
            if o.get("ends_at") and o["ends_at"] < now:
                continue
            out.append(o)
        return out

    async def upsert(self, data: dict) -> dict:
        is_free = bool(data.get("is_free"))
        price = 0 if is_free else max(0, int(data.get("price_cents") or 0))
        compare = max(0, int(data.get("compare_cents") or 0))
        # «Πριν/τώρα»: το compare εμφανίζεται μόνο αν είναι μεγαλύτερο της τιμής.
        if compare and not is_free and compare <= price:
            compare = 0
        doc = {
            "title": (data.get("title") or "").strip()[:120] or "Προσφορά",
            "description": (data.get("description") or "").strip()[:600],
            "photo_url": (data.get("photo_url") or "").strip()[:1000] or None,
            "image_id": (str(data.get("image_id")).strip() or None) if data.get("image_id") else None,
            "is_free": is_free,
            "price_cents": price,
            "compare_cents": compare,
            "cta": "reserve" if data.get("cta", "reserve") == "reserve" else "info",
            "active": bool(data.get("active", True)),
            "starts_at": data.get("starts_at"),
            "ends_at": data.get("ends_at"),
            "updated_at": _now(),
        }
        oid_raw = data.get("_id") or data.get("id")
        if oid_raw:
            try:
                oid = ObjectId(str(oid_raw))
            except Exception:  # noqa: BLE001
                return {"ok": False, "error": "bad_id"}
            await self.update_one({"_id": oid}, {"$set": doc})
            return {"ok": True, "id": str(oid)}
        res = await self.insert_one({**doc, "created_at": _now()})
        return {"ok": True, "id": str(res.inserted_id if hasattr(res, "inserted_id") else res)}

    async def delete(self, oid_raw: str) -> dict:
        try:
            oid = ObjectId(str(oid_raw))
        except Exception:  # noqa: BLE001
            return {"ok": False}
        await self.delete_many({"_id": oid})
        return {"ok": True}
