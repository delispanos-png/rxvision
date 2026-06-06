"""sync_jobs repository — ingestion job records + stats (DATABASE.md §16)."""

from __future__ import annotations

from datetime import datetime, timezone

from app.repositories.base import BaseRepository


class SyncJobRepository(BaseRepository):
    collection_name = "sync_jobs"

    async def list_jobs(self, *, source: str | None, skip: int, limit: int) -> list[dict]:
        query: dict = {}
        if source:
            query["source"] = source
        return await self.find(query, sort=[("started_at", -1)], skip=skip, limit=limit)

    async def get(self, job_id) -> dict | None:
        return await self.find_one({"_id": job_id})

    async def create_queued(self, *, source: str, job_type: str) -> dict:
        """Create a queued job row; the Celery worker advances its status."""
        doc = {
            "source": source,
            "type": job_type,
            "status": "queued",
            "cursor": {},
            "stats": {"fetched": 0, "inserted": 0, "duplicates": 0, "invalid": 0},
            "attempts": 0,
            "error": None,
            "started_at": datetime.now(tz=timezone.utc),
            "finished_at": None,
        }
        job_id = await self.insert_one(doc)
        doc["_id"] = job_id
        return doc
