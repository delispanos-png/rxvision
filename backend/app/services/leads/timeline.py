"""Χρονολόγιο lead — μία γραμμή για όλες τις πηγές.

Δεν υπάρχει event bus στο RxVision και δεν φτιάχνουμε έναν για 12 φαρμακεία. Αυτή η
συνάρτηση είναι το ίδιο ΣΥΜΒΟΛΑΙΟ με ένα bus (σταθερά ονόματα γεγονότων, φορτίο, χρονική
σειρά) χωρίς την υποδομή. Αν αύριο μπει bus, οι καλούντες δεν αλλάζουν.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db

COLL = "lead_events"

# Κλειστή λίστα. Ένα γεγονός που δεν είναι εδώ δεν γράφεται — αλλιώς σε έναν χρόνο το
# χρονολόγιο γεμίζει ορθογραφικές παραλλαγές του ίδιου πράγματος και κανένα φίλτρο δεν πιάνει.
KINDS = {
    "trial.started", "trial.expiring", "trial.expired", "trial.purged",
    "lead.created", "lead.status_changed", "lead.activity", "lead.returned",
    "lead.note", "lead.task_created", "lead.task_done", "lead.tagged", "lead.assigned",
    "email.sent", "email.opened", "email.clicked",
    "offer.sent", "offer.opened", "offer.redeemed",
    "lead.converted", "lead.lost", "lead.unsubscribed", "lead.suppressed",
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def record(lead_key: str, kind: str, title: str, *, by: str | None = None,
                 data: dict | None = None, ref: dict | None = None,
                 at: datetime | None = None, dedupe: bool = False) -> bool:
    """Γράψε γεγονός. Επιστρέφει False αν αγνοήθηκε.

    `dedupe=True` → δεν ξαναγράφει το ΙΔΙΟ είδος για τον ίδιο lead την ίδια ημέρα. Το
    χρειάζεται η ωριαία προβολή: τρέχει 24 φορές την ημέρα και δεν πρέπει να γεμίσει το
    χρονολόγιο με 24 πανομοιότυπες γραμμές «δραστηριότητα».
    """
    if kind not in KINDS:
        return False
    when = at or _now()
    db = shared_db()
    if dedupe:
        start = when.replace(hour=0, minute=0, second=0, microsecond=0)
        if await db[COLL].count_documents(
                {"lead_key": lead_key, "kind": kind, "at": {"$gte": start}}, limit=1):
            return False
    await db[COLL].insert_one({
        "lead_key": lead_key, "kind": kind, "title": title, "at": when,
        "by": by or "system", "data": data or {}, "ref": ref or {},
    })
    return True


async def for_lead(lead_key: str, *, limit: int = 300) -> list[dict]:
    rows = [r async for r in shared_db()[COLL].find({"lead_key": lead_key})
            .sort("at", -1).limit(limit)]
    for r in rows:
        r["_id"] = str(r["_id"])
    return rows


async def purge_for(lead_key: str) -> int:
    """Διαγραφή χρονολογίου — μόνο όταν διαγράφεται ο ίδιος ο lead (αίτημα διαγραφής)."""
    res = await shared_db()[COLL].delete_many({"lead_key": lead_key})
    return res.deleted_count
