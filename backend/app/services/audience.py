"""Audience Engine — «σε ποιους θέλεις να μιλήσεις;» χωρίς SQL.

Ο φαρμακοποιός δεν γράφει ερωτήματα. Διαλέγει από έτοιμες ομάδες ή συνθέτει κανόνες σε φυσική
γλώσσα («δεν έχουν έρθει τις τελευταίες 90 ημέρες» ΚΑΙ «έχουν πάνω από 5 εκτελέσεις»).

ΑΡΧΕΣ:
 · Οι έτοιμες ομάδες είναι **πρότυπα κανόνων**, όχι κώδικας (§7 του brief). Αντιγράφονται και
   τροποποιούνται· δεν είναι κλειδωμένη λογική κρυμμένη σε if.
 · Κάθε πεδίο δηλώνει αν είναι **κλινικό**. Τα κλινικά κλειδώνονται πίσω από `purpose="care"`,
   όπως ακριβώς και τα παλιά segments — η δικλείδα είναι ΕΝΑ σημείο, όχι δύο.
 · Ο υπολογισμός γυρίζει ΠΑΝΤΑ `patient_contacts._id`, δηλαδή το ίδιο κλειδί που χρησιμοποιεί
   ήδη η `comms.campaign_audience` — καμία παράλληλη διαδρομή.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


# ── τα πεδία πάνω στα οποία χτίζεται ένας κανόνας ───────────────────────────────────────────
# `clinical: True` ⇒ δεδομένα υγείας ⇒ επιτρέπεται ΜΟΝΟ σε επικοινωνία φροντίδας.
FIELDS: dict[str, dict] = {
    "days_since_visit":  {"label": "Μέρες από την τελευταία επίσκεψη", "type": "number"},
    "rx_count":          {"label": "Πλήθος εκτελέσεων", "type": "number"},
    "rx_value_total":    {"label": "Συνολική αξία (€)", "type": "money"},
    "avg_per_visit":     {"label": "Μέση αξία επίσκεψης (€)", "type": "money"},
    "age_group":         {"label": "Ηλικιακή ομάδα", "type": "choice",
                          "options": ["0-17", "18-34", "35-49", "50-64", "65-74", "75+"]},
    "lifecycle":         {"label": "Κατάσταση πελάτη", "type": "choice",
                          "options": ["new", "active", "at_risk", "lost"]},
    "has_portal":        {"label": "Έχει την εφαρμογή", "type": "bool"},
    "is_loyalty":        {"label": "Μέλος πιστότητας", "type": "bool"},
    "loyalty_points":    {"label": "Πόντοι πιστότητας", "type": "number"},
    "orders_count":      {"label": "Παραγγελίες e-shop", "type": "number"},
    "days_since_order":  {"label": "Μέρες από την τελευταία παραγγελία", "type": "number"},
    "area":              {"label": "Περιοχή", "type": "text"},
    # ── κλινικά — κλειδωμένα πίσω από purpose="care" ──
    "therapy_atc":       {"label": "Θεραπευτική κατηγορία (ATC)", "type": "text", "clinical": True},
    "icd10":             {"label": "Διάγνωση (ICD-10)", "type": "text", "clinical": True},
    "unfinished_therapy": {"label": "Δεν ολοκλήρωσε αγωγή", "type": "bool", "clinical": True},
}

OPS = ("eq", "ne", "gt", "lt", "gte", "lte", "between", "before", "after", "contains", "is")

# ── έτοιμες ομάδες: ΠΡΟΤΥΠΑ κανόνων, όχι hardcoded λογική ───────────────────────────────────
SMART: list[dict] = [
    {"key": "active", "icon": "🟢", "name": "Ενεργοί πελάτες",
     "why": "Ήρθαν μέσα στον τελευταίο μήνα.",
     "rules": {"match": "all", "conditions": [{"field": "days_since_visit", "op": "lte", "value": 30}]}},
    {"key": "slipping", "icon": "🟡", "name": "Αραιώνουν",
     "why": "Έρχονταν τακτικά και έχουν αρχίσει να αργούν.",
     "rules": {"match": "all", "conditions": [
         {"field": "days_since_visit", "op": "between", "value": [45, 89]},
         {"field": "rx_count", "op": "gte", "value": 5}]}},
    {"key": "inactive60", "icon": "🟠", "name": "Δεν ήρθαν 60 μέρες",
     "why": "Δύο μήνες χωρίς επίσκεψη.",
     "rules": {"match": "all", "conditions": [{"field": "days_since_visit", "op": "between", "value": [60, 89]}]}},
    {"key": "inactive90", "icon": "🔴", "name": "Δεν ήρθαν 90 μέρες",
     "why": "Τρεις μήνες. Ακόμη ανακτήσιμοι.",
     "rules": {"match": "all", "conditions": [{"field": "days_since_visit", "op": "between", "value": [90, 179]}]}},
    {"key": "inactive180", "icon": "🚩", "name": "Δεν ήρθαν 180 μέρες",
     "why": "Μισός χρόνος. Χρειάζεται καλό λόγο για να γυρίσουν.",
     "rules": {"match": "all", "conditions": [{"field": "days_since_visit", "op": "gte", "value": 180}]}},
    {"key": "vip", "icon": "👑", "name": "VIP πελάτες",
     "why": "Στηρίζουν πραγματικά το φαρμακείο σου.",
     "rules": {"match": "all", "conditions": [
         {"field": "rx_count", "op": "gte", "value": 20},
         {"field": "days_since_visit", "op": "lte", "value": 90}]}},
    {"key": "loyalty", "icon": "💳", "name": "Μέλη πιστότητας",
     "why": "Έχουν κάρτα και μαζεύουν πόντους.",
     "rules": {"match": "all", "conditions": [{"field": "is_loyalty", "op": "is", "value": True}]}},
    {"key": "loyalty_rich", "icon": "🏆", "name": "Έχουν πόντους να εξαργυρώσουν",
     "why": "Πάνω από 500 πόντους — και δεν το θυμούνται.",
     "rules": {"match": "all", "conditions": [{"field": "loyalty_points", "op": "gte", "value": 500}]}},
    {"key": "new", "icon": "🆕", "name": "Νέοι πελάτες",
     "why": "Ήρθαν πρώτη φορά τον τελευταίο μήνα.",
     "rules": {"match": "all", "conditions": [
         {"field": "rx_count", "op": "lte", "value": 2},
         {"field": "days_since_visit", "op": "lte", "value": 30}]}},
    {"key": "portal", "icon": "📱", "name": "Έχουν την εφαρμογή",
     "why": "Μπορείς να τους στείλεις δωρεάν ειδοποίηση.",
     "rules": {"match": "all", "conditions": [{"field": "has_portal", "op": "is", "value": True}]}},
    {"key": "shoppers", "icon": "📦", "name": "Αγοράζουν από το e-shop",
     "why": "Έχουν κάνει τουλάχιστον μία παραγγελία.",
     "rules": {"match": "all", "conditions": [{"field": "orders_count", "op": "gte", "value": 1}]}},
]


def uses_clinical(rules: dict) -> bool:
    """Περιέχει ο κανόνας δεδομένα υγείας; Ένα σημείο ελέγχου για όλη την εφαρμογή."""
    for c in (rules or {}).get("conditions", []):
        if FIELDS.get(c.get("field"), {}).get("clinical"):
            return True
    return False


# ── υπολογισμός ─────────────────────────────────────────────────────────────────────────────
def _cmp(op: str, val: Any, want: Any) -> bool:
    if val is None:
        return False
    try:
        if op == "eq":
            return val == want
        if op == "ne":
            return val != want
        if op == "is":
            return bool(val) == bool(want)
        if op == "contains":
            return str(want).lower() in str(val).lower()
        if op == "between":
            lo, hi = want
            return float(lo) <= float(val) <= float(hi)
        v, w = float(val), float(want)
        return {"gt": v > w, "lt": v < w, "gte": v >= w, "lte": v <= w,
                "after": v > w, "before": v < w}.get(op, False)
    except (TypeError, ValueError):
        return False


async def resolve(tenant_id: str, rules: dict, *, purpose: str = "commercial") -> set:
    """Κανόνες → σύνολο `patient_contacts._id`.

    Ένα πέρασμα πάνω στους ασθενείς, με τα «ακριβά» πεδία (πόντοι, παραγγελίες, πύλη) να
    φορτώνονται ΜΟΝΟ αν τα ζητά ο κανόνας — αλλιώς ένα απλό «δεν ήρθαν 90 μέρες» θα κόστιζε
    τέσσερα περιττά ερωτήματα.
    """
    if uses_clinical(rules) and purpose != "care":
        raise PermissionError("clinical_field_requires_care_purpose")

    db = shared_db()
    conds = (rules or {}).get("conditions") or []
    # Κανόνες που δεν καταλαβαίνουμε ΔΕΝ σημαίνουν «όλοι». Ένα λάθος πεδίο ή ένα παλιό
    # αποθηκευμένο σχήμα θα άνοιγε σιωπηλά ΟΛΟ το πελατολόγιο — δηλαδή θα έστελνε μήνυμα σε
    # 3.000 ανθρώπους ενώ ο φαρμακοποιός νόμιζε ότι διάλεξε 139. Καλύτερα να σκάσει τώρα.
    if rules and not conds:
        raise ValueError("empty_or_unknown_rules")
    unknown = sorted({str(c.get("field")) for c in conds} - set(FIELDS))
    if unknown:
        raise ValueError(f"unknown_field:{unknown[0]}")
    match_all = (rules or {}).get("match", "all") != "any"
    used = {c.get("field") for c in conds}
    now = _now()

    points: dict = {}
    if "loyalty_points" in used or "is_loyalty" in used:
        from app.repositories.loyalty import LoyaltyRepository
        refs = [m["patient_ref"] async for m in db["loyalty_members"].find(
            {"tenant_id": tenant_id}, {"patient_ref": 1})]
        try:
            points = await LoyaltyRepository(tenant_id=tenant_id).balances_for_refs(refs)
        except Exception:                                  # noqa: BLE001
            points = {r: 0 for r in refs}

    orders: dict = {}
    if "orders_count" in used or "days_since_order" in used:
        for r in await db["orders_delivery"].aggregate([
            {"$match": {"tenant_id": tenant_id}},
            {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}, "last": {"$max": "$created_at"}}},
        ]).to_list(length=None):
            orders[str(r["_id"])] = r

    portal: set = set()
    if "has_portal" in used:
        amkas = {l["tenant_id"]: None async for l in db["patient_links"].find({"tenant_id": tenant_id})}
        _ = amkas
        portal = {l["patient_ref"] async for l in db["patient_links"].find(
            {"tenant_id": tenant_id}, {"patient_ref": 1})}

    clinical_ids: set | None = None
    if purpose == "care":
        for c in conds:
            f = c.get("field")
            if f in ("therapy_atc", "icd10"):
                from app.services import comms
                seg = await comms.segment_patient_ids(
                    tenant_id, "therapy" if f == "therapy_atc" else "icd", str(c.get("value") or ""))
                clinical_ids = seg if clinical_ids is None else (clinical_ids & (seg or set()))

    out: set = set()
    async for p in db["patients_anonymized"].find(
            {"tenant_id": tenant_id},
            {"last_seen_at": 1, "rx_count": 1, "rx_value_total": 1, "age_group": 1,
             "lifecycle": 1, "residence_area_canonical": 1, "residence_area": 1}):
        pid = p["_id"]
        last = p.get("last_seen_at")
        vals = {
            "days_since_visit": (now - last.replace(tzinfo=timezone.utc)).days if last else None,
            "rx_count": p.get("rx_count") or 0,
            "rx_value_total": (p.get("rx_value_total") or 0) / 100,
            "avg_per_visit": ((p.get("rx_value_total") or 0) / 100) / max(1, p.get("rx_count") or 1),
            "age_group": p.get("age_group"),
            "lifecycle": p.get("lifecycle"),
            "area": p.get("residence_area_canonical") or p.get("residence_area"),
            "has_portal": pid in portal,
            "is_loyalty": pid in points,
            "loyalty_points": points.get(pid, 0),
            "orders_count": (orders.get(str(pid)) or {}).get("n", 0),
            "days_since_order": ((now - orders[str(pid)]["last"].replace(tzinfo=timezone.utc)).days
                                 if orders.get(str(pid), {}).get("last") else None),
        }
        results = []
        for c in conds:
            f = c.get("field")
            if f in ("therapy_atc", "icd10"):
                results.append(clinical_ids is not None and pid in clinical_ids)
            else:
                results.append(_cmp(c.get("op", "eq"), vals.get(f), c.get("value")))
        if (all(results) if match_all else any(results)) if results else True:
            out.add(pid)
    return out


async def preview(tenant_id: str, rules: dict, *, purpose: str = "commercial") -> dict:
    """Πόσοι είναι — για να το δει ο φαρμακοποιός ΠΡΙΝ γράψει το μήνυμα."""
    try:
        ids = await resolve(tenant_id, rules, purpose=purpose)
    except PermissionError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "count": len(ids), "clinical": uses_clinical(rules)}


async def smart_counts(tenant_id: str) -> list[dict]:
    """Οι έτοιμες ομάδες με ΖΩΝΤΑΝΟ πλήθος — οι κάρτες επιλογής κοινού."""
    out = []
    for s in SMART:
        try:
            n = len(await resolve(tenant_id, s["rules"]))
        except Exception:                                  # noqa: BLE001
            n = 0
        out.append({**s, "count": n})
    return out


# ── αποθηκευμένα κοινά ──────────────────────────────────────────────────────────────────────
async def save(tenant_id: str, *, name: str, rules: dict, by: str | None = None,
               audience_id: str | None = None) -> dict:
    db = shared_db()
    doc = {"tenant_id": tenant_id, "name": name.strip()[:80], "rules": rules,
           "clinical": uses_clinical(rules), "updated_at": _now(), "updated_by": by}
    oid = _oid(audience_id) if audience_id else None
    if oid:
        await db["comm_audiences"].update_one({"_id": oid, "tenant_id": tenant_id}, {"$set": doc})
    else:
        doc.update({"created_at": _now(), "created_by": by})
        oid = (await db["comm_audiences"].insert_one(doc)).inserted_id
    return {"ok": True, "audience_id": str(oid)}


async def listing(tenant_id: str) -> list[dict]:
    db = shared_db()
    out = []
    async for a in db["comm_audiences"].find({"tenant_id": tenant_id}).sort("updated_at", -1):
        try:
            n = len(await resolve(tenant_id, a.get("rules") or {},
                                  purpose="care" if a.get("clinical") else "commercial"))
        except Exception:                                  # noqa: BLE001
            n = 0
        out.append({"_id": str(a["_id"]), "name": a.get("name"), "rules": a.get("rules"),
                    "clinical": bool(a.get("clinical")), "count": n})
    return out


async def delete(tenant_id: str, audience_id: str) -> dict:
    oid = _oid(audience_id)
    if not oid:
        return {"ok": False, "error": "bad_id"}
    await shared_db()["comm_audiences"].delete_one({"_id": oid, "tenant_id": tenant_id})
    return {"ok": True}
