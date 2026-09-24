"""ICD-10 analytics — count / value / profit per diagnosis (ANALYTICS.md §4)."""

from __future__ import annotations

from datetime import datetime

from app.repositories.base import BaseRepository
from app.services.icd10_meta import chapter_for


class Icd10Repository(BaseRepository):
    collection_name = "prescription_executions"

    async def aggregate_metric(self, *, metric: str, date_from: datetime,
                               date_to: datetime, limit: int = 50) -> list[dict]:
        sort_field = {"count": "rx", "value": "value", "profit": "profit"}.get(metric, "rx")
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$unwind": "$icd10"},
            {"$group": {
                "_id": "$icd10",
                "rx": {"$sum": 1},
                "value": {"$sum": "$amount_total"},
                "claimed": {"$sum": "$amount_claimed"},
                "cost": {"$sum": "$wholesale_cost"},
                "patients": {"$addToSet": "$patient_ref"},
            }},
            {"$set": {"profit": {"$subtract": ["$value", "$cost"]},   # retail − wholesale
                      "patients": {"$size": "$patients"}}},
            {"$sort": {sort_field: -1}},
            {"$limit": limit},
            {"$lookup": {"from": "icd10_codes", "localField": "_id",
                         "foreignField": "_id", "as": "c"}},
            {"$set": {"title": {"$first": "$c.title_el"},
                      "description": {"$first": "$c.description"}}},
            {"$project": {"c": 0}},
        ]
        rows = await self.aggregate(pipeline)
        for r in rows:
            r["chapter"] = chapter_for(r.get("_id") or "")
            # Η «πλούσια» περιγραφή (συμπεριλαμβανόμενα/εξαιρέσεις) υπάρχει μόνο στο ~37% των
            # κωδικών· όπου είναι ίδια με τον τίτλο δεν προσθέτει τίποτα → μην τη στέλνεις.
            if (r.get("description") or "") == (r.get("title") or ""):
                r["description"] = None
        return rows

    async def detail(self, *, code: str, date_from: datetime, date_to: datetime) -> dict:
        """Ό,τι ξέρουμε για ΜΙΑ πάθηση: τίτλος, πλήρης περιγραφή, κεφάλαιο, μεγέθη, τάση,
        και τα φάρμακα που όντως δόθηκαν γι\' αυτήν σ\' αυτό το φαρμακείο."""
        code = str(code or "").strip().upper()
        if not code:
            return {}
        span = date_to - date_from
        # tenant-ok: ο κατάλογος ICD-10 είναι διεθνής, κοινός για όλα τα φαρμακεία
        cat = await self._db["icd10_codes"].find_one({"_id": code}) or {}

        async def _window(a: datetime, b: datetime) -> dict:
            rows = await self.aggregate([
                {"$match": {"icd10": code, "executed_at": {"$gte": a, "$lt": b}}},
                {"$group": {"_id": None, "rx": {"$sum": 1}, "value": {"$sum": "$amount_total"},
                            "claimed": {"$sum": "$amount_claimed"},
                            "cost": {"$sum": "$wholesale_cost"},
                            "patients": {"$addToSet": "$patient_ref"}}},
                {"$set": {"profit": {"$subtract": ["$value", "$cost"]},
                          "patients": {"$size": "$patients"}}},
                {"$project": {"_id": 0}},
            ])
            return rows[0] if rows else {"rx": 0, "value": 0, "claimed": 0, "cost": 0,
                                         "profit": 0, "patients": 0}

        cur = await _window(date_from, date_to)
        prev = await _window(date_from - span, date_from)

        meds = await self.aggregate([
            {"$match": {"icd10": code, "executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$match": {"it.product_id": {"$ne": None}}},
            {"$group": {"_id": "$it.product_id", "times": {"$sum": 1},
                        "value": {"$sum": "$it.retail_price"}}},
            {"$sort": {"times": -1}},
            {"$limit": 8},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.name"}, "atc": {"$first": "$p.atc"}}},
            {"$project": {"_id": 0, "name": 1, "atc": 1, "times": 1, "value": 1}},
        ])

        desc = cat.get("description")
        return {
            "code": code, "title": cat.get("title_el"),
            "description": desc if desc and desc != cat.get("title_el") else None,
            "chapter": chapter_for(code), **cur,
            "prev": prev,
            "trend_pct": (round((cur["rx"] - prev["rx"]) * 100 / prev["rx"])
                          if prev.get("rx") else None),
            "medicines": meds,
        }

    async def aggregate_hierarchy(self, *, level: int, metric: str,
                                  date_from: datetime, date_to: datetime,
                                  limit: int = 50) -> list[dict]:
        """Concept doc §4 — roll codes up to an ICD-10 hierarchy level (1-5).

        Codes look like "E11.9"; the dot is cosmetic, so we strip it and group by
        the first `level` characters (1='E' chapter, 3='E11' category, 5=full).
        """
        level = max(1, min(level, 5))
        sort_field = {"count": "rx", "value": "value", "profit": "profit"}.get(metric, "rx")
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$unwind": "$icd10"},
            {"$set": {"_node": {"$substrCP": [
                {"$replaceAll": {"input": "$icd10", "find": ".", "replacement": ""}},
                0, level,
            ]}}},
            {"$group": {
                "_id": "$_node",
                "rx": {"$sum": 1},
                "value": {"$sum": "$amount_total"},
                "claimed": {"$sum": "$amount_claimed"},
                "cost": {"$sum": "$wholesale_cost"},
                "codes": {"$addToSet": "$icd10"},
            }},
            {"$set": {"profit": {"$subtract": ["$value", "$cost"]},  # retail − wholesale
                      "code_count": {"$size": "$codes"}}},
            {"$sort": {sort_field: -1}},
            {"$limit": limit},
            # name the node from a representative code's Greek title
            {"$set": {"_first_code": {"$arrayElemAt": ["$codes", 0]}}},
            {"$lookup": {"from": "icd10_codes", "localField": "_first_code",
                         "foreignField": "_id", "as": "_c"}},
            {"$set": {"title": {"$first": "$_c.title_el"}}},
            {"$project": {"_id": 0, "node": "$_id", "level": {"$literal": level},
                          "title": 1, "rx": 1, "value": 1, "claimed": 1, "cost": 1,
                          "profit": 1, "codes": 1, "code_count": 1}},
        ]
        return await self.aggregate(pipeline)
