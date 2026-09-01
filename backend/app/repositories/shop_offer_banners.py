"""Θεματικά banners προσφορών του φαρμακείου («1+1», «−50%», «Καλοκαίρι» …).

Εμφανίζονται ως slider στο κύκλωμα «🔥 Προσφορές» της πύλης (my.rxvision.gr). Κάθε banner
είναι clickable και οδηγεί σε φιλτραρισμένη λίστα προϊόντων (target_type/target_value).

Δύο πηγές (και οι δύο, «Και τα δύο» — απόφαση owner):
  • MANUAL: ο φαρμακοποιός τα φτιάχνει εδώ (εικόνα/τίτλος/στόχος).
  • AUTO: παράγονται αυτόματα από τις υπάρχουσες προσφορές (βλ. patient.shop_offers).
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId

from app.repositories.base import BaseRepository, jsonsafe

_TARGETS = ("on_sale", "brand", "tag", "bundles")     # πού οδηγεί το banner (κλικ → λίστα)
_ACCENTS = ("rose", "violet", "amber", "emerald", "sky")


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


class ShopOfferBannerRepository(BaseRepository):
    collection_name = "shop_offer_banners"

    async def list(self) -> list[dict]:
        return jsonsafe(await self.find({}, sort=[("sort_order", 1), ("created_at", -1)], limit=100))

    async def active_now(self) -> list[dict]:
        """Banners ενεργά ΤΩΡΑ (active + εντός τυχόν χρονικού παραθύρου)."""
        now = _now()
        out = []
        for b in await self.find({"active": True}, sort=[("sort_order", 1), ("created_at", -1)], limit=100):
            if b.get("starts_at") and b["starts_at"] > now:
                continue
            if b.get("ends_at") and b["ends_at"] < now:
                continue
            out.append(b)
        return jsonsafe(out)

    async def upsert(self, data: dict) -> dict:
        tt = data.get("target_type") if data.get("target_type") in _TARGETS else "on_sale"
        doc = {
            "title": (data.get("title") or "").strip()[:80] or "Προσφορές",
            "subtitle": (data.get("subtitle") or "").strip()[:120] or None,
            "badge": (data.get("badge") or "").strip()[:16] or None,
            "image_id": (str(data.get("image_id")).strip() or None) if data.get("image_id") else None,
            "accent": data.get("accent") if data.get("accent") in _ACCENTS else "rose",
            "target_type": tt,
            "target_value": (data.get("target_value") or "").strip()[:80] or None,
            "sort_order": int(data.get("sort_order") or 0),
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
