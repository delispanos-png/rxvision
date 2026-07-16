"""RxVision Copilot repository — shared LLM plumbing with PharmaCat (cache + daily limit + audit),
separate persona/collection. Level 1: app-usage guide with deep links."""

from __future__ import annotations

from datetime import datetime, timezone

from app.repositories.base import BaseRepository, jsonsafe
from app.services import copilot_service


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


class CopilotRepository(BaseRepository):
    collection_name = "copilot_cases"

    async def chat(self, user: str, perms: set[str], messages: list[dict]) -> dict:
        # No caching: answers can carry live tenant data / action proposals → must be fresh.
        # Το ημερήσιο όριο επιβάλλεται κεντρικά στο service (ai_quota, ρυθμιζόμενο ανά φαρμακείο).
        res = await copilot_service.ask(tenant_id=self.tenant_id, perms=perms, messages=messages,
                                        demo=self.demo)
        if res.get("ok"):
            await self._record(user, messages, source="llm")
        return jsonsafe(res)

    async def action_plan(self, perms: set[str]) -> dict:
        return jsonsafe(await copilot_service.build_action_plan(
            tenant_id=self.tenant_id, perms=perms, demo=self.demo))

    async def run_action(self, user: str, perms: set[str], action: str,
                         params: dict | None = None) -> dict:
        """Execute a confirmed Level-3 action (whitelisted in copilot_service)."""
        res = await copilot_service.execute_action(
            tenant_id=self.tenant_id, perms=perms, action=action, params=params)
        await self._coll.insert_one({
            "tenant_id": self.tenant_id, "user_id": user, "at": _now(),
            "source": "action", "action": action, "ok": bool(res.get("ok"))})
        return jsonsafe(res)

    async def _record(self, user: str, messages: list[dict], *, source: str) -> None:
        q = next((m["content"] for m in messages if m["role"] == "user"), "")
        await self._coll.insert_one({
            "tenant_id": self.tenant_id, "user_id": user, "at": _now(),
            "source": source, "question": q[:500]})

    async def status(self) -> dict:
        s = await copilot_service.status()
        from app.services import ai_quota
        s["today_used"] = await ai_quota.usage_today(self._db, self.tenant_id)
        s["daily_limit"] = await ai_quota.tenant_daily_limit(self._db, self.tenant_id)
        return s
