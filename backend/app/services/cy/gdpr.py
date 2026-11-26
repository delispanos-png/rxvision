"""GDPR για τα κυπριακά δεδομένα (`cy_patients`, `cy_dispensings`).

Το κοινό `services/gdpr_service.py` δρομολογεί εδώ κάθε υποκείμενο με id `cy:<pseudo_id>`.
Ίδιοι κανόνες με την Ελλάδα: εξαγωγή = ό,τι κρατάμε· διαγραφή = αφαίρεση άμεσων αναγνωριστικών,
ΜΕ νόμιμη διατήρηση (legal hold) των εκτελέσεων, που κρατούν μόνο ψευδώνυμο + κλινικά στοιχεία.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from app.repositories.base import jsonsafe
from app.repositories.cy import CyDispensingRepository, CyPatientRepository, find_all

PREFIX = "cy:"
DIRECT_IDENTIFIERS = ("full_name", "dob", "hio_code", "contact", "notify_prefs")


def is_cy(subject_id: str) -> bool:
    return str(subject_id or "").startswith(PREFIX)


def _ref(subject_id: str) -> str:
    return str(subject_id)[len(PREFIX):]


async def search(tenant_id: str, q: str, *, limit: int = 20) -> list[dict]:
    rx = {"$regex": re.escape(q), "$options": "i"}
    return [{"id": PREFIX + p["pseudo_id"], "name": p.get("full_name"), "age_group": None,
             "erased": bool(p.get("erased")), "source": "ΓεΣΥ"}
            for p in await CyPatientRepository(tenant_id=tenant_id).find({"full_name": rx}, limit=limit)]


async def export(tenant_id: str, subject_id: str) -> dict:
    ref = _ref(subject_id)
    patient = await CyPatientRepository(tenant_id=tenant_id).find_one({"pseudo_id": ref})
    if not patient:
        raise LookupError("subject_not_found")
    disp = await find_all(CyDispensingRepository(tenant_id=tenant_id), {"patient_ref": ref},   # GDPR: ΠΛΗΡΗΣ εξαγωγή
                          sort=[("dispensed_at", -1)])
    notes = await _notes(tenant_id, ref)
    return jsonsafe({
        "exported_at": datetime.now(tz=timezone.utc).isoformat(),
        "subject_id": subject_id, "tenant_id": tenant_id,
        "identity": patient, "cy_dispensings": disp, "pharmacist_notes": notes,
        "counts": {"dispensings": len(disp), "notes": len(notes)},
    })


async def _notes(tenant_id: str, ref: str) -> list[dict]:
    """Σχόλια φαρμακοποιού (κοινό `patient_notes`, μέσω της καρτέλας-γέφυρας του πελάτη ΓεΣΥ)."""
    from app.core.db import shared_db
    from app.repositories.patient_portal import PatientAccountRepository
    shell = await PatientAccountRepository().cy_shell_id(tenant_id, ref)
    if not shell:
        return []
    return [{"text": n.get("text"), "at": n.get("at")} async for n in shared_db()["patient_notes"].find(  # tenant-ok
        {"tenant_id": tenant_id, "patient_ref": shell}).sort("at", -1)]


async def erase(tenant_id: str, subject_id: str) -> dict:
    ref = _ref(subject_id)
    repo = CyPatientRepository(tenant_id=tenant_id)
    if not await repo.find_one({"pseudo_id": ref}):
        raise LookupError("subject_not_found")
    now = datetime.now(tz=timezone.utc)
    from app.core.db import shared_db
    from app.repositories.patient_portal import PatientAccountRepository
    shell = await PatientAccountRepository().cy_shell_id(tenant_id, ref)
    if shell:                    # τα σχόλια είναι ελεύθερο κείμενο → μπορεί να ταυτοποιούν: διαγράφονται
        await shared_db()["patient_notes"].delete_many({"tenant_id": tenant_id, "patient_ref": shell})  # tenant-ok
    await repo.update_one({"pseudo_id": ref},
                          {"$unset": {**{f: "" for f in DIRECT_IDENTIFIERS}, "clinical": ""},
                           "$set": {"erased": True, "erased_at": now, "processing_restricted": True}})
    return {"subject_id": subject_id, "identifiers_stripped": list(DIRECT_IDENTIFIERS),
            "legal_hold_kept": ["cy_dispensings"], "erased_at": now.isoformat()}
