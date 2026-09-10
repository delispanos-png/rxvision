"""Προτιμήσεις ειδοποιήσεων του ΑΣΘΕΝΗ — μία πύλη για ΟΛΑ τα κανάλια.

Ο πελάτης ελέγχει από την πύλη αν το φαρμακείο μπορεί να του στέλνει ενημερώσεις, **ανά κανάλι**:
SMS · Viber · email · ειδοποιήσεις κινητού (push). Ένας κεντρικός διακόπτης τα κλείνει όλα μαζί.

ΓΙΑΤΙ ΕΔΩ ΚΑΙ ΟΧΙ ΣΤΟΝ ΚΑΘΕ ΑΠΟΣΤΟΛΕΑ: τα μηνύματα φεύγουν από πολλά σημεία (καμπάνιες,
υπενθυμίσεις, εμβολιασμοί, διατροφή, εξαντλήσεις…). Αν ο έλεγχος ήταν στον κάθε καλούντα, θα
ξεχνιόταν σε κάποιον — και θα έφευγε μήνυμα σε πελάτη που το έχει απαγορεύσει. Ο έλεγχος μπαίνει
**μέσα** στα `comms.send_*` και στο `push_service.send_to_account`, οπότε καμία νέα διαδρομή δεν
μπορεί να τον παρακάμψει κατά λάθος.

ΤΙ ΔΕΝ ΜΠΛΟΚΑΡΕΤΑΙ (`ESSENTIAL_KINDS`): μηνύματα που απαντούν σε **δική του ενέργεια** ή αφορούν την
ασφάλεια του λογαριασμού του — κωδικοί επιβεβαίωσης, κατάσταση παραγγελίας που έκανε, ραντεβού που
έκλεισε, απάντηση σε ερώτημα διαθεσιμότητας. Χωρίς αυτά η υπηρεσία που ΖΗΤΗΣΕ δεν λειτουργεί. Αυτό
δηλώνεται ΡΗΤΑ στην πύλη, ώστε να μην είναι έκπληξη.
"""

from __future__ import annotations

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db

CHANNELS: tuple[str, ...] = ("sms", "viber", "email", "push")

# Είδη που φεύγουν ΠΑΝΤΑ (βλ. docstring). Ό,τι δεν είναι εδώ θεωρείται ενημέρωση φαρμακείου.
ESSENTIAL_KINDS: frozenset[str] = frozenset({
    "otp", "auth", "security", "password", "verify",
    "order", "order_status", "delivery", "payment", "invoice",
    "appointment", "transfer", "rx_request", "availability",
    "test", "system",
})


def defaults() -> dict:
    return {c: True for c in CHANNELS}


def normalize(raw) -> dict:
    """Ό,τι κι αν βρεθεί αποθηκευμένο → πλήρες dict με όλα τα κανάλια (default: επιτρέπεται)."""
    out = defaults()
    if isinstance(raw, dict):
        for c in CHANNELS:
            if c in raw:
                out[c] = bool(raw[c])
    return out


def is_essential(kind: str | None) -> bool:
    return str(kind or "").strip().lower() in ESSENTIAL_KINDS


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


# ── λογαριασμός πύλης (πηγή αλήθειας) ────────────────────────────────────────
async def for_account(account_id) -> dict:
    oid = _oid(account_id)
    if not oid:
        return defaults()
    acc = await shared_db()["patient_accounts"].find_one(  # tenant-ok: global portal account
        {"_id": oid}, {"notify_prefs": 1})
    return normalize((acc or {}).get("notify_prefs"))


async def set_for_account(account_id, patch: dict) -> dict:
    """Ενημέρωση προτιμήσεων + διάδοση σε ΟΛΕΣ τις καρτέλες φαρμακείων του ίδιου ΑΜΚΑ."""
    oid = _oid(account_id)
    if not oid:
        return defaults()
    cur = await for_account(oid)
    cur.update({c: bool(v) for c, v in (patch or {}).items() if c in CHANNELS})
    await shared_db()["patient_accounts"].update_one(  # tenant-ok: global portal account
        {"_id": oid}, {"$set": {"notify_prefs": cur}})
    await _propagate(oid, cur)
    return cur


async def _propagate(account_oid, prefs: dict) -> None:
    """Αντιγραφή στις καρτέλες `patient_contacts` κάθε φαρμακείου με το ίδιο ΑΜΚΑ, ώστε ο έλεγχος
    κατά την αποστολή να γίνεται τοπικά (χωρίς αντίστροφη αναζήτηση ψευδώνυμο→λογαριασμό)."""
    db = shared_db()
    acc = await db["patient_accounts"].find_one({"_id": account_oid}, {"amka": 1})  # tenant-ok
    amka = str((acc or {}).get("amka") or "").strip()
    if not amka:
        return
    targets = await db["patients_anonymized"].find(  # tenant-ok: cross-tenant fan-out by ΑΜΚΑ
        {"amka": amka}, {"_id": 1, "tenant_id": 1}).to_list(length=None)
    for t in targets:
        await db["patient_contacts"].update_one(  # tenant-ok: filtered by tenant_id below
            {"_id": t["_id"], "tenant_id": t["tenant_id"]}, {"$set": {"notify_prefs": prefs}})


# ── έλεγχοι που καλούν οι αποστολείς ─────────────────────────────────────────
async def allows_account(account_id, channel: str, kind: str = "update") -> bool:
    if is_essential(kind):
        return True
    return bool((await for_account(account_id)).get(channel, True))


async def allows_patient(tenant_id: str, patient_ref, channel: str, kind: str = "update") -> bool:
    """Επιτρέπεται αποστολή στον ασθενή `patient_ref` του `tenant_id` από αυτό το κανάλι;

    Fail-OPEN αν δεν βρεθεί καρτέλα ή προτίμηση: η προεπιλογή είναι «επιτρέπεται» (ο πελάτης δεν
    έχει δηλώσει τίποτε). Μπλοκάρουμε ΜΟΝΟ όταν υπάρχει ρητή άρνηση.
    """
    if is_essential(kind):
        return True
    oid = _oid(patient_ref)
    if not oid or not tenant_id:
        return True
    doc = await shared_db()["patient_contacts"].find_one(  # tenant-ok: tenant_id στο φίλτρο
        {"_id": oid, "tenant_id": tenant_id}, {"notify_prefs": 1})
    if not doc or not isinstance(doc.get("notify_prefs"), dict):
        return True
    return bool(doc["notify_prefs"].get(channel, True))
