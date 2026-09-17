"""Προβολή leads — χτίζει την ΕΝΙΑΙΑ εικόνα από τις πηγές που ήδη υπάρχουν.

ΓΙΑΤΙ ΠΡΟΒΟΛΗ ΚΑΙ ΟΧΙ ΑΝΤΙΓΡΑΦΟ: αν αντιγράψουμε ονόματα, emails και ημερομηνίες λήξης σε
δικό μας πίνακα, την επόμενη μέρα ο πίνακας λέει άλλα από τη συνδρομή. Άρα η `leads` κρατά
μόνο ό,τι ΔΕΝ υπάρχει αλλού (κατάσταση πωλήσεων, ετικέτες, ανάθεση, σημειώσεις) και όλα τα
υπόλοιπα ξαναγράφονται από την πηγή σε κάθε πέρασμα, σημειωμένα ως cache.

ΤΟ ΠΡΟΒΛΗΜΑ ΠΟΥ ΛΥΝΕΙ: η παλιά `trial_leads` γέμιζε ΜΟΝΟ από την `purge_expired_trials`,
δηλαδή 20+ ημέρες μετά τη λήξη, τη στιγμή που ο λογαριασμός διαγραφόταν. Τα φαρμακεία με
ληγμένη δοκιμαστική και ζωντανό λογαριασμό — τα θερμότερα leads — δεν εμφανίζονταν πουθενά.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.services.leads import config as cfg
from app.services.leads import scoring, timeline

COLL = "leads"

# Στάδια λογαριασμού (αυτόματα — κανείς δεν τα θέτει με το χέρι)
SIGNUP_ABANDONED, TRIAL_ACTIVE, TRIAL_ENDING, TRIAL_EXPIRED = (
    "signup_abandoned", "trial_active", "trial_ending", "trial_expired")
TRIAL_PURGED, CHURNED, CUSTOMER = "trial_purged", "churned", "customer"

STAGE_LABEL = {
    SIGNUP_ABANDONED: "Δεν ολοκλήρωσε την εγγραφή",
    TRIAL_ACTIVE: "Δοκιμάζει", TRIAL_ENDING: "Η δοκιμή τελειώνει",
    TRIAL_EXPIRED: "Η δοκιμή έληξε", TRIAL_PURGED: "Ο λογαριασμός διαγράφηκε",
    CHURNED: "Ήταν πελάτης, έφυγε", CUSTOMER: "Πελάτης",
}

# Περιοχές προϊόντος από τη διαδρομή του audit. Κρατάμε ΜΟΝΟ την κατηγορία — ποτέ ολόκληρη
# τη διαδρομή, γιατί κάποιες περιέχουν patient_id (κανένα δεδομένο ασθενή στο Lead Engine).
_AREA = {
    "reimbursement": "Αποζημίωση", "patient-intelligence": "Εικόνα πελάτη",
    "patients": "Πελάτες", "prescriptions": "Συνταγές", "loyalty": "Πιστότητα",
    "catalog": "Κατάλογος", "shop": "e-shop", "orders": "Παραγγελίες",
    "copilot": "Copilot", "pharmacat": "PharmaCat", "communications": "Επικοινωνία",
    "vaccinations": "Εμβολιασμοί", "coach": "Σύμβουλος", "ingestion": "Δεδομένα ΗΔΥΚΑ",
    "reports": "Αναφορές", "analytics": "Στατιστικά", "optical": "Οπτικός έλεγχος",
}
_PATH = re.compile(r"/api/v1/([a-z0-9-]+)")

# Η ίδια η CloudOn δεν είναι lead. Χωρίς αυτό, η δοκιμαστική εγγραφή της εταιρείας μας
# εμφανίζεται στη λίστα πωλήσεων σαν υποψήφιος πελάτης.
_OUR_DOMAINS = ("cloudon.gr", "rxvision.gr")


def _is_ours(email: str | None, name: str | None) -> bool:
    e = (email or "").lower()
    return any(e.endswith("@" + d) for d in _OUR_DOMAINS) or "cloudon" in (name or "").lower()


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _aware(dt):
    if isinstance(dt, datetime):
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None


def _days_between(a, b) -> int | None:
    a, b = _aware(a), _aware(b)
    return (b.date() - a.date()).days if a and b else None


def lead_key(afm: str | None, email: str | None, tenant_id: str | None) -> str:
    """Σταθερό κλειδί σε όλη τη ζωή του lead: ΑΦΜ → email → tid:<tenant>.

    Έτσι ένα φαρμακείο που δοκίμασε, διαγράφηκε και ξαναγράφτηκε είναι Ο ΙΔΙΟΣ lead με
    ενιαίο ιστορικό. Οι υπάρχουσες εγγραφές `trial_leads` έχουν ήδη ακριβώς αυτό το `_id`.
    """
    return ((afm or "").strip() or (email or "").strip().lower()
            or (f"tid:{tenant_id}" if tenant_id else ""))


# ── ΣΗΜΑΤΑ ΔΡΑΣΤΗΡΙΟΤΗΤΑΣ ───────────────────────────────────────────────────────────────────
async def _activity_by_tenant(db, since: datetime) -> dict:
    """Ενέργειες ανά φαρμακείο από τα audit_logs — η ΜΟΝΗ μόνιμη πηγή συμπεριφοράς.

    (Τα `user_sessions` έχουν TTL 15′ — άχρηστα ως ιστορικό.)
    """
    out: dict = {}
    cutoff30 = _now() - timedelta(days=30)
    async for r in db["audit_logs"].find(
            {"at": {"$gte": since}, "tenant_id": {"$ne": None}},
            {"tenant_id": 1, "action": 1, "at": 1}):
        tid = r["tenant_id"]
        a = out.setdefault(tid, {"total": 0, "n30": 0, "days30": set(),
                                 "areas": set(), "last": None, "hdika": False,
                                 "day_set": set()})
        at = _aware(r.get("at"))
        a["total"] += 1
        if at:
            a["day_set"].add(at.date())
            if a["last"] is None or at > a["last"]:
                a["last"] = at
            if at >= cutoff30:
                a["n30"] += 1
                a["days30"].add(at.date())
        m = _PATH.search(r.get("action") or "")
        seg = m.group(1) if m else None
        if seg in _AREA:
            a["areas"].add(_AREA[seg])
        if seg == "ingestion" and "credentials" in (r.get("action") or ""):
            a["hdika"] = True          # έβαλε τους κωδικούς του → δοκιμάζει στα σοβαρά
    return out


def _returned_gap(day_set: set, last) -> int | None:
    """Ξαναμπήκε μετά από σιωπή; Επιστρέφει το μέγεθος της τελευταίας σιωπής σε ημέρες.

    Σήμα «δεν έφυγε, σκέφτεται» — από τα ισχυρότερα για το πότε αξίζει τηλέφωνο.
    """
    if not day_set or not last:
        return None
    days = sorted(day_set)
    if len(days) < 2:
        return None
    gap = (days[-1] - days[-2]).days
    return gap if gap >= 7 else None


# ── ΤΑΥΤΟΤΗΤΑ ΦΑΡΜΑΚΕΙΟΥ ────────────────────────────────────────────────────────────────────
def _identity(t: dict) -> dict:
    bp, comp = (t.get("billing_profile") or {}), (t.get("company") or {})
    g = lambda *ks: next((str(v).strip() for k in ks                      # noqa: E731
                          for v in (bp.get(k), comp.get(k), t.get(k)) if v and str(v).strip()), None)
    email = g("email", "billing_email", "contact_email")
    return {
        "afm": g("afm"),
        "email": email.lower() if email else None,
        "phone": g("phone", "contact_phone"),
        "contact_name": g("name"),
        "pharmacy_name": t.get("name") or g("title"),
        "city": g("city"),
        "country": t.get("country", "GR"),
    }


# ── ΤΟ ΠΕΡΑΣΜΑ ──────────────────────────────────────────────────────────────────────────────
async def project() -> dict:
    """Ξαναχτίζει την προβολή από όλες τις πηγές. Ιδεμποτεντική — τρέχει κάθε ώρα.

    ΓΡΑΦΕΙ ΜΟΝΟ cache πεδία (stage/trial/activity/score/identity). ΔΕΝ αγγίζει ποτέ
    `status`, `tags`, `assigned_to`, `trial_allowed` — αυτά είναι ανθρώπινες αποφάσεις.
    """
    db = shared_db()
    now = _now()
    c = await cfg.get()
    acts = await _activity_by_tenant(db, now - timedelta(days=180))
    seen: set = set()
    stats = {"tenants": 0, "abandoned": 0, "archived": 0, "total": 0}

    # 1) Φαρμακεία με ζωντανό λογαριασμό (η πηγή που ΕΛΕΙΠΕ εντελώς)
    async for t in db["tenants"].find({}):
        tid = t["_id"]
        sub = await db["subscriptions"].find_one({"tenant_id": tid}) or {}
        ident = _identity(t)
        if not ident["email"]:
            u = await db["users"].find_one({"tenant_id": tid}, {"email": 1, "full_name": 1},
                                           sort=[("created_at", 1)])
            if u:
                ident["email"] = (u.get("email") or "").strip().lower() or None
                ident["contact_name"] = ident["contact_name"] or u.get("full_name")
        key = lead_key(ident["afm"], ident["email"], tid)
        if not key or _is_ours(ident["email"], ident["pharmacy_name"]):
            continue
        stage, trial = _stage_for(sub, c, now)
        act = await _activity_for(db, tid, acts.get(tid), now)
        await _upsert(db, key, source="trial", tenant_id=tid, ident=ident, stage=stage,
                      trial=trial, activity=act, sub=sub, c=c, now=now)
        seen.add(key)
        stats["tenants"] += 1

    # 2) Ημιτελείς εγγραφές — έφτασαν στο ταμείο και δεν πλήρωσαν. Δεν φαίνονταν πουθενά.
    cutoff = now - timedelta(hours=int(c["signup_abandoned_hours"]))
    async for p in db["pending_registrations"].find(
            {"created_at": {"$lte": cutoff}, "status": {"$nin": ["completed", "paid"]}}):
        comp = p.get("company") or {}
        ident = {
            "afm": (comp.get("afm") or "").strip() or None,
            "email": (p.get("owner_email") or comp.get("email") or "").strip().lower() or None,
            "phone": (comp.get("phone") or "").strip() or None,
            "contact_name": p.get("owner_name") or comp.get("name"),
            "pharmacy_name": p.get("pharmacy_name") or comp.get("title"),
            "city": (comp.get("city") or "").strip() or None,
            "country": p.get("country", "GR"),
        }
        key = lead_key(ident["afm"], ident["email"], None)
        if not key or key in seen or _is_ours(ident["email"], ident["pharmacy_name"]):
            continue                     # ολοκλήρωσε αργότερα → ο tenant υπερισχύει
        await _upsert(db, key, source="signup_abandoned", tenant_id=None, ident=ident,
                      stage=SIGNUP_ABANDONED,
                      trial={"started_at": None, "ends_at": None, "duration_days": None,
                             "days_left": None, "days_since_expiry": None, "bucket": None},
                      activity={"last_login_at": None, "last_action_at": None,
                                "days_since_activity": None, "actions_30d": 0,
                                "actions_total": 0, "active_days_30d": 0, "features": [],
                                "data_connected": False, "returned_after_days": None},
                      sub={}, c=c, now=now,
                      extra_flags={"reached_checkout": True,
                                   "package": p.get("package_code"),
                                   "amount_cents": p.get("amount_cents")})
        seen.add(key)
        stats["abandoned"] += 1

    # 3) Αρχειοθετημένα (διαγραμμένος λογαριασμός) — οι υπάρχουσες εγγραφές
    async for old in db[COLL].find({"_id": {"$nin": list(seen)}}):
        act = old.get("activity")
        if act:
            score = scoring.compute(act, {"never_logged_in": not act.get("last_login_at"),
                                          "data_connected": bool(act.get("data_connected"))},
                                    c["weights"])
        else:
            # Ο λογαριασμός διαγράφηκε ΠΡΙΝ υπάρξει το Lead Engine — η δραστηριότητά του
            # χάθηκε μαζί του. «0» θα ήταν ψέμα: δεν σημαίνει «δεν το χρησιμοποίησε»,
            # σημαίνει «δεν το ξέρουμε». Βλ. κανόνα «καμία ψεύτικη μέτρηση».
            score = {"value": None, "band": "unknown", "band_label": "Δεν το ξέρουμε πια",
                     "signals": [{"key": "no_history", "points": 0,
                                  "why": "Ο λογαριασμός διαγράφηκε πριν αρχίσουμε να μετράμε"}]}
        stage = old.get("stage") or TRIAL_PURGED
        if stage not in (TRIAL_PURGED, CHURNED, SIGNUP_ABANDONED):
            stage = TRIAL_PURGED         # δεν έχει πια tenant → ο λογαριασμός έφυγε
        await db[COLL].update_one({"_id": old["_id"]}, {"$set": {
            "stage": stage, "stage_label": STAGE_LABEL[stage],
            "score": {**score, "computed_at": now}, "tenant_id": None, "updated_at": now}})
        stats["archived"] += 1

    stats["total"] = await db[COLL].count_documents({})
    await db["platform_settings"].update_one(
        {"_id": cfg.SETTINGS_ID}, {"$set": {"last_projection_at": now}}, upsert=True)
    return stats


def _stage_for(sub: dict, c: dict, now: datetime) -> tuple[str, dict]:
    """Στάδιο λογαριασμού — ΜΟΝΗ πηγή αλήθειας το `billing_service.effective_status`."""
    from app.services.billing_service import effective_status
    st = effective_status(sub or None)
    started = _aware((sub or {}).get("started_at") or (sub or {}).get("created_at"))
    is_trial_plan = (sub or {}).get("plan") == "trial" or (sub or {}).get("status") in (
        "trial", "trialing")
    ends = _aware((sub or {}).get("trial_ends_at") if is_trial_plan else None) \
        or _aware((sub or {}).get("current_period_end"))

    trial = {
        "started_at": started, "ends_at": ends,
        "duration_days": _days_between(started, ends),
        "days_left": _days_between(now, ends),
        "days_since_expiry": None, "bucket": None,
    }
    if st == "active":
        return (CUSTOMER if not is_trial_plan else TRIAL_ACTIVE), trial
    if st == "trial":
        left = trial["days_left"]
        return (TRIAL_ENDING if left is not None and left <= int(c["trial_ending_days"])
                else TRIAL_ACTIVE), trial
    # ληγμένη / past_due / suspended / cancelled
    since = _days_between(ends, now)
    trial["days_since_expiry"] = since
    if since is not None:
        for b in sorted(int(x) for x in c["expired_buckets"]):
            if since <= b:
                trial["bucket"] = str(b)
                break
        else:
            trial["bucket"] = "90+"
    return (TRIAL_EXPIRED if is_trial_plan else CHURNED), trial


async def _activity_for(db, tenant_id: str, raw: dict | None, now: datetime) -> dict:
    last_login = None
    async for u in db["users"].find({"tenant_id": tenant_id}, {"last_login_at": 1}):
        ll = _aware(u.get("last_login_at"))
        if ll and (last_login is None or ll > last_login):
            last_login = ll
    raw = raw or {}
    last_action = raw.get("last")
    newest = max([d for d in (last_login, last_action) if d], default=None)
    return {
        "last_login_at": last_login, "last_action_at": last_action,
        "days_since_activity": _days_between(newest, now) if newest else None,
        "actions_30d": raw.get("n30", 0), "actions_total": raw.get("total", 0),
        "active_days_30d": len(raw.get("days30") or ()),
        "features": sorted(raw.get("areas") or ()),
        "data_connected": bool(raw.get("hdika")),
        "returned_after_days": _returned_gap(raw.get("day_set") or set(), last_action),
    }


async def _upsert(db, key: str, *, source: str, tenant_id, ident: dict, stage: str,
                  trial: dict, activity: dict, sub: dict, c: dict, now: datetime,
                  extra_flags: dict | None = None) -> None:
    old = await db[COLL].find_one({"_id": key}) or {}
    extra_flags = extra_flags or {}

    asked_demo = bool(await db["announcement_requests"].count_documents(
        {"tenant_id": tenant_id}, limit=1)) if tenant_id else False
    flags = {
        "data_connected": activity["data_connected"],
        "asked_for_demo": asked_demo,
        "reached_checkout": bool(extra_flags.get("reached_checkout")),
        "never_logged_in": tenant_id is not None and not activity["last_login_at"],
    }
    score = scoring.compute(activity, flags, c["weights"])

    set_doc: dict = {
        "source": old.get("source") or source,
        "tenant_id": tenant_id,
        "stage": stage, "stage_label": STAGE_LABEL[stage],
        "trial": trial, "activity": activity,
        "score": {**score, "computed_at": now},
        "updated_at": now,
        **{k: v for k, v in ident.items() if v},      # μη σβήνεις στοιχείο που συμπλήρωσε άνθρωπος
    }
    if extra_flags.get("package"):
        set_doc["signup"] = {"package": extra_flags.get("package"),
                             "amount_cents": extra_flags.get("amount_cents")}
    if stage == CUSTOMER and (old.get("conversion") is None):
        set_doc["conversion"] = {
            "at": now, "tenant_id": tenant_id, "plan": (sub or {}).get("plan"),
            "cycle": (sub or {}).get("billing_cycle"),
            "attribution": {"model": "last_touch", "detected_by": "projection"},
        }
        set_doc["status"] = "won"

    on_insert = {"status": "new", "tags": [], "assigned_to": None,
                 "consent": {"marketing": None, "source": None, "at": None},
                 "unsubscribed_at": None, "suppressed": False,
                 "comms": {}, "offers": {}, "next_action": None,
                 "created_at": now}
    # Η Mongo απορρίπτει το ίδιο πεδίο σε $set και $setOnInsert. Όταν η προβολή ορίζει
    # `status` (μετατροπή σε πελάτη), υπερισχύει αυτή.
    on_insert = {k: v for k, v in on_insert.items() if k not in set_doc}
    await db[COLL].update_one({"_id": key},
                              {"$set": set_doc, "$setOnInsert": on_insert}, upsert=True)

    await _emit_transitions(key, old, stage, trial, activity, now)


async def _emit_transitions(key: str, old: dict, stage: str, trial: dict,
                            activity: dict, now: datetime) -> None:
    """Γεγονότα από τη ΣΥΓΚΡΙΣΗ με το προηγούμενο πέρασμα — εδώ γεννιέται το χρονολόγιο."""
    prev = old.get("stage")
    if not old:
        await timeline.record(key, "lead.created", "Μπήκε στη λίστα")
    if prev != stage:
        if stage == TRIAL_ENDING:
            left = trial.get("days_left")
            await timeline.record(key, "trial.expiring",
                                  f"Η δοκιμή τελειώνει σε {left} ημέρες" if left is not None
                                  else "Η δοκιμή τελειώνει")
        elif stage == TRIAL_EXPIRED:
            await timeline.record(key, "trial.expired", "Η δοκιμή έληξε")
        elif stage == CUSTOMER and prev:
            await timeline.record(key, "lead.converted", "Έγινε πελάτης")
        elif stage == TRIAL_ACTIVE and not prev:
            await timeline.record(key, "trial.started", "Ξεκίνησε δοκιμαστική")
    gap = activity.get("returned_after_days")
    if gap and (old.get("activity") or {}).get("returned_after_days") != gap:
        await timeline.record(key, "lead.returned",
                              f"Ξαναμπήκε μετά από {int(gap)} ημέρες σιωπής")
    if activity.get("actions_30d"):
        await timeline.record(key, "lead.activity",
                              f"{activity['actions_30d']} ενέργειες τον τελευταίο μήνα",
                              data={"features": activity.get("features")}, dedupe=True)
