"""Ενέργειες πωλήσεων πάνω σε ένα lead: κατάσταση, σημειώσεις, εργασίες, ετικέτες, ανάθεση.

Κάθε ενέργεια γράφει ΚΑΙ στο χρονολόγιο. Ο λόγος είναι πρακτικός: πριν σηκώσει τηλέφωνο, ο
πωλητής πρέπει να διαβάσει μία στήλη και να ξέρει τι προηγήθηκε — όχι να ανοίξει τέσσερις
καρτέλες.
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db
from app.services.leads import timeline
from app.services.leads.projection import COLL

NOTES, TASKS, HISTORY = "lead_notes", "lead_tasks", "lead_status_history"

STATUSES = {
    "new": "Δεν του έχουμε μιλήσει", "contacted": "Του μιλήσαμε",
    "engaged": "Ανταποκρίθηκε", "offer_sent": "Πήρε προσφορά",
    "negotiating": "Το συζητάμε", "won": "Έγινε πελάτης",
    "lost": "Δεν προχωράει", "do_not_contact": "Δεν θέλει επικοινωνία",
}
# «won» δεν δίνεται με το χέρι — το δίνει μόνο η πληρωμή (projection).
MANUAL_STATUSES = set(STATUSES) - {"won"}

NOTE_KINDS = {"call": "Τηλέφωνο", "meeting": "Συνάντηση", "demo": "Παρουσίαση",
              "objection": "Αντίρρηση", "note": "Σημείωση"}
TASK_ACTIONS = {"call": "Τηλέφωνο", "email": "Email", "demo": "Παρουσίαση",
                "offer": "Προσφορά", "followup": "Επαναφορά"}
TAGS = ["HOT_LEAD", "NEEDS_CALL", "PRICE_OBJECTION", "INTERESTED", "RETURNING",
        "DEMO_REQUESTED", "HIGH_VALUE", "REACTIVATION"]
TAG_LABEL = {"HOT_LEAD": "Καυτό", "NEEDS_CALL": "Θέλει τηλέφωνο",
             "PRICE_OBJECTION": "Θέμα τιμής", "INTERESTED": "Ενδιαφέρεται",
             "RETURNING": "Επέστρεψε", "DEMO_REQUESTED": "Ζήτησε παρουσίαση",
             "HIGH_VALUE": "Μεγάλο φαρμακείο", "REACTIVATION": "Επαναπροσέγγιση"}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


async def _lead(db, key: str) -> dict | None:
    return await db[COLL].find_one({"_id": key})


# ── κατάσταση ───────────────────────────────────────────────────────────────────────────────
async def set_status(key: str, status: str, *, by: str, reason: str | None = None) -> dict:
    if status not in MANUAL_STATUSES:
        return {"ok": False, "error": "bad_status"}
    if status == "lost" and not (reason or "").strip():
        # Χαμένο lead χωρίς λόγο δεν διδάσκει τίποτα. Ο λόγος είναι το προϊόν της απώλειας.
        return {"ok": False, "error": "reason_required"}
    db = shared_db()
    lead = await _lead(db, key)
    if not lead:
        return {"ok": False, "error": "not_found"}
    old = lead.get("status") or "new"
    if old == status:
        return {"ok": True, "unchanged": True}
    upd: dict = {"status": status, "status_reason": (reason or "").strip() or None,
                 "updated_at": _now()}
    if status == "do_not_contact":
        upd["suppressed"] = True
        upd["suppress_reason"] = "do_not_contact"
    await db[COLL].update_one({"_id": key}, {"$set": upd})
    await db[HISTORY].insert_one({"lead_key": key, "from": old, "to": status,
                                  "by": by, "at": _now(), "reason": reason})
    await timeline.record(key, "lead.status_changed",
                          f"{STATUSES[old]} → {STATUSES[status]}", by=by,
                          data={"from": old, "to": status, "reason": reason})
    if status == "do_not_contact":
        await timeline.record(key, "lead.suppressed", "Δεν θέλει επικοινωνία", by=by)
    elif status == "lost":
        await timeline.record(key, "lead.lost", f"Χάθηκε — {reason}", by=by)
    return {"ok": True, "status": status}


# ── ανάθεση & ετικέτες ──────────────────────────────────────────────────────────────────────
async def assign(key: str, admin_id: str | None, *, by: str) -> dict:
    db = shared_db()
    name = None
    if admin_id:
        a = await db["platform_admins"].find_one({"_id": _oid(admin_id)}, {"email": 1, "name": 1})
        if not a:
            return {"ok": False, "error": "unknown_admin"}
        name = a.get("name") or a.get("email")
    r = await db[COLL].update_one({"_id": key}, {"$set": {
        "assigned_to": admin_id, "assigned_name": name, "updated_at": _now()}})
    if not r.matched_count:
        return {"ok": False, "error": "not_found"}
    await timeline.record(key, "lead.assigned",
                          f"Ανατέθηκε στον/στην {name}" if name else "Αφαιρέθηκε η ανάθεση",
                          by=by)
    return {"ok": True, "assigned_to": admin_id, "assigned_name": name}


async def set_tags(key: str, tags: list[str], *, by: str) -> dict:
    clean = [t for t in dict.fromkeys(tags or []) if t in TAGS]
    db = shared_db()
    lead = await _lead(db, key)
    if not lead:
        return {"ok": False, "error": "not_found"}
    before = set(lead.get("tags") or [])
    await db[COLL].update_one({"_id": key}, {"$set": {"tags": clean, "updated_at": _now()}})
    added = [t for t in clean if t not in before]
    if added:
        await timeline.record(key, "lead.tagged",
                              "Ετικέτες: " + ", ".join(TAG_LABEL[t] for t in added), by=by)
    return {"ok": True, "tags": clean}


# ── σημειώσεις ──────────────────────────────────────────────────────────────────────────────
async def add_note(key: str, body: str, *, kind: str = "note", by: str) -> dict:
    body = (body or "").strip()
    if not body:
        return {"ok": False, "error": "empty"}
    if kind not in NOTE_KINDS:
        kind = "note"
    db = shared_db()
    if not await _lead(db, key):
        return {"ok": False, "error": "not_found"}
    doc = {"lead_key": key, "kind": kind, "body": body[:2000], "by": by, "at": _now()}
    res = await db[NOTES].insert_one(doc)
    await timeline.record(key, "lead.note", f"{NOTE_KINDS[kind]}: {body[:120]}", by=by,
                          data={"kind": kind}, ref={"kind": "note", "id": str(res.inserted_id)})
    # Μια καταγεγραμμένη επαφή σημαίνει ότι του μιλήσαμε — μην το αφήνεις στο «νέο».
    if kind in ("call", "meeting", "demo"):
        lead = await _lead(db, key)
        if (lead or {}).get("status") == "new":
            await set_status(key, "contacted", by=by, reason="καταγράφηκε επαφή")
    return {"ok": True, "id": str(res.inserted_id)}


async def notes_for(key: str) -> list[dict]:
    rows = [r async for r in shared_db()[NOTES].find({"lead_key": key}).sort("at", -1).limit(200)]
    for r in rows:
        r["_id"] = str(r["_id"])
        r["kind_label"] = NOTE_KINDS.get(r.get("kind"), "Σημείωση")
    return rows


# ── εργασίες ────────────────────────────────────────────────────────────────────────────────
async def add_task(key: str, *, action: str, title: str | None, due_at: datetime,
                   priority: str = "normal", assigned_to: str | None = None, by: str) -> dict:
    if action not in TASK_ACTIONS:
        return {"ok": False, "error": "bad_action"}
    if priority not in ("high", "normal", "low"):
        priority = "normal"
    db = shared_db()
    if not await _lead(db, key):
        return {"ok": False, "error": "not_found"}
    doc = {"lead_key": key, "action": action,
           "title": (title or TASK_ACTIONS[action]).strip()[:200],
           "due_at": due_at, "priority": priority,
           "assigned_to": assigned_to, "status": "open",
           "created_by": by, "created_at": _now()}
    res = await db[TASKS].insert_one(doc)
    await _refresh_next(db, key)
    await timeline.record(key, "lead.task_created",
                          f"{doc['title']} — για {due_at.strftime('%d/%m/%Y')}", by=by,
                          ref={"kind": "task", "id": str(res.inserted_id)})
    return {"ok": True, "id": str(res.inserted_id)}


async def complete_task(task_id: str, *, by: str, note: str | None = None,
                        cancel: bool = False) -> dict:
    db = shared_db()
    t = await db[TASKS].find_one({"_id": _oid(task_id)})
    if not t:
        return {"ok": False, "error": "not_found"}
    await db[TASKS].update_one({"_id": t["_id"]}, {"$set": {
        "status": "cancelled" if cancel else "done", "done_at": _now(),
        "done_by": by, "done_note": (note or "").strip() or None}})
    await _refresh_next(db, t["lead_key"])
    if not cancel:
        await timeline.record(t["lead_key"], "lead.task_done",
                              f"Ολοκληρώθηκε: {t.get('title')}", by=by)
    return {"ok": True}


async def _refresh_next(db, key: str) -> None:
    """Η ανοιχτή εργασία με την κοντινότερη προθεσμία γίνεται η «επόμενη ενέργεια» του lead."""
    t = await db[TASKS].find_one({"lead_key": key, "status": "open"}, sort=[("due_at", 1)])
    await db[COLL].update_one({"_id": key}, {"$set": {"next_action": (
        {"task_id": str(t["_id"]), "action": t["action"], "title": t.get("title"),
         "due_at": t["due_at"], "priority": t.get("priority"),
         "assigned_to": t.get("assigned_to")} if t else None), "updated_at": _now()}})


async def tasks_for(key: str) -> list[dict]:
    rows = [r async for r in shared_db()[TASKS].find({"lead_key": key}).sort("due_at", 1)]
    for r in rows:
        r["_id"] = str(r["_id"])
        r["action_label"] = TASK_ACTIONS.get(r.get("action"), r.get("action"))
    return rows


async def open_tasks(*, overdue_only: bool = False, limit: int = 100) -> list[dict]:
    q: dict = {"status": "open"}
    if overdue_only:
        q["due_at"] = {"$lte": _now()}
    rows = [r async for r in shared_db()[TASKS].find(q).sort("due_at", 1).limit(limit)]
    for r in rows:
        r["_id"] = str(r["_id"])
    return rows


# ── στοιχεία επικοινωνίας ───────────────────────────────────────────────────────────────────
async def update_contact(key: str, *, email=None, phone=None, contact_name=None,
                         by: str) -> dict:
    """Χειροκίνητη συμπλήρωση — 3 στους 6 παλιούς leads δεν έχουν email και είναι ανέφικτοι."""
    upd: dict = {}
    if email is not None:
        upd["email"] = (email or "").strip().lower() or None
    if phone is not None:
        upd["phone"] = (phone or "").strip() or None
    if contact_name is not None:
        upd["contact_name"] = (contact_name or "").strip() or None
    if not upd:
        return {"ok": True}
    upd["contact_updated_by"] = by
    upd["updated_at"] = _now()
    r = await shared_db()[COLL].update_one({"_id": key}, {"$set": upd})
    return {"ok": bool(r.matched_count)}
