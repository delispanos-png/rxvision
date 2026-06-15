"""Doctor repository — tenant-scoped reads + analytics (rx/value/profit/new-patients).

Pipelines translate ANALYTICS.md §3, §7, §8. They intentionally omit the leading
{$match: tenant_id}; BaseRepository.aggregate prepends it.
"""

from __future__ import annotations

import re
from datetime import datetime

from bson import ObjectId

from app.repositories.base import BaseRepository


def _oid(v):
    """Coerce a string doctor_id (from the URL) to ObjectId so it matches stored ids."""
    try:
        return v if isinstance(v, ObjectId) else ObjectId(str(v))
    except Exception:  # noqa: BLE001
        return v


class DoctorRepository(BaseRepository):
    collection_name = "doctors"

    async def list_doctors(self, *, search: str | None, skip: int, limit: int) -> list[dict]:
        query: dict = {}
        if search:
            # Escape user input: a raw $regex lets an authenticated user submit a
            # catastrophic-backtracking pattern → CPU DoS on the shared Mongo (H3).
            query["full_name"] = {"$regex": re.escape(search.strip()), "$options": "i"}
        return await self.find(query, sort=[("full_name", 1)], skip=skip, limit=limit)

    async def get(self, doctor_id) -> dict | None:
        return await self.find_one({"_id": doctor_id})


class DoctorExecutionsRepository(BaseRepository):
    """Doctor analytics computed from prescription_executions (ANALYTICS.md §3/§7/§8)."""

    collection_name = "prescription_executions"

    _SORT_FIELDS = {"value": "value", "rx": "rx_count", "profit": "gross_profit",
                    "patients": "new_patients", "name": "name"}

    async def doctors_with_stats(self, *, date_from: datetime, date_to: datetime,
                                 search: str | None, skip: int, limit: int,
                                 sort: str = "value") -> list[dict]:
        """One row per doctor for the period: name + specialty (joined from `doctors`) +
        rx_count / value / gross_profit / distinct patients. Powers the Doctors page."""
        pipe: list[dict] = [
            {"$match": {"executed_at": {"$gte": date_from, "$lte": date_to},
                        "doctor_id": {"$ne": None}}},
            {"$group": {"_id": "$doctor_id",
                        "rx_count": {"$sum": 1},
                        "value": {"$sum": "$amount_total"},
                        "cost": {"$sum": "$wholesale_cost"},
                        "patients": {"$addToSet": "$patient_ref"}}},
            {"$lookup": {"from": "doctors", "localField": "_id",
                         "foreignField": "_id", "as": "d"}},
            {"$set": {"d": {"$first": "$d"}}},
            {"$set": {"name": {"$ifNull": ["$d.full_name", "Άγνωστος"]},
                      "specialty": "$d.specialty"}},
        ]
        if search:
            # re.escape → no ReDoS / CPU DoS on the shared Mongo from a crafted pattern
            pipe.append({"$match": {"name": {"$regex": re.escape(search), "$options": "i"}}})
        pipe += [
            {"$project": {"_id": 0, "id": {"$toString": "$_id"}, "name": 1, "specialty": 1,
                          "rx_count": 1, "value": 1,
                          "gross_profit": {"$subtract": ["$value", "$cost"]},
                          "new_patients": {"$size": "$patients"}}},
            {"$sort": {self._SORT_FIELDS.get(sort, "value"): (1 if sort == "name" else -1)}},
            {"$skip": skip}, {"$limit": limit},
        ]
        return await self.aggregate(pipe)

    async def stats(self, *, doctor_id, date_from: datetime, date_to: datetime) -> dict:
        """rx / value / claimed / cost / profit / margin for one doctor in a period."""
        doctor_id = _oid(doctor_id)
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
            {"$set": {"profit": {"$subtract": ["$value", "$cost"]},  # retail − wholesale
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

    async def prescriptions(self, *, doctor_id, date_from: datetime,
                            date_to: datetime, limit: int = 300) -> list[dict]:
        """Prescriptions written by this doctor in the period (patient, fund, amounts)."""
        pipe = [
            {"$match": {"doctor_id": _oid(doctor_id),
                        "executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$sort": {"executed_at": -1}},
            {"$limit": limit},
            {"$lookup": {"from": "patients_anonymized", "localField": "patient_ref",
                         "foreignField": "_id", "as": "p"}},
            {"$lookup": {"from": "insurance_funds", "localField": "fund_id",
                         "foreignField": "_id", "as": "f"}},
            {"$project": {"_id": 0, "external_id": 1, "executed_at": 1, "icd10": 1,
                          "amount_total": 1, "amount_claimed": 1, "status": 1,
                          "has_unexecuted_substances": 1,
                          "patient_name": {"$first": "$p.full_name"},
                          "amka": {"$first": "$p.amka"},
                          "fund_name": {"$first": "$f.name"}}},
        ]
        return await self.aggregate(pipe)

    async def patients(self, *, doctor_id, date_from: datetime,
                       date_to: datetime, limit: int = 300) -> list[dict]:
        """Patients this doctor prescribed to in the period (rx count + value)."""
        pipe = [
            {"$match": {"doctor_id": _oid(doctor_id),
                        "executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {"_id": "$patient_ref", "rx": {"$sum": 1},
                        "value": {"$sum": "$amount_total"}, "last": {"$max": "$executed_at"}}},
            {"$sort": {"value": -1}},
            {"$limit": limit},
            {"$lookup": {"from": "patients_anonymized", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$project": {"_id": 0, "patient_ref": {"$toString": "$_id"},
                          "rx": 1, "value": 1, "last": 1,
                          "name": {"$first": "$p.full_name"},
                          "amka": {"$first": "$p.amka"},
                          "age_group": {"$first": "$p.age_group"},
                          "sex": {"$first": "$p.sex"}}},
        ]
        return await self.aggregate(pipe)
