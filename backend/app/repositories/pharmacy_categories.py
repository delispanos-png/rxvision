"""Per-pharmacy e-shop category TREE (3 levels): Κατηγορία 1 → 2 (γονική=1) → 3 (γονική=2).
Οδηγεί (α) την κατηγοριοποίηση ειδών, (β) το μενού πλοήγησης της πύλης, (γ) τη στόχευση προσφορών.
Ένα είδος πρέπει να έχει ΤΟΥΛΑΧΙΣΤΟΝ Κατηγορία 1 για να μπει «προς πώληση» (for_sale)."""

from __future__ import annotations

import unicodedata
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository, jsonsafe

MAX_LEVEL = 3

# Εικονίδια ανά κατηγορία (keyword match) — καθρέφτης του catEmoji της πύλης (ShopTab), ώστε οι
# μεταφερόμενες κατηγορίες να «φέρνουν» το εικονίδιο που είχαν ήδη στο e-shop. Αποθηκεύεται στον κόμβο.
_ICON_KEYWORDS: list[tuple[str, str]] = [
    ("καρδι", "❤️"), ("αντιβιοτ", "🦠"), ("αντιλοιμ", "🦠"), ("ψυχοφ", "🧠"), ("νευρολογ", "🧠"),
    ("αναλγητ", "💊"), ("αντιπυρετ", "🌡️"), ("αντιφλεγμον", "🦴"), ("μυοσκελετ", "🦴"), ("ορθοπεδ", "🦴"),
    ("γαστρεντ", "🫄"), ("διαβητ", "🩸"), ("μεταβολ", "🩸"), ("αναπνευστ", "🫁"), ("ασθμα", "🫁"),
    ("βηχ", "🤧"), ("κρυολ", "🤧"), ("δερματολογ", "🧴"), ("οφθαλμ", "👁️"), ("ωρλ", "👂"),
    ("ορμον", "🦋"), ("θυρεοειδ", "🦋"), ("ουρογεν", "🚻"), ("γυναικολογ", "🌸"), ("αιμα", "🩸"),
    ("αντιπηκτ", "🩸"), ("ογκολογ", "🎗️"), ("ανοσολογ", "🎗️"), ("εμβολ", "💉"), ("βιταμιν", "🍊"),
    ("συμπληρ", "🍊"), ("καλλυντ", "💄"), ("αντηλιακ", "☀️"), ("προσωπ", "🧖"), ("σωματ", "🧴"),
    ("μαλλι", "💇"), ("βρεφ", "🍼"), ("παιδ", "🧸"), ("εγκυμ", "🤰"), ("μαμα", "🤱"),
    ("στοματ", "🦷"), ("πιεσομ", "🩺"), ("ιατροτεχν", "🩺"), ("αντισηπτ", "🧼"), ("υγιειν", "🧼"),
    ("σεξουαλ", "💗"), ("διαιτητ", "🥗"), ("γλουτεν", "🥗"), ("φυτικ", "🌿"), ("ομοιοπαθ", "🌿"),
    ("επιδεσμ", "🩹"), ("διαφορα", "📦"), ("λοιπα", "📦"),
]


def _no_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def guess_icon(name: str) -> str:
    s = _no_accents((name or "").lower())   # αγνόησε τόνους: «Εμβόλια»→εμβολ, «Διάφορα»→διαφορα
    for kw, e in _ICON_KEYWORDS:
        if kw in s:
            return e
    return "💊"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


class PharmacyCategoryRepository(BaseRepository):
    collection_name = "pharmacy_categories"

    async def tree(self) -> list[dict]:
        """Επίπεδη λίστα (id, name, parent_id, level) — ο frontend χτίζει το δέντρο & το μενού."""
        rows = await self.find({}, sort=[("level", 1), ("order", 1), ("name", 1)], limit=3000)
        return jsonsafe([{"id": str(r["_id"]), "name": r.get("name"),
                          "parent_id": r.get("parent_id"), "level": int(r.get("level", 1)),
                          "order": int(r.get("order", 0)), "image_id": r.get("image_id"),
                          "icon": r.get("icon") or guess_icon(r.get("name") or "")} for r in rows])

    async def set_icon(self, cat_id: str, icon: str | None) -> dict:
        oid = _oid(cat_id)
        if not oid:
            return {"ok": False}
        await self.update_one({"_id": oid}, {"$set": {"icon": (icon or "").strip()[:8] or None,
                                                       "updated_at": _now()}})
        return {"ok": True}

    async def backfill_icons(self) -> int:
        """Θέτει εικονίδιο (από keyword match) σε όσους κόμβους δεν έχουν — για μεταφερμένες κατηγορίες."""
        rows = await self.find({"$or": [{"icon": {"$in": [None, ""]}}, {"icon": {"$exists": False}}]}, limit=3000)
        n = 0
        for r in rows:
            oid = _oid(r["_id"])   # find() επιστρέφει string _id (jsonsafe) → μετέτρεψέ το σε ObjectId
            if not oid:
                continue
            await self.update_one({"_id": oid}, {"$set": {"icon": guess_icon(r.get("name") or "")}})
            n += 1
        return n

    async def set_image(self, cat_id: str, image_id: str | None) -> dict:
        oid = _oid(cat_id)
        if not oid:
            return {"ok": False}
        await self.update_one({"_id": oid}, {"$set": {"image_id": (image_id or None), "updated_at": _now()}})
        return {"ok": True}

    async def add(self, name: str, parent_id: str | None = None) -> dict:
        name = (name or "").strip()[:80]
        if not name:
            return {"ok": False, "error": "no_name"}
        level = 1
        pid = None
        if parent_id:
            parent = await self.find_one({"_id": _oid(parent_id)}) if _oid(parent_id) else None
            if not parent:
                return {"ok": False, "error": "no_parent"}
            level = int(parent.get("level", 1)) + 1
            if level > MAX_LEVEL:
                return {"ok": False, "error": "max_depth"}
            pid = str(parent["_id"])
        # dedup: ίδιο όνομα κάτω από την ίδια γονική → επέστρεψε το υπάρχον
        exist = await self.find_one({"name": name, "parent_id": pid})
        if exist:
            return {"ok": True, "id": str(exist["_id"]), "existed": True}
        n = await self.count({"parent_id": pid})
        new_id = await self.insert_one({"name": name, "parent_id": pid, "level": level,
                                        "order": n, "icon": guess_icon(name), "created_at": _now()})
        return {"ok": True, "id": str(new_id), "level": level}

    async def rename(self, cat_id: str, name: str) -> dict:
        name = (name or "").strip()[:80]
        oid = _oid(cat_id)
        if not oid or not name:
            return {"ok": False}
        await self.update_one({"_id": oid}, {"$set": {"name": name, "updated_at": _now()}})
        return {"ok": True}

    async def _descendants(self, cat_id: str) -> set[str]:
        """Το ίδιο + όλα τα παιδιά/εγγόνια (max 3 επίπεδα)."""
        ids = {str(cat_id)}
        for _ in range(MAX_LEVEL):
            kids = await self.find({"parent_id": {"$in": list(ids)}}, limit=3000)
            new = {str(k["_id"]) for k in kids} - ids
            if not new:
                break
            ids |= new
        return ids

    async def import_rows(self, rows: list, *, col1: int, col2: int | None = None,
                          col3: int | None = None, start_row: int = 1) -> dict:
        """Χτίζει το δέντρο από γραμμές Excel/CSV: για κάθε γραμμή, στήλη col1→Κατ1, col2→Κατ2 (γονική=Κατ1),
        col3→Κατ3 (γονική=Κατ2). Dedup μέσω cache + add()· επιστρέφει πλήθη."""
        cache: dict = {}
        stats = {"processed": 0, "created": 0}

        def cell(row, i) -> str:
            return "" if i is None or i >= len(row) or row[i] is None else str(row[i]).strip()

        async def ensure(name: str, parent: str | None) -> str | None:
            name = (name or "").strip()[:80]
            if not name:
                return None
            key = (parent or "", name.lower())
            if key in cache:
                return cache[key]
            r = await self.add(name, parent)
            cid = r.get("id")
            if r.get("ok") and not r.get("existed"):
                stats["created"] += 1
            cache[key] = cid
            return cid

        for row in rows[max(0, int(start_row) - 1):]:
            v1 = cell(row, col1)
            if not v1:
                continue
            stats["processed"] += 1
            id1 = await ensure(v1, None)
            id2 = await ensure(cell(row, col2), id1) if (col2 is not None and cell(row, col2) and id1) else None
            v3 = cell(row, col3)
            if col3 is not None and v3 and id2:
                await ensure(v3, id2)
        return {"ok": True, **stats}

    async def seed_from_products(self) -> dict:
        """Μεταφορά υπαρχουσών κατηγοριών ειδών (legacy string `category`) στο δέντρο ως Κατηγορία 1
        και ανάθεση cat1_id στα είδη. Idempotent: dedup ανά όνομα, δεν πατάει χειροκίνητες αναθέσεις
        (γράφει cat1_id μόνο όπου λείπει)."""
        prods = self._db["pharmacy_products"]
        names = await prods.distinct("category", {"tenant_id": self.tenant_id,
                                                   "category": {"$nin": [None, ""]}})
        created, assigned = 0, 0
        for name in names:
            nm = (str(name) or "").strip()
            if not nm:
                continue
            r = await self.add(nm, None)           # Κατηγορία 1 (dedup ανά όνομα)
            cid = r.get("id")
            if not cid:
                continue
            if r.get("ok") and not r.get("existed"):
                created += 1
            res = await prods.update_many(
                {"tenant_id": self.tenant_id, "category": name,
                 "$or": [{"cat1_id": {"$in": [None, ""]}}, {"cat1_id": {"$exists": False}}]},
                {"$set": {"cat1_id": cid, "updated_at": _now()}})
            assigned += res.modified_count
        await self.backfill_icons()   # «φέρε» τα εικονίδια που είχαν οι κατηγορίες
        return {"ok": True, "categories": len([n for n in names if str(n).strip()]),
                "created": created, "assigned": assigned}

    async def delete(self, cat_id: str) -> dict:
        """Διαγράφει την κατηγορία + όλο το υποδέντρο της, και ΚΑΘΑΡΙΖΕΙ τις αναφορές στα είδη."""
        oid = _oid(cat_id)
        if not oid:
            return {"ok": False}
        ids = await self._descendants(cat_id)
        oids = [o for o in (_oid(i) for i in ids) if o]
        await self.delete_many({"_id": {"$in": oids}})
        # ξεκαθάρισε τα cat1_id/cat2_id/cat3_id των ειδών που δείχνουν εδώ (tenant-scoped)
        prods = self._db["pharmacy_products"]
        idlist = list(ids)
        for field in ("cat1_id", "cat2_id", "cat3_id"):
            await prods.update_many({"tenant_id": self.tenant_id, field: {"$in": idlist}},
                                    {"$set": {field: None, "updated_at": _now()}})
        return {"ok": True, "deleted": len(ids)}
