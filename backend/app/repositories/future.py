"""Future prescriptions + demand forecast + order suggestions.

ANALYTICS.md §9 (upcoming per day) and Bonus (order suggestions with safety stock).
"""

from __future__ import annotations

from datetime import datetime

from app.repositories.base import BaseRepository


class FuturePrescriptionRepository(BaseRepository):
    collection_name = "future_prescriptions"

    async def _patients_with_min_history(self, min_history: int) -> list:
        """Concept doc §5 — patient_refs whose executed-rx count ≥ min_history."""
        execs = BaseRepository(tenant_id=self.tenant_id)
        execs.collection_name = "prescription_executions"
        rows = await execs.aggregate([
            {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}}},
            {"$match": {"n": {"$gte": min_history}}},
            {"$project": {"_id": 1}},
        ])
        return [r["_id"] for r in rows]

    async def upcoming(self, *, today: datetime, horizon: datetime,
                       min_history: int = 0) -> list[dict]:
        """ANALYTICS.md §9 — pending future prescriptions per day within horizon.

        With min_history>0, restrict to patients who already executed ≥X rx (§5)."""
        match: dict = {"status": "pending",
                       "expected_open_date": {"$gte": today, "$lt": horizon}}
        if min_history > 0:
            match["patient_ref"] = {"$in": await self._patients_with_min_history(min_history)}
        pipeline = [
            {"$match": match},
            {"$group": {
                "_id": {"$dateToString": {"format": "%Y-%m-%d",
                                          "date": "$expected_open_date",
                                          "timezone": "Europe/Athens"}},
                "count": {"$sum": 1},
            }},
            {"$sort": {"_id": 1}},
            {"$project": {"_id": 0, "date": "$_id", "count": 1}},
        ]
        return await self.aggregate(pipeline)

    async def upcoming_list(self, *, today: datetime, horizon: datetime,
                            min_history: int = 0, limit: int = 1000) -> list[dict]:
        """Individual pending future prescriptions within the window, enriched with
        patient name/AMKA, the source prescription barcode and the expected products."""
        match: dict = {"status": "pending",
                       "expected_open_date": {"$gte": today, "$lt": horizon}}
        if min_history > 0:
            match["patient_ref"] = {"$in": await self._patients_with_min_history(min_history)}
        pipeline = [
            {"$match": match},
            {"$sort": {"expected_open_date": 1}},
            {"$limit": limit},
            {"$lookup": {"from": "patients_anonymized", "localField": "patient_ref",
                         "foreignField": "_id", "as": "p"}},
            {"$lookup": {"from": "prescription_executions", "localField": "source_execution_id",
                         "foreignField": "_id", "as": "ex"}},
            {"$lookup": {"from": "products", "localField": "products.product_id",
                         "foreignField": "_id", "as": "pr"}},
            {"$project": {
                "_id": 0,
                "expected_open_date": 1,
                "confidence": 1,
                "patient_name": {"$first": "$p.full_name"},
                "amka": {"$first": "$p.amka"},
                "source_barcode": {"$first": "$ex.external_id"},
                "products": "$pr.name",
                "n_items": {"$size": {"$ifNull": ["$products", []]}},
            }},
        ]
        return await self.aggregate(pipeline)

    async def forecast(self, *, today: datetime, horizon: datetime,
                       product_id=None) -> list[dict]:
        """Expected demand per product from pending future prescriptions."""
        match: dict = {"status": "pending",
                       "expected_open_date": {"$gte": today, "$lt": horizon}}
        pipeline: list[dict] = [
            {"$match": match},
            {"$unwind": "$products"},
        ]
        if product_id is not None:
            pipeline.append({"$match": {"products.product_id": product_id}})
        pipeline += [
            {"$group": {"_id": "$products.product_id",
                        "expected_demand": {"$sum": "$products.expected_qty"}}},
            {"$sort": {"expected_demand": -1}},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.name"}}},
            # inclusion-only projection (mixing include + "p":0 exclusion errors in Mongo)
            {"$project": {"_id": 0, "product_id": "$_id",
                          "expected_demand": 1, "name": 1}},
        ]
        return await self.aggregate(pipeline)

    async def order_suggestions(self, *, today: datetime, lead_horizon: datetime,
                                safety_stock_pct: float = 15.0) -> list[dict]:
        """ANALYTICS.md Bonus — expected demand + safety stock → suggested qty."""
        factor = 1 + safety_stock_pct / 100.0
        pipeline = [
            {"$match": {"status": "pending",
                        "expected_open_date": {"$gte": today, "$lt": lead_horizon}}},
            {"$unwind": "$products"},
            {"$group": {"_id": "$products.product_id",
                        "expected_demand": {"$sum": "$products.expected_qty"}}},
            {"$set": {"suggested_qty": {"$ceil": {"$multiply": ["$expected_demand", factor]}}}},
            {"$sort": {"suggested_qty": -1}},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.name"},
                      "category": {"$first": "$p.category"}}},
            {"$project": {"_id": 0, "product_id": "$_id",
                          "expected_demand": 1, "suggested_qty": 1,
                          "name": 1, "category": 1}},
        ]
        return await self.aggregate(pipeline)
