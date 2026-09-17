"""Αποστολή καμπανιών στο παρασκήνιο.

Κάθε πέρασμα στέλνει ΜΙΑ παρτίδα και ξαναπρογραμματίζει τον εαυτό του αν μένουν κι άλλοι. Έτσι
ένα task δεν κρατά ποτέ θέση worker για ώρα (incident 2026-09-05: κολλημένα tasks → νεκρός
worker → σταμάτησε όλη η ουρά).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.workers.celery_app import celery_app
from app.workers.ingestion import _fresh_db, _run_async


@celery_app.task(name="app.workers.comms.dispatch_campaign", bind=True, max_retries=5)
def dispatch_campaign(self, campaign_id: str) -> dict:
    """Στέλνει μία παρτίδα· αν μένουν κι άλλοι, ξαναμπαίνει στην ουρά."""
    async def _run() -> dict:
        from app.services.campaign_engine import dispatch
        client, _ = _fresh_db()
        try:
            return await dispatch(campaign_id)
        finally:
            client.close()

    res = _run_async(_run())
    if res.get("more"):
        # 2 δευτερόλεπτα ανάσα: σέβεται τα όρια ρυθμού του παρόχου και αφήνει τον worker ελεύθερο.
        dispatch_campaign.apply_async((campaign_id,), countdown=2)
    return res


@celery_app.task(name="app.workers.comms.sweep_campaigns")
def sweep_campaigns() -> dict:
    """Δίχτυ ασφαλείας, κάθε 5΄:

    1. Καμπάνιες σε `queued` που δεν ξεκίνησαν ποτέ (π.χ. χάθηκε το μήνυμα στην ουρά).
    2. Παραλήπτες κολλημένοι σε `sending` πάνω από 10΄ (το task πέθανε στη μέση) → πίσω σε
       `pending` για να ξαναδοκιμαστούν. ΧΩΡΙΣ αυτό, μένουν για πάντα σε λίμπο.
    3. Καμπάνιες προγραμματισμένες για τώρα.
    4. Παγωμένες από έλλειψη υπολοίπου που ξαναγέμισαν → συνεχίζουν μόνες τους.
    """
    async def _run() -> dict:
        from app.services import message_wallet
        from app.services.campaign_engine import PAUSED, QUEUED, SENDING
        client, db = _fresh_db()
        now = datetime.now(tz=timezone.utc)
        started = revived = resumed = 0
        try:
            # 2. κολλημένοι παραλήπτες
            r = await db["comm_recipients"].update_many(
                {"status": "sending", "claimed_at": {"$lt": now - timedelta(minutes=10)}},
                {"$set": {"status": "pending"}})
            revived = r.modified_count

            # 1 + 3. queued (και όσες έφτασε η ώρα τους)
            async for c in db["comms_campaigns"].find(
                    {"status": QUEUED,
                     "$or": [{"scheduled_at": None}, {"scheduled_at": {"$lte": now}}]},
                    {"_id": 1}).limit(50):
                dispatch_campaign.delay(str(c["_id"]))
                started += 1

            # 4. παγωμένες από credits — ξεπάγωμα ΜΟΝΟ αν υπάρχει πλέον υπόλοιπο
            async for c in db["comms_campaigns"].find(
                    {"status": PAUSED, "paused_reason": "no_credits"}, {"_id": 1, "tenant_id": 1}):
                if await message_wallet.balance(c["tenant_id"]) > 0:
                    await db["comms_campaigns"].update_one(
                        {"_id": c["_id"]}, {"$set": {"status": QUEUED, "paused_reason": None}})
                    dispatch_campaign.delay(str(c["_id"]))
                    resumed += 1

            # κολλημένες σε SENDING χωρίς εκκρεμείς παραλήπτες → κλείσ' τες
            async for c in db["comms_campaigns"].find(
                    {"status": SENDING, "updated_at": {"$lt": now - timedelta(minutes=15)}},
                    {"_id": 1}).limit(20):
                dispatch_campaign.delay(str(c["_id"]))
        finally:
            client.close()
        return {"started": started, "revived_recipients": revived, "resumed_no_credits": resumed}

    return _run_async(_run())
