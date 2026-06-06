"""Subscription repository — plan, limits, modules + usage vs limits.

`subscriptions` carries tenant_id, so BaseRepository tenant-scoping applies normally.
"""

from __future__ import annotations

from app.repositories.base import BaseRepository


class SubscriptionRepository(BaseRepository):
    collection_name = "subscriptions"

    async def current(self) -> dict | None:
        return await self.find_one()

    async def usage(self) -> dict:
        """Usage counters vs plan limits. Counts are tenant-scoped reads."""
        sub = await self.find_one() or {}
        limits = sub.get("limits", {})

        pharmacies = BaseRepository(tenant_id=self.tenant_id)
        pharmacies.collection_name = "pharmacies"
        users = BaseRepository(tenant_id=self.tenant_id)
        users.collection_name = "users"

        pharmacy_count = await pharmacies.count()
        user_count = await users.count()
        return {
            "plan": sub.get("plan"),
            "seats": sub.get("seats"),
            "limits": limits,
            "usage": {
                "pharmacies": pharmacy_count,
                "users": user_count,
            },
            "modules_included": sub.get("modules_included", []),
            "addons": sub.get("addons", []),
        }

    async def set_checkout_pending(self, *, plan: str, seats: int, addons: list[str]) -> None:
        await self.update_one(
            {},
            {"$set": {"pending_change": {"plan": plan, "seats": seats, "addons": addons},
                      "status": "pending_checkout"}},
            upsert=True,
        )
