"""Future prescriptions + demand forecast + order suggestions.

ANALYTICS.md §9 (upcoming per day) and Bonus (order suggestions with safety stock).
"""

from __future__ import annotations

from datetime import datetime, timedelta

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
                "chronic": {"$ifNull": [{"$first": "$ex.details.chronic"}, False]},
                # name + αναμενόμενη ποσότητα ανά σκεύασμα (διατηρεί το expected_qty)
                "products": {
                    "$map": {
                        "input": {"$ifNull": ["$products", []]},
                        "as": "it",
                        "in": {
                            "name": {"$let": {
                                "vars": {"m": {"$first": {"$filter": {
                                    "input": "$pr", "as": "p",
                                    "cond": {"$eq": ["$$p._id", "$$it.product_id"]}}}}},
                                "in": {"$ifNull": ["$$m.name", "$$it.product_id"]}}},
                            "qty": {"$ifNull": ["$$it.expected_qty", 1]},
                        },
                    }
                },
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

    async def daily_coverage(self, *, day_start: datetime, day_end: datetime,
                             history_days: int = 90) -> dict:
        """«Κάλυψη ημέρας» — για τις επαναλαμβανόμενες συνταγές που ΑΝΟΙΓΟΥΝ τη
        συγκεκριμένη μέρα: ποσότητες ανά φάρμακο που πρέπει να έχουμε, + πόσοι σταθεροί
        ασθενείς/συνταγές, + πραγματική ημερήσια κατανάλωση & εκτ. κόστος. Το βλέπεις
        από την προηγούμενη μέρα για να προλάβεις να παραγγείλεις."""
        base = {"status": "pending",
                "expected_open_date": {"$gte": day_start, "$lt": day_end}}
        summary = await self.aggregate([
            {"$match": base},
            # χρόνια πάθηση: από τη συνταγή-πηγή (execution.details.chronic, ΗΔΥΚΑ 1.10.9)
            {"$lookup": {"from": "prescription_executions", "localField": "source_execution_id",
                         "foreignField": "_id", "as": "ex"}},
            {"$set": {"chronic": {"$ifNull": [{"$first": "$ex.details.chronic"}, False]}}},
            {"$group": {"_id": None, "prescriptions": {"$sum": 1},
                        "patients": {"$addToSet": "$patient_ref"},
                        "chronic": {"$sum": {"$cond": ["$chronic", 1, 0]}}}},
            {"$project": {"_id": 0, "prescriptions": 1, "chronic": 1,
                          "n_patients": {"$size": "$patients"}}},
        ])
        products = await self.aggregate([
            {"$match": base},
            {"$unwind": "$products"},
            {"$group": {"_id": "$products.product_id",
                        "needed_qty": {"$sum": "$products.expected_qty"},
                        "prescriptions": {"$sum": 1},
                        "patients": {"$addToSet": "$patient_ref"}}},
            {"$set": {"n_patients": {"$size": "$patients"}}},
            {"$sort": {"needed_qty": -1}},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"product_name": {"$first": "$p.name"},
                      "substance": {"$first": "$p.substance"},
                      "category": {"$first": "$p.category"}}},
            {"$project": {"_id": 0, "product_id": "$_id", "needed_qty": 1,
                          "prescriptions": 1, "n_patients": 1,
                          "product_name": 1, "substance": 1, "category": 1}},
        ])
        # trailing-window real daily consumption + unit wholesale cost (for ordering)
        items = BaseRepository(tenant_id=self.tenant_id)
        items.collection_name = "prescription_items"
        hist_start = day_start - timedelta(days=history_days)
        hist = await items.aggregate([
            {"$match": {"executed_at": {"$gte": hist_start}, "is_executed": True}},
            {"$group": {"_id": "$product_id", "units": {"$sum": "$quantity"},
                        "cost": {"$sum": "$wholesale_price"}}},
        ])
        hmap = {h["_id"]: h for h in hist}
        out = []
        for d in products:
            h = hmap.get(d["product_id"], {})
            units, cost = h.get("units") or 0, h.get("cost") or 0
            unit_cost = (cost / units) if units else 0
            sub = d.get("substance")
            out.append({**d,
                        "substance": None if sub in (None, "None", "") else sub,
                        "avg_daily": round(units / history_days, 2),
                        "est_cost": int(round((d.get("needed_qty") or 0) * unit_cost))})
        s = summary[0] if summary else {"prescriptions": 0, "n_patients": 0, "chronic": 0}
        return {"summary": {**s, "products": len(out),
                            "total_units": sum(i["needed_qty"] for i in out),
                            "est_cost": sum(i["est_cost"] for i in out)},
                "items": out}

    async def order_suggestions(self, *, today: datetime, lead_horizon: datetime,
                                safety_stock_pct: float = 15.0,
                                history_days: int = 90) -> list[dict]:
        """ANALYTICS.md Bonus — expected demand + safety stock → suggested qty.

        Enriched with the REAL trailing-window daily consumption (Μ.Ο./ημέρα) and the
        REAL unit wholesale cost (from executed lines), so Εκτ. κόστος is meaningful.
        on_hand/supplier stay None — RxVision has no inventory/supplier feed."""
        factor = 1 + safety_stock_pct / 100.0
        demand = await self.aggregate([
            {"$match": {"status": "pending",
                        "expected_open_date": {"$gte": today, "$lt": lead_horizon}}},
            {"$unwind": "$products"},
            {"$group": {"_id": "$products.product_id",
                        "expected_demand": {"$sum": "$products.expected_qty"}}},
            {"$set": {"suggested_qty": {"$ceil": {"$multiply": ["$expected_demand", factor]}}}},
            {"$sort": {"suggested_qty": -1}},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"product_name": {"$first": "$p.name"},
                      "substance": {"$first": "$p.substance"},
                      "category": {"$first": "$p.category"}}},
            {"$project": {"_id": 0, "product_id": "$_id",
                          "expected_demand": 1, "suggested_qty": 1,
                          "product_name": 1, "substance": 1, "category": 1}},
        ])
        # trailing-window real consumption + unit wholesale cost from executed lines
        items = BaseRepository(tenant_id=self.tenant_id)
        items.collection_name = "prescription_items"
        hist_start = today - timedelta(days=history_days)
        hist = await items.aggregate([
            {"$match": {"executed_at": {"$gte": hist_start}, "is_executed": True}},
            {"$group": {"_id": "$product_id",
                        "units": {"$sum": "$quantity"},
                        "cost": {"$sum": "$wholesale_price"}}},
        ])
        hmap = {h["_id"]: h for h in hist}
        out = []
        for d in demand:
            h = hmap.get(d["product_id"], {})
            units = h.get("units") or 0
            cost = h.get("cost") or 0
            unit_cost = (cost / units) if units else 0  # cents per unit
            sub = d.get("substance")
            out.append({
                **d,
                "substance": None if sub in (None, "None", "") else sub,
                "avg_daily": round(units / history_days, 2),
                "est_cost": int(round((d.get("suggested_qty") or 0) * unit_cost)),
                "on_hand": None,
                "supplier": None,
            })
        return out
