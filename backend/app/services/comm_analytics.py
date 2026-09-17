"""Analytics + AI βοηθός σύνταξης (Φάση 4).

ΑΝΟΙΓΜΑΤΑ & ΚΛΙΚ: παρακολούθηση ανθρώπου. **Κλειστά εξ ορισμού**, ανοίγουν ανά φαρμακείο με
ρητή επιλογή (`tenants.comms_tracking`). Ο φαρμακοποιός βλέπει τι σημαίνει πριν το ανοίξει.
Όσο είναι κλειστά, δεν μπαίνει pixel και δεν ξαναγράφεται κανένας σύνδεσμος.

ATTRIBUTION: δύο διαδρομές, και οι δύο πραγματικές —
  1. **Κουπόνι** (ήδη υπήρχε): εξαργύρωση με τον κωδικό της καμπάνιας. Αδιαμφισβήτητο.
  2. **Επίσκεψη μετά**: εκτέλεση συνταγής εντός Ν ημερών από τη λήψη. Ενδεικτικό — και το λέμε
     ρητά «ήρθαν μετά», όχι «επειδή». Δεν ισχυριζόμαστε αιτιότητα που δεν μπορούμε να δείξουμε.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db

ATTRIBUTION_DAYS = 14


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


async def tracking_enabled(tenant_id: str) -> bool:
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"comms_tracking": 1})
    return bool((t or {}).get("comms_tracking"))


async def set_tracking(tenant_id: str, on: bool) -> dict:
    await shared_db()["tenants"].update_one(
        {"_id": tenant_id}, {"$set": {"comms_tracking": bool(on), "updated_at": _now()}})
    return {"ok": True, "enabled": bool(on)}


async def record_event(campaign_id: str, recipient_key: str, kind: str, meta: dict | None = None) -> None:
    """`opened` | `clicked` — καταγράφεται μία φορά ανά παραλήπτη ανά είδος."""
    if kind not in ("opened", "clicked"):
        return
    db = shared_db()
    cid = _oid(campaign_id)
    if not cid:
        return
    r = await db["comm_recipients"].find_one({"campaign_id": cid, "key": recipient_key},
                                             {"tenant_id": 1, f"{kind}_at": 1})
    if not r or r.get(f"{kind}_at"):
        return                                             # ήδη καταγεγραμμένο — δεν διπλομετράμε
    now = _now()
    await db["comm_recipients"].update_one({"_id": r["_id"]}, {"$set": {f"{kind}_at": now}})
    await db["comm_events"].insert_one({
        "tenant_id": r["tenant_id"], "campaign_id": cid, "key": recipient_key,
        "kind": kind, "at": now, **(meta or {})})


async def report(tenant_id: str, campaign_id: str) -> dict:
    """Τι απέδωσε μία καμπάνια. Δείχνει ΜΟΝΟ ό,τι μετρήθηκε πραγματικά."""
    db = shared_db()
    cid = _oid(campaign_id)
    c = await db["comms_campaigns"].find_one({"_id": cid, "tenant_id": tenant_id}) if cid else None
    if not c:
        return {"ok": False, "error": "not_found"}

    counts = {r["_id"]: r["n"] for r in await db["comm_recipients"].aggregate([
        {"$match": {"campaign_id": cid}},
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]).to_list(length=None)}
    opened = await db["comm_recipients"].count_documents({"campaign_id": cid, "opened_at": {"$ne": None}})
    clicked = await db["comm_recipients"].count_documents({"campaign_id": cid, "clicked_at": {"$ne": None}})
    sent = counts.get("sent", 0)

    # ── attribution 1: κουπόνι (βέβαιο) ──
    coupon = await db["campaign_coupons"].find_one({"tenant_id": tenant_id, "campaign_id": str(cid)})
    redeemed = int((coupon or {}).get("redemptions") or 0)
    redeemed_value = int((coupon or {}).get("redeemed_value_cents") or 0)

    # ── attribution 2: ήρθαν μετά (ενδεικτικό) ──
    start = c.get("created_at") or _now()
    refs = [r["patient_ref"] async for r in db["comm_recipients"].find(
        {"campaign_id": cid, "status": "sent"}, {"patient_ref": 1}) if r.get("patient_ref")]
    came = value = 0
    if refs:
        rows = await db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": tenant_id, "patient_ref": {"$in": [_oid(r) for r in refs]},
                        "executed_at": {"$gte": start, "$lte": start + timedelta(days=ATTRIBUTION_DAYS)}}},
            {"$group": {"_id": "$patient_ref", "v": {"$sum": "$amount_total"}}},
        ]).to_list(length=None)
        came = len(rows)
        value = sum(r["v"] for r in rows)

    return {
        "ok": True, "campaign_id": str(cid), "status": c.get("status"),
        "subject": c.get("subject"), "channel": c.get("channel"),
        "recipients": int(c.get("recipients") or 0), "sent": sent,
        "failed": counts.get("failed", 0), "skipped": counts.get("skipped", 0),
        "tracking": await tracking_enabled(tenant_id),
        "opened": opened, "clicked": clicked,
        "coupon": {"code": (coupon or {}).get("code"), "redemptions": redeemed,
                   "value_cents": redeemed_value} if coupon else None,
        "came_after": {"days": ATTRIBUTION_DAYS, "people": came, "value_cents": value},
        "unsubscribed": await db["comm_events"].count_documents(
            {"campaign_id": cid, "kind": "unsubscribed"}),
    }


async def overview(tenant_id: str, days: int = 30) -> dict:
    """Η μία πρόταση της επισκόπησης: σε πόσους μίλησες και πόσοι γύρισαν."""
    db = shared_db()
    since = _now() - timedelta(days=days)
    cs = [c async for c in db["comms_campaigns"].find(
        {"tenant_id": tenant_id, "created_at": {"$gte": since}},
        {"sent": 1, "recipients": 1, "status": 1, "created_at": 1})]
    sent = sum(int(c.get("sent") or 0) for c in cs)
    refs = {r["patient_ref"] async for r in db["comm_recipients"].find(
        {"tenant_id": tenant_id, "status": "sent", "sent_at": {"$gte": since}},
        {"patient_ref": 1}) if r.get("patient_ref")}
    came = 0
    if refs:
        came = len(await db["prescription_executions"].distinct(
            "patient_ref", {"tenant_id": tenant_id, "patient_ref": {"$in": [_oid(r) for r in refs]},
                            "executed_at": {"$gte": since}}))
    return {"days": days, "campaigns": len(cs), "messages": sent,
            "people": len(refs), "came_after": came,
            "live": sum(1 for c in cs if c.get("status") in ("queued", "sending")),
            "scheduled": await db["comms_campaigns"].count_documents(
                {"tenant_id": tenant_id, "status": "queued", "scheduled_at": {"$ne": None}})}


# ── AI βοηθός σύνταξης — ΠΟΤΕ δεν στέλνει ───────────────────────────────────────────────────
_SYSTEM = """Γράφεις μηνύματα φαρμακείου προς πελάτες, στα ελληνικά.

ΚΑΝΟΝΕΣ:
- Μίλα στον ενικό, ζεστά και σύντομα. Ο παραλήπτης είναι άνθρωπος, όχι «καταναλωτής».
- ΠΟΤΕ ιατρική συμβουλή, διάγνωση ή αναφορά σε πάθηση/φάρμακο του παραλήπτη.
- ΠΟΤΕ πίεση («τρέξτε», «μην το χάσετε», «τελευταία ευκαιρία»).
- Μπορείς να χρησιμοποιήσεις {first} για το μικρό όνομα και {coupon} για κωδικό έκπτωσης.
- SMS: έως 300 χαρακτήρες, χωρίς θέμα. Email: σύντομο θέμα + 3-5 μικρές παραγράφους.
- Τελείωσε με κάτι συγκεκριμένο που μπορεί να κάνει ο άνθρωπος, όχι με σύνθημα.

Επίστρεψε ΜΟΝΟ JSON: {"subject": "...", "message": "..."}"""


async def draft(tenant_id: str, *, brief: str, channel: str, audience_label: str = "") -> dict:
    """Πρόχειρο μήνυμα από περιγραφή. Ο φαρμακοποιός το διαβάζει, το αλλάζει, το εγκρίνει.

    Το αποτέλεσμα ΔΕΝ στέλνεται ποτέ αυτόματα (§25): επιστρέφεται στη φόρμα ως προσχέδιο.
    """
    import json
    try:
        from app.services import ai_cost, ai_quota, pharmacat_service
        c = await pharmacat_service._config()              # noqa: SLF001
        if not c.get("api_key") or not c.get("enabled"):
            return {"ok": False, "error": "ai_off"}
        allowed, *_ = await ai_quota.check_and_consume(tenant_id, source="campaign")
        if not allowed:
            return {"ok": False, "error": "quota"}
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=c["api_key"])
        ph = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"name": 1})
        resp = await client.messages.create(
            model=c["model"], max_tokens=700, system=_SYSTEM,
            messages=[{"role": "user", "content":
                       f"Φαρμακείο: {(ph or {}).get('name') or ''}\n"
                       f"Κανάλι: {channel}\nΣε ποιους: {audience_label or 'πελάτες του φαρμακείου'}\n"
                       f"Τι θέλω να πω: {brief}"}])
        await ai_cost.record(tenant_id, c["model"], getattr(resp, "usage", None))
        txt = "".join(b.text for b in resp.content if b.type == "text").strip()
        txt = txt[txt.find("{"):txt.rfind("}") + 1] if "{" in txt else txt
        d = json.loads(txt)
        return {"ok": True, "subject": str(d.get("subject") or "")[:160],
                "message": str(d.get("message") or "")[:2000], "needs_review": True}
    except Exception as e:                                 # noqa: BLE001
        import logging
        logging.getLogger(__name__).warning("campaign draft failed: %s", e)
        return {"ok": False, "error": "failed"}
