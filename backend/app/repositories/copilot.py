"""RxVision Copilot repository — shared LLM plumbing with PharmaCat (cache + daily limit + audit),
separate persona/collection. Level 1: app-usage guide with deep links."""

from __future__ import annotations

from datetime import datetime, timezone

from app.repositories.base import BaseRepository, jsonsafe
from app.repositories.pharmacat import DAILY_LIMIT  # shared daily cap
from app.services import copilot_service


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


class CopilotRepository(BaseRepository):
    collection_name = "copilot_cases"

    async def _today_llm_count(self) -> int:
        day0 = _now().replace(hour=0, minute=0, second=0, microsecond=0)
        return await self._coll.count_documents(
            {"tenant_id": self.tenant_id, "source": "llm", "at": {"$gte": day0}})

    async def chat(self, user: str, perms: set[str], messages: list[dict]) -> dict:
        # No caching: answers can carry live tenant data / action proposals → must be fresh.
        if await self._today_llm_count() >= DAILY_LIMIT:
            return {"ok": False, "error": "daily_limit", "limit": DAILY_LIMIT}
        res = await copilot_service.ask(tenant_id=self.tenant_id, perms=perms, messages=messages)
        if res.get("ok"):
            await self._record(user, messages, source="llm")
        return jsonsafe(res)

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
        s["today_used"] = await self._today_llm_count()
        s["daily_limit"] = DAILY_LIMIT
        return s
