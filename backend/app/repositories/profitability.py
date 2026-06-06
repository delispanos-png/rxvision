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
        return await self._summary_live(period)

    async def _summary_live(self, period: str) -> dict:
        """Compute the period summary directly from prescription_executions."""
        start, end = _month_range(period)
        execs = BaseRepository(tenant_id=self.tenant_id)
        execs.collection_name = "prescription_executions"
        pipeline = [
            {"$match": {"executed_at": {"$gte": start, "$lt": end}}},
            {"$group": {"_id": None, "rx_count": {"$sum": 1},
                        "amount_claimed": {"$sum": "$amount_claimed"},
                        "wholesale_cost": {"$sum": "$wholesale_cost"}}},
            {"$set": {"gross_profit": {"$subtract": ["$amount_claimed", "$wholesale_cost"]}}},
            {"$set": {"margin_pct": {"$cond": [
                {"$gt": ["$amount_claimed", 0]},
                {"$multiply": [{"$divide": ["$gross_profit", "$amount_claimed"]}, 100]},
                0,
            ]}}},
            {"$project": {"_id": 0, "period": period, "rx_count": 1, "amount_claimed": 1,
                          "wholesale_cost": 1, "gross_profit": 1, "margin_pct": 1}},
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


class ProductRepository(BaseRepository):
    collection_name = "products"

    async def low_margin(self, *, threshold_pct: float, limit: int = 50) -> list[dict]:
        """ANALYTICS.md §10 — low margin but frequently prescribed → priority."""
        pipeline = [
            {"$match": {"margin_pct": {"$lt": threshold_pct}, "rx_frequency": {"$gt": 0}}},
            {"$sort": {"rx_frequency": -1}},
            {"$limit": limit},
            {"$project": {"name": 1, "category": 1, "retail_price": 1,
                          "wholesale_price": 1, "margin": 1, "margin_pct": 1,
                          "rx_frequency": 1}},
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
