"""Monthly closing — pre-close control, discrepancies, fund totals, period lock.

Reads prescription_executions for the period; lock state lives in `module_settings`
under module "monthly_closing" keyed by period.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.repositories.base import BaseRepository


def _period_bounds(period: str) -> tuple[datetime, datetime]:
    """`period` is YYYY-MM → [first-of-month, first-of-next-month) in UTC."""
    year, month = (int(x) for x in period.split("-"))
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    return start, end


class ClosingRepository(BaseRepository):
    collection_name = "prescription_executions"

    async def control(self, *, period: str) -> dict:
        """Pre-close totals + readiness signals for the period."""
        start, end = _period_bounds(period)
        pipeline = [
            {"$match": {"executed_at": {"$gte": start, "$lt": end}}},
            {"$group": {
                "_id": None,
                "executions": {"$sum": 1},
                "value": {"$sum": "$amount_total"},
                "claimed": {"$sum": "$amount_claimed"},
                "cost": {"$sum": "$wholesale_cost"},
                "cancelled": {"$sum": {"$cond": [
                    {"$eq": ["$status", "cancelled"]}, 1, 0]}},
                "partial": {"$sum": {"$cond": [
                    {"$eq": ["$status", "partial"]}, 1, 0]}},
                "with_unexecuted": {"$sum": {"$cond": [
                    {"$eq": ["$has_unexecuted_substances", True]}, 1, 0]}},
            }},
            {"$project": {"_id": 0, "executions": 1, "value": 1, "claimed": 1,
                          "cost": 1, "cancelled": 1, "partial": 1, "with_unexecuted": 1,
                          "gross_profit": {"$subtract": ["$value", "$cost"]}}},  # retail − wholesale
        ]
        rows = await self.aggregate(pipeline)
        result = rows[0] if rows else {
            "executions": 0, "value": 0, "claimed": 0, "cost": 0,
            "cancelled": 0, "partial": 0, "with_unexecuted": 0, "gross_profit": 0,
        }
        result["period"] = period
        return result

    async def discrepancies(self, *, period: str) -> list[dict]:
        """Executions that need attention before closing (partial/cancelled/unexecuted)."""
        start, end = _period_bounds(period)
        pipeline = [
            {"$match": {
                "executed_at": {"$gte": start, "$lt": end},
                "$or": [
                    {"status": {"$in": ["partial", "cancelled"]}},
                    {"has_unexecuted_substances": True},
                    {"$expr": {"$gt": ["$amount_claimed", "$amount_total"]}},
                ],
            }},
            {"$project": {"external_id": 1, "executed_at": 1, "status": 1,
                          "amount_total": 1, "amount_claimed": 1,
                          "has_unexecuted_substances": 1, "fund_id": 1, "doctor_id": 1}},
            {"$sort": {"executed_at": 1}},
            {"$limit": 500},
        ]
        return await self.aggregate(pipeline)

    async def fund_totals(self, *, period: str) -> list[dict]:
        """Per-fund summary for the period (the closing settlement view)."""
        start, end = _period_bounds(period)
        pipeline = [
            {"$match": {"executed_at": {"$gte": start, "$lt": end}}},
            {"$group": {"_id": "$fund_id",
                        "executions": {"$sum": 1},
                        "value": {"$sum": "$amount_total"},
                        "claimed": {"$sum": "$amount_claimed"},
                        "patient_share": {"$sum": "$patient_share"}}},
            {"$lookup": {"from": "insurance_funds", "localField": "_id",
                         "foreignField": "_id", "as": "fund"}},
            {"$set": {"fund": {"$first": "$fund.name"}}},
            {"$sort": {"claimed": -1}},
            {"$project": {"fund_id": "$_id", "_id": 0, "fund": 1, "executions": 1,
                          "value": 1, "claimed": 1, "patient_share": 1}},
        ]
        return await self.aggregate(pipeline)


class ClosingLockRepository(BaseRepository):
    """Period lock state stored in module_settings (module=monthly_closing)."""

    collection_name = "module_settings"

    async def is_locked(self, *, period: str) -> bool:
        doc = await self.find_one({"module": "monthly_closing"})
        return bool(doc and period in (doc.get("config", {}).get("locked_periods") or []))

    async def lock(self, *, period: str, actor_user_id: str) -> dict:
        await self.update_one(
            {"module": "monthly_closing"},
            {
                "$addToSet": {"config.locked_periods": period},
                "$set": {"updated_at": datetime.now(tz=timezone.utc),
                         f"config.locks.{period}": {
                             "locked_at": datetime.now(tz=timezone.utc),
                             "locked_by": actor_user_id}},
            },
            upsert=True,
        )
        return {"period": period, "locked": True}
