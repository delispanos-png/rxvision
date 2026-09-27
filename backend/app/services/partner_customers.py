"""Αντιστοίχιση «πελάτης εμπορικού προγράμματος» ↔ «ασθενής RxVision».

ΤΟ ΠΡΟΒΛΗΜΑ: το εμπορικό πρόγραμμα ξέρει τον πελάτη με ΤΟ ΔΙΚΟ ΤΟΥ κωδικό (`customer_ref`).
Εμείς τον ξέρουμε ως εγγραφή `patients_anonymized`. Χωρίς γέφυρα, το καλάθι που μας στέλνουν
είναι ανώνυμο — άρα δεν πιστώνονται πόντοι και δεν ελέγχεται η αγωγή του.

ΤΟ ΣΧΕΔΙΟ: η γέφυρα χτίζεται ΜΙΑ ΦΟΡΑ ανά πελάτη, ρητά, με ταυτοποιητικό στοιχείο (ΑΜΚΑ ή
κινητό) — και από 'κει και πέρα ΟΛΕΣ οι κλήσεις χρησιμοποιούν τον ΔΙΚΟ ΤΟΥ κωδικό. Έτσι:

  • Κανένα δικό μας εσωτερικό id δεν φεύγει ΠΟΤΕ από το API (ούτε `_id`, ούτε ψευδώνυμο).
  • Το ΑΜΚΑ ταξιδεύει ΜΟΝΟ στη στιγμή της σύνδεσης, πίσω από το ευαίσθητο δικαίωμα
    `patients:read` (που απαιτεί ρητή αποδοχή GDPR από τον φαρμακοποιό) — όχι σε κάθε πώληση.
  • Η αποσύνδεση σβήνει τη γέφυρα και τίποτα άλλο: τα δεδομένα υγείας δεν τα αγγίζει.

ΤΕΝΑΝΤ: κάθε ερώτημα εδώ γράφει `tenant_id` ΡΗΤΑ. Η γέφυρα είναι ακριβώς το σημείο όπου ένα
ξεχασμένο φίλτρο θα έδινε στο φαρμακείο Α τον πελάτη του φαρμακείου Β — γι' αυτό δεν υπάρχει
ούτε ένα ερώτημα χωρίς αυτό.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from app.core.db import shared_db

COLL = "partner_customers"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _phone_variants(raw: str) -> list[str]:
    """Το ίδιο κινητό γράφεται με χίλιους τρόπους (+30, 0030, κενά, παύλες). Ταιριάζουμε στα
    ΤΕΛΕΥΤΑΙΑ 10 ψηφία — αρκετά για να είναι μοναδικό στην Ελλάδα, ανεκτικά σε πρόθεμα χώρας."""
    d = _digits(raw)
    if len(d) < 10:
        return []
    tail = d[-10:]
    return [tail, f"+30{tail}", f"30{tail}", f"0030{tail}"]


async def resolve(tenant_id: str, *, amka: str | None = None,
                  phone: str | None = None) -> tuple[str | None, str | None]:
    """(patient_ref, method) από ταυτοποιητικό στοιχείο. (None, λόγος) αν δεν βρεθεί.

    Σειρά: ΑΜΚΑ πρώτα (μοναδικό εξ ορισμού), κινητό μετά (μπορεί να είναι κοινό σε οικογένεια —
    γι' αυτό ΑΡΝΟΥΜΑΣΤΕ τη σύνδεση αν ταιριάξουν πολλοί, αντί να μαντέψουμε λάθος πρόσωπο)."""
    db = shared_db()
    if amka and _digits(amka):
        p = await db["patients_anonymized"].find_one(
            {"tenant_id": tenant_id, "amka": _digits(amka)}, {"_id": 1})
        if p:
            return str(p["_id"]), "amka"
        return None, "amka_not_found"
    if phone:
        variants = _phone_variants(phone)
        if not variants:
            return None, "phone_invalid"
        hits = [c async for c in db["patient_contacts"].find(
            {"tenant_id": tenant_id,
             "$or": [{"mobile": {"$in": variants}}, {"phone": {"$in": variants}}]},
            {"_id": 1}).limit(3)]
        if not hits:
            return None, "phone_not_found"
        if len(hits) > 1:
            # Κοινό τηλέφωνο (οικογένεια). Λάθος σύνδεση εδώ = πόντοι και ΑΓΩΓΗ σε άλλο πρόσωπο.
            return None, "phone_ambiguous"
        return str(hits[0]["_id"]), "phone"
    return None, "no_identifier"


async def link(tenant_id: str, customer_ref: str, patient_ref: str, *,
               method: str, api_key_id: str | None = None) -> None:
    await shared_db()[COLL].update_one(
        {"tenant_id": tenant_id, "customer_ref": customer_ref},
        {"$set": {"patient_ref": patient_ref, "method": method,
                  "api_key_id": api_key_id, "linked_at": _now()},
         "$setOnInsert": {"tenant_id": tenant_id, "customer_ref": customer_ref}},
        upsert=True)


async def patient_ref_for(tenant_id: str, customer_ref: str | None) -> str | None:
    """Ο δικός μας ασθενής για τον κωδικό πελάτη του συνεργάτη — ή None αν δεν έχει συνδεθεί.
    ΣΙΩΠΗΛΟ None (όχι σφάλμα): μια πώληση ΔΕΝ πρέπει ποτέ να απορριφθεί επειδή ο πελάτης δεν
    είναι συνδεδεμένος — απλώς δεν κερδίζει πόντους."""
    if not customer_ref:
        return None
    doc = await shared_db()[COLL].find_one(
        {"tenant_id": tenant_id, "customer_ref": str(customer_ref)}, {"patient_ref": 1})
    return doc.get("patient_ref") if doc else None


async def unlink(tenant_id: str, customer_ref: str) -> bool:
    res = await shared_db()[COLL].delete_one(
        {"tenant_id": tenant_id, "customer_ref": str(customer_ref)})
    return bool(res.deleted_count)
