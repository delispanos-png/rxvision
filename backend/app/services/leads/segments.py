"""Δυναμικά τμήματα leads — κανόνες AND/OR πάνω στα πεδία της προβολής.

ΙΔΙΟ ΣΧΗΜΑ με το `services/audience.py` των ασθενών (`match` + `conditions`), σκόπιμα: ένας
τρόπος να γράφεις κανόνες σε όλο το προϊόν.

Μαζί έρχεται και το μάθημα της 17/09: κανόνες που δεν αναγνωρίζονται ΔΕΝ σημαίνουν «όλοι».
Άγνωστο πεδίο ή κενοί κανόνες = σφάλμα. Στους ασθενείς ένα λάθος σχήμα άνοιγε σιωπηλά όλο το
πελατολόγιο· εδώ θα άνοιγε όλη τη λίστα φαρμακείων.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db
from app.services.leads.projection import COLL

SEGMENTS = "lead_segments"

# Πεδίο → (διαδρομή στο έγγραφο, ελληνική ετικέτα, τύπος)
FIELDS: dict[str, dict] = {
    "stage":            {"path": "stage", "label": "Κατάσταση λογαριασμού", "type": "enum"},
    "status":           {"path": "status", "label": "Πού είναι η κουβέντα", "type": "enum"},
    "score":            {"path": "score.value", "label": "Δραστηριότητα (0-100)", "type": "number"},
    "days_since_expiry": {"path": "trial.days_since_expiry", "label": "Ημέρες από τη λήξη", "type": "number"},
    "days_left":        {"path": "trial.days_left", "label": "Ημέρες ως τη λήξη", "type": "number"},
    "days_since_activity": {"path": "activity.days_since_activity", "label": "Ημέρες χωρίς κίνηση", "type": "number"},
    "actions_30d":      {"path": "activity.actions_30d", "label": "Ενέργειες τον μήνα", "type": "number"},
    "data_connected":   {"path": "activity.data_connected", "label": "Σύνδεσε δεδομένα ΗΔΥΚΑ", "type": "bool"},
    "returned":         {"path": "activity.returned_after_days", "label": "Ξαναμπήκε μετά από σιωπή", "type": "number"},
    "has_email":        {"path": "email", "label": "Έχει email", "type": "exists"},
    "has_phone":        {"path": "phone", "label": "Έχει τηλέφωνο", "type": "exists"},
    "tags":             {"path": "tags", "label": "Ετικέτα", "type": "array"},
    "assigned_to":      {"path": "assigned_to", "label": "Υπεύθυνος", "type": "enum"},
    "offers_sent":      {"path": "offers.last_sent_at", "label": "Έχει πάρει προσφορά", "type": "exists"},
    "source":           {"path": "source", "label": "Από πού ήρθε", "type": "enum"},
}

OPS = {"is": "$eq", "not": "$ne", "gte": "$gte", "lte": "$lte",
       "in": "$in", "not_in": "$nin", "exists": None, "between": None}

# Έτοιμα τμήματα — απαντούν σε ερωτήσεις που όντως κάνει ο ιδιοκτήτης.
BUILTIN: list[dict] = [
    {"key": "needs_contact", "icon": "🔴", "name": "Χρειάζονται επικοινωνία",
     "why": "Η δοκιμή τους έληξε και δεν τους έχει μιλήσει κανείς.",
     "rules": {"match": "all", "conditions": [
         {"field": "stage", "op": "in", "value": ["trial_expired", "churned", "signup_abandoned"]},
         {"field": "status", "op": "in", "value": ["new"]}]}},
    {"key": "ending", "icon": "🟠", "name": "Η δοκιμή τελειώνει",
     "why": "Μέσα στις επόμενες ημέρες αποφασίζουν.",
     "rules": {"match": "all", "conditions": [{"field": "stage", "op": "is", "value": "trial_ending"}]}},
    {"key": "hot_expired", "icon": "🔥", "name": "Το δούλεψαν και δεν αγόρασαν",
     "why": "Η πιο ακριβή κατηγορία για να αφήσεις να κρυώσει.",
     "rules": {"match": "all", "conditions": [
         {"field": "stage", "op": "in", "value": ["trial_expired", "trial_purged"]},
         {"field": "score", "op": "gte", "value": 51},
         {"field": "status", "op": "not_in", "value": ["won", "lost", "do_not_contact"]}]}},
    {"key": "quiet_expired", "icon": "💤", "name": "Έληξαν χωρίς να το δοκιμάσουν",
     "why": "Δεν τους έπεισε το προϊόν — τους έχασε η αρχή.",
     "rules": {"match": "all", "conditions": [
         {"field": "stage", "op": "in", "value": ["trial_expired", "trial_purged"]},
         {"field": "score", "op": "lte", "value": 20}]}},
    {"key": "returning", "icon": "↩️", "name": "Ξαναμπήκαν μόνοι τους",
     "why": "Επέστρεψαν χωρίς να τους καλέσουμε. Το ισχυρότερο σήμα που υπάρχει.",
     "rules": {"match": "all", "conditions": [{"field": "returned", "op": "gte", "value": 7}]}},
    {"key": "reengage", "icon": "🔄", "name": "Για επαναπροσέγγιση",
     "why": "Έληξαν εδώ και καιρό — θέλουν νέα αφορμή, όχι υπενθύμιση.",
     "rules": {"match": "all", "conditions": [
         {"field": "days_since_expiry", "op": "gte", "value": 60},
         {"field": "status", "op": "not_in", "value": ["won", "do_not_contact"]}]}},
    {"key": "unreachable", "icon": "📵", "name": "Δεν έχουμε πώς να τους βρούμε",
     "why": "Ούτε email ούτε τηλέφωνο. Πρέπει να συμπληρωθούν με το χέρι.",
     "rules": {"match": "all", "conditions": [
         {"field": "has_email", "op": "exists", "value": False},
         {"field": "has_phone", "op": "exists", "value": False}]}},
]


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


def to_query(rules: dict) -> dict:
    """Κανόνες → φίλτρο Mongo. Σκάει σε ό,τι δεν αναγνωρίζει — ΠΟΤΕ δεν επιστρέφει {}."""
    conds = (rules or {}).get("conditions") or []
    if not conds:
        raise ValueError("empty_or_unknown_rules")
    unknown = sorted({str(c.get("field")) for c in conds} - set(FIELDS))
    if unknown:
        raise ValueError(f"unknown_field:{unknown[0]}")

    parts: list[dict] = []
    for c in conds:
        f = FIELDS[c["field"]]
        path, op, val = f["path"], c.get("op"), c.get("value")
        if op not in OPS:
            raise ValueError(f"unknown_operator:{op}")
        if op == "exists":
            parts.append({path: {"$nin": [None, ""]}} if val else {path: {"$in": [None, ""]}})
        elif op == "between":
            if not isinstance(val, (list, tuple)) or len(val) != 2:
                raise ValueError("between_needs_two_values")
            parts.append({path: {"$gte": val[0], "$lte": val[1]}})
        elif op in ("in", "not_in"):
            if not isinstance(val, (list, tuple)):
                raise ValueError("in_needs_list")
            parts.append({path: {OPS[op]: list(val)}})
        else:
            parts.append({path: {OPS[op]: val}})
    key = "$and" if (rules or {}).get("match", "all") != "any" else "$or"
    return {key: parts}


async def resolve(rules: dict) -> list[str]:
    q = to_query(rules)
    return [d["_id"] async for d in shared_db()[COLL].find(q, {"_id": 1})]


async def count(rules: dict) -> int:
    return await shared_db()[COLL].count_documents(to_query(rules))


async def builtin_counts() -> list[dict]:
    """Τα έτοιμα τμήματα με ΖΩΝΤΑΝΑ νούμερα — όχι αποθηκευμένα, όχι εκτιμήσεις."""
    out = []
    for s in BUILTIN:
        try:
            n = await count(s["rules"])
        except ValueError:
            n = 0
        out.append({**s, "count": n})
    return out


# ── αποθηκευμένα τμήματα ────────────────────────────────────────────────────────────────────
async def save(*, name: str, rules: dict, by: str, segment_id: str | None = None) -> dict:
    name = (name or "").strip()
    if not name:
        return {"ok": False, "error": "name_required"}
    to_query(rules)                      # επικύρωση ΠΡΙΝ αποθηκευτεί
    db = shared_db()
    doc = {"name": name[:120], "rules": rules, "updated_at": _now(), "updated_by": by}
    oid = _oid(segment_id) if segment_id else None
    if oid:
        await db[SEGMENTS].update_one({"_id": oid}, {"$set": doc})
    else:
        doc.update({"created_at": _now(), "created_by": by})
        oid = (await db[SEGMENTS].insert_one(doc)).inserted_id
    return {"ok": True, "id": str(oid), "count": await count(rules)}


async def listing() -> list[dict]:
    out = []
    async for s in shared_db()[SEGMENTS].find({}).sort("name", 1):
        try:
            n: Any = await count(s.get("rules") or {})
        except ValueError:
            n = None                     # χαλασμένος κανόνας → «δεν μετριέται», ποτέ 0
        out.append({"_id": str(s["_id"]), "name": s.get("name"),
                    "rules": s.get("rules"), "count": n})
    return out


async def delete(segment_id: str) -> dict:
    r = await shared_db()[SEGMENTS].delete_one({"_id": _oid(segment_id)})
    return {"ok": bool(r.deleted_count)}
