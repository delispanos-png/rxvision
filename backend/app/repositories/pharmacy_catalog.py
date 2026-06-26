"""Per-pharmacy product catalog (OTC medicines + parapharmacy) for the order/delivery circuit.
Populated manually OR via a flexible XML import from the pharmacy's commercial software.

PRICING RULE (enforced in code): OTC medicines (`otc_medicine`) allow NO discount; parapharmacy
(`parapharmacy`) may be discounted. Prescription medicines are NOT in this catalog — they go through
the existing repeat-reservation flow.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

from app.repositories.base import BaseRepository, jsonsafe

TYPES = ("otc_medicine", "parapharmacy")


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _strip_ns(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _price_cents(v) -> int | None:
    """'3,50' / '3.50' / '€3,50' → 350 (integer cents)."""
    if v is None:
        return None
    s = re.sub(r"[^0-9.,]", "", str(v))
    if "," in s and "." in s:                    # 1.234,56 → 1234.56
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", ".")
    try:
        return round(float(s) * 100)
    except ValueError:
        return None


def _int(v) -> int | None:
    try:
        return int(float(re.sub(r"[^0-9.\-]", "", str(v))))
    except (ValueError, TypeError):
        return None


class PharmacyCatalogRepository(BaseRepository):
    collection_name = "pharmacy_products"

    async def list(self, *, q: str = "", category: str | None = None, ptype: str | None = None,
                   in_stock_only: bool = False, page: int = 1, page_size: int = 40) -> dict:
        query: dict = {"active": {"$ne": False}}
        if q and q.strip():
            rx = {"$regex": re.escape(q.strip()), "$options": "i"}
            query["$or"] = [{"name": rx}, {"barcode": rx}, {"description_long": rx}]
        if category:
            query["category"] = category
        if ptype in TYPES:
            query["type"] = ptype
        if in_stock_only:
            query["stock_qty"] = {"$gt": 0}
        page = max(1, page)
        page_size = max(1, min(page_size, 100))
        total = await self.count(query)
        items = await self.find(query, sort=[("name", 1)], skip=(page - 1) * page_size, limit=page_size)
        return {"items": jsonsafe(items), "total": total, "page": page, "page_size": page_size}

    async def get(self, barcode: str) -> dict | None:
        d = await self.find_one({"barcode": str(barcode)})
        return jsonsafe(d) if d else None

    async def upsert(self, data: dict) -> dict:
        bc = str(data.get("barcode") or "").strip()
        if not bc:
            return {"ok": False, "error": "no_barcode"}
        ptype = data.get("type") if data.get("type") in TYPES else "parapharmacy"
        # PRICING RULE: φάρμακα (OTC) → καμία έκπτωση· παραφάρμακα → επιτρέπεται.
        disc = 0 if ptype == "otc_medicine" else max(0, min(90, _int(data.get("discount_pct")) or 0))
        doc = {
            "name": (data.get("name") or "").strip()[:200],
            "description_short": (data.get("description_short") or "").strip()[:300] or None,
            "description_long": (data.get("description_long") or "").strip()[:6000] or None,
            "photo_url": (data.get("photo_url") or "").strip()[:1000] or None,
            "price_cents": max(0, _int(data.get("price_cents")) or 0),
            "type": ptype,
            "category": (data.get("category") or "").strip()[:80] or None,
            "discount_pct": disc,
            "stock_qty": max(0, _int(data.get("stock_qty")) or 0),
            "active": bool(data.get("active", True)),
            "source": data.get("source") if data.get("source") in ("manual", "xml") else "manual",
            "updated_at": _now(),
        }
        await self.update_one({"barcode": bc},
                              {"$set": doc, "$setOnInsert": {"barcode": bc, "created_at": _now()}},
                              upsert=True)
        return {"ok": True, "barcode": bc}

    async def delete(self, barcode: str) -> dict:
        await self.update_one({"barcode": str(barcode)},
                              {"$set": {"active": False, "updated_at": _now()}})
        return {"ok": True}

    async def categories(self) -> list[str]:
        rows = await self.aggregate([{"$match": {"active": {"$ne": False}}},
                                     {"$group": {"_id": "$category"}}, {"$sort": {"_id": 1}}])
        return [r["_id"] for r in rows if r.get("_id")]

    async def prefill(self, barcode: str) -> dict:
        """Auto-fill a medicine from the shared ΗΔΙΚΑ catalogue by barcode (less typing)."""
        m = await self._db["medicine_catalog"].find_one({"barcode": str(barcode)})  # tenant-ok: shared ref
        if not m:
            return {"found": False}
        return jsonsafe({"found": True, "name": m.get("full_name") or m.get("name"),
                         "price_cents": m.get("retail_cents"), "category": m.get("drug_category"),
                         "type": "otc_medicine"})

    async def import_xml(self, content: bytes | str, *, row_tag: str, mapping: dict,
                         default_type: str = "parapharmacy") -> dict:
        """Flexible importer: `row_tag` = the repeating element (e.g. 'product'); `mapping` maps our
        fields → the XML tag/attribute names in THIS pharmacy's export. Upserts by barcode + stock."""
        try:
            root = ET.fromstring(content)
        except ET.ParseError as e:
            return {"ok": False, "error": f"xml_parse: {e}"}
        rt = (row_tag or "").strip()
        rows = [el for el in root.iter() if _strip_ns(el.tag) == rt] if rt else list(root)

        def field(row, key):
            tag = mapping.get(key)
            if not tag:
                return None
            for ch in row:
                if _strip_ns(ch.tag) == tag and (ch.text or "").strip():
                    return ch.text.strip()
            return row.get(tag)  # attribute fallback

        imported = skipped = 0
        for row in rows:
            bc = field(row, "barcode")
            if not bc:
                skipped += 1
                continue
            ptype = field(row, "type")
            ptype = ptype if ptype in TYPES else default_type
            await self.upsert({
                "barcode": bc, "name": field(row, "name"),
                "description_short": field(row, "description_short"),
                "description_long": field(row, "description"),
                "price_cents": _price_cents(field(row, "price")),
                "stock_qty": _int(field(row, "stock")),
                "category": field(row, "category"), "photo_url": field(row, "photo"),
                "type": ptype, "discount_pct": _int(field(row, "discount")) or 0, "source": "xml",
            })
            imported += 1
        return {"ok": True, "imported": imported, "skipped": skipped, "rows": len(rows)}
