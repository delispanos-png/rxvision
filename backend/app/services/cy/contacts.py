"""Στοιχεία επικοινωνίας, συγκατάθεση και κοινό μηνυμάτων για τους πελάτες ΓεΣΥ.

Το XML ΓεΣΥ δεν έχει τηλέφωνο ή email. Τα στοιχεία τα γράφει ο φαρμακοποιός (Καρτέλα πελάτη) ή ο
ίδιος ο πελάτης από την πύλη, και ζουν στο `cy_patients.contact`, ΠΟΤΕ στα ελληνικά
`patient_contacts`/`patients_anonymized`.

Η αποστολή (χρέωση, ουρά, ιδιοπάθεια, υποσέλιδο διαγραφής, προτιμήσεις πελάτη) είναι η ΚΟΙΝΗ:
`campaign_engine` + `comms.send_*`. Εδώ ζει μόνο το «ποιος» για την Κύπρο. Οι παραλήπτες
δηλώνονται με `patient_ref = "cy:<pseudo_id>"`, ώστε κάθε κοινός έλεγχος (προτιμήσεις,
διαγραφή, ιστορικό) να ξέρει ότι μιλά για κυπριακό πελάτη.

Κανόνες (ίδιοι με την Ελλάδα):
- ΚΑΝΕΝΑ μήνυμα χωρίς ρητή συγκατάθεση (`marketing_consent`) ή μετά από «δεν θέλω άλλα».
- Κοινά με βάση δεδομένα υγείας (συνταγές, αναλώσιμα) → μόνο για μηνύματα φροντίδας, ποτέ με κουπόνι.
- Όριο προωθητικών ανά μήνα (anti-fatigue) από τη ρύθμιση του φαρμακείου.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from app.core.db import shared_db
from app.repositories.cy import CyPatientRepository
from app.services.cy import chains as ch

PREFIX = "cy:"
CHANNELS = ("sms", "viber", "email", "push")
# Κοινό → (ελληνική/αγγλική ετικέτα, είναι δεδομένα υγείας;)
SEGMENTS: dict[str, tuple[str, str, bool]] = {
    "all": ("Όλοι με συγκατάθεση", "Everyone with consent", False),
    "recent": ("Ήρθαν τους τελευταίους 90 ημέρες", "Visited in the last 90 days", False),
    "inactive": ("Δεν έχουν έρθει 90+ ημέρες", "No visit for 90+ days", False),
    "soon": ("Η επόμενη φάση τους έρχεται σε 7 ημέρες", "Next step due within 7 days", True),
    "late": ("Καθυστερούν για την επόμενη φάση", "Late for their next step", True),
    "lost": ("Χαμένοι πελάτες (συνταγή που δεν συνεχίστηκε)", "Lost customers (prescription not continued)", True),
    "diabetic": ("Διαβητικοί (από αναλώσιμα)", "Diabetics (from consumables)", True),
}
# Θεραπευτικά κοινά (Φάση 3): ίδιες 10 κατηγορίες με την Ελλάδα, από τον ATC των φαρμάκων που ΠΗΡΑΝ.
# Δεδομένα υγείας → ΠΑΝΤΑ μόνο μήνυμα φροντίδας.
_THERAPY_EN = {"diabetes": "Diabetes", "hypertension": "Hypertension", "cardio": "Cardiology",
               "cholesterol": "Cholesterol", "thyroid": "Thyroid", "respiratory": "Respiratory",
               "allergy": "Allergies", "psych": "Neuro/Psych", "osteo": "Osteoporosis", "gastro": "Gastrointestinal"}


def _therapy_segments() -> dict[str, tuple[str, str, bool]]:
    from app.services.marketing import THERAPY_CATEGORIES
    return {f"therapy:{c['key']}": (f"Θεραπεία: {c['label']} (από τα φάρμακα)",
                                    f"Therapy: {_THERAPY_EN.get(c['key'], c['key'])} (from medicines)", True)
            for c in THERAPY_CATEGORIES}


SEGMENTS.update(_therapy_segments())
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def is_cy_ref(patient_ref: Any) -> bool:
    return str(patient_ref or "").startswith(PREFIX)


def norm_mobile(raw: str | None) -> str | None:
    """Κινητό σε διεθνή μορφή χωρίς «+». Κύπρος 8 ψηφία (9x), Ελλάδα 10 (69x). Αλλιώς None."""
    from app.services.comms import _normalize
    n = _normalize(raw or "")
    if re.fullmatch(r"3579\d{7}", n) or re.fullmatch(r"3069\d{8}", n):
        return n
    return None


async def _find_all(tenant_id: str, q: dict) -> list[dict]:
    """Όλοι οι πελάτες που ταιριάζουν (το `find` έχει όριο σελίδας 500)."""
    repo, out, skip = CyPatientRepository(tenant_id=tenant_id), [], 0
    while True:
        page = await repo.find(q, sort=[("_id", 1)], skip=skip, limit=500)
        out += page
        if len(page) < 500:
            return out
        skip += 500


def clinical(segment: str) -> bool:
    return SEGMENTS.get(segment, ("", "", True))[2]


# ── στοιχεία επικοινωνίας ────────────────────────────────────────────────────

async def set_contact(tenant_id: str, pseudo: str, data: dict, *, source: str) -> dict | None:
    """Αποθήκευση στοιχείων. Κενό πεδίο = διαγραφή του. Η συγκατάθεση αλλάζει ΜΟΝΟ όταν δοθεί ρητά.
    Επιστρέφει το νέο `contact` ή None αν ο πελάτης δεν υπάρχει. Άκυρο κινητό/email → ValueError."""
    repo = CyPatientRepository(tenant_id=tenant_id)
    p = await repo.find_one({"pseudo_id": pseudo})
    if not p:
        return None
    cur = dict(p.get("contact") or {})
    now = _now()
    if "mobile" in data:
        raw = (data.get("mobile") or "").strip()
        mob = norm_mobile(raw) if raw else None
        if raw and not mob:
            raise ValueError("bad_mobile")
        cur["mobile"] = mob
    if "email" in data:
        em = (data.get("email") or "").strip().lower() or None
        if em and not _EMAIL.match(em):
            raise ValueError("bad_email")
        cur["email"] = em
    if data.get("marketing_consent") is not None:
        given = bool(data["marketing_consent"])
        if given != bool(cur.get("marketing_consent")):
            cur["marketing_consent"] = given
            cur["consent_at"] = now
            cur["consent_source"] = source
        if given:   # νέα ρητή συγκατάθεση ξαναανοίγει ό,τι είχε κλείσει ο ίδιος
            cur.pop("unsubscribed_at", None)
            cur.pop("withdrawn", None)
    cur.update({"source": source, "updated_at": now})
    await repo.update_one({"pseudo_id": pseudo}, {"$set": {"contact": cur}})
    return cur


async def sync_from_account(acc: dict) -> dict:
    """Ο πελάτης άλλαξε κινητό/email/προτιμήσεις στην πύλη → η καρτέλα του φαρμακείου του.
    Ο λογαριασμός βρίσκει τον πελάτη από τον σύνδεσμο της πύλης, όχι από ΑΜΚΑ (δεν υπάρχει)."""
    from app.repositories.patient_portal import PatientAccountRepository
    from app.services import notify_prefs
    repo = PatientAccountRepository()
    synced = 0
    for link in await repo.links(acc["_id"]):
        pseudo = await repo.cy_pseudo_of(link["tenant_id"], link.get("patient_ref"))
        if not pseudo:
            continue
        data: dict[str, Any] = {}
        if acc.get("email"):
            data["email"] = acc["email"]
        if norm_mobile(acc.get("phone")):
            data["mobile"] = acc["phone"]
        if data:
            await set_contact(link["tenant_id"], pseudo, data, source="patient")
        await CyPatientRepository(tenant_id=link["tenant_id"]).update_one(
            {"pseudo_id": pseudo}, {"$set": {"notify_prefs": notify_prefs.normalize(acc.get("notify_prefs"))}})
        synced += 1
    return {"synced": synced}


async def allows(tenant_id: str, patient_ref: str, channel: str) -> bool:
    """Προτίμηση του ίδιου του πελάτη (από την πύλη). Fail-open μόνο όταν δεν έχει δηλώσει τίποτα."""
    p = await CyPatientRepository(tenant_id=tenant_id).find_one(
        {"pseudo_id": str(patient_ref)[len(PREFIX):]})
    if not p:
        return True
    if p.get("erased") or p.get("processing_restricted"):
        return False
    prefs = p.get("notify_prefs")
    return bool(prefs.get(channel, True)) if isinstance(prefs, dict) else True


async def unsubscribe(tenant_id: str, patient_ref: str, scope: str) -> bool:
    """«Δεν θέλω άλλα» από τον σύνδεσμο του email: `all` ή ένα κανάλι."""
    repo = CyPatientRepository(tenant_id=tenant_id)
    pseudo = str(patient_ref)[len(PREFIX):]
    if not await repo.find_one({"pseudo_id": pseudo}):
        return False
    now = _now()
    upd = ({"contact.unsubscribed_at": now, "contact.marketing_consent": False} if scope == "all"
           else {f"contact.withdrawn.{scope}": now})
    await repo.update_one({"pseudo_id": pseudo}, {"$set": upd})
    return True


async def is_unsubscribed(tenant_id: str, patient_ref: str) -> bool:
    p = await CyPatientRepository(tenant_id=tenant_id).find_one(
        {"pseudo_id": str(patient_ref)[len(PREFIX):]})
    return bool(((p or {}).get("contact") or {}).get("unsubscribed_at"))


# ── κοινό μηνυμάτων ──────────────────────────────────────────────────────────

async def segment_refs(tenant_id: str, segment: str, *, today: date | None = None) -> set[str] | None:
    """Οι πελάτες (pseudo_id) ενός κοινού. None = όλοι."""
    today = today or datetime.now(tz=ch.TZ).date()
    if segment == "all":
        return None
    if segment in ("recent", "inactive"):
        since = datetime.combine(today - timedelta(days=90), datetime.min.time(), tzinfo=ch.TZ)
        pats = await _find_all(tenant_id, {"last_seen": {"$gte" if segment == "recent" else "$lt": since}})
        return {p["pseudo_id"] for p in pats}
    if segment in ("soon", "late"):
        return {c["patient_ref"] for c in await ch.chains(tenant_id, today=today)
                if c["status"] == segment and c["patient_ref"]}
    if segment == "lost":
        return {i["patient_ref"] for i in (await ch.lost_customers(tenant_id, today=today))["items"]}
    if segment.startswith("therapy:"):
        from app.services.cy import marketing as cy_marketing
        key = segment.split(":", 1)[1]
        br = await cy_marketing.therapy_breakdown(tenant_id)
        if key not in br:
            raise ValueError("unknown_segment")
        return set(br[key]["patients"])
    if segment == "diabetic":
        from app.services.cy import insights
        return {p["patient_ref"] for p in (await insights.consumables(tenant_id, today=today))["patients"]
                if p["diabetic"]}
    raise ValueError("unknown_segment")


async def _capped(tenant_id: str) -> set[str]:
    """Όσοι έλαβαν ήδη τα μέγιστα προωθητικά αυτού του μήνα (ίδια ρύθμιση με την Ελλάδα)."""
    from app.services.comms import _frequency_cap
    cap = await _frequency_cap(tenant_id)
    if cap <= 0:
        return set()
    start = _now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    rows = await shared_db()["sent_messages"].aggregate([  # tenant-ok: tenant_id στο φίλτρο
        {"$match": {"tenant_id": tenant_id, "kind": {"$in": ["campaign", "routine"]}, "status": "sent",
                    "created_at": {"$gte": start}, "patient_ref": {"$regex": f"^{PREFIX}"}}},
        {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}}},
        {"$match": {"n": {"$gte": cap}}}]).to_list(length=None)
    return {r["_id"] for r in rows}


async def audience(tenant_id: str, channel: str, segment: str = "all", *,
                   today: date | None = None, only: set[str] | None = None) -> dict[str, Any]:
    """Παραλήπτες στο σχήμα που περιμένει το `campaign_engine`, μαζί με το πόσοι εξαιρέθηκαν και γιατί."""
    if channel not in CHANNELS:
        raise ValueError("bad_channel")
    refs = await segment_refs(tenant_id, segment, today=today)
    if only is not None:
        # αυτοματισμός: ΜΟΝΟ οι συγκεκριμένοι (`cy:<pseudo>`) — ποτέ όλο το κοινό
        own = {r[len(PREFIX):] for r in only if str(r).startswith(PREFIX)}
        refs = own if refs is None else (refs & own)
    # ΠΟΤΕ μήνυμα σε πελάτη που σημειώθηκε ότι απεβίωσε
    q: dict[str, Any] = {"erased": {"$ne": True}, "deceased.at": {"$exists": False}}
    if refs is not None:
        q["pseudo_id"] = {"$in": list(refs)}
    pats = await _find_all(tenant_id, q)
    capped = await _capped(tenant_id)
    rows: list[dict] = []
    why = {"no_contact": 0, "no_consent": 0, "unsubscribed": 0, "channel_off": 0, "capped": 0}
    accounts: dict[str, str] = {}
    if channel == "push":
        from app.repositories.patient_portal import PatientAccountRepository
        repo = PatientAccountRepository()
        for p in pats:
            acc = await repo.cy_account_for(tenant_id, p["pseudo_id"])
            if acc:
                accounts[p["pseudo_id"]] = str(acc["_id"])
    for p in pats:
        ref = PREFIX + p["pseudo_id"]
        c = p.get("contact") or {}
        to = accounts.get(p["pseudo_id"]) if channel == "push" else (
            c.get("email") if channel == "email" else c.get("mobile"))
        if not to:
            why["no_contact"] += 1
        elif not c.get("marketing_consent"):
            why["no_consent"] += 1
        elif c.get("unsubscribed_at"):
            why["unsubscribed"] += 1
        elif (c.get("withdrawn") or {}).get(channel) or not (p.get("notify_prefs") or {}).get(channel, True):
            why["channel_off"] += 1
        elif ref in capped:
            why["capped"] += 1
        else:
            row = {"patient_id": ref, "name": p.get("full_name")}
            row["account_id" if channel == "push" else ("email" if channel == "email" else "mobile")] = to
            rows.append(row)
    return {"segment": segment, "channel": channel, "clinical": clinical(segment),
            "candidates": len(pats), "recipients": rows, "excluded": why}
