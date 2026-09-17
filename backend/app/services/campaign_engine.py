"""Campaign Engine — η αποστολή ΔΕΝ γίνεται ποτέ μέσα στο HTTP request.

ΤΟ ΠΡΟΒΛΗΜΑ ΠΟΥ ΛΥΝΕΙ (R-1): η παλιά `/send` έτρεχε βρόχο έως 2.000 παραληπτών με κλήση δικτύου
στον καθένα, μέσα στο αίτημα. Επέστρεφε 202 χωρίς να είναι ασύγχρονη. Αποτέλεσμα: χρονικά όρια,
μισοτελειωμένες αποστολές, καμία επανάληψη, και —το χειρότερο— **refresh ή διπλό κλικ σήμαινε
διπλή αποστολή και διπλή χρέωση**.

Η ΛΟΓΙΚΗ ΕΔΩ:
  1. Ο φαρμακοποιός πατά «στείλε» → υλοποιείται ΜΙΑ γραμμή καμπάνιας + ΜΙΑ γραμμή ανά παραλήπτη
     (`comm_recipients`) σε κατάσταση `pending`. Καμία αποστολή ακόμη. Επιστρέφει αμέσως.
  2. Ένα Celery task στέλνει σε παρτίδες. Κάθε παραλήπτης έχει **μοναδικό κλειδί**
     (campaign_id + patient_ref) με unique index → ακόμη κι αν το task ξανατρέξει, κανείς δεν
     λαμβάνει δεύτερη φορά και κανείς δεν χρεώνεται δεύτερη φορά.
  3. Αποτυχία παρόχου → `attempts += 1` και ξαναδοκιμάζει, μέχρι MAX_ATTEMPTS. Δεν χάνεται σιωπηλά.
  4. Τελείωσαν τα credits → η καμπάνια ΠΑΓΩΝΕΙ (`paused_no_credits`), δεν πεθαίνει. Συνεχίζει
     από εκεί που έμεινε μόλις ανανεωθεί το πορτοφόλι.

ΔΕΝ αντικαθιστά τη `comms.py` — τη χρησιμοποιεί. Όλη η αποστολή, η χρέωση και οι έλεγχοι
συγκατάθεσης μένουν εκεί που ήταν.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db

# Καταστάσεις καμπάνιας. Το UI δεν βλέπει ποτέ άλλη τιμή.
DRAFT, QUEUED, SENDING, PAUSED, COMPLETED, CANCELLED, FAILED = (
    "draft", "queued", "sending", "paused", "completed", "cancelled", "failed")
LIVE_STATES = (QUEUED, SENDING, PAUSED)

_PORTAL_BASE = "https://my.rxvision.gr"
_API_BASE = "https://api.rxvision.gr/api/v1"

BATCH = 50              # παραλήπτες ανά πέρασμα — κρατά το task κάτω από τα χρονικά όρια
MAX_ATTEMPTS = 3        # μετά από τόσες αποτυχίες, ο παραλήπτης σημειώνεται ως failed


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


# ── δημιουργία ──────────────────────────────────────────────────────────────────────────────
async def create(tenant_id: str, *, channel: str, message: str, subject: str | None,
                 segment: str, value: str | None, by: str | None,
                 purpose: str = "commercial", coupon_code: str | None = None,
                 scheduled_at: datetime | None = None, source: str = "campaign",
                 audience_rules: dict | None = None, audience_name: str | None = None) -> dict:
    """Υλοποιεί την καμπάνια και ΚΛΕΙΔΩΝΕΙ τους παραλήπτες τώρα.

    Γιατί κλειδώνονται τώρα και δεν υπολογίζονται τη στιγμή της αποστολής: ο φαρμακοποιός είδε
    «1.102 άνθρωποι» στην οθόνη έγκρισης. Αν το κοινό ξαναϋπολογιζόταν αργότερα, θα έστελνε σε
    διαφορετικό σύνολο από αυτό που ενέκρινε.
    """
    from app.services import comms
    db = shared_db()
    only = None
    if audience_rules:
        from app.services import audience as aud
        only = await aud.resolve(tenant_id, audience_rules, purpose=purpose)
    rows = await comms.campaign_audience(tenant_id, channel, segment, value, only_ids=only) \
        if channel != "push" else await comms.push_audience(tenant_id, segment, value)
    if only is not None and channel == "push":
        rows = [r for r in rows if r.get("patient_id") in only]

    cid = ObjectId()
    field = "email" if channel == "email" else "mobile"
    now = _now()
    await db["comms_campaigns"].insert_one({
        "_id": cid, "tenant_id": tenant_id, "channel": channel, "subject": subject,
        "message": message, "segment": segment, "segment_value": value,
        "purpose": purpose, "coupon_code": coupon_code, "source": source,
        "audience_rules": audience_rules, "audience_name": audience_name,
        "status": QUEUED if not scheduled_at else QUEUED,
        "scheduled_at": scheduled_at,
        "recipients": len(rows), "sent": 0, "failed": 0, "skipped": 0,
        "by": by, "created_at": now, "updated_at": now,
    })
    if rows:
        docs = []
        for r in rows:
            pref = r.get("patient_id")
            docs.append({
                "tenant_id": tenant_id, "campaign_id": cid,
                # ΚΛΕΙΔΙ ΙΔΙΟΠΑΘΕΙΑΣ: ένας παραλήπτης, μία φορά, ό,τι κι αν συμβεί.
                "key": f"{cid}|{pref}",
                "patient_ref": pref, "to": r.get(field) or r.get("account_id"),
                "name": r.get("name"), "status": "pending", "attempts": 0,
                "created_at": now,
            })
        # ordered=False: αν κάποιο κλειδί υπάρχει ήδη (επανάληψη), τα υπόλοιπα γράφονται κανονικά.
        try:
            await db["comm_recipients"].insert_many(docs, ordered=False)
        except Exception:                                  # noqa: BLE001 — duplicate keys μόνο
            pass
    return {"campaign_id": str(cid), "recipients": len(rows), "status": QUEUED}


# ── αποστολή (τρέχει ΜΟΝΟ από Celery) ───────────────────────────────────────────────────────
async def dispatch(campaign_id: str, *, limit: int = BATCH) -> dict:
    """Στέλνει ΜΙΑ παρτίδα. Επιστρέφει αν μένουν κι άλλοι, ώστε ο worker να ξαναπρογραμματίσει."""
    from app.services import comms, message_wallet
    db = shared_db()
    cid = _oid(campaign_id)
    c = await db["comms_campaigns"].find_one({"_id": cid}) if cid else None
    if not c:
        return {"ok": False, "error": "not_found"}
    if c.get("status") in (CANCELLED, COMPLETED):
        return {"ok": True, "done": True, "status": c["status"]}

    tenant_id = c["tenant_id"]
    ph = await comms._pharmacy(tenant_id)                  # noqa: SLF001 — ίδιο package
    channel, source = c["channel"], c.get("source") or "campaign"
    await db["comms_campaigns"].update_one(
        {"_id": cid}, {"$set": {"status": SENDING, "updated_at": _now()}})

    from app.services import comm_analytics
    track = await comm_analytics.tracking_enabled(tenant_id)

    batch = [r async for r in db["comm_recipients"].find(
        {"campaign_id": cid, "status": "pending", "attempts": {"$lt": MAX_ATTEMPTS}}).limit(limit)]
    if not batch:
        return await _finish(cid)

    sent = failed = 0
    for r in batch:
        to = r.get("to")
        if not to:
            await db["comm_recipients"].update_one(
                {"_id": r["_id"]}, {"$set": {"status": "skipped", "reason": "no_contact"}})
            continue
        # ΚΛΕΙΔΩΜΑ ΠΡΙΝ την αποστολή: αν το task πεθάνει στη μέση, ο παραλήπτης δεν ξαναπιάνεται
        # από άλλο πέρασμα ως «pending» — μένει «sending» και τον πιάνει ο reaper.
        claimed = await db["comm_recipients"].find_one_and_update(
            {"_id": r["_id"], "status": "pending"},
            {"$set": {"status": "sending", "claimed_at": _now()}, "$inc": {"attempts": 1}})
        if not claimed:
            continue                                       # το πήρε άλλο πέρασμα
        text = _personalise(c.get("message") or "", r, c.get("coupon_code"))
        try:
            if channel == "email":
                # Υποχρεωτικό υποσέλιδο διαγραφής σε κάθε ΠΡΟΩΘΗΤΙΚΟ email. Στη φροντίδα
                # (purpose="care") δεν μπαίνει: δεν είναι διαφημιστικό μήνυμα.
                from app.services import unsubscribe as _unsub
                html = comms._campaign_email_html(text, ph.get("name"))            # noqa: SLF001
                if c.get("purpose", "commercial") != "care" and r.get("patient_ref"):
                    html += _unsub.footer_html(tenant_id, r["patient_ref"], _PORTAL_BASE)
                # Pixel ανοίγματος ΜΟΝΟ αν το φαρμακείο έχει ανοίξει ρητά τη μέτρηση.
                if track:
                    html += (f'<img src="{_API_BASE}/communications/o/{cid}/'
                             f'{r["key"]}.gif" width="1" height="1" alt="" style="display:none">')
                await comms.send_email(tenant_id, to, c.get("subject") or "Ενημέρωση φαρμακείου",
                                       html,
                                       patient_ref=str(r.get("patient_ref") or "") or None,
                                       campaign_id=str(cid), kind=source)
            elif channel == "viber":
                await comms.send_viber(tenant_id, to, text,
                                       patient_ref=str(r.get("patient_ref") or "") or None,
                                       campaign_id=str(cid), kind=source)
            elif channel == "push":
                from app.services import push_service
                await push_service.send_to_account(to, title=c.get("subject") or ph.get("name") or "",
                                                   body=text, url="/portal")
            else:
                await comms.send_sms(tenant_id, to, text,
                                     patient_ref=str(r.get("patient_ref") or "") or None,
                                     campaign_id=str(cid), kind=source)
            await db["comm_recipients"].update_one(
                {"_id": r["_id"]}, {"$set": {"status": "sent", "sent_at": _now()}})
            sent += 1
        except message_wallet.InsufficientCredits:
            # ΠΑΓΩΝΕΙ, δεν πεθαίνει: ο παραλήπτης γυρίζει σε pending για να σταλεί μετά την ανανέωση.
            await db["comm_recipients"].update_one(
                {"_id": r["_id"]}, {"$set": {"status": "pending"}, "$inc": {"attempts": -1}})
            await db["comms_campaigns"].update_one({"_id": cid}, {"$set": {
                "status": PAUSED, "paused_reason": "no_credits", "updated_at": _now()}})
            await _bump(cid, sent, failed)
            return {"ok": True, "paused": "no_credits", "sent": sent}
        except Exception as e:                             # noqa: BLE001
            over = int(claimed.get("attempts", 0)) + 1 >= MAX_ATTEMPTS
            await db["comm_recipients"].update_one({"_id": r["_id"]}, {"$set": {
                "status": "failed" if over else "pending",
                "last_error": str(e)[:200], "failed_at": _now() if over else None}})
            if over:
                failed += 1

    await _bump(cid, sent, failed)
    left = await db["comm_recipients"].count_documents(
        {"campaign_id": cid, "status": {"$in": ["pending", "sending"]}, "attempts": {"$lt": MAX_ATTEMPTS}})
    if left:
        return {"ok": True, "more": True, "sent": sent, "left": left}
    return await _finish(cid)


def _personalise(message: str, r: dict, coupon: str | None) -> str:
    """Μεταβλητές με ΕΦΕΔΡΙΚΗ τιμή — ο παραλήπτης δεν βλέπει ποτέ `{name}` σκέτο."""
    name = (r.get("name") or "").strip()
    first = name.split(" ")[-1] if name else ""
    return (message
            .replace("{name}", name)
            .replace("{first}", first)
            .replace("{coupon}", coupon or ""))


async def _bump(cid, sent: int, failed: int) -> None:
    if sent or failed:
        await shared_db()["comms_campaigns"].update_one(
            {"_id": cid}, {"$inc": {"sent": sent, "failed": failed},
                           "$set": {"updated_at": _now()}})


async def _finish(cid) -> dict:
    db = shared_db()
    skipped = await db["comm_recipients"].count_documents({"campaign_id": cid, "status": "skipped"})
    await db["comms_campaigns"].update_one({"_id": cid}, {"$set": {
        "status": COMPLETED, "skipped": skipped, "finished_at": _now(), "updated_at": _now()}})
    c = await db["comms_campaigns"].find_one({"_id": cid}, {"sent": 1, "failed": 1})
    return {"ok": True, "done": True, "sent": (c or {}).get("sent", 0), "failed": (c or {}).get("failed", 0)}


# ── έλεγχος από τον φαρμακοποιό ─────────────────────────────────────────────────────────────
async def set_status(tenant_id: str, campaign_id: str, action: str) -> dict:
    """pause | resume | cancel — πάντα tenant-scoped."""
    db = shared_db()
    cid = _oid(campaign_id)
    c = await db["comms_campaigns"].find_one({"_id": cid, "tenant_id": tenant_id}) if cid else None
    if not c:
        return {"ok": False, "error": "not_found"}
    if action == "pause" and c.get("status") in (QUEUED, SENDING):
        await db["comms_campaigns"].update_one({"_id": cid}, {"$set": {
            "status": PAUSED, "paused_reason": "manual", "updated_at": _now()}})
    elif action == "resume" and c.get("status") == PAUSED:
        await db["comms_campaigns"].update_one({"_id": cid}, {"$set": {
            "status": QUEUED, "paused_reason": None, "updated_at": _now()}})
        from app.workers.comms import dispatch_campaign
        dispatch_campaign.delay(str(cid))
    elif action == "cancel" and c.get("status") in LIVE_STATES:
        await db["comms_campaigns"].update_one({"_id": cid}, {"$set": {
            "status": CANCELLED, "updated_at": _now()}})
        # Όσοι δεν έχουν λάβει ακόμη, ΔΕΝ θα λάβουν. Όσοι έλαβαν, δεν αναιρούνται.
        await db["comm_recipients"].update_many(
            {"campaign_id": cid, "status": {"$in": ["pending", "sending"]}},
            {"$set": {"status": "cancelled"}})
    else:
        return {"ok": False, "error": "bad_transition", "status": c.get("status")}
    return {"ok": True, "status": (await db["comms_campaigns"].find_one({"_id": cid}))["status"]}


async def progress(tenant_id: str, campaign_id: str) -> dict:
    """Ζωντανή πρόοδος — «340 από 1.102», ώστε ο φαρμακοποιός να μη μένει να κοιτάζει το κενό."""
    db = shared_db()
    cid = _oid(campaign_id)
    c = await db["comms_campaigns"].find_one({"_id": cid, "tenant_id": tenant_id}) if cid else None
    if not c:
        return {"ok": False, "error": "not_found"}
    counts = {r["_id"]: r["n"] for r in await db["comm_recipients"].aggregate([
        {"$match": {"campaign_id": cid}},
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]).to_list(length=None)}
    return {"ok": True, "campaign_id": str(cid), "status": c.get("status"),
            "paused_reason": c.get("paused_reason"),
            "recipients": int(c.get("recipients") or 0),
            "sent": counts.get("sent", 0), "failed": counts.get("failed", 0),
            "pending": counts.get("pending", 0) + counts.get("sending", 0),
            "skipped": counts.get("skipped", 0), "cancelled": counts.get("cancelled", 0)}
