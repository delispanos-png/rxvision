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
            cat = await db["medicine_catalog"].find_one({"barcode": prod.get("barcode")}) if prod.get("barcode") else None
            cat = cat or {}
            retail = it.get("retail_price", 0)
            qty = it.get("quantity", 1)
            line_total = retail * qty
            participation = cat.get("participation")  # co-pay % (0/10/25…)
            # per-line split: what the patient pays vs what the fund reimburses
            pat_share = round(line_total * (participation or 0) / 100) if participation else 0
            items.append({
                "name": prod.get("name"), "barcode": prod.get("barcode"),
                "substance": cat.get("substance_name"),
                "category": it.get("category") or prod.get("category"),
                "quantity": qty,
                "retail_price": retail,
                "wholesale_price": it.get("wholesale_price", 0),
                "margin": it.get("margin", (retail - it.get("wholesale_price", 0))),
                "participation": participation,
                "patient_share": pat_share,
                "fund_share": line_total - pat_share,
                "is_executed": it.get("is_executed", True),
            })
        # ΠΛΗΡΩΤΕΟ ΑΠΟ ΤΑΜΕΙΟ = amount_claimed (fund reimburses); ΑΠΟ ΑΣΦ/ΝΟ = patient_share
        fund_payable = ex.get("amount_claimed", 0)
        patient_payable = ex.get("patient_share", 0)
        out = {
            "external_id": ex.get("external_id"), "executed_at": ex.get("executed_at"),
            "status": ex.get("status"), "source": ex.get("source"),
            "repeat_current": ex.get("repeat_current", 1), "repeat_total": ex.get("repeat_total", 1),
            "next_open_date": ex.get("next_open_date"),
            "amount_total": ex.get("amount_total", 0), "amount_claimed": ex.get("amount_claimed", 0),
            "patient_share": ex.get("patient_share", 0), "wholesale_cost": ex.get("wholesale_cost", 0),
            "fund_payable": fund_payable, "patient_payable": patient_payable,
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

    _LIST_SORTS = {"executed_at", "amount_total", "amount_claimed", "external_id"}

    async def list_executions(self, query: dict, skip: int, limit: int,
                              sort: str = "executed_at", direction: int = -1) -> list[dict]:
        """Executions list enriched like the ΗΔΙΚΑ portal: patient name/AMKA, fund,
        status + execution case, ICD-10 and amounts. Server-side sort over the WHOLE set."""
        sort_field = sort if sort in self._LIST_SORTS else "executed_at"
        pipeline = [
            {"$match": query},
            {"$sort": {sort_field: 1 if direction >= 0 else -1, "_id": 1}},
            {"$skip": skip},
            {"$limit": limit},
            {"$lookup": {"from": "patients_anonymized", "localField": "patient_ref",
                         "foreignField": "_id", "as": "p"}},
            {"$lookup": {"from": "insurance_funds", "localField": "fund_id",
                         "foreignField": "_id", "as": "f"}},
            {"$set": {"patient_name": {"$first": "$p.full_name"},
                      "amka": {"$first": "$p.amka"},
                      "fund_name": {"$first": "$f.name"}}},
            {"$project": {"_id": 0, "external_id": 1, "executed_at": 1, "source": 1,
                          "icd10": 1, "amount_total": 1, "amount_claimed": 1,
                          "status": 1, "has_unexecuted_substances": 1,
                          "patient_name": 1, "amka": 1, "fund_name": 1}},
        ]
        return await self.aggregate(pipeline)

    async def by_fund(self, date_from: datetime, date_to: datetime) -> list[dict]:
        """Per-fund breakdown for the period (rx/value/claimed/unexecuted), folded into
        the central fund GROUPS (ΗΔΙΚΑ code → group). Funds with no group stay as
        themselves; grouped funds are summed. Each row carries its member `funds`."""
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {"_id": "$fund_id",
                        "rx": {"$sum": 1},
                        "value": {"$sum": "$amount_total"},
                        "claimed": {"$sum": "$amount_claimed"},
                        "unexecuted": {"$sum": {"$cond": ["$has_unexecuted_substances", 1, 0]}}}},
            {"$lookup": {"from": "insurance_funds", "localField": "_id",
                         "foreignField": "_id", "as": "f"}},
            {"$set": {"fund_name": {"$ifNull": [{"$first": "$f.name"}, "— (χωρίς ταμείο)"]},
                      "code": {"$first": "$f.code"}}},
            {"$project": {"_id": 0, "fund_name": 1, "code": 1, "rx": 1, "value": 1,
                          "claimed": 1, "unexecuted": 1}},
        ]
        funds = await self.aggregate(pipeline)

        from app.core.db import shared_db
        cfg = await shared_db()["fund_groups"].find().to_list(length=None)
        code2group = {c: g["name"] for g in cfg for c in g.get("codes", [])}

        groups: dict[str, dict] = {}
        for f in funds:
            gname = code2group.get(f.get("code")) or f["fund_name"]
            g = groups.get(gname)
            if g is None:
                g = groups[gname] = {"fund_name": gname, "rx": 0, "value": 0,
                                     "claimed": 0, "unexecuted": 0, "funds": []}
            g["rx"] += f["rx"]
            g["value"] += f["value"]
            g["claimed"] += f["claimed"]
            g["unexecuted"] += f["unexecuted"]
            g["funds"].append({k: f.get(k) for k in
                               ("fund_name", "rx", "value", "claimed", "unexecuted")})
        for g in groups.values():
            g["is_group"] = len(g["funds"]) > 1
        return sorted(groups.values(), key=lambda x: -x["value"])

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
                # gross margin = retail − wholesale (the pharmacy collects full retail
                # from patient+fund); NOT claimed−cost (claimed is only the fund share).
                "gross_profit": {"$subtract": ["$value", "$cost"]},
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
            # which prescription each unexecuted line came from (barcode + patient + date)
            {"$lookup": {"from": "prescription_executions", "localField": "execution_id",
                         "foreignField": "_id", "as": "ex"}},
            {"$set": {"ex": {"$first": "$ex"}}},
            {"$lookup": {"from": "patients_anonymized", "localField": "ex.patient_ref",
                         "foreignField": "_id", "as": "pt"}},
            {"$set": {"rx": {"barcode": "$ex.external_id",
                             "patient": {"$first": "$pt.full_name"},
                             "date": "$ex.executed_at"}}},
            {"$group": {"_id": "$product_id",
                        "occurrences": {"$sum": 1},
                        "qty": {"$sum": "$quantity"},
                        "lost_value": {"$sum": "$retail_price"},
                        "category": {"$first": "$category"},
                        "barcodes": {"$addToSet": "$ex.external_id"},
                        "rxs": {"$addToSet": "$rx"}}},
            {"$sort": {"occurrences": -1}}, {"$limit": limit},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.name"}}},
            {"$project": {"_id": 0, "product_id": "$_id",
                          "occurrences": 1, "qty": 1, "lost_value": 1,
                          "category": 1, "name": 1, "barcodes": 1, "rxs": 1}},
        ])
        return {
            "items": rows,
            "total_occurrences": sum(r["occurrences"] for r in rows),
            "total_lost_value": sum(r["lost_value"] for r in rows),
        }
