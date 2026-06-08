"""ICD-10 analytics — count / value / profit per diagnosis (ANALYTICS.md §4)."""

from __future__ import annotations

from datetime import datetime

from app.repositories.base import BaseRepository


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
            }},
            {"$set": {"profit": {"$subtract": ["$value", "$cost"]}}},  # retail − wholesale
            {"$sort": {sort_field: -1}},
            {"$limit": limit},
            {"$lookup": {"from": "icd10_codes", "localField": "_id",
                         "foreignField": "_id", "as": "c"}},
            {"$set": {"title": {"$first": "$c.title_el"}}},
            {"$project": {"c": 0}},
        ]
        return await self.aggregate(pipeline)

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
