"""Doctor repository — tenant-scoped reads + analytics (rx/value/profit/new-patients).

Pipelines translate ANALYTICS.md §3, §7, §8. They intentionally omit the leading
{$match: tenant_id}; BaseRepository.aggregate prepends it.
"""

from __future__ import annotations

from datetime import datetime

from app.repositories.base import BaseRepository


class DoctorRepository(BaseRepository):
    collection_name = "doctors"

    async def list_doctors(self, *, search: str | None, skip: int, limit: int) -> list[dict]:
        query: dict = {}
        if search:
            query["full_name"] = {"$regex": search, "$options": "i"}
        return await self.find(query, sort=[("full_name", 1)], skip=skip, limit=limit)

    async def get(self, doctor_id) -> dict | None:
        return await self.find_one({"_id": doctor_id})


class DoctorExecutionsRepository(BaseRepository):
    """Doctor analytics computed from prescription_executions (ANALYTICS.md §3/§7/§8)."""

    collection_name = "prescription_executions"

    async def stats(self, *, doctor_id, date_from: datetime, date_to: datetime) -> dict:
        """rx / value / claimed / cost / profit / margin for one doctor in a period."""
        pipeline = [
            {"$match": {"doctor_id": doctor_id,
                        "executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {
                "_id": "$doctor_id",
                "rx": {"$sum": 1},
                "value": {"$sum": "$amount_total"},
                "claimed": {"$sum": "$amount_claimed"},
                "cost": {"$sum": "$wholesale_cost"},
                "patients": {"$addToSet": "$patient_ref"},
            }},
            {"$set": {"profit": {"$subtract": ["$claimed", "$cost"]},
                      "distinct_patients": {"$size": "$patients"}}},
            {"$set": {"margin_pct": {"$cond": [
                {"$gt": ["$claimed", 0]},
                {"$multiply": [{"$divide": ["$profit", "$claimed"]}, 100]},
                0,
            ]}}},
            {"$project": {"_id": 0, "rx": 1, "value": 1, "claimed": 1,
                          "cost": 1, "profit": 1, "margin_pct": 1, "distinct_patients": 1}},
        ]
        rows = await self.aggregate(pipeline)
        stats = rows[0] if rows else {
            "rx": 0, "value": 0, "claimed": 0, "cost": 0, "profit": 0,
            "margin_pct": 0, "distinct_patients": 0,
        }
        stats["new_patients"] = await self.new_patients_count(
            doctor_id=doctor_id, date_from=date_from, date_to=date_to)
        return stats

    async def new_patients_count(self, *, doctor_id, date_from: datetime,
                                 date_to: datetime) -> int:
        """ANALYTICS.md §8 narrowed to one doctor: patients whose FIRST-ever rx (any
        doctor) fell in the period AND was via this doctor."""
        pipeline = [
            {"$sort": {"executed_at": 1}},
            {"$group": {"_id": "$patient_ref",
                        "first_at": {"$first": "$executed_at"},
                        "first_doctor": {"$first": "$doctor_id"}}},
            {"$match": {"first_at": {"$gte": date_from, "$lt": date_to},
                        "first_doctor": doctor_id}},
            {"$count": "new_patients"},
        ]
        rows = await self.aggregate(pipeline)
        return rows[0]["new_patients"] if rows else 0

    async def new_patients(self, *, doctor_id, date_from: datetime,
                           date_to: datetime) -> list[dict]:
        """List of new-patient pseudo refs for one doctor in the period."""
        pipeline = [
            {"$sort": {"executed_at": 1}},
            {"$group": {"_id": "$patient_ref",
                        "first_at": {"$first": "$executed_at"},
                        "first_doctor": {"$first": "$doctor_id"}}},
            {"$match": {"first_at": {"$gte": date_from, "$lt": date_to},
                        "first_doctor": doctor_id}},
            {"$sort": {"first_at": 1}},
            {"$project": {"_id": 0, "patient_ref": "$_id", "first_at": 1}},
        ]
        return await self.aggregate(pipeline)
