"""Patient repository — anonymized aggregates + retention cohorts.

Reads only from patients_anonymized (no PII). Tenant-scoped by construction.
"""

from __future__ import annotations

from datetime import datetime

from app.repositories.base import BaseRepository

_DIM_FIELD = {
    "age_group": "$age_group",
    "sex": "$sex",
    "area": "$residence_area",
    "lifecycle": "$lifecycle",
}


class PatientRepository(BaseRepository):
    collection_name = "patients_anonymized"

    async def aggregate_by(self, *, by: str) -> list[dict]:
        field = _DIM_FIELD.get(by, "$lifecycle")
        pipeline = [
            {"$group": {
                "_id": field,
                "patients": {"$sum": 1},
                "rx_count": {"$sum": "$rx_count"},
                "rx_value_total": {"$sum": "$rx_value_total"},
            }},
            {"$sort": {"patients": -1}},
            {"$project": {"_id": 0, "key": "$_id", "patients": 1,
                          "rx_count": 1, "rx_value_total": 1}},
        ]
        return await self.aggregate(pipeline)

    async def retention(self, *, cohort: str | None) -> list[dict]:
        """Retention by lifecycle within a first-seen cohort (YYYY-MM).

        Buckets the cohort's patients by lifecycle (new/active/inactive) so the
        client can render retention vs churn.
        """
        match: dict = {}
        if cohort:
            match["$expr"] = {"$eq": [
                {"$dateToString": {"format": "%Y-%m", "date": "$first_seen_at"}},
                cohort,
            ]}
        pipeline: list[dict] = []
        if match:
            pipeline.append({"$match": match})
        pipeline += [
            {"$group": {"_id": "$lifecycle", "patients": {"$sum": 1}}},
            {"$sort": {"_id": 1}},
            {"$project": {"_id": 0, "lifecycle": "$_id", "patients": 1}},
        ]
        rows = await self.aggregate(pipeline)
        total = sum(r["patients"] for r in rows)
        for r in rows:
            r["pct"] = round(r["patients"] / total * 100, 2) if total else 0.0
        return rows


_PATIENT_SORT = {"value": "value", "claimed": "claimed", "profit": "profit", "rx": "rx"}


class PatientExecutionsRepository(BaseRepository):
    """Per-patient analytics from prescription_executions (concept doc §2):
    πλήθος/αξία/αιτούμενο/κερδοφορία ανά ασφαλισμένο + «ενεργός από» (first rx)."""

    collection_name = "prescription_executions"

    async def per_patient(self, *, date_from: datetime, date_to: datetime,
                          sort: str = "value", limit: int = 100) -> list[dict]:
        sort_field = _PATIENT_SORT.get(sort, "value")
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {
                "_id": "$patient_ref",
                "rx": {"$sum": 1},
                "value": {"$sum": "$amount_total"},
                "claimed": {"$sum": "$amount_claimed"},
                "cost": {"$sum": "$wholesale_cost"},
                "active_since": {"$min": "$executed_at"},
                "last_seen": {"$max": "$executed_at"},
            }},
            {"$set": {"profit": {"$subtract": ["$claimed", "$cost"]}}},
            {"$sort": {sort_field: -1}},
            {"$limit": limit},
            # join anonymized profile (no PII): pseudo_id + demographics + lifecycle
            {"$lookup": {"from": "patients_anonymized", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"pseudo_id": {"$first": "$p.pseudo_id"},
                      "age_group": {"$first": "$p.age_group"},
                      "sex": {"$first": "$p.sex"},
                      "area": {"$first": "$p.residence_area"},
                      "lifecycle": {"$first": "$p.lifecycle"}}},
            {"$project": {"_id": 0, "patient_ref": "$_id",
                          "rx": 1, "value": 1, "claimed": 1, "cost": 1, "profit": 1,
                          "active_since": 1, "last_seen": 1, "pseudo_id": 1,
                          "age_group": 1, "sex": 1, "area": 1, "lifecycle": 1}},
        ]
        return await self.aggregate(pipeline)
