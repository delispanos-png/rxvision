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
from datetime import datetime, timedelta, timezone

from bson import Binary, ObjectId

from app.repositories.base import BaseRepository, jsonsafe
from app.services.catalog_taxonomy import PRODUCT_TYPES, discount_allowed

TYPES = PRODUCT_TYPES   # ("rx_medicine", "otc_medicine", "parapharmacy")

# Accent-insensitive αναζήτηση: κάθε ελληνικό φωνήεν ταιριάζει με ΟΛΕΣ τις τονισμένες παραλλαγές του,
# ώστε «βρεφικο γαλα» να βρίσκει «Βρεφικό γάλα» (case handled by regex $options:i).
_GREEK_FOLD = {
    "α": "αά", "ά": "αά", "ε": "εέ", "έ": "εέ", "η": "ηή", "ή": "ηή",
    "ι": "ιίϊΐ", "ί": "ιίϊΐ", "ϊ": "ιίϊΐ", "ΐ": "ιίϊΐ",
    "ο": "οό", "ό": "οό", "υ": "υύϋΰ", "ύ": "υύϋΰ", "ϋ": "υύϋΰ", "ΰ": "υύϋΰ",
    "ω": "ωώ", "ώ": "ωώ",
}


def _fold_accents_regex(tok: str) -> str:
    """→ regex όπου κάθε φωνήεν γίνεται character class με όλες τις τονισμένες μορφές του."""
    out = []
    for ch in tok:
        cls = _GREEK_FOLD.get(ch.lower())
        out.append(f"[{cls}]" if cls else re.escape(ch))
    return "".join(out)
_MAX_TAGS = 12
# Ταξινομήσεις βιτρίνας (πάντα «προτεινόμενα» πρώτα): νεότερα, τιμή ↑/↓, αλφαβητικά.
_SORTS: dict = {
    "featured": [("name", 1)],
    "newest": [("created_at", -1)],
    "price_asc": [("price_cents", 1)],
    "price_desc": [("price_cents", -1)],
    "name": [("name", 1)],
}


def _clean_images(v) -> list[str]:
    """Gallery: λίστα image_id (uploaded). Καθαρίζει διπλότυπα/κενά, cap 8. Η κύρια εικόνα του
    προϊόντος παραμένει το `image_id` (backward compat)· το `images` είναι το πλήρες gallery."""
    if isinstance(v, str):
        v = [v]
    out: list[str] = []
    for x in (v or []):
        s = str(x or "").strip()[:64]
        if s and s not in out:
            out.append(s)
    return out[:8]


def _clean_tags(v) -> list[str]:
    if isinstance(v, str):
        v = [v]
    out: list[str] = []
    for t in (v or []):
        s = str(t).strip()[:40]
        if s and s not in out:
            out.append(s)
    return out[:_MAX_TAGS]


def _clean_barcodes(v) -> list[str]:
    """Εναλλακτικά barcodes (πέρα από το κύριο): μόνο ψηφία, ≥6, μοναδικά, cap 20."""
    if isinstance(v, str):
        v = re.split(r"[,\s]+", v)
    out: list[str] = []
    for x in (v or []):
        s = re.sub(r"\D", "", str(x or ""))
        if len(s) >= 6 and s not in out:
            out.append(s)
    return out[:20]


def _clean_variants(v) -> list[dict]:
    """Εκδοχές είδους (χρώμα/μέγεθος) — καθεμία με δικό της (προαιρετικό) barcode & απόθεμα."""
    out: list[dict] = []
    for it in (v or [])[:60]:
        if not isinstance(it, dict):
            continue
        color = str(it.get("color") or "").strip()[:40]
        size = str(it.get("size") or "").strip()[:40]
        bc = re.sub(r"\D", "", str(it.get("barcode") or ""))
        if not (color or size or bc):
            continue
        out.append({"color": color or None, "size": size or None,
                    "barcode": bc or None, "stock_qty": max(0, _int(it.get("stock_qty")) or 0)})
    return out


def _clean_refs(v) -> list[str]:
    """Λίστα barcodes-αναφορών (cross-sell) — κρατά το barcode ΟΠΩΣ ΕΙΝΑΙ (και μη-αριθμητικά SKU), dedup, cap 8."""
    if isinstance(v, str):
        v = re.split(r"[,\s]+", v)
    out: list[str] = []
    for x in (v or []):
        s = str(x or "").strip()[:64]
        if s and s not in out:
            out.append(s)
    return out[:8]


def _clean_highlights(v) -> list[str]:
    """Σημεία πώλησης (bullets) στη σελίδα προϊόντος — σύντομα, μοναδικά, cap 6."""
    if isinstance(v, str):
        v = v.splitlines()
    out: list[str] = []
    for x in (v or []):
        s = str(x or "").strip()[:120]
        if s and s not in out:
            out.append(s)
    return out[:6]


def sale_active_now(product: dict, now: datetime | None = None) -> bool:
    """True αν η per-item έκπτωση ισχύει ΤΩΡΑ (flash παράθυρο). Χωρίς παράθυρο → πάντα ενεργή."""
    now = now or datetime.now(tz=timezone.utc)
    s, e = product.get("sale_starts_at"), product.get("sale_ends_at")
    if s and _as_utc(s) and now < _as_utc(s):
        return False
    if e and _as_utc(e) and now > _as_utc(e):
        return False
    return True


def _as_utc(v):
    """Δέξου datetime (naive→UTC) ή ISO string· επέστρεψε aware datetime ή None."""
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str) and v:
        try:
            d = datetime.fromisoformat(v.replace("Z", "+00:00"))
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


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


def _iso_date(v) -> str | None:
    """Δεκτές μορφές: 2026-08-19 / 19/08/2026 / 19-08-2026 / datetime → YYYY-MM-DD."""
    s = str(v or "").strip()[:19]
    if not s:
        return None
    s = s.split(" ")[0].split("T")[0]
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    if m:
        return s
    m = re.match(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$", s)
    if m:
        d, mo, y = m.groups()
        y = ("20" + y) if len(y) == 2 else y
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    return None


def parse_spreadsheet(content: bytes, filename: str) -> list[list[str]]:
    """Ευέλικτη ανάγνωση .xlsx/.xlsm/.csv → λίστα γραμμών (κάθε γραμμή = λίστα κελιών ως string).
    ΔΕΝ υποθέτει επικεφαλίδες/θέση στηλών — αυτά τα ορίζει ο χρήστης στο mapping."""
    name = (filename or "").lower()
    rows: list[list[str]] = []
    if name.endswith((".xlsx", ".xlsm")):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        try:
            for r in (wb.active.iter_rows(values_only=True) if wb.active else []):
                rows.append(["" if c is None else str(c).strip() for c in r])
        finally:
            wb.close()
    else:                                   # CSV (auto-sniff ; ή ,)
        import csv as _csv
        text = content.decode("utf-8-sig", errors="replace")
        head = text[:4000]
        delim = ";" if head.count(";") > head.count(",") else ","
        for r in _csv.reader(io.StringIO(text), delimiter=delim):
            rows.append([str(c).strip() for c in r])
    return rows[:20000]                     # cap (anti-abuse)


class PharmacyCatalogRepository(BaseRepository):
    collection_name = "pharmacy_products"

    async def list(self, *, q: str = "", category: str | None = None, ptype: str | None = None,
                   tag: str | None = None, in_stock_only: bool = False, for_sale_only: bool = False,
                   cat1: str | None = None, cat2: str | None = None, cat3: str | None = None,
                   sort: str = "featured", page: int = 1, page_size: int = 40) -> dict:
        query: dict = {"active": {"$ne": False}}
        if for_sale_only:                    # Κατάλογος e-shop: ΜΟΝΟ όσα ο φαρμακοποιός έχει βάλει προς πώληση
            query["for_sale"] = True
        if q and q.strip():
            # Έξυπνη αναζήτηση: κάθε λέξη πρέπει να ταιριάζει ΚΑΠΟΥ (AND ανά λέξη, OR ανά πεδίο) —
            # όνομα, barcode, περιγραφή, ετικέτες, κατηγορία. Π.χ. «depon 500» = όνομα με «depon» ΚΑΙ «500».
            tokens = [tok for tok in re.split(r"\s+", q.strip()) if tok][:6]
            ands = []
            for tok in tokens:
                rx = {"$regex": _fold_accents_regex(tok), "$options": "i"}
                ands.append({"$or": [{"name": rx}, {"barcode": rx}, {"description_long": rx},
                                     {"description_short": rx}, {"tags": rx}, {"category": rx}]})
            if ands:
                query["$and"] = ands
        if category:
            query["category"] = category
        # Φίλτρο δέντρου κατηγοριών e-shop (μενού πύλης): το πιο συγκεκριμένο επίπεδο υπερισχύει.
        if cat3:
            query["cat3_id"] = cat3
        elif cat2:
            query["cat2_id"] = cat2
        elif cat1:
            query["cat1_id"] = cat1
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

    async def deals(self, campaigns: list[dict], *, limit: int = 200) -> list[dict]:
        """Προϊόντα ΣΕ ΠΡΟΣΦΟΡΑ ΤΩΡΑ: effective έκπτωση = max(δική του, καλύτερης καμπάνιας) > 0.
        Καθρεφτίζει τη μηχανή τιμολόγησης (τα rx εξαιρούνται ήδη). Κάθε είδος αποκτά eff_discount_pct
        & sale_cents («τώρα») ώστε η βιτρίνα να δείχνει «πριν/τώρα» χωρίς client-side λογική τιμών."""
        from app.repositories.shop_campaigns import campaign_pct_for
        rows = await self.find({"active": {"$ne": False}, "for_sale": True}, limit=1000)
        out: list[dict] = []
        for p in rows:
            self_disc = int(p.get("discount_pct") or 0) if sale_active_now(p) else 0  # flash: μόνο εντός παραθύρου
            eff = max(self_disc, campaign_pct_for(p, campaigns))
            if eff <= 0:
                continue
            price = int(p.get("price_cents") or 0)
            p = dict(p)
            p["eff_discount_pct"] = eff
            p["sale_cents"] = round(price * (100 - eff) / 100)
            out.append(p)
        out.sort(key=lambda x: (-x["eff_discount_pct"], not x.get("featured"), x.get("name") or ""))
        return jsonsafe(out[:limit])

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
            "images": _clean_images(data.get("images")),      # gallery (πολλαπλές εικόνες)
            "usage_video_url": _safe_video_url(data.get("usage_video_url")),
            "price_cents": max(0, _int(data.get("price_cents")) or 0),
            "wholesale_cents": max(0, _int(data.get("wholesale_cents")) or 0),  # χονδρική → κερδοφορία
            "vat_rate": max(0, min(30, _int(data.get("vat_rate")) if data.get("vat_rate") is not None else 6)),  # ΦΠΑ %
            "price_includes_vat": bool(data.get("price_includes_vat", True)),   # λιανική με/χωρίς ΦΠΑ
            "is_fyk": bool(data.get("is_fyk", False)),                          # ΦΥΚ (εξαιρείται από rebate note)
            "participation": max(0, min(100, _int(data.get("participation")) if data.get("participation") is not None else 0)),  # % συμμετοχής ασφαλισμένου (indicative split)
            "type": ptype,
            "category": (data.get("category") or "").strip()[:80] or None,
            "tags": _clean_tags(data.get("tags")),           # ελεύθερες ετικέτες (badges/φίλτρα)
            "featured": bool(data.get("featured", False)),   # προτεινόμενο → πρώτο στη βιτρίνα
            "discount_pct": disc,
            "stock_qty": max(0, _int(data.get("stock_qty")) or 0),
            "active": bool(data.get("active", True)),           # ενεργό/ανενεργό είδος στην αποθήκη
            # e-shop κατηγορίες (3 επίπεδα)· για «προς πώληση» ΠΡΕΠΕΙ να υπάρχει Κατηγορία 1.
            "cat1_id": (str(data.get("cat1_id")).strip() or None) if data.get("cat1_id") else None,
            "cat2_id": (str(data.get("cat2_id")).strip() or None) if data.get("cat2_id") else None,
            "cat3_id": (str(data.get("cat3_id")).strip() or None) if data.get("cat3_id") else None,
            "for_sale": bool(data.get("for_sale", False)) and bool(data.get("cat1_id")),  # for_sale ⇒ Κατ.1
            # ── πλήρη χαρακτηριστικά ΑΠΟΘΗΚΗΣ ──
            "min_stock": max(0, _int(data.get("min_stock")) or 0),   # σημείο αναπαραγγελίας (alert χαμηλού)
            "supplier": (data.get("supplier") or "").strip()[:120] or None,   # προμηθευτής
            "location": (data.get("location") or "").strip()[:60] or None,    # θέση/ράφι
            "batch": (data.get("batch") or "").strip()[:60] or None,          # παρτίδα
            "expiry": (data.get("expiry") or "").strip()[:10] or None,        # λήξη YYYY-MM-DD
            "barcodes": _clean_barcodes(data.get("barcodes")),                # εναλλακτικά barcodes
            "variants": _clean_variants(data.get("variants")),                # εκδοχές (χρώμα/μέγεθος)
            # ── καθαρά ΠΩΛΗΣΙΑΚΑ χαρακτηριστικά e-shop ──
            "sale_starts_at": data.get("sale_starts_at"),      # flash προσφορά: παράθυρο ισχύος έκπτωσης
            "sale_ends_at": data.get("sale_ends_at"),
            "highlights": _clean_highlights(data.get("highlights")),          # σημεία πώλησης (bullets)
            "related_barcodes": _clean_refs(data.get("related_barcodes")),  # cross-sell «συχνά μαζί»
            "points_multiplier": max(1.0, min(10.0, float(data.get("points_multiplier") or 1))),  # bonus πόντοι (×)
            "source": data.get("source") if data.get("source") in ("manual", "xml", "hdika") else "manual",
            "updated_at": _now(),
        }
        # Τα tags/featured/image_id τα διαχειρίζεται ΜΟΝΟ ο φαρμακοποιός (edit). Το XML import δεν τα
        # στέλνει → μην τα σβήνεις σε επανα-εισαγωγή (διατήρησε ό,τι έχει ήδη μπει χειροκίνητα).
        for k in ("tags", "featured", "image_id", "images", "wholesale_cents", "is_fyk", "participation",
                  "for_sale", "min_stock", "supplier", "location", "batch", "expiry", "barcodes", "variants",
                  "cat1_id", "cat2_id", "cat3_id", "sale_starts_at", "sale_ends_at", "highlights",
                  "related_barcodes", "points_multiplier", "vat_rate", "price_includes_vat"):
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

    # ── ΑΠΟΘΗΚΗ (πλήρης διαχείριση αποθέματος) ───────────────────────────────
    NEAR_EXPIRY_DAYS = 90

    async def warehouse(self, *, q: str = "", ptype: str | None = None, low_stock: bool = False,
                        expiring: bool = False, include_inactive: bool = True,
                        cat1: str | None = None, cat2: str | None = None, cat3: str | None = None,
                        for_sale: bool | None = None, stock: str | None = None,
                        supplier: str | None = None, no_image: bool = False, no_category: bool = False,
                        page: int = 1, page_size: int = 60) -> dict:
        """Master inventory: ΟΛΑ τα είδη (ενεργά + ανενεργά) με πλήρη χαρακτηριστικά + πλούσια φίλτρα."""
        query: dict = {} if include_inactive else {"active": {"$ne": False}}
        if q and q.strip():
            rx = {"$regex": re.escape(q.strip()), "$options": "i"}
            query["$or"] = [{"name": rx}, {"barcode": rx}, {"barcodes": rx}, {"variants.barcode": rx},
                            {"supplier": rx}, {"location": rx}, {"category": rx}]
        if ptype in TYPES:
            query["type"] = ptype
        # Κατηγορία-δέντρο (το πιο συγκεκριμένο επίπεδο υπερισχύει)
        if cat3:
            query["cat3_id"] = cat3
        elif cat2:
            query["cat2_id"] = cat2
        elif cat1:
            query["cat1_id"] = cat1
        if for_sale is True:
            query["for_sale"] = True
        elif for_sale is False:
            query["for_sale"] = {"$ne": True}
        if supplier:
            query["supplier"] = supplier
        if no_image:
            query["$and"] = query.get("$and", []) + [
                {"$or": [{"image_id": {"$in": [None, ""]}}, {"image_id": {"$exists": False}}]},
                {"$or": [{"photo_url": {"$in": [None, ""]}}, {"photo_url": {"$exists": False}}]}]
        if no_category:
            query["cat1_id"] = {"$in": [None, ""]}
        # Κατάσταση αποθέματος: σε απόθεμα / εξαντλημένο / χαμηλό (min_stock)
        if stock == "out":
            query["stock_qty"] = {"$lte": 0}
        elif stock == "in":
            query["stock_qty"] = {"$gt": 0}
        if low_stock or stock == "low":
            query["$expr"] = {"$lte": ["$stock_qty", {"$ifNull": ["$min_stock", 0]}]}
        if expiring:
            cutoff = (_now() + timedelta(days=self.NEAR_EXPIRY_DAYS)).date().isoformat()
            query["expiry"] = {"$ne": None, "$lte": cutoff}
        page = max(1, page); page_size = max(1, min(page_size, 200))
        total = await self.count(query)
        items = await self.find(query, sort=[("name", 1)], skip=(page - 1) * page_size, limit=page_size)
        return {"items": jsonsafe(items), "total": total, "page": page, "page_size": page_size}

    async def copy_from(self, source_tenant: str, *, overwrite: bool = False) -> dict:
        """Αντιγραφή ΟΛΩΝ των ειδών ενός φαρμακείου (source) στο ΤΡΕΧΟΝ (self=target) ως αρχικοποίηση.
        Οι εικόνες είναι ΚΟΙΝΕΣ (global image_id) → δεν αντιγράφονται blobs, μόνο η αναφορά. Απόθεμα→0.
        Idempotent ανά barcode: υπάρχον barcode στο target → skip (ή overwrite)."""
        if not source_tenant or source_tenant == self.tenant_id:
            return {"ok": False, "error": "bad_source"}
        col = self._db["pharmacy_products"]
        existing = set(await col.distinct("barcode", {"tenant_id": self.tenant_id}))
        # πεδία που ΔΕΝ μεταφέρονται (tenant-specific): markers/ιστορικό/ταυτότητα εγγραφής
        drop = {"_id", "tenant_id", "created_at", "updated_at", "profarm_tried", "profarm_tried_at",
                "profarm_synced_at", "profarm_pid", "photo_source", "source"}
        copied = skipped = updated = 0
        buf: list = []
        async for p in col.find({"tenant_id": source_tenant}):
            bc = p.get("barcode")
            if not bc:
                continue
            doc = {k: v for k, v in p.items() if k not in drop}
            doc.update({"tenant_id": self.tenant_id, "stock_qty": 0,
                        "source": "copy", "created_at": _now(), "updated_at": _now()})
            if bc in existing:
                if not overwrite:
                    skipped += 1
                    continue
                doc.pop("stock_qty", None)          # μη μηδενίζεις το απόθεμα υπάρχοντος
                await col.update_one({"tenant_id": self.tenant_id, "barcode": bc}, {"$set": doc})
                updated += 1
                continue
            buf.append(doc)
            if len(buf) >= 1000:
                await col.insert_many(buf); copied += len(buf); buf = []
        if buf:
            await col.insert_many(buf); copied += len(buf)
        return {"ok": True, "copied": copied, "updated": updated, "skipped": skipped}

    async def delete_all_items(self) -> dict:
        """Διαγραφή ΟΛΩΝ των ειδών αποθήκης του φαρμακείου + κινήσεις αποθέματος (admin-only, destructive).
        Δεν αγγίζει παραγγελίες/ιστορικό."""
        res = await self._db["pharmacy_products"].delete_many({"tenant_id": self.tenant_id})
        try:
            await self._db["pharmacy_stock_movements"].delete_many({"tenant_id": self.tenant_id})
        except Exception:  # noqa: BLE001
            pass
        return {"ok": True, "deleted": res.deleted_count}

    async def warehouse_suppliers(self) -> list[str]:
        rows = await self.aggregate([{"$match": {"supplier": {"$nin": [None, ""]}}},
                                     {"$group": {"_id": "$supplier"}}, {"$sort": {"_id": 1}}])
        return [r["_id"] for r in rows if r.get("_id")][:200]

    async def warehouse_summary(self) -> dict:
        """KPIs αποθήκης: SKUs, ενεργά, προς πώληση, αξία αποθέματος (τεμ×χονδρική), χαμηλό, λήγοντα."""
        cutoff = (_now() + timedelta(days=self.NEAR_EXPIRY_DAYS)).date().isoformat()
        rows = await self.aggregate([{"$group": {
            "_id": None,
            "skus": {"$sum": 1},
            "active": {"$sum": {"$cond": [{"$ne": ["$active", False]}, 1, 0]}},
            "for_sale": {"$sum": {"$cond": [{"$eq": ["$for_sale", True]}, 1, 0]}},
            "units": {"$sum": {"$ifNull": ["$stock_qty", 0]}},
            "value_cents": {"$sum": {"$multiply": [{"$ifNull": ["$stock_qty", 0]}, {"$ifNull": ["$wholesale_cents", 0]}]}},
            "low": {"$sum": {"$cond": [{"$lte": ["$stock_qty", {"$ifNull": ["$min_stock", 0]}]}, 1, 0]}},
            "expiring": {"$sum": {"$cond": [{"$and": [{"$ne": ["$expiry", None]}, {"$lte": ["$expiry", cutoff]}]}, 1, 0]}},
        }}])
        s = rows[0] if rows else {}
        return {k: int(s.get(k, 0) or 0) for k in ("skus", "active", "for_sale", "units", "value_cents", "low", "expiring")}

    async def set_flags(self, barcode: str, *, for_sale: bool | None = None, active: bool | None = None) -> dict:
        """Toggle ανεξάρτητα flags: ενεργό/ανενεργό (active) & πωλείται στο e-shop (for_sale)."""
        upd: dict = {"updated_at": _now()}
        if for_sale is not None:
            if for_sale:   # ΚΑΝΟΝΑΣ: για «προς πώληση» ΠΡΕΠΕΙ να έχει Κατηγορία 1
                p = await self.find_one({"barcode": str(barcode)}) or {}
                if not p.get("cat1_id"):
                    return {"ok": False, "error": "no_category", "need_category": True}
            upd["for_sale"] = bool(for_sale)
        if active is not None:
            upd["active"] = bool(active)
        if len(upd) == 1:
            return {"ok": False, "error": "no_flag"}
        await self.update_one({"barcode": str(barcode)}, {"$set": upd})
        return {"ok": True}

    async def apply_stock(self, barcode: str, *, delta: int | None = None, set_to: int | None = None,
                          expiry: str | None = None, batch: str | None = None,
                          cost_cents: int | None = None) -> int | None:
        """Εφαρμόζει κίνηση αποθέματος στο είδος & επιστρέφει το ΝΕΟ stock_qty (None αν δεν υπάρχει)."""
        p = await self.find_one({"barcode": str(barcode)})
        if not p:
            return None
        cur = int(p.get("stock_qty") or 0)
        new = max(0, int(set_to) if set_to is not None else cur + int(delta or 0))
        upd: dict = {"stock_qty": new, "updated_at": _now()}
        if expiry:
            upd["expiry"] = expiry[:10]
        if batch:
            upd["batch"] = batch[:60]
        if cost_cents is not None and cost_cents > 0:
            upd["wholesale_cents"] = cost_cents
        await self.update_one({"barcode": str(barcode)}, {"$set": upd})
        return new

    async def import_mapped(self, rows: list[list], mapping: dict, *, start_row: int = 1,
                            default_type: str = "parapharmacy", for_sale: bool = False) -> dict:
        """Εισαγωγή γραμμών Excel/CSV με ΧΑΡΤΟΓΡΑΦΗΣΗ στηλών ({field: col_index}) — ο χρήστης ορίζει
        από ποια γραμμή ξεκινούν τα δεδομένα & ποια στήλη έχει ποια πληροφορία (self-service)."""
        def cell(row: list, field: str):
            idx = mapping.get(field)
            if idx is None or idx == "":
                return None
            try:
                idx = int(idx)
            except (ValueError, TypeError):
                return None
            return row[idx] if 0 <= idx < len(row) else None

        imported = skipped = 0
        for row in rows[max(0, int(start_row) - 1):]:
            bc = str(cell(row, "barcode") or "").strip()
            name = str(cell(row, "name") or "").strip()
            if not bc or not name:
                skipped += 1
                continue
            ptype = str(cell(row, "type") or "").strip()
            data = {
                "barcode": bc, "name": name,
                "price_cents": _price_cents(cell(row, "price")),
                "wholesale_cents": _price_cents(cell(row, "cost")),
                "stock_qty": _int(cell(row, "stock")),
                "min_stock": _int(cell(row, "min_stock")),
                "category": (str(cell(row, "category")).strip() or None) if cell(row, "category") else None,
                "supplier": (str(cell(row, "supplier")).strip() or None) if cell(row, "supplier") else None,
                "location": (str(cell(row, "location")).strip() or None) if cell(row, "location") else None,
                "batch": (str(cell(row, "batch")).strip() or None) if cell(row, "batch") else None,
                "expiry": _iso_date(cell(row, "expiry")),
                "type": ptype if ptype in TYPES else default_type,
                "for_sale": for_sale,
                "source": "xml",
            }
            # μη στέλνεις πεδία που δεν χαρτογραφήθηκαν (να μη μηδενίζουν υπάρχουσες τιμές σε re-import)
            for k in ("price_cents", "wholesale_cents", "stock_qty", "min_stock", "category",
                      "supplier", "location", "batch", "expiry"):
                if data.get(k) is None:
                    data.pop(k, None)
            if not for_sale:
                data.pop("for_sale", None)   # μη το σβήνεις αν ξανα-εισάγεις (κράτα το ήδη υπάρχον)
            await self.upsert(data)
            imported += 1
        return {"ok": True, "imported": imported, "skipped": skipped, "rows": len(rows)}

    async def categories(self) -> list[str]:
        rows = await self.aggregate([{"$match": {"active": {"$ne": False}}},
                                     {"$group": {"_id": "$category"}}, {"$sort": {"_id": 1}}])
        return [r["_id"] for r in rows if r.get("_id")]

    async def category_counts(self) -> dict:
        """Πλήθος «προς πώληση» ειδών ανά κατηγορία-δέντρου (κάθε είδος μετρά στα cat1/cat2/cat3 του).
        Οδηγεί το μενού της πύλης ώστε να κρύβει άδεια κλαδιά."""
        rows = await self.aggregate([
            {"$match": {"active": {"$ne": False}, "for_sale": True}},
            {"$project": {"ids": ["$cat1_id", "$cat2_id", "$cat3_id"]}},
            {"$unwind": "$ids"},
            {"$match": {"ids": {"$ne": None}}},
            {"$group": {"_id": "$ids", "n": {"$sum": 1}}},
        ])
        return {str(r["_id"]): int(r.get("n") or 0) for r in rows if r.get("_id")}

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


class StockMovementRepository(BaseRepository):
    """Κινήσεις αποθέματος (ledger) ανά είδος: παραλαβή/πώληση/απογραφή/απόσυρση. Κάθε κίνηση κρατά
    και το νέο υπόλοιπο (audit trail). Tenant-scoped by construction (BaseRepository)."""
    collection_name = "pharmacy_stock_movements"
    KINDS = ("in", "out", "adjust", "waste")   # παραλαβή / πώληση-εξαγωγή / διόρθωση απογραφής / απόσυρση(λήξη)

    async def add(self, *, barcode: str, kind: str, qty: int, reason: str = "", batch: str = "",
                  expiry: str = "", cost_cents: int | None = None, by: str | None = None,
                  new_stock: int | None = None) -> dict:
        doc = {"barcode": str(barcode), "kind": kind if kind in self.KINDS else "adjust",
               "qty": int(qty), "reason": (reason or "").strip()[:200] or None,
               "batch": (batch or "").strip()[:60] or None, "expiry": (expiry or "").strip()[:10] or None,
               "cost_cents": cost_cents, "by": by, "new_stock": new_stock, "at": _now()}
        new_id = await self.insert_one(doc)
        return {"ok": True, "id": str(new_id)}

    async def history(self, barcode: str, *, limit: int = 100) -> list:
        return jsonsafe(await self.find({"barcode": str(barcode)}, sort=[("at", -1)], limit=limit))

    async def recent(self, *, limit: int = 60) -> list:
        return jsonsafe(await self.find({}, sort=[("at", -1)], limit=limit))
