"""Profitability engine — summary, by-dimension, low-margin, unprofitable categories.

Period summaries read precomputed `profitability_snapshots` (ANALYTICS.md "precompute"),
falling back to a live scan of prescription_executions (ANALYTICS.md §6/§7) when no
snapshot exists. Low-margin items read `products` (ANALYTICS.md §10).
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.repositories.base import BaseRepository


def _month_range(period: str) -> tuple[datetime, datetime]:
    """'YYYY-MM' -> (start_of_month, start_of_next_month) in UTC."""
    year, month = (int(x) for x in period.split("-")[:2])
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    end = datetime(year + (month // 12), (month % 12) + 1, 1, tzinfo=timezone.utc)
    return start, end


_DIM_LOOKUP = {
    "fund": ("insurance_funds", "name"),
    "doctor": ("doctors", "full_name"),
    "icd10": ("icd10_codes", "title_el"),
    "product": ("products", "name"),
    "category": (None, None),
}


class ProfitabilitySnapshotRepository(BaseRepository):
    collection_name = "profitability_snapshots"

    async def summary(self, *, period: str) -> dict:
        """Aggregate all dimensions of a period's snapshots into a single summary."""
        pipeline = [
            {"$match": {"period": period}},
            {"$group": {
                "_id": "$period",
                "rx_count": {"$sum": "$rx_count"},
                "amount_claimed": {"$sum": "$amount_claimed"},
                "wholesale_cost": {"$sum": "$wholesale_cost"},
                "gross_profit": {"$sum": "$gross_profit"},
            }},
            {"$set": {"margin_pct": {"$cond": [
                {"$gt": ["$amount_claimed", 0]},
                {"$multiply": [{"$divide": ["$gross_profit", "$amount_claimed"]}, 100]},
                0,
            ]}}},
            {"$project": {"_id": 0, "period": period, "rx_count": 1, "amount_claimed": 1,
                          "wholesale_cost": 1, "gross_profit": 1, "margin_pct": 1}},
        ]
        rows = await self.aggregate(pipeline)
        if rows and rows[0].get("rx_count"):
            return rows[0]
        # No snapshot yet (e.g. current month before nightly precompute) → live scan.
        start, end = _month_range(period)
        return await self._summary_live(start=start, end=end, label=period)

    async def range_summary(self, *, date_from: datetime, date_to: datetime) -> dict:
        """Live profitability summary for an arbitrary date range (shared date filter)."""
        return await self._summary_live(start=date_from, end=date_to)

    async def _summary_live(self, *, start: datetime, end: datetime, label: str = "") -> dict:
        """Compute the period summary directly from prescription_executions."""
        period = label
        execs = BaseRepository(tenant_id=self.tenant_id)
        execs.collection_name = "prescription_executions"
        pipeline = [
            {"$match": {"executed_at": {"$gte": start, "$lt": end}}},
            {"$group": {"_id": None, "rx_count": {"$sum": 1},
                        "amount_total": {"$sum": "$amount_total"},
                        "amount_claimed": {"$sum": "$amount_claimed"},
                        "wholesale_cost": {"$sum": "$wholesale_cost"}}},
            # margin = retail − wholesale (revenue is the full retail, not the fund share)
            {"$set": {"gross_profit": {"$subtract": ["$amount_total", "$wholesale_cost"]}}},
            {"$set": {"margin_pct": {"$cond": [
                {"$gt": ["$amount_total", 0]},
                {"$multiply": [{"$divide": ["$gross_profit", "$amount_total"]}, 100]},
                0,
            ]}}},
            {"$project": {"_id": 0, "period": period, "rx_count": 1,
                          "revenue": "$amount_total", "cost": "$wholesale_cost",
                          "amount_total": 1, "amount_claimed": 1, "wholesale_cost": 1,
                          "gross_profit": 1, "margin_pct": 1}},
        ]
        rows = await execs.aggregate(pipeline)
        return rows[0] if rows else {
            "period": period, "rx_count": 0, "amount_claimed": 0,
            "wholesale_cost": 0, "gross_profit": 0, "margin_pct": 0,
        }

    async def by_dimension(self, *, period: str, dim: str) -> list[dict]:
        """Precomputed profitability rows for a period grouped by `dim`."""
        coll, name_field = _DIM_LOOKUP.get(dim, (None, None))
        pipeline: list[dict] = [
            {"$match": {"period": period, "dimension": dim}},
            {"$set": {"margin_pct": {"$cond": [
                {"$gt": ["$amount_claimed", 0]},
                {"$multiply": [{"$divide": ["$gross_profit", "$amount_claimed"]}, 100]},
                0,
            ]}}},
            {"$sort": {"gross_profit": -1}},
        ]
        if coll:
            pipeline += [
                {"$lookup": {"from": coll, "localField": "dimension_id",
                             "foreignField": "_id", "as": "_d"}},
                {"$set": {"name": {"$first": f"$_d.{name_field}"}}},
                {"$project": {"_d": 0}},
            ]
        return await self.aggregate(pipeline)


class ProfitabilityLiveRepository(BaseRepository):
    """Live fallback when no snapshot exists (ANALYTICS.md §6)."""

    collection_name = "prescription_executions"

    async def live_summary(self, *, date_from: datetime, date_to: datetime) -> dict:
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$set": {"gross_profit": {"$subtract": ["$amount_claimed", "$wholesale_cost"]}}},
            {"$set": {"margin_pct": {"$cond": [
                {"$gt": ["$amount_claimed", 0]},
                {"$multiply": [{"$divide": ["$gross_profit", "$amount_claimed"]}, 100]},
                0,
            ]}}},
            {"$group": {
                "_id": None,
                "rx_count": {"$sum": 1},
                "amount_claimed": {"$sum": "$amount_claimed"},
                "wholesale_cost": {"$sum": "$wholesale_cost"},
                "gross_profit": {"$sum": "$gross_profit"},
                "avg_margin_pct": {"$avg": "$margin_pct"},
            }},
            {"$project": {"_id": 0}},
        ]
        rows = await self.aggregate(pipeline)
        return rows[0] if rows else {
            "rx_count": 0, "amount_claimed": 0, "wholesale_cost": 0,
            "gross_profit": 0, "avg_margin_pct": 0,
        }

    async def by_dimension_live(self, *, date_from: datetime, date_to: datetime,
                                dim: str, limit: int = 20) -> list[dict]:
        """Live gross profit (retail − wholesale) + margin grouped by a dimension.
        Snapshots are not generated, so this computes from prescription_executions."""
        match = {"executed_at": {"$gte": date_from, "$lt": date_to}}
        margin = {"$set": {"gross_profit": {"$subtract": ["$value", "$cost"]}}}
        pct = {"$set": {"margin_pct": {"$cond": [
            {"$gt": ["$value", 0]},
            {"$multiply": [{"$divide": ["$gross_profit", "$value"]}, 100]}, 0]}}}
        tail = [{"$sort": {"gross_profit": -1}}, {"$limit": limit}]
        proj = {"$project": {"_id": 0, "label": 1, "gross_profit": 1, "margin_pct": 1}}

        if dim == "fund":
            # per-fund value/cost + ΗΔΥΚΑ code, then fold into the central fund GROUPS
            rows = await self.aggregate([
                {"$match": match},
                {"$group": {"_id": "$fund_id", "value": {"$sum": "$amount_total"},
                            "cost": {"$sum": "$wholesale_cost"}}},
                {"$lookup": {"from": "insurance_funds", "localField": "_id",
                             "foreignField": "_id", "as": "_d"}},
                {"$set": {"name": {"$ifNull": [{"$first": "$_d.name"}, "—"]},
                          "code": {"$first": "$_d.code"}}},
                {"$project": {"_id": 0, "name": 1, "code": 1, "value": 1, "cost": 1}},
            ])
            from app.core.db import shared_db
            cfg = await shared_db()["fund_groups"].find().to_list(length=None)
            code2group = {c: g["name"] for g in cfg for c in g.get("codes", [])}
            groups: dict[str, dict] = {}
            for r in rows:
                gname = code2group.get(r.get("code")) or r["name"]
                g = groups.setdefault(gname, {"label": gname, "value": 0, "cost": 0})
                g["value"] += r["value"] or 0
                g["cost"] += r["cost"] or 0
            out = [{"label": g["label"], "gross_profit": g["value"] - g["cost"],
                    "margin_pct": ((g["value"] - g["cost"]) / g["value"] * 100) if g["value"] else 0}
                   for g in groups.values()]
            out.sort(key=lambda x: x["gross_profit"], reverse=True)
            return out[:limit]
        if dim == "doctor":
            coll, name_field = _DIM_LOOKUP[dim]
            pipe = [{"$match": match},
                    {"$group": {"_id": "$doctor_id", "value": {"$sum": "$amount_total"},
                                "cost": {"$sum": "$wholesale_cost"}}},
                    margin, pct, *tail,
                    {"$lookup": {"from": coll, "localField": "_id",
                                 "foreignField": "_id", "as": "_d"}},
                    {"$set": {"label": {"$ifNull": [{"$first": f"$_d.{name_field}"}, "—"]}}}, proj]
        elif dim == "icd10":
            pipe = [{"$match": match}, {"$unwind": "$icd10"},
                    {"$group": {"_id": "$icd10", "value": {"$sum": "$amount_total"},
                                "cost": {"$sum": "$wholesale_cost"}}},
                    margin, pct, *tail,
                    {"$lookup": {"from": "icd10_codes", "localField": "_id",
                                 "foreignField": "_id", "as": "_d"}},
                    {"$set": {"label": {"$concat": ["$_id", " ",
                                {"$ifNull": [{"$first": "$_d.title_el"}, ""]}]}}}, proj]
        else:  # product | category — from the medicine lines
            group_id = "$it.product_id" if dim == "product" else "$it.category"
            pipe = [{"$match": match},
                    {"$lookup": {"from": "prescription_items", "localField": "_id",
                                 "foreignField": "execution_id", "as": "it"}},
                    {"$unwind": "$it"},
                    {"$group": {"_id": group_id,
                                "value": {"$sum": {"$multiply": ["$it.retail_price", "$it.quantity"]}},
                                "cost": {"$sum": {"$multiply": ["$it.wholesale_price", "$it.quantity"]}}}},
                    margin, pct, *tail]
            if dim == "product":
                pipe += [{"$lookup": {"from": "products", "localField": "_id",
                                      "foreignField": "_id", "as": "_d"}},
                         {"$set": {"label": {"$ifNull": [{"$first": "$_d.name"}, "—"]}}}, proj]
            else:
                pipe += [{"$set": {"label": {"$ifNull": ["$_id", "—"]}}}, proj]
        return await self.aggregate(pipe)


class ProductRepository(BaseRepository):
    collection_name = "products"

    async def low_margin(self, *, threshold_pct: float, limit: int = 50) -> list[dict]:
        """ANALYTICS.md §10 — low margin but frequently prescribed → priority.
        Field names match the frontend table (product_name/units/gross_profit)."""
        pipeline = [
            {"$match": {"margin_pct": {"$lt": threshold_pct}, "rx_frequency": {"$gt": 0}}},
            {"$sort": {"rx_frequency": -1}},
            {"$limit": limit},
            {"$project": {"_id": 0, "product_id": {"$toString": "$_id"},
                          "product_name": "$name", "category": 1,
                          "units": "$rx_frequency", "margin_pct": 1,
                          "gross_profit": {"$multiply": [{"$ifNull": ["$margin", 0]},
                                                         {"$ifNull": ["$rx_frequency", 0]}]}}},
        ]
        return await self.aggregate(pipeline)

    async def unprofitable_categories(self) -> list[dict]:
        """Average margin per product category; surface the loss-making ones first."""
        pipeline = [
            {"$group": {
                "_id": "$category",
                "products": {"$sum": 1},
                "avg_margin_pct": {"$avg": "$margin_pct"},
                "total_rx_frequency": {"$sum": "$rx_frequency"},
            }},
            {"$sort": {"avg_margin_pct": 1}},
            {"$project": {"_id": 0, "category": "$_id", "products": 1,
                          "avg_margin_pct": 1, "total_rx_frequency": 1}},
        ]
        return await self.aggregate(pipeline)


# Receivables aging buckets (days since execution). Funds pay claimed amounts after
# ~30-60 days (concept doc §6), so older claimed = cash still owed to the pharmacy.
_AGING_BUCKETS = [(0, 30, "0-30"), (30, 60, "31-60"), (60, 90, "61-90"), (90, None, "90+")]


class ReceivablesRepository(BaseRepository):
    """Concept doc §6 — cashflow/aging of fund receivables (amount_claimed) by age."""

    collection_name = "prescription_executions"

    async def aging(self, *, now: datetime) -> dict:
        boundaries = [b[0] for b in _AGING_BUCKETS]  # [0,30,60,90]
        labels = [b[2] for b in _AGING_BUCKETS]
        pipeline = [
            {"$set": {"_age_days": {"$dateDiff": {
                "startDate": "$executed_at", "endDate": now, "unit": "day"}}}},
            {"$bucket": {
                "groupBy": "$_age_days",
                "boundaries": boundaries,
                "default": "90+",
                "output": {"claimed": {"$sum": "$amount_claimed"},
                           "rx": {"$sum": 1},
                           "funds": {"$addToSet": "$fund_id"}}},
            },
        ]
        rows = await self.aggregate(pipeline)
        # map mongo bucket _id (lower boundary or "90+") -> human label
        edge_to_label = {0: "0-30", 30: "31-60", 60: "61-90", "90+": "90+"}
        by_label = {edge_to_label.get(r["_id"], str(r["_id"])): r for r in rows}
        buckets = [{
            "bucket": lab,
            "claimed": by_label.get(lab, {}).get("claimed", 0),
            "rx": by_label.get(lab, {}).get("rx", 0),
        } for lab in labels]
        return {
            "buckets": buckets,
            "total_claimed": sum(b["claimed"] for b in buckets),
            "overdue_claimed": sum(b["claimed"] for b in buckets if b["bucket"] in ("61-90", "90+")),
        }
