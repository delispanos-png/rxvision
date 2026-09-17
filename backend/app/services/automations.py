"""Automation Engine — μηνύματα που φεύγουν χωρίς να τα θυμηθεί κανείς.

`Trigger → Conditions → Delay → Action`. Ένα πέρασμα την ημέρα βρίσκει ποιοι ταιριάζουν και
στέλνει ΑΤΟΜΙΚΑ (όχι μαζική καμπάνια): ένας άνθρωπος, ένα μήνυμα, τη στιγμή που τον αφορά.

ΤΡΕΙΣ ΔΙΚΛΕΙΔΕΣ ώστε να μη γίνει μηχανή spam (§34):
 1. **Μία φορά ανά άνθρωπο ανά αυτοματισμό** — `comm_automation_runs` με unique key. Κάποιος που
    έμεινε ανενεργός 90 μέρες δεν παίρνει το ίδιο μήνυμα κάθε μέρα επ' άπειρον.
 2. **Το όριο συχνότητας ισχύει κανονικά** — οι αυτοματισμοί περνούν από τους ίδιους ελέγχους
    συγκατάθεσης με τις χειροκίνητες καμπάνιες.
 3. **Ημερήσιο πλαφόν ανά αυτοματισμό** — αν κάτι πάει στραβά στους κανόνες, δεν ξυπνά ένα πρωί
    το φαρμακείο έχοντας στείλει 3.000 μηνύματα.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db

DAILY_CAP = 200          # μέγιστα μηνύματα ανά αυτοματισμό ανά ημέρα — δικλείδα, όχι ρύθμιση

# Τι μπορεί να πυροδοτήσει έναν αυτοματισμό. Κάθε trigger λύνεται σε σύνολο ασθενών.
TRIGGERS: dict[str, dict] = {
    "inactive_days": {
        "label": "Δεν έχει έρθει Ν ημέρες", "param": "days", "default": 90,
        "help": "Στέλνεται μία φορά, όταν συμπληρωθούν οι μέρες."},
    "loyalty_points_over": {
        "label": "Μάζεψε πάνω από Ν πόντους", "param": "points", "default": 500,
        "help": "Για να μη μένουν πόντοι αξεργάριστοι στο συρτάρι."},
    "portal_joined": {
        "label": "Μπήκε στην εφαρμογή του φαρμακείου", "param": "days", "default": 1,
        "help": "Καλωσόρισμα την επόμενη μέρα."},
    "first_visit": {
        "label": "Ήρθε για πρώτη φορά", "param": "days", "default": 7,
        "help": "Μία εβδομάδα μετά την πρώτη επίσκεψη."},
    "order_ready": {
        "label": "Η παραγγελία του είναι έτοιμη", "param": "hours", "default": 2,
        "help": "Λειτουργικό μήνυμα — δεν χρειάζεται εμπορική συγκατάθεση."},
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


async def save(tenant_id: str, data: dict, *, automation_id: str | None = None,
               by: str | None = None) -> dict:
    db = shared_db()
    trig = data.get("trigger")
    if trig not in TRIGGERS:
        return {"ok": False, "error": "bad_trigger"}
    doc = {
        "tenant_id": tenant_id,
        "name": (data.get("name") or TRIGGERS[trig]["label"]).strip()[:80],
        "trigger": trig,
        "param": int(data.get("param") or TRIGGERS[trig]["default"]),
        "channel": data.get("channel") or "email",
        "subject": (data.get("subject") or "").strip()[:160] or None,
        "message": (data.get("message") or "").strip()[:2000],
        "purpose": "care" if trig == "order_ready" else (data.get("purpose") or "commercial"),
        "active": bool(data.get("active", False)),
        "updated_at": _now(), "updated_by": by,
    }
    if not doc["message"]:
        return {"ok": False, "error": "message_required"}
    oid = _oid(automation_id) if automation_id else None
    if oid:
        await db["comm_automations"].update_one({"_id": oid, "tenant_id": tenant_id}, {"$set": doc})
    else:
        doc.update({"created_at": _now(), "created_by": by, "sent_total": 0})
        oid = (await db["comm_automations"].insert_one(doc)).inserted_id
    return {"ok": True, "automation_id": str(oid)}


async def listing(tenant_id: str) -> list[dict]:
    out = []
    async for a in shared_db()["comm_automations"].find({"tenant_id": tenant_id}).sort("created_at", -1):
        out.append({**a, "_id": str(a["_id"]),
                    "trigger_label": TRIGGERS.get(a.get("trigger"), {}).get("label")})
    return out


async def delete(tenant_id: str, automation_id: str) -> dict:
    oid = _oid(automation_id)
    if not oid:
        return {"ok": False, "error": "bad_id"}
    await shared_db()["comm_automations"].delete_one({"_id": oid, "tenant_id": tenant_id})
    return {"ok": True}


# ── εκτέλεση ────────────────────────────────────────────────────────────────────────────────
async def _candidates(tenant_id: str, a: dict) -> set:
    """Ποιοι ταιριάζουν ΣΗΜΕΡΑ στον trigger. Ξαναχρησιμοποιεί τον Audience Engine."""
    from app.services import audience as aud
    trig, param = a.get("trigger"), int(a.get("param") or 0)
    db = shared_db()
    if trig == "inactive_days":
        # ΑΚΡΙΒΩΣ στο κατώφλι (παράθυρο 1 ημέρας) — όχι «όλοι όσοι ξεπέρασαν», αλλιώς την πρώτη
        # μέρα λειτουργίας θα έφευγαν χιλιάδες μηνύματα μονομιάς.
        return await aud.resolve(tenant_id, {"match": "all", "conditions": [
            {"field": "days_since_visit", "op": "between", "value": [param, param + 1]}]})
    if trig == "loyalty_points_over":
        return await aud.resolve(tenant_id, {"match": "all", "conditions": [
            {"field": "loyalty_points", "op": "gte", "value": param}]})
    if trig == "first_visit":
        return await aud.resolve(tenant_id, {"match": "all", "conditions": [
            {"field": "rx_count", "op": "lte", "value": 1},
            {"field": "days_since_visit", "op": "between", "value": [param, param + 1]}]})
    if trig == "portal_joined":
        since = _now() - timedelta(days=param + 1)
        return {l["patient_ref"] async for l in db["patient_links"].find(
            {"tenant_id": tenant_id, "created_at": {"$gte": since}}, {"patient_ref": 1})}
    if trig == "order_ready":
        since = _now() - timedelta(hours=param + 24)
        return {_oid(o.get("patient_ref")) async for o in db["orders_delivery"].find(
            {"tenant_id": tenant_id, "status": "ready", "updated_at": {"$gte": since}},
            {"patient_ref": 1})} - {None}
    return set()


async def run_for_tenant(tenant_id: str) -> dict:
    """Ένα πέρασμα για ένα φαρμακείο. Καλείται από τον worker, μία φορά την ημέρα."""
    from app.services import comms
    db = shared_db()
    total = 0
    async for a in db["comm_automations"].find({"tenant_id": tenant_id, "active": True}):
        try:
            cand = await _candidates(tenant_id, a)
        except Exception:                                  # noqa: BLE001
            import logging
            logging.getLogger(__name__).exception("automation candidates failed: %s", a.get("_id"))
            continue
        if not cand:
            continue
        # Δικλείδα 1: όποιος έχει ήδη λάβει ΑΥΤΟΝ τον αυτοματισμό, δεν ξαναλαμβάνει.
        done = {r["patient_ref"] async for r in db["comm_automation_runs"].find(
            {"automation_id": a["_id"]}, {"patient_ref": 1})}
        fresh = list(cand - done)[:DAILY_CAP]              # δικλείδα 3
        if not fresh:
            continue
        # Δικλείδα 2: περνά από τους ΙΔΙΟΥΣ ελέγχους συγκατάθεσης με τις χειροκίνητες καμπάνιες.
        rows = await comms.campaign_audience(tenant_id, a["channel"], "all", None, only_ids=set(fresh))
        if not rows:
            continue
        from app.services import campaign_engine as ce
        res = await ce.create(
            tenant_id, channel=a["channel"], message=a["message"], subject=a.get("subject"),
            segment="all", value=None, purpose=a.get("purpose", "commercial"),
            by=f"automation:{a['_id']}", source="automation",
            audience_rules=None, audience_name=a.get("name"))
        # Καταγραφή ΠΡΙΝ την αποστολή: αν κάτι σκάσει, χειρότερο είναι να ξανασταλεί.
        await db["comm_automation_runs"].insert_many(
            [{"automation_id": a["_id"], "tenant_id": tenant_id, "patient_ref": r["patient_id"],
              "campaign_id": res["campaign_id"], "at": _now()} for r in rows], ordered=False)
        await db["comm_automations"].update_one(
            {"_id": a["_id"]}, {"$inc": {"sent_total": len(rows)},
                                "$set": {"last_run_at": _now()}})
        from app.workers.comms import dispatch_campaign
        dispatch_campaign.delay(res["campaign_id"])
        total += len(rows)
    return {"tenant_id": tenant_id, "queued": total}


async def calendar(tenant_id: str, days: int = 60) -> list[dict]:
    """Τι έφυγε και τι θα φύγει — ώστε να φαίνεται πότε ενοχλείς τον κόσμο (§26)."""
    db = shared_db()
    since = _now() - timedelta(days=days)
    out = []
    async for c in db["comms_campaigns"].find(
            {"tenant_id": tenant_id, "$or": [{"created_at": {"$gte": since}},
                                             {"scheduled_at": {"$ne": None}}]},
            {"subject": 1, "channel": 1, "status": 1, "recipients": 1, "sent": 1,
             "scheduled_at": 1, "created_at": 1, "source": 1, "audience_name": 1}).sort("created_at", -1).limit(200):
        out.append({"id": str(c["_id"]), "title": c.get("subject") or c.get("audience_name") or "—",
                    "channel": c.get("channel"), "status": c.get("status"),
                    "when": c.get("scheduled_at") or c.get("created_at"),
                    "scheduled": bool(c.get("scheduled_at")),
                    "automation": c.get("source") == "automation",
                    "recipients": c.get("recipients", 0), "sent": c.get("sent", 0)})
    return out
