"""Ποια φαρμακεία δικαιούνται συγχρονισμό ΗΔΥΚΑ — ΕΝΑ σημείο απόφασης.

ΤΟ ΠΡΟΒΛΗΜΑ: οκτώ διαφορετικά dispatch tasks έκαναν το ίδιο φίλτρο με αντιγραφή
(`tenants.status ∈ {active, trial}`). Αυτό όμως κοιτά τον ΛΟΓΑΡΙΑΣΜΟ, όχι τη ΣΥΝΔΡΟΜΗ: ένα
φαρμακείο με ληγμένη δοκιμαστική κρατά `tenants.status = "trial"` και συνέχιζε να
συγχρονίζεται κάθε 5 λεπτά επ' άπειρον. Στην παραγωγή (17/09/2026) αυτό ίσχυε για 5 από τα
12 φαρμακεία — χτυπούσαμε την ΗΔΥΚΑ και γεμίζαμε τη βάση για λογαριασμούς που δεν πληρώνουν.

ΓΙΑΤΙ Η ΕΠΑΝΕΚΚΙΝΗΣΗ ΕΙΝΑΙ ΑΣΦΑΛΗΣ: ο incremental sync δεν κρατά αποθηκευμένο δείκτη — τον
υπολογίζει από την ΤΕΛΕΥΤΑΙΑ εκτέλεση που έχουμε (`_watermark`). Άρα όταν ο πελάτης
επιστρέψει, ο συγχρονισμός συνεχίζει μόνος του από την ημέρα που σταμάτησε. Εμείς απλώς
προσθέτουμε ένα στοχευμένο backfill για το κενό, γιατί το ημερήσιο reconcile κοιτά μόνο 40
ημέρες πίσω και μια μεγάλη παύση δεν θα καλυπτόταν.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db

# Καταστάσεις συνδρομής που ΣΤΑΜΑΤΟΥΝ τον συγχρονισμό. Το `past_due` ΔΕΝ είναι εδώ: είναι
# περιθώριο πληρωμής — ο πελάτης δουλεύει κανονικά και δεν του κόβουμε τα δεδομένα.
STOP_STATES = {"expired", "cancelled", "none"}
FIELD = "ingestion_config.hdika.sync_stopped"

# Το κοινό φίλτρο που είχαν αντιγράψει όλα τα dispatchers.
BASE_FILTER: dict = {
    "country": "GR",
    "status": {"$in": ["active", "trial"]},
    "credentials_ref.hdika": {"$ne": None},
    "ingestion_config.hdika.sync_enabled": {"$ne": False},
    "ingestion_config.hdika.auth_paused": {"$ne": True},
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _should_stop(db, tenant_id: str) -> bool:
    from app.services.billing_service import effective_status
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id})
    return effective_status(sub) in STOP_STATES


async def eligible_tenant_ids(db, *, extra: dict | None = None,
                              country_gr: bool = True) -> list[str]:
    """Τα φαρμακεία που πρέπει να συγχρονιστούν ΤΩΡΑ.

    Παράλληλα κρατά ενήμερο το σημάδι παύσης/επανεκκίνησης, ώστε (α) να φαίνεται στο
    adminpanel γιατί δεν τρέχει ο συγχρονισμός και (β) να ξέρουμε το κενό που πρέπει να
    καλυφθεί όταν ο πελάτης γυρίσει.
    """
    flt = dict(BASE_FILTER)
    if not country_gr:
        flt.pop("country", None)
    if extra:
        flt.update(extra)

    out: list[str] = []
    async for t in db["tenants"].find(flt, {"_id": 1, "ingestion_config.hdika.sync_stopped": 1}):
        tid = str(t["_id"])
        stopped = (((t.get("ingestion_config") or {}).get("hdika") or {}).get("sync_stopped")) or None
        if await _should_stop(db, tid):
            if not stopped:
                await _mark_stopped(db, tid)
            continue
        if stopped:
            await resume(db, tid, stopped)
        out.append(tid)
    return out


async def _mark_stopped(db, tenant_id: str) -> None:
    """Σταμάτα και κράτα ΑΠΟ ΠΟΤΕ — το κενό που θα χρειαστεί να καλυφθεί αργότερα."""
    await db["tenants"].update_one({"_id": tenant_id}, {"$set": {FIELD: {
        "at": _now(), "reason": "subscription_expired",
    }}})
    await db["sync_events"].insert_one({
        "tenant_id": tenant_id, "kind": "sync_stopped", "reason": "subscription_expired",
        "at": _now()})


async def resume(db, tenant_id: str, stopped: dict) -> None:
    """Ο πελάτης γύρισε: καθάρισε το σημάδι και κάλυψε το κενό από τη μέρα που σταματήσαμε.

    ΔΕΝ γίνεται εδώ καμία παραδοχή για το μέγεθος του κενού: το backfill παίρνει ρητά
    «από τότε μέχρι σήμερα». Ένα φαρμακείο που έλειψε τρεις μήνες καλύπτεται όπως κι ένα που
    έλειψε τρεις μέρες.
    """
    await db["tenants"].update_one({"_id": tenant_id}, {"$unset": {FIELD: ""}})
    since = stopped.get("at")
    if not isinstance(since, datetime):
        since = _now() - timedelta(days=1)
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    # μια μέρα πίσω: η ΗΔΥΚΑ καταχωρεί με καθυστέρηση και δεν θέλουμε τρύπα στο όριο
    since = since - timedelta(days=1)
    await db["sync_events"].insert_one({
        "tenant_id": tenant_id, "kind": "sync_resumed", "at": _now(),
        "gap_from": since, "gap_days": max(0, (_now() - since).days)})
    try:
        from app.workers.ingestion import hdika_backfill
        hdika_backfill.delay(tenant_id, since.isoformat(), _now().isoformat())
    except Exception:                                    # noqa: BLE001 — η επανεκκίνηση δεν ρίχνει τον dispatcher
        import logging
        logging.getLogger(__name__).warning("resume backfill enqueue failed", exc_info=True)


async def status_for(tenant_id: str) -> dict:
    """Για το adminpanel: τρέχει ο συγχρονισμός; αν όχι, γιατί και από πότε."""
    db = shared_db()
    t = await db["tenants"].find_one({"_id": tenant_id},
                                     {"ingestion_config.hdika.sync_stopped": 1}) or {}
    stopped = (((t.get("ingestion_config") or {}).get("hdika") or {}).get("sync_stopped")) or None
    if not stopped:
        return {"syncing": True}
    return {"syncing": False, "reason": stopped.get("reason"), "since": stopped.get("at"),
            "label": "Σταμάτησε επειδή έληξε η συνδρομή — θα συνεχίσει μόλις ανανεωθεί"}
