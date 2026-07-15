"""Προωθητικά εργαλεία e-shop: ΚΟΥΠΟΝΙΑ + ΠΑΚΕΤΑ (bundles).

PRICING RULE (παντού): τα ΣΥΝΤΑΓΟΓΡΑΦΟΥΜΕΝΑ (`rx_medicine`) ΔΕΝ συμμετέχουν ΠΟΤΕ — ούτε σε
κουπόνι, ούτε σε πακέτο, ούτε στην κλιμακωτή έκπτωση καλαθιού. Η αξία τους αφαιρείται από τη
«βάση» πριν υπολογιστεί οποιαδήποτε έκπτωση (βλ. services/shop_pricing.py).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from bson import ObjectId

from app.repositories.base import BaseRepository, jsonsafe


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


_CODE_RE = re.compile(r"[^A-Z0-9_-]")


def norm_code(c: str) -> str:
    return _CODE_RE.sub("", (c or "").strip().upper())[:32]


class ShopCouponRepository(BaseRepository):
    collection_name = "shop_coupons"

    async def list(self) -> list[dict]:
        return jsonsafe(await self.find({}, sort=[("created_at", -1)], limit=200))

    async def upsert(self, data: dict) -> dict:
        code = norm_code(data.get("code") or "")
        if not code:
            return {"ok": False, "error": "bad_code"}
        kind = data.get("kind") if data.get("kind") in ("pct", "amount") else "pct"
        value = int(data.get("value") or 0)
        value = max(1, min(90, value)) if kind == "pct" else max(1, value)
        doc = {
            "code": code, "kind": kind, "value": value,
            "min_order_cents": max(0, int(data.get("min_order_cents") or 0)),
            "max_uses": max(0, int(data.get("max_uses") or 0)),      # 0 = απεριόριστο
            "expires_at": data.get("expires_at"),
            "active": bool(data.get("active", True)),
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
        if await self.find_one({"code": code}):
            return {"ok": False, "error": "code_exists"}
        res = await self.insert_one({**doc, "used_count": 0, "created_at": _now()})
        return {"ok": True, "id": str(res.inserted_id)}

    async def delete(self, cid: str) -> dict:
        try:
            oid = ObjectId(str(cid))
        except Exception:  # noqa: BLE001
            return {"ok": False}
        await self.delete_many({"_id": oid})
        return {"ok": True}

    async def validate(self, code: str, eligible_cents: int) -> dict:
        """Έλεγχος κουπονιού για δεδομένη ΕΠΙΛΕΞΙΜΗ αξία (μη-συνταγογραφούμενα)."""
        c = await self.find_one({"code": norm_code(code)})
        if not c or not c.get("active"):
            return {"ok": False, "error": "coupon_invalid"}
        if c.get("expires_at") and c["expires_at"] < _now():
            return {"ok": False, "error": "coupon_expired"}
        if c.get("max_uses") and int(c.get("used_count") or 0) >= int(c["max_uses"]):
            return {"ok": False, "error": "coupon_exhausted"}
        if eligible_cents <= 0:
            return {"ok": False, "error": "coupon_no_eligible_items"}
        if eligible_cents < int(c.get("min_order_cents") or 0):
            return {"ok": False, "error": "coupon_below_min", "min_cents": int(c["min_order_cents"])}
        return {"ok": True, "coupon": jsonsafe(c)}

    async def consume(self, code: str) -> None:
        await self.update_one({"code": norm_code(code)}, {"$inc": {"used_count": 1}})

    async def release(self, code: str) -> None:
        """Επιστροφή χρήσης (ακύρωση/απόρριψη παραγγελίας)."""
        await self.update_one({"code": norm_code(code), "used_count": {"$gt": 0}},
                              {"$inc": {"used_count": -1}})


class ShopBundleRepository(BaseRepository):
    collection_name = "shop_bundles"

    async def list(self) -> list[dict]:
        return jsonsafe(await self.find({}, sort=[("created_at", -1)], limit=200))

    async def active_now(self) -> list[dict]:
        return await self.find({"active": True}, limit=200)

    async def upsert(self, data: dict) -> dict:
        kind = data.get("kind") if data.get("kind") in ("combo", "nplusm") else "combo"
        doc = {
            "name": (data.get("name") or "").strip()[:120] or "Πακέτο",
            "kind": kind,
            "active": bool(data.get("active", True)),
            "updated_at": _now(),
        }
        if kind == "nplusm":                       # «2+1»: ανά (buy+free) τεμάχια, τα free δωρεάν
            doc["barcode"] = str(data.get("barcode") or "").strip()
            doc["buy_qty"] = max(1, int(data.get("buy_qty") or 2))
            doc["free_qty"] = max(1, int(data.get("free_qty") or 1))
            if not doc["barcode"]:
                return {"ok": False, "error": "bad_barcode"}
        else:                                      # combo: όλα μαζί → % έκπτωση στα είδη του πακέτου
            lines = []
            for ln in (data.get("lines") or []):
                bc = str((ln or {}).get("barcode") or "").strip()
                if bc:
                    lines.append({"barcode": bc, "qty": max(1, int((ln or {}).get("qty") or 1))})
            if len(lines) < 2:
                return {"ok": False, "error": "need_two_lines"}
            doc["lines"] = lines[:10]
            doc["discount_pct"] = max(1, min(90, int(data.get("discount_pct") or 10)))
        cid = data.get("_id") or data.get("id")
        if cid:
            try:
                oid = ObjectId(str(cid))
            except Exception:  # noqa: BLE001
                return {"ok": False, "error": "bad_id"}
            await self.update_one({"_id": oid}, {"$set": doc})
            return {"ok": True, "id": str(oid)}
        res = await self.insert_one({**doc, "created_at": _now()})
        return {"ok": True, "id": str(res.inserted_id)}

    async def delete(self, cid: str) -> dict:
        try:
            oid = ObjectId(str(cid))
        except Exception:  # noqa: BLE001
            return {"ok": False}
        await self.delete_many({"_id": oid})
        return {"ok": True}
