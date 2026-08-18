"""Φάση C — συγχρονισμός στοιχείων που διορθώνει Ο ΙΔΙΟΣ Ο ΠΕΛΑΤΗΣ από την πύλη my.rxvision
(global `patient_accounts`) πίσω στην καρτέλα ΚΑΘΕ φαρμακείου (`patient_contacts`, ανά tenant),
με προέλευση `patient` (η GDPR-καθαρή διαδρομή: αυτο-παρεχόμενα + αυτο-επιβεβαιωμένα).

Ταίριασμα με ΑΜΚΑ → βρίσκει όλα τα φαρμακεία όπου υπάρχει ο ασθενής και ενημερώνει την καρτέλα
του σε καθένα. Το `marketing_consent` συγχρονίζεται ΜΟΝΟ όταν ο πελάτης το άλλαξε ρητά (ώστε μια
απλή διόρθωση διεύθυνσης να μη σβήσει συγκατάθεση που έδωσε ο φαρμακοποιός στο ταμείο)."""

from __future__ import annotations

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db
from app.repositories.contacts import PatientContactRepository


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(v)
    except (InvalidId, TypeError):
        return None


async def sync_from_account(account_id, *, verify: bool = True,
                            include_consent: bool = False) -> dict:
    """Διάδοση των στοιχείων επικοινωνίας ενός portal account σε όλες τις καρτέλες φαρμακείων
    (patient_contacts) με ίδιο ΑΜΚΑ. `verify` → μαρκάρει την καρτέλα ως επιβεβαιωμένη από πελάτη.
    `include_consent` → συγχρονίζει και το marketing_consent (μόνο σε ρητή αλλαγή συγκατάθεσης)."""
    oid = _oid(account_id)
    if not oid:
        return {"synced": 0}
    db = shared_db()
    acc = await db["patient_accounts"].find_one({"_id": oid})
    if not acc:
        return {"synced": 0}
    amka = str(acc.get("amka") or "").strip()
    if not amka:
        return {"synced": 0}

    phone = str(acc.get("phone") or "").strip()
    email = str(acc.get("email") or "").strip().lower()
    is_mobile = phone.startswith("69") and len(phone) == 10
    data: dict = {}
    if phone:
        data["mobile" if is_mobile else "phone"] = phone
    if email:
        data["email"] = email
    for k in ("address", "city", "postal_code"):
        if acc.get(k):
            data[k] = acc[k]
    if include_consent:
        mk = (acc.get("consents") or {}).get("marketing") or {}
        data["marketing_consent"] = bool(mk.get("granted"))
    if not data:
        return {"synced": 0}

    targets = await db["patients_anonymized"].find(
        {"amka": amka}, {"_id": 1, "tenant_id": 1}).to_list(length=None)
    synced = 0
    for tgt in targets:
        await PatientContactRepository(tenant_id=tgt["tenant_id"]).save_contact(
            str(tgt["_id"]), dict(data), source="patient", verify=verify)
        synced += 1
    return {"synced": synced, "amka": amka}
