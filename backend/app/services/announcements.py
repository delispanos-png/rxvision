"""Ανακοινώσεις προς τους πελάτες — «τι καινούργιο υπάρχει για σένα».

Ο ιδιοκτήτης της πλατφόρμας γράφει ΜΙΑ ανακοίνωση στο adminpanel και αυτή εμφανίζεται ως
παράθυρο μέσα στο RxVision του πελάτη, με τρεις πιθανές απαντήσεις:
  · «Θέλω να το δοκιμάσω»  → αίτημα για προσωρινή ενεργοποίηση στη ΔΙΚΗ ΤΟΥ υποδομή
  · «Θέλω παρουσίαση»      → αίτημα για ραντεβού/επίδειξη
  · «Δες περισσότερα»      → πάει στη σελίδα δυνατοτήτων

ΣΧΕΔΙΑΣΤΙΚΕΣ ΑΡΧΕΣ (γιατί αυτό δεν είναι απλό «popup»):
 1. ΠΟΤΕ σε λάθος κοινό. Μια ανακοίνωση για add-on ΔΕΝ εμφανίζεται σε όποιον το έχει ήδη —
    τίποτα δεν εκνευρίζει περισσότερο από προσφορά για κάτι που ήδη πληρώνεις.
 2. ΠΟΤΕ δύο φορές στον ίδιο άνθρωπο χωρίς λόγο. Η συχνότητα ορίζεται ρητά, και το
    «μη μου το ξαναδείξεις» σημαίνει ΠΟΤΕ ξανά.
 3. Ένα τη φορά. Ακόμη κι αν ταιριάζουν τρεις, εμφανίζεται η σημαντικότερη.
 4. Το περιεχόμενο δανείζεται από τον κατάλογο add-ons (όνομα/εικονίδιο/τιμή/δυνατότητες)
    ώστε να μη χρειάζεται να ξαναγραφτεί — και να μη βγει ποτέ λάθος τιμή.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db

FREQUENCIES = ("once", "daily", "weekly", "every_login")
ACTIONS = ("shown", "dismissed", "never", "trial", "demo", "info")
# Ενέργειες που κλείνουν ΟΡΙΣΤΙΚΑ την ανακοίνωση για τον συγκεκριμένο χρήστη.
_FINAL = ("never", "trial", "demo")


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


def _clean(a: dict) -> dict:
    a = dict(a)
    a["_id"] = str(a["_id"])
    return a


# ── σύνθεση περιεχομένου ────────────────────────────────────────────────────────────────────
async def _addon_card(key: str | None) -> dict | None:
    """Τα στοιχεία του add-on από τον κατάλογο — ώστε τιμή/δυνατότητες να είναι ΠΑΝΤΑ σωστά,
    ακόμη κι αν η ανακοίνωση γράφτηκε μήνες πριν."""
    if not key:
        return None
    a = await shared_db()["addons"].find_one({"_id": key})
    if not a:
        return None
    return {"key": key, "name": a.get("name"), "icon": a.get("icon"),
            "description": a.get("description"), "features": a.get("features") or [],
            "price_monthly": a.get("price_monthly"), "price_yearly": a.get("price_yearly")}


# ── στόχευση ────────────────────────────────────────────────────────────────────────────────
async def explain(ann: dict, tenant: dict, sub: dict, modules: dict) -> str | None:
    """ΓΙΑΤΙ δεν θα το δει αυτό το φαρμακείο — ή None αν θα το δει.

    Υπάρχει για έναν λόγο: «το ενεργοποίησα και δεν το είδα» δεν πρέπει να λύνεται με μαντεψιά.
    """
    aud = ann.get("audience") or {}
    if not ann.get("active"):
        return "η ανακοίνωση δεν είναι ενεργή"
    now = _now()
    if ann.get("from") and ann["from"].replace(tzinfo=timezone.utc) > now:
        return "δεν έχει ξεκινήσει ακόμη"
    if ann.get("to") and ann["to"].replace(tzinfo=timezone.utc) < now:
        return "έχει λήξει"
    allowed = aud.get("status") or ["active"]
    if tenant.get("status") not in allowed:
        return f"το φαρμακείο είναι «{tenant.get('status')}» — στέλνουμε μόνο σε {', '.join(allowed)}"
    mode = aud.get("mode") or "all"
    if mode == "tenants" and tenant["_id"] not in (aud.get("tenant_ids") or []):
        return "δεν είναι στη λίστα φαρμακείων που επέλεξες"
    if mode == "packages" and sub.get("plan") not in (aud.get("packages") or []):
        return f"το πακέτο του («{sub.get('plan')}») δεν είναι στα επιλεγμένα"
    key = ann.get("addon_key")
    if key and aud.get("exclude_with_addon", True) and modules.get(key) in ("enabled", "trial"):
        return "το έχει ήδη ενεργό"
    return None


async def _matches(ann: dict, tenant: dict, sub: dict, modules: dict) -> bool:
    aud = ann.get("audience") or {}
    # ΠΡΟΕΠΙΛΟΓΗ: ΜΟΝΟ ενεργοί συνδρομητές. Ο δοκιμαστικός αξιολογεί ακόμη το βασικό προϊόν —
    # προσφορά για extra εκείνη τη στιγμή είναι πίεση, όχι εξυπηρέτηση.
    if tenant.get("status") not in (aud.get("status") or ["active"]):
        return False
    mode = aud.get("mode") or "all"
    if mode == "tenants" and tenant["_id"] not in (aud.get("tenant_ids") or []):
        return False
    if mode == "packages" and sub.get("plan") not in (aud.get("packages") or []):
        return False
    # Ο σημαντικότερος κανόνας: μην πουλάς σε κάποιον κάτι που ήδη έχει.
    key = ann.get("addon_key")
    if key and aud.get("exclude_with_addon", True):
        if modules.get(key) in ("enabled", "trial"):
            return False
    return True


def _due(ann: dict, ev: dict | None) -> bool:
    """Ήρθε η ώρα να ξαναδείξουμε αυτή την ανακοίνωση σε ΑΥΤΟΝ τον χρήστη;"""
    if not ev:
        return True
    if ev.get("final"):
        return False                                   # «μη μου το ξαναδείξεις» ή ήδη απάντησε
    freq = ann.get("frequency") or "once"
    if freq == "every_login":
        return True
    if freq == "once":
        return False
    last = ev.get("last_shown_at")
    if not last:
        return True
    gap = timedelta(days=1 if freq == "daily" else 7)
    return (_now() - last.replace(tzinfo=timezone.utc)) >= gap


async def next_for(tenant_id: str, user_id: str | None) -> dict | None:
    """Η ΜΙΑ ανακοίνωση που πρέπει να δει τώρα αυτός ο χρήστης — ή τίποτα."""
    db = shared_db()
    now = _now()
    tenant = await db["tenants"].find_one({"_id": tenant_id}, {"status": 1, "name": 1})
    if not tenant:
        return None
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}, {"plan": 1}) or {}
    from app.services.auth_service import resolve_tenant_modules
    modules = await resolve_tenant_modules(tenant_id)

    cands = [a async for a in db["announcements"].find({
        "active": True,
        "$and": [{"$or": [{"from": None}, {"from": {"$lte": now}}]},
                 {"$or": [{"to": None}, {"to": {"$gte": now}}]}],
    }).sort([("priority", -1), ("created_at", -1)])]
    if not cands:
        return None

    uid = _oid(user_id) or user_id
    for ann in cands:
        if not await _matches(ann, tenant, sub, modules):
            continue
        ev = await db["announcement_events"].find_one(
            {"announcement_id": ann["_id"], "tenant_id": tenant_id, "user_id": uid})
        if not _due(ann, ev):
            continue
        out = _clean(ann)
        out["addon"] = await _addon_card(ann.get("addon_key"))
        return out
    return None


# ── καταγραφή απαντήσεων ────────────────────────────────────────────────────────────────────
async def record(ann_id: str, tenant_id: str, user_id: str | None, action: str,
                 *, note: str | None = None, user: dict | None = None) -> dict:
    if action not in ACTIONS:
        return {"ok": False, "error": "bad_action"}
    db = shared_db()
    aid = _oid(ann_id)
    ann = await db["announcements"].find_one({"_id": aid}) if aid else None
    if not ann:
        return {"ok": False, "error": "not_found"}
    uid = _oid(user_id) or user_id
    upd: dict[str, Any] = {"$set": {"last_action": action, "last_at": _now()},
                           "$inc": {f"counts.{action}": 1},
                           "$setOnInsert": {"announcement_id": aid, "tenant_id": tenant_id,
                                            "user_id": uid, "created_at": _now()}}
    if action == "shown":
        upd["$set"]["last_shown_at"] = _now()
    if action in _FINAL:
        upd["$set"]["final"] = True
    await db["announcement_events"].update_one(
        {"announcement_id": aid, "tenant_id": tenant_id, "user_id": uid}, upd, upsert=True)
    await db["announcements"].update_one({"_id": aid}, {"$inc": {f"stats.{action}": 1}})

    if action in ("trial", "demo"):
        return await _open_request(ann, tenant_id, uid, action, note=note, user=user)
    return {"ok": True}


async def _open_request(ann: dict, tenant_id: str, uid, kind: str, *,
                        note: str | None, user: dict | None) -> dict:
    """Το αίτημα του πελάτη → φάκελος του ιδιοκτήτη. Κρατάμε ΟΛΑ όσα χρειάζονται για να τον
    πάρει τηλέφωνο χωρίς να ψάξει πουθενά αλλού."""
    db = shared_db()
    t = await db["tenants"].find_one({"_id": tenant_id}, {"name": 1, "company": 1, "billing_profile": 1})
    comp = (t or {}).get("company") or {}
    bill = (t or {}).get("billing_profile") or {}
    existing = await db["announcement_requests"].find_one(
        {"announcement_id": ann["_id"], "tenant_id": tenant_id, "kind": kind, "status": "new"})
    if existing:
        return {"ok": True, "already": True}            # μην πλημμυρίζεις τον φάκελο με διπλά
    doc = {
        "announcement_id": ann["_id"], "title": ann.get("title"),
        "addon_key": ann.get("addon_key"), "kind": kind, "status": "new",
        "tenant_id": tenant_id, "tenant_name": (t or {}).get("name"),
        "contact_email": bill.get("email") or comp.get("email"),
        "contact_phone": comp.get("phone") or bill.get("phone"),
        "user_id": uid, "user_name": (user or {}).get("full_name"),
        "user_email": (user or {}).get("email"),
        "note": (note or "").strip()[:500] or None,
        "created_at": _now(),
    }
    await db["announcement_requests"].insert_one(doc)
    # SMS στον ιδιοκτήτη: ΑΥΤΟ είναι ζεστό ενδιαφέρον πελάτη — δεν περιμένει μέχρι να ανοίξει
    # το adminpanel. Best-effort· αν αποτύχει, το αίτημα είναι ήδη στον φάκελο.
    try:
        from app.services.comms import admin_alert
        what = "ΔΟΚΙΜΗ" if kind == "trial" else "ΠΑΡΟΥΣΙΑΣΗ"
        await admin_alert(f"RxVision: το «{(t or {}).get('name')}» ζητά {what} για "
                          f"«{ann.get('title')}». Δες: /admin/announcements")
    except Exception:                                   # noqa: BLE001
        import logging
        logging.getLogger(__name__).warning("announcement admin_alert failed", exc_info=True)
    return {"ok": True}


# ── διαχείριση (adminpanel) ─────────────────────────────────────────────────────────────────
async def list_all() -> list[dict]:
    db = shared_db()
    out = []
    async for a in db["announcements"].find({}).sort([("active", -1), ("created_at", -1)]):
        a = _clean(a)
        a["reach"] = await _reach(a)
        out.append(a)
    return out


async def _reach(ann: dict) -> int:
    """Σε πόσα φαρμακεία θα εμφανιστεί πραγματικά — το νούμερο που θέλεις ΠΡΙΝ πατήσεις «ενεργή»."""
    db = shared_db()
    from app.services.auth_service import resolve_tenant_modules
    n = 0
    async for t in db["tenants"].find({"status": {"$in": ["active", "trial"]}}, {"status": 1}):
        sub = await db["subscriptions"].find_one({"tenant_id": t["_id"]}, {"plan": 1}) or {}
        if await _matches(ann, t, sub, await resolve_tenant_modules(t["_id"])):
            n += 1
    return n


async def save(data: dict, *, ann_id: str | None = None, by: str | None = None) -> dict:
    db = shared_db()
    doc = {
        "title": (data.get("title") or "").strip()[:160],
        "body": (data.get("body") or "").strip()[:4000],
        "addon_key": (data.get("addon_key") or None),
        "kind": data.get("kind") or ("addon" if data.get("addon_key") else "news"),
        "cta": {"trial": bool((data.get("cta") or {}).get("trial", True)),
                "demo": bool((data.get("cta") or {}).get("demo", True)),
                "info_href": (data.get("cta") or {}).get("info_href") or None},
        "audience": {
            "mode": (data.get("audience") or {}).get("mode") or "all",
            "tenant_ids": (data.get("audience") or {}).get("tenant_ids") or [],
            "packages": (data.get("audience") or {}).get("packages") or [],
            "status": (data.get("audience") or {}).get("status") or ["active"],
            "exclude_with_addon": bool((data.get("audience") or {}).get("exclude_with_addon", True)),
        },
        "from": data.get("from"), "to": data.get("to"),
        "frequency": data.get("frequency") if data.get("frequency") in FREQUENCIES else "once",
        "priority": int(data.get("priority") or 0),
        "active": bool(data.get("active", False)),
        "updated_at": _now(), "updated_by": by,
    }
    if not doc["title"]:
        return {"ok": False, "error": "title_required"}
    oid = _oid(ann_id) if ann_id else None
    if oid:
        await db["announcements"].update_one({"_id": oid}, {"$set": doc})
    else:
        doc.update({"created_at": _now(), "created_by": by, "stats": {}})
        res = await db["announcements"].insert_one(doc)
        oid = res.inserted_id
    saved = await db["announcements"].find_one({"_id": oid})
    saved = _clean(saved)
    saved["reach"] = await _reach(saved)
    return {"ok": True, "announcement": saved}


async def delete(ann_id: str) -> dict:
    oid = _oid(ann_id)
    if not oid:
        return {"ok": False, "error": "bad_id"}
    db = shared_db()
    await db["announcements"].delete_one({"_id": oid})
    await db["announcement_events"].delete_many({"announcement_id": oid})
    return {"ok": True}


async def audience_check(ann_id: str) -> list[dict]:
    """Ανά φαρμακείο: θα το δει ή όχι, και ΓΙΑΤΙ. Συν το τι έχει ήδη γίνει ανά φαρμακείο."""
    db = shared_db()
    aid = _oid(ann_id)
    ann = await db["announcements"].find_one({"_id": aid}) if aid else None
    if not ann:
        return []
    from app.services.auth_service import resolve_tenant_modules
    out: list[dict] = []
    async for t in db["tenants"].find({"status": {"$in": ["active", "trial"]}},
                                      {"name": 1, "status": 1}):
        sub = await db["subscriptions"].find_one({"tenant_id": t["_id"]}, {"plan": 1}) or {}
        why = await explain(ann, t, sub, await resolve_tenant_modules(t["_id"]))
        seen = await db["announcement_events"].count_documents(
            {"announcement_id": aid, "tenant_id": t["_id"]})
        acted = await db["announcement_events"].count_documents(
            {"announcement_id": aid, "tenant_id": t["_id"], "final": True})
        out.append({"tenant_id": t["_id"], "name": t.get("name"), "status": t.get("status"),
                    "plan": sub.get("plan"), "will_show": why is None, "reason": why,
                    "seen": seen, "answered": acted})
    out.sort(key=lambda r: (not r["will_show"], r["name"] or ""))
    return out


async def requests(status: str = "new") -> list[dict]:
    db = shared_db()
    q = {} if status == "all" else {"status": status}
    return [{**r, "_id": str(r["_id"]), "announcement_id": str(r["announcement_id"]),
             "user_id": str(r.get("user_id") or "")}
            async for r in db["announcement_requests"].find(q).sort("created_at", -1).limit(300)]


async def close_request(req_id: str, *, by: str | None = None, outcome: str = "done") -> dict:
    oid = _oid(req_id)
    if not oid:
        return {"ok": False, "error": "bad_id"}
    await shared_db()["announcement_requests"].update_one(
        {"_id": oid}, {"$set": {"status": outcome, "closed_at": _now(), "closed_by": by}})
    return {"ok": True}
