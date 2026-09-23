"""Ημερολόγιο αλλαγών καταλόγου ανά φαρμακείο — «τι μου άλλαξε χθες το βράδυ».

Περνά από BaseRepository ώστε το φίλτρο tenant να μπαίνει από την υποδομή: ένα ξεχασμένο
tenant_id εδώ θα έδειχνε στον έναν φαρμακοποιό τι προστέθηκε στον κατάλογο του άλλου.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.repositories.base import BaseRepository, jsonsafe

#: Πόσο κρατάμε το ημερολόγιο. Είναι ενημερωτικό, όχι λογιστικό — δεν υπάρχει λόγος να μεγαλώνει
#: για πάντα (η πρώτη φόρτωση μόνη της γράφει δεκάδες χιλιάδες γραμμές).
RETENTION_DAYS = 120

KINDS = ("added", "price", "renamed", "info")


class CatalogSyncEventRepository(BaseRepository):
    collection_name = "catalog_sync_events"

    async def runs(self, *, days: int = 90) -> list[dict]:
        """Μία γραμμή ανά νυχτερινή ενημέρωση, με πλήθη ανά είδος αλλαγής."""
        since = datetime.now(tz=timezone.utc) - timedelta(days=days)
        rows = await self.aggregate([
            {"$match": {"run_at": {"$gte": since}}},
            {"$group": {"_id": {"run": "$run_at", "kind": "$kind"}, "n": {"$sum": 1}}},
        ])
        by_run: dict = {}
        for r in rows:
            run = r["_id"]["run"]
            by_run.setdefault(run, {"run_at": run, **{k: 0 for k in KINDS}})
            by_run[run][r["_id"]["kind"]] = r["n"]
        return jsonsafe(sorted(by_run.values(), key=lambda x: x["run_at"], reverse=True))

    async def items(self, *, days: int = 30, kind: str | None = None,
                    limit: int = 300) -> list[dict]:
        since = datetime.now(tz=timezone.utc) - timedelta(days=days)
        q: dict = {"run_at": {"$gte": since}}
        if kind in KINDS:
            q["kind"] = kind
        rows = await self.find(q, sort=[("run_at", -1), ("name", 1)], limit=limit)
        for r in rows:
            r["_id"] = str(r["_id"])
        return jsonsafe(rows)

    async def purge_old(self) -> int:
        cut = datetime.now(tz=timezone.utc) - timedelta(days=RETENTION_DAYS)
        res = await self.delete_many({"run_at": {"$lt": cut}})
        return res.deleted_count
