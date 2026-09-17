"""Η οθόνη «Leads & Conversions»: «Σήμερα», μετρήσεις, λίστα, καρτέλα.

Η κεντρική ερώτηση της σελίδας είναι μία: «ποιο φαρμακείο χρειάζεται την προσοχή μου σήμερα
και τι να του πω;». Ό,τι δεν βοηθά σε αυτό δεν μπαίνει.

Κανόνας «καμία ψεύτικη μέτρηση»: μέτρηση που δεν υπολογίζεται επιστρέφει `None` και το UI
γράφει «δεν μετριέται ακόμη» — ποτέ μηδέν, ποτέ επινοημένο νούμερο.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.services.leads import actions, config as cfg, next_action, segments, timeline
from app.services.leads.projection import (CHURNED, COLL, CUSTOMER, SIGNUP_ABANDONED,
                                           TRIAL_ACTIVE, TRIAL_ENDING, TRIAL_EXPIRED,
                                           TRIAL_PURGED)

# Οι καρτέλες/φίλτρα της σελίδας → φίλτρο Mongo. Ελληνικά, όχι ορολογία CRM.
TABS: list[dict] = [
    {"key": "attention", "label": "Θέλουν προσοχή"},
    {"key": "all", "label": "Όλα"},
    {"key": "trialing", "label": "Δοκιμάζουν"},
    {"key": "ending", "label": "Τελειώνουν"},
    {"key": "expired", "label": "Έληξαν"},
    {"key": "contacted", "label": "Τους μιλήσαμε"},
    {"key": "reengage", "label": "Επαναπροσέγγιση"},
    {"key": "customers", "label": "Πελάτες"},
    {"key": "lost", "label": "Χαμένα"},
]

_NOT_CLOSED = {"$nin": ["won", "lost", "do_not_contact"]}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _tab_query(tab: str) -> dict:
    return {
        "attention": {"stage": {"$in": [TRIAL_ENDING, TRIAL_EXPIRED, SIGNUP_ABANDONED, CHURNED]},
                      "status": _NOT_CLOSED},
        "all": {},
        "trialing": {"stage": {"$in": [TRIAL_ACTIVE, TRIAL_ENDING]}},
        "ending": {"stage": TRIAL_ENDING},
        "expired": {"stage": {"$in": [TRIAL_EXPIRED, TRIAL_PURGED]}},
        "contacted": {"status": {"$in": ["contacted", "engaged", "offer_sent", "negotiating"]}},
        "reengage": {"trial.days_since_expiry": {"$gte": 60}, "status": _NOT_CLOSED},
        "customers": {"stage": CUSTOMER},
        "lost": {"status": {"$in": ["lost", "do_not_contact"]}},
    }.get(tab, {})


def _row(lead: dict) -> dict:
    """Επτά στήλες, όχι δεκατέσσερις. Τα υπόλοιπα ζουν στην καρτέλα."""
    s = lead.get("score") or {}
    a = lead.get("activity") or {}
    t = lead.get("trial") or {}
    return {
        "_id": lead["_id"],
        "pharmacy_name": lead.get("pharmacy_name") or lead.get("contact_name") or lead["_id"],
        "city": lead.get("city"),
        "tenant_id": lead.get("tenant_id"),
        "stage": lead.get("stage"), "stage_label": lead.get("stage_label"),
        "status": lead.get("status"), "status_label": actions.STATUSES.get(lead.get("status")),
        "days_since_expiry": t.get("days_since_expiry"), "days_left": t.get("days_left"),
        "score": s.get("value"), "band": s.get("band"), "band_label": s.get("band_label"),
        "days_since_activity": a.get("days_since_activity"),
        "actions_30d": a.get("actions_30d"),
        "has_email": bool(lead.get("email")), "has_phone": bool(lead.get("phone")),
        "tags": lead.get("tags") or [],
        "assigned_name": lead.get("assigned_name"),
        "next_action": lead.get("next_action"),
        "last_comm_at": (lead.get("comms") or {}).get("last_sent_at"),
        "suggestion": next_action.suggest(lead),
    }


async def listing(*, tab: str = "attention", q: str | None = None,
                  segment_id: str | None = None, rules: dict | None = None,
                  assigned_to: str | None = None, limit: int = 200) -> dict:
    db = shared_db()
    flt: dict = dict(_tab_query(tab))
    if rules:
        flt = {"$and": [flt, segments.to_query(rules)]} if flt else segments.to_query(rules)
    elif segment_id:
        seg = await db[segments.SEGMENTS].find_one({"_id": segments._oid(segment_id)})
        if seg:
            sq = segments.to_query(seg.get("rules") or {})
            flt = {"$and": [flt, sq]} if flt else sq
    if assigned_to:
        flt["assigned_to"] = assigned_to
    if (q or "").strip():
        rx = {"$regex": q.strip(), "$options": "i"}
        term = [{"pharmacy_name": rx}, {"contact_name": rx}, {"email": rx},
                {"afm": rx}, {"phone": rx}, {"city": rx}]
        flt = {"$and": [flt, {"$or": term}]} if flt else {"$or": term}

    rows = [_row(r) async for r in db[COLL].find(flt)
            .sort([("score.value", -1), ("updated_at", -1)]).limit(limit)]
    return {"items": rows, "total": await db[COLL].count_documents(flt)}


async def tabs() -> list[dict]:
    db = shared_db()
    return [{**t, "count": await db[COLL].count_documents(_tab_query(t["key"]))} for t in TABS]


async def today() -> list[dict]:
    """«Σήμερα» — τι χρειάζεται την προσοχή μου. Κάθε γραμμή οδηγεί κάπου.

    Το μάθημα από τον Σύμβουλο: γραμμή που δεν οδηγεί σε συγκεκριμένη λίστα δεν μπαίνει.
    """
    db = shared_db()
    now = _now()
    c = await cfg.get()
    out: list[dict] = []

    overdue = await db[actions.TASKS].count_documents({"status": "open", "due_at": {"$lte": now}})
    if overdue:
        out.append({"tone": "red", "icon": "🔴", "n": overdue,
                    "text": f"{overdue} {'φαρμακείο περιμένει' if overdue == 1 else 'φαρμακεία περιμένουν'} ενέργεια που έχει ήδη περάσει",
                    "link": {"kind": "tasks", "value": "overdue"}})

    ending = await db[COLL].count_documents(
        {"stage": TRIAL_ENDING, "status": _NOT_CLOSED})
    if ending:
        out.append({"tone": "orange", "icon": "🟠", "n": ending,
                    "text": f"{ending} {'δοκιμή τελειώνει' if ending == 1 else 'δοκιμές τελειώνουν'} μέσα στις επόμενες {c['trial_ending_days']} ημέρες",
                    "link": {"kind": "tab", "value": "ending"}})

    silent = await db[COLL].count_documents(
        {"stage": {"$in": [TRIAL_EXPIRED, CHURNED, SIGNUP_ABANDONED]}, "status": "new"})
    if silent:
        out.append({"tone": "yellow", "icon": "🟡", "n": silent,
                    "text": f"{silent} {'φαρμακείο έληξε' if silent == 1 else 'φαρμακεία έληξαν'} και δεν τους μίλησε κανείς",
                    "link": {"kind": "segment", "value": "needs_contact"}})

    returned = await db[COLL].count_documents(
        {"activity.returned_after_days": {"$gte": int(c["returned_after_days"])},
         "status": _NOT_CLOSED})
    if returned:
        out.append({"tone": "green", "icon": "🟢", "n": returned,
                    "text": f"{returned} ξαναμπήκαν μόνοι τους μετά από καιρό",
                    "link": {"kind": "segment", "value": "returning"}})

    unreachable = await db[COLL].count_documents(
        {"email": {"$in": [None, ""]}, "phone": {"$in": [None, ""]},
         "stage": {"$ne": CUSTOMER}})
    if unreachable:
        out.append({"tone": "slate", "icon": "📵", "n": unreachable,
                    "text": f"{unreachable} δεν έχουν ούτε email ούτε τηλέφωνο — συμπλήρωσέ τα",
                    "link": {"kind": "segment", "value": "unreachable"}})
    return out


async def kpis() -> dict:
    """Πραγματικά νούμερα. Ό,τι δεν υπολογίζεται → None → «δεν μετριέται ακόμη»."""
    db = shared_db()
    n = db[COLL].count_documents
    trials = await n({"stage": {"$in": [TRIAL_ACTIVE, TRIAL_ENDING]}})
    expired = await n({"stage": {"$in": [TRIAL_EXPIRED, TRIAL_PURGED]}})
    customers = await n({"stage": CUSTOMER})
    # «Πόσοι έγιναν πελάτες» — κλάσμα, όχι ποσοστό με δεκαδικά πάνω σε 12 εγγραφές.
    pool = customers + expired + await n({"stage": CHURNED})
    return {
        "total": await n({}),
        "trialing": trials,
        "ending": await n({"stage": TRIAL_ENDING}),
        "expired": expired,
        "needs_contact": await n({"stage": {"$in": [TRIAL_EXPIRED, CHURNED, SIGNUP_ABANDONED]},
                                  "status": "new"}),
        "reengage": await n({"trial.days_since_expiry": {"$gte": 60}, "status": _NOT_CLOSED}),
        "offers_sent": await n({"offers.last_sent_at": {"$ne": None}}),
        "customers": customers,
        "lost": await n({"status": {"$in": ["lost", "do_not_contact"]}}),
        "conversion": {"won": customers, "of": pool} if pool else None,
        # Φάση 2 — δεν υπάρχει ακόμη μηχανισμός· λέμε ότι δεν μετριέται.
        "contacted_30d": None,
    }


async def detail(key: str) -> dict | None:
    db = shared_db()
    lead = await db[COLL].find_one({"_id": key})
    if not lead:
        return None
    lead["status_label"] = actions.STATUSES.get(lead.get("status"))
    lead["suggestion"] = next_action.suggest(lead)
    lead["tag_labels"] = [actions.TAG_LABEL.get(t, t) for t in (lead.get("tags") or [])]
    return {
        "lead": lead,
        "timeline": await timeline.for_lead(key),
        "notes": await actions.notes_for(key),
        "tasks": await actions.tasks_for(key),
        "history": [{**h, "_id": str(h["_id"])} async for h in
                    db[actions.HISTORY].find({"lead_key": key}).sort("at", -1).limit(50)],
    }


async def overview() -> dict:
    last = (await shared_db()["platform_settings"].find_one({"_id": cfg.SETTINGS_ID}) or {}
            ).get("last_projection_at")
    return {"today": await today(), "kpis": await kpis(), "tabs": await tabs(),
            "segments": await segments.builtin_counts(), "last_projection_at": last}
