"""PharmacyOne add-on — POS sales analytics (by seller / by user) + unexecuted.

Add-on data is ingested into `pharmacyone_sales` (one doc per sale line) carrying
`sold_at, seller_id, user_id, amount, is_executed, product_id`. Tenant-scoped.
"""

from __future__ import annotations

from datetime import datetime

from app.repositories.base import BaseRepository


class PharmacyOneRepository(BaseRepository):
    collection_name = "pharmacyone_sales"

    async def sales(self, *, date_from: datetime, date_to: datetime) -> dict:
        pipeline = [
            {"$match": {"sold_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {"_id": None,
                        "lines": {"$sum": 1},
                        "qty": {"$sum": "$quantity"},
                        "amount": {"$sum": "$amount"}}},
            {"$project": {"_id": 0, "lines": 1, "qty": 1, "amount": 1}},
        ]
        rows = await self.aggregate(pipeline)
        return rows[0] if rows else {"lines": 0, "qty": 0, "amount": 0}

    async def by_seller(self, *, date_from: datetime, date_to: datetime) -> list[dict]:
        return await self._grouped("seller_id", "sellers", "name", date_from, date_to)

    async def by_user(self, *, date_from: datetime, date_to: datetime) -> list[dict]:
        return await self._grouped("user_id", "users", "full_name", date_from, date_to)

    async def _grouped(self, field: str, coll: str, name_field: str,
                       date_from: datetime, date_to: datetime) -> list[dict]:
        pipeline = [
            {"$match": {"sold_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {"_id": f"${field}",
                        "lines": {"$sum": 1},
                        "qty": {"$sum": "$quantity"},
                        "amount": {"$sum": "$amount"}}},
            {"$sort": {"amount": -1}},
            {"$lookup": {"from": coll, "localField": "_id",
                         "foreignField": "_id", "as": "_r"}},
            {"$set": {"name": {"$first": f"$_r.{name_field}"}}},
            {"$project": {"_id": 0, "key": "$_id",
                          "name": 1, "lines": 1, "qty": 1, "amount": 1}},
        ]
        return await self.aggregate(pipeline)

    async def unexecuted(self, *, date_from: datetime, date_to: datetime,
                         skip: int = 0, limit: int = 100) -> list[dict]:
        """Unexecuted sale lines in the period (ανεκτέλεστα)."""
        return await self.find(
            {"sold_at": {"$gte": date_from, "$lt": date_to}, "is_executed": False},
            sort=[("sold_at", -1)], skip=skip, limit=limit,
        )
