"""Prescription repository — tenant-scoped reads + analytics pipelines.

Pipelines here intentionally omit the leading {$match: tenant_id}; BaseRepository.aggregate
prepends it so isolation can never be forgotten.
"""

from __future__ import annotations

from datetime import datetime

from bson import ObjectId

from app.repositories.base import BaseRepository, jsonsafe

_GRAIN_FMT = {"day": "%Y-%m-%d", "month": "%Y-%m"}
_METRIC_FIELD = {"executions": None, "value": "$amount_total", "claimed": "$amount_claimed"}


def _oid(v):
    try:
        return v if isinstance(v, ObjectId) else ObjectId(str(v))
    except Exception:  # noqa: BLE001
        return None


class PrescriptionRepository(BaseRepository):
    collection_name = "prescription_executions"

    async def execution_detail(self, external_id: str) -> dict | None:
        """Full drill-down for one executed prescription: doctor + (anonymised) patient +
        fund + repeat info + ICD-10 + every medicine line (name/qty/retail/wholesale/margin)."""
        ex = await self._coll.find_one(self._scope({"external_id": external_id}))
        if not ex:
            return None
        db = self._db
        async def _get(coll, oid):
            o = _oid(oid)
            return await db[coll].find_one({"_id": o}) if o else None
        doctor = await _get("doctors", ex.get("doctor_id"))
        fund = await _get("insurance_funds", ex.get("fund_id"))
        patient = await _get("patients_anonymized", ex.get("patient_ref"))
        item_docs = await db["prescription_items"].find(
            {"tenant_id": self.tenant_id, "execution_id": ex["_id"]}).to_list(200)
        items = []
        for it in item_docs:
            prod = await db["products"].find_one({"_id": it.get("product_id")}) if it.get("product_id") else None
            prod = prod or {}
            items.append({
                "name": prod.get("name"), "barcode": prod.get("barcode"),
                "category": it.get("category") or prod.get("category"),
                "quantity": it.get("quantity", 1),
                "retail_price": it.get("retail_price", 0),
                "wholesale_price": it.get("wholesale_price", 0),
                "margin": it.get("margin", (it.get("retail_price", 0) - it.get("wholesale_price", 0))),
                "is_executed": it.get("is_executed", True),
            })
        out = {
            "external_id": ex.get("external_id"), "executed_at": ex.get("executed_at"),
            "status": ex.get("status"), "source": ex.get("source"),
            "repeat_current": ex.get("repeat_current", 1), "repeat_total": ex.get("repeat_total", 1),
            "next_open_date": ex.get("next_open_date"),
            "amount_total": ex.get("amount_total", 0), "amount_claimed": ex.get("amount_claimed", 0),
            "patient_share": ex.get("patient_share", 0), "wholesale_cost": ex.get("wholesale_cost", 0),
            "icd10": ex.get("icd10", []),
            "has_unexecuted_substances": ex.get("has_unexecuted_substances", False),
            "doctor": {"name": (doctor or {}).get("full_name"),
                       "specialty": (doctor or {}).get("specialty")} if doctor else None,
            "fund": {"name": (fund or {}).get("name"), "code": (fund or {}).get("code")} if fund else None,
            "patient": {"sex": (patient or {}).get("sex"), "birth_year": (patient or {}).get("birth_year"),
                        "area": (patient or {}).get("area")} if patient else None,
            "items": items,
        }
        return jsonsafe(out)

    async def dashboard_summary(self, date_from: datetime, date_to: datetime) -> dict:
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {
                "_id": None,
                "executions": {"$sum": 1},
                "value": {"$sum": "$amount_total"},
                "claimed": {"$sum": "$amount_claimed"},
                "cost": {"$sum": "$wholesale_cost"},
                "patients": {"$addToSet": "$patient_ref"},
            }},
            {"$project": {
                "_id": 0, "executions": 1, "value": 1, "claimed": 1,
                "gross_profit": {"$subtract": ["$claimed", "$cost"]},
                "patient_count": {"$size": "$patients"},
            }},
        ]
        rows = await self.aggregate(pipeline)
        return rows[0] if rows else {
            "executions": 0, "value": 0, "claimed": 0, "gross_profit": 0, "patient_count": 0,
        }

    async def timeseries(self, *, metric: str, grain: str, date_from: datetime,
                         date_to: datetime) -> list[dict]:
        field = _METRIC_FIELD[metric]
        agg = {"$sum": 1} if field is None else {"$sum": field}
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {
                "_id": {"$dateToString": {"format": _GRAIN_FMT[grain],
                                          "date": "$executed_at", "timezone": "Europe/Athens"}},
                "value": agg,
            }},
            {"$sort": {"_id": 1}},
            {"$project": {"_id": 0, "bucket": "$_id", "value": 1}},
        ]
        return await self.aggregate(pipeline)

    async def hourly_heatmap(self, *, metric: str, date_from: datetime,
                             date_to: datetime) -> list[dict]:
        """Executions (or value/claimed) bucketed by ISO weekday (1=Mon..7=Sun) × hour
        (0-23), in Europe/Athens local time — the pharmacy "busy hours" matrix."""
        field = _METRIC_FIELD[metric]
        agg = {"$sum": 1} if field is None else {"$sum": field}
        tz = {"timezone": "Europe/Athens"}
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {
                "_id": {
                    "dow": {"$isoDayOfWeek": {"date": "$executed_at", **tz}},
                    "hour": {"$hour": {"date": "$executed_at", **tz}},
                },
                "value": agg,
            }},
            {"$sort": {"_id.dow": 1, "_id.hour": 1}},
            {"$project": {"_id": 0, "dow": "$_id.dow", "hour": "$_id.hour", "value": 1}},
        ]
        return await self.aggregate(pipeline)

    async def top(self, *, dim: str, limit: int, date_from: datetime,
                  date_to: datetime) -> list[dict]:
        match = {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}}}
        if dim == "icd10":
            pipeline = [match, {"$unwind": "$icd10"},
                        {"$group": {"_id": "$icd10", "rx": {"$sum": 1},
                                    "value": {"$sum": "$amount_total"}}},
                        {"$sort": {"rx": -1}}, {"$limit": limit}]
        elif dim == "doctors":
            pipeline = [match,
                        {"$group": {"_id": "$doctor_id", "rx": {"$sum": 1},
                                    "value": {"$sum": "$amount_total"}}},
                        {"$sort": {"value": -1}}, {"$limit": limit},
                        {"$lookup": {"from": "doctors", "localField": "_id",
                                     "foreignField": "_id", "as": "d"}},
                        {"$set": {"name": {"$first": "$d.full_name"}}},
                        {"$project": {"d": 0}}]
        else:  # products — aggregate from items
            return await self._top_products(limit, date_from, date_to)
        return await self.aggregate(pipeline)

    async def _top_products(self, limit, date_from, date_to) -> list[dict]:
        items = BaseRepository(tenant_id=self.tenant_id)
        items.collection_name = "prescription_items"
        return await items.aggregate([
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}, "is_executed": True}},
            {"$group": {"_id": "$product_id", "qty": {"$sum": "$quantity"}}},
            {"$sort": {"qty": -1}}, {"$limit": limit},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.name"}}}, {"$project": {"p": 0}},
        ])

    async def unexecuted_substances(self, *, date_from: datetime, date_to: datetime,
                                    limit: int = 50) -> dict:
        """Concept doc §9 — ανεκτέλεστες δραστικές: prescription lines that were NOT
        dispensed (is_executed=False), grouped by product, with lost retail value."""
        items = BaseRepository(tenant_id=self.tenant_id)
        items.collection_name = "prescription_items"
        rows = await items.aggregate([
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to},
                        "is_executed": False}},
            {"$group": {"_id": "$product_id",
                        "occurrences": {"$sum": 1},
                        "qty": {"$sum": "$quantity"},
                        "lost_value": {"$sum": "$retail_price"},
                        "category": {"$first": "$category"}}},
            {"$sort": {"occurrences": -1}}, {"$limit": limit},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.name"}}},
            {"$project": {"_id": 0, "product_id": "$_id",
                          "occurrences": 1, "qty": 1, "lost_value": 1,
                          "category": 1, "name": 1}},
        ])
        return {
            "items": rows,
            "total_occurrences": sum(r["occurrences"] for r in rows),
            "total_lost_value": sum(r["lost_value"] for r in rows),
        }
