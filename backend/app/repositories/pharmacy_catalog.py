"""Per-pharmacy product catalog (OTC medicines + parapharmacy) for the order/delivery circuit.
Populated manually OR via a flexible XML import from the pharmacy's commercial software.

PRICING RULE (enforced in code): ONLY prescription medicines (`rx_medicine`) allow NO discount;
OTC/ΜΗ.ΣΥ.ΦΑ. (`otc_medicine`) and parapharmacy (`parapharmacy`) may be discounted. See
`services/catalog_taxonomy.py` for the 3 product classes + ATC→category auto-classification.
"""

from __future__ import annotations

import io
import re
import defusedxml.ElementTree as ET   # hardened: blocks entity-expansion / XXE (billion-laughs DoS)
from datetime import datetime, timezone

from bson import Binary, ObjectId

from app.repositories.base import BaseRepository, jsonsafe
from app.services.catalog_taxonomy import PRODUCT_TYPES, discount_allowed

TYPES = PRODUCT_TYPES   # ("rx_medicine", "otc_medicine", "parapharmacy")
_MAX_TAGS = 12
# Ταξινομήσεις βιτρίνας (πάντα «προτεινόμενα» πρώτα): νεότερα, τιμή ↑/↓, αλφαβητικά.
_SORTS: dict = {
    "featured": [("name", 1)],
    "newest": [("created_at", -1)],
    "price_asc": [("price_cents", 1)],
    "price_desc": [("price_cents", -1)],
    "name": [("name", 1)],
}


def _clean_tags(v) -> list[str]:
    if isinstance(v, str):
        v = [v]
    out: list[str] = []
    for t in (v or []):
        s = str(t).strip()[:40]
        if s and s not in out:
            out.append(s)
    return out[:_MAX_TAGS]


_VIDEO_HOSTS = re.compile(r"^https://(www\.)?(youtube\.com/|youtu\.be/|m\.youtube\.com/|vimeo\.com/)", re.I)


def _safe_video_url(url) -> str | None:
    """Δέξου ΜΟΝΟ YouTube/Vimeo (whitelist) → ασφαλές embed. Ό,τι άλλο → None (όχι αυθαίρετα iframes)."""
    u = str(url or "").strip()[:500]
    return u if u and _VIDEO_HOSTS.match(u) else None


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
                   tag: str | None = None, in_stock_only: bool = False, sort: str = "featured",
                   page: int = 1, page_size: int = 40) -> dict:
        query: dict = {"active": {"$ne": False}}
        if q and q.strip():
            rx = {"$regex": re.escape(q.strip()), "$options": "i"}
            query["$or"] = [{"name": rx}, {"barcode": rx}, {"description_long": rx},
                            {"tags": rx}, {"category": rx}]
        if category:
            query["category"] = category
        if ptype in TYPES:
            query["type"] = ptype
        if tag:
            query["tags"] = tag
        if in_stock_only:
            query["stock_qty"] = {"$gt": 0}
        page = max(1, page)
        page_size = max(1, min(page_size, 100))
        # «Προτεινόμενα» πάντα πρώτα, μετά η ζητούμενη ταξινόμηση.
        sort_spec = [("featured", -1), *_SORTS.get(sort, _SORTS["featured"])]
        total = await self.count(query)
        items = await self.find(query, sort=sort_spec, skip=(page - 1) * page_size, limit=page_size)
        return {"items": jsonsafe(items), "total": total, "page": page, "page_size": page_size}

    async def get(self, barcode: str) -> dict | None:
        d = await self.find_one({"barcode": str(barcode)})
        return jsonsafe(d) if d else None

    async def upsert(self, data: dict) -> dict:
        bc = str(data.get("barcode") or "").strip()
        if not bc:
            return {"ok": False, "error": "no_barcode"}
        ptype = data.get("type") if data.get("type") in TYPES else "parapharmacy"
        # PRICING RULE: ΜΟΝΟ τα συνταγογραφούμενα (rx_medicine) → καμία έκπτωση.
        # OTC (ΜΗ.ΣΥ.ΦΑ.) & παραφάρμακα → επιτρέπεται έκπτωση.
        disc = max(0, min(90, _int(data.get("discount_pct")) or 0)) if discount_allowed(ptype) else 0
        doc = {
            "name": (data.get("name") or "").strip()[:200],
            "description_short": (data.get("description_short") or "").strip()[:300] or None,
            "description_long": (data.get("description_long") or "").strip()[:6000] or None,
            "photo_url": (data.get("photo_url") or "").strip()[:1000] or None,
            "image_id": (str(data.get("image_id")).strip() or None) if data.get("image_id") else None,
            "usage_video_url": _safe_video_url(data.get("usage_video_url")),
            "price_cents": max(0, _int(data.get("price_cents")) or 0),
            "wholesale_cents": max(0, _int(data.get("wholesale_cents")) or 0),  # χονδρική → κερδοφορία
            "is_fyk": bool(data.get("is_fyk", False)),                          # ΦΥΚ (εξαιρείται από rebate note)
            "participation": max(0, min(100, _int(data.get("participation")) if data.get("participation") is not None else 0)),  # % συμμετοχής ασφαλισμένου (indicative split)
            "type": ptype,
            "category": (data.get("category") or "").strip()[:80] or None,
            "tags": _clean_tags(data.get("tags")),           # ελεύθερες ετικέτες (badges/φίλτρα)
            "featured": bool(data.get("featured", False)),   # προτεινόμενο → πρώτο στη βιτρίνα
            "discount_pct": disc,
            "stock_qty": max(0, _int(data.get("stock_qty")) or 0),
            "active": bool(data.get("active", True)),
            "source": data.get("source") if data.get("source") in ("manual", "xml", "hdika") else "manual",
            "updated_at": _now(),
        }
        # Τα tags/featured/image_id τα διαχειρίζεται ΜΟΝΟ ο φαρμακοποιός (edit). Το XML import δεν τα
        # στέλνει → μην τα σβήνεις σε επανα-εισαγωγή (διατήρησε ό,τι έχει ήδη μπει χειροκίνητα).
        for k in ("tags", "featured", "image_id", "wholesale_cents", "is_fyk", "participation"):
            if k not in data:
                doc.pop(k, None)
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

    async def tags(self) -> list[str]:
        rows = await self.aggregate([{"$match": {"active": {"$ne": False}}},
                                     {"$unwind": "$tags"}, {"$group": {"_id": "$tags"}},
                                     {"$sort": {"_id": 1}}])
        return [r["_id"] for r in rows if r.get("_id")]

    # ── product images (uploaded, stored in shared DB so they serve from BOTH app nodes) ──────
    async def save_image(self, raw: bytes, content_type: str) -> str | None:
        """Resize (≤900px) + re-encode JPEG, store bytes in `pharmacy_product_images`. Returns id."""
        try:
            from PIL import Image
            im = Image.open(io.BytesIO(raw))
            im.thumbnail((900, 900))
            if im.mode == "P":
                im = im.convert("RGBA")
            if im.mode in ("RGBA", "LA"):
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[-1])
                im = bg
            elif im.mode != "RGB":
                im = im.convert("RGB")
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=82, optimize=True)
            data = buf.getvalue()
        except Exception:  # noqa: BLE001 — κακή/εχθρική εικόνα → καθαρό error, ποτέ 500
            return None
        res = await self._db["pharmacy_product_images"].insert_one(
            {"tenant_id": self.tenant_id, "content_type": "image/jpeg",
             "data": Binary(data), "created_at": _now()})
        return str(res.inserted_id)

    @staticmethod
    async def get_image(image_id: str) -> tuple[bytes, str] | None:
        """Public read by opaque id (product photos are non-PII marketing content, no tenant gate)."""
        from app.core.db import shared_db
        try:
            oid = ObjectId(image_id)
        except Exception:  # noqa: BLE001
            return None
        d = await shared_db()["pharmacy_product_images"].find_one({"_id": oid})
        if not d or not d.get("data"):
            return None
        return bytes(d["data"]), d.get("content_type") or "image/jpeg"

    # ── stock reservation (prevent oversell on concurrent orders) ─────────────────────────────
    async def reserve_stock(self, items: list[dict]) -> dict:
        """Ατομική μείωση αποθέματος ανά είδος· rollback ΟΛΩΝ αν κάποιο δεν επαρκεί (χωρίς oversell)."""
        done: list[dict] = []
        for it in items:
            bc = str(it.get("barcode"))
            qty = max(1, int(it.get("qty") or 1))
            r = await self.update_one({"barcode": bc, "stock_qty": {"$gte": qty}},
                                      {"$inc": {"stock_qty": -qty}, "$set": {"updated_at": _now()}})
            if getattr(r, "modified_count", 0) < 1:
                for d in done:   # rollback ό,τι μειώθηκε ήδη
                    await self.update_one({"barcode": d["barcode"]}, {"$inc": {"stock_qty": d["qty"]}})
                return {"ok": False, "barcode": bc}
            done.append({"barcode": bc, "qty": qty})
        return {"ok": True}

    async def restore_stock(self, items: list[dict]) -> None:
        """Επιστροφή αποθέματος (π.χ. σε ακύρωση παραγγελίας)."""
        for it in items:
            await self.update_one({"barcode": str(it.get("barcode"))},
                                  {"$inc": {"stock_qty": max(1, int(it.get("qty") or 1))},
                                   "$set": {"updated_at": _now()}})

    async def prefill(self, barcode: str) -> dict:
        """Auto-fill a medicine from the shared ΗΔΙΚΑ catalogue by barcode (less typing)."""
        from app.services.catalog_taxonomy import medicine_category
        m = await self._db["medicine_catalog"].find_one({"barcode": str(barcode)})  # tenant-ok: shared ref
        if not m:
            return {"found": False}
        # Φάρμακο από ΗΔΥΚΑ → default «συνταγογραφούμενο» (ο φαρμακοποιός το κάνει OTC αν είναι ΜΗ.ΣΥ.ΦΑ.),
        # αυτόματη θεραπευτική κατηγορία από το ATC.
        return jsonsafe({"found": True, "name": m.get("full_name") or m.get("name"),
                         "price_cents": m.get("retail_cents"),
                         "category": medicine_category(m.get("atc")), "type": "rx_medicine"})

    # ── ΜΗΤΡΩΟ ΗΔΥΚΑ (φάρμακα) — αναζήτηση/πλοήγηση & ενεργοποίηση «προς πώληση» ──────────────
    async def registry(self, *, q: str = "", category: str | None = None,
                       page: int = 1, page_size: int = 40) -> dict:
        """Πλοήγηση/αναζήτηση στο shared μητρώο φαρμάκων (`medicine_catalog`) ανά θεραπευτική
        κατηγορία (sale_category, ATC-based), με σήμανση ποια είναι ήδη «προς πώληση» στο φαρμακείο."""
        query: dict = {"in_circulation": {"$ne": False}}
        if category:
            query["sale_category"] = category
        if q and q.strip():
            rx = {"$regex": re.escape(q.strip()), "$options": "i"}
            query["$or"] = [{"full_name": rx}, {"name": rx}, {"barcode": rx}, {"substance_name": rx}]
        page = max(1, page)
        page_size = max(1, min(page_size, 100))
        total = await self._db["medicine_catalog"].count_documents(query)
        rows = [d async for d in self._db["medicine_catalog"].find(
            query, {"barcode": 1, "full_name": 1, "name": 1, "retail_cents": 1, "atc": 1,
                    "sale_category": 1, "narcotic": 1}).sort("full_name", 1)
            .skip((page - 1) * page_size).limit(page_size)]
        bcs = [d["barcode"] for d in rows if d.get("barcode")]
        active = {p["barcode"] for p in await self.find({"barcode": {"$in": bcs}}, limit=len(bcs) or 1)} if bcs else set()
        items = [{"barcode": d["barcode"], "name": d.get("full_name") or d.get("name") or "—",
                  "price_cents": d.get("retail_cents") or 0,
                  "category": d.get("sale_category") or medicine_category(d.get("atc")),
                  "narcotic": bool(d.get("narcotic")), "activated": d["barcode"] in active}
                 for d in rows if d.get("barcode")]
        return {"items": items, "total": total, "page": page, "page_size": page_size}

    async def activate(self, *, barcodes: list[str] | None = None, category: str | None = None,
                       ptype: str = "rx_medicine", stock_qty: int = 0) -> dict:
        """Ενεργοποίηση «προς πώληση»: αντιγράφει είδη από το μητρώο ΗΔΥΚΑ στα `pharmacy_products`
        (αυτόματη κατηγορία από ATC + τιμή/όνομα). Είτε συγκεκριμένα barcodes είτε ΟΛΗ κατηγορία."""
        if ptype not in TYPES:
            ptype = "rx_medicine"
        query: dict = {"in_circulation": {"$ne": False}}
        if barcodes:
            query["barcode"] = {"$in": [str(b) for b in barcodes]}
        elif category:
            query["sale_category"] = category
        else:
            return {"ok": False, "error": "nothing_selected"}
        n = 0
        async for m in self._db["medicine_catalog"].find(
                query, {"barcode": 1, "full_name": 1, "name": 1, "retail_cents": 1, "wholesale_cents": 1,
                        "high_cost": 1, "participation": 1, "atc": 1, "sale_category": 1}):
            bc = m.get("barcode")
            if not bc:
                continue
            await self.upsert({
                "barcode": bc, "name": m.get("full_name") or m.get("name"),
                "price_cents": m.get("retail_cents") or 0,
                "wholesale_cents": m.get("wholesale_cents") or 0, "is_fyk": bool(m.get("high_cost")),
                "participation": int(m.get("participation") or 0),
                "type": ptype, "category": m.get("sale_category") or medicine_category(m.get("atc")),
                "stock_qty": max(0, int(stock_qty or 0)), "source": "hdika", "active": True,
            })
            n += 1
        return {"ok": True, "activated": n}

    async def import_xml(self, content: bytes | str, *, row_tag: str, mapping: dict,
                         default_type: str = "parapharmacy") -> dict:
        """Flexible importer: `row_tag` = the repeating element (e.g. 'product'); `mapping` maps our
        fields → the XML tag/attribute names in THIS pharmacy's export. Upserts by barcode + stock."""
        try:
            root = ET.fromstring(content)   # defused: raises on forbidden entities/DTDs
        except Exception as e:  # noqa: BLE001 — bad or hostile XML → clean error, never a 500/DoS
            return {"ok": False, "error": f"xml_parse: {type(e).__name__}"}
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
