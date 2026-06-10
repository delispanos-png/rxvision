"""GDPR data-subject-rights service (Art.15/16/17/18/20/21).

All access is tenant-scoped THROUGH BaseRepository (THE rule). The data subject is a
patient identified by their `patients_anonymized._id` (the same `_id` keys
`patient_contacts`, and `patient_ref` on executions / future prescriptions).

LEGAL HOLD: prescription executions/items carry a statutory pharmacy-law retention and
hold no direct identifiers (only a pseudonymous link). Erasure therefore STRIPS direct
identifiers (contact PII + name/AMKA) and keeps the pseudonymous, legally-required record
— it never hard-deletes prescription history. See docs/gdpr/retention-policy.md.
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db
from app.repositories.base import BaseRepository, jsonsafe
from app.repositories.consents import PatientConsentRepository

# Direct identifiers stripped on erasure (kept on export — the subject is entitled to them).
_DIRECT_IDENTIFIERS = ("full_name", "amka")


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(v)
    except (InvalidId, TypeError):
        return None


def _repo(tenant_id: str, collection: str) -> BaseRepository:
    """A tenant-scoped repository bound to `collection` (every query gets tenant_id)."""
    r = BaseRepository(tenant_id=tenant_id)
    r.collection_name = collection
    return r


async def audit(tenant_id: str, *, actor_user_id: str | None, action: str,
                subject_id, outcome: str = "success", **details) -> None:
    """Record a GDPR event in audit_logs (same shape as the audit middleware + subject).
    NEVER stores raw PII — only the subject's internal id and operation metadata."""
    await shared_db()["audit_logs"].insert_one({
        "tenant_id": tenant_id,
        "actor_user_id": actor_user_id,
        "action": action,                       # e.g. "gdpr.export" / "gdpr.erase"
        "category": "gdpr",
        "subject_id": str(subject_id) if subject_id else None,
        "outcome": outcome,
        "details": details or None,
        "at": datetime.now(tz=timezone.utc),
    })


async def export_subject(tenant_id: str, patient_id: str, *, actor_user_id: str | None = None) -> dict:
    """Art.15 (access) + Art.20 (portability): everything RxVision holds about one patient,
    as a structured dict. Tenant-scoped; returns jsonsafe values."""
    oid = _oid(patient_id)
    if not oid:
        raise ValueError("invalid patient_id")

    patient = await _repo(tenant_id, "patients_anonymized").find_one({"_id": oid})
    contact = await _repo(tenant_id, "patient_contacts").find_one({"_id": oid})
    executions = await _repo(tenant_id, "prescription_executions").find(
        {"patient_ref": oid}, sort=[("executed_at", -1)], limit=500)
    exec_ids = [_oid(e["_id"]) for e in executions if e.get("_id")]
    items = []
    if exec_ids:
        items = await _repo(tenant_id, "prescription_items").find(
            {"execution_id": {"$in": exec_ids}}, limit=500)
    future = await _repo(tenant_id, "future_prescriptions").find({"patient_ref": oid}, limit=500)
    consents = await PatientConsentRepository(tenant_id=tenant_id).history(oid)
    gdpr_events = await _repo(tenant_id, "audit_logs").find(
        {"subject_id": str(oid), "category": "gdpr"}, sort=[("at", -1)], limit=500)

    bundle = {
        "exported_at": datetime.now(tz=timezone.utc).isoformat(),
        "subject_id": str(oid),
        "tenant_id": tenant_id,
        "identity": patient,                 # pseudo_id, full_name, amka, sex, age_group…
        "contact": contact,                  # raw phone/email/address (pharmacist-entered)
        "prescription_executions": executions,
        "prescription_items": items,
        "future_prescriptions": future,
        "consents": consents,
        "gdpr_request_history": gdpr_events,
        "counts": {
            "executions": len(executions), "items": len(items),
            "future": len(future), "consents": len(consents),
        },
    }
    await audit(tenant_id, actor_user_id=actor_user_id, action="gdpr.export",
                subject_id=oid, executions=len(executions))
    return jsonsafe(bundle)


async def erase_subject(tenant_id: str, patient_id: str, *, actor_user_id: str | None = None,
                        reason: str | None = None) -> dict:
    """Art.17 (erasure) with LEGAL HOLD. Strips direct identifiers and contact PII; keeps
    the pseudonymous, statutorily-retained prescription record. Idempotent."""
    oid = _oid(patient_id)
    if not oid:
        raise ValueError("invalid patient_id")
    patient = await _repo(tenant_id, "patients_anonymized").find_one({"_id": oid})
    if not patient:
        raise LookupError("subject_not_found")

    now = datetime.now(tz=timezone.utc)
    # 1) Delete the raw contact record (no statutory retention on marketing/contact PII).
    contact_res = await _repo(tenant_id, "patient_contacts").delete_many({"_id": oid})
    # 2) Strip direct identifiers from the analytical record; keep pseudo_id + aggregates.
    await _repo(tenant_id, "patients_anonymized").update_one(
        {"_id": oid},
        {"$unset": {f: "" for f in _DIRECT_IDENTIFIERS},
         "$set": {"erased": True, "erased_at": now, "processing_restricted": True,
                  "marketing_objected": True, "lifecycle": "erased"}},
    )
    # 3) Withdraw all consents (processing must stop going forward).
    await PatientConsentRepository(tenant_id=tenant_id).record(
        patient_id=oid, channel="all", status="withdrawn", source="gdpr_erasure",
        policy_version=None, actor_user_id=actor_user_id)
    # NOTE: prescription_executions / prescription_items / future_prescriptions are NOT
    # deleted — statutory pharmacy-law retention (legal hold). They hold only a pseudonymous
    # link (patient_ref) + clinical data, no direct identifiers.

    result = {
        "subject_id": str(oid),
        "contact_deleted": getattr(contact_res, "deleted_count", 0),
        "identifiers_stripped": list(_DIRECT_IDENTIFIERS),
        "legal_hold_kept": ["prescription_executions", "prescription_items", "future_prescriptions"],
        "erased_at": now.isoformat(),
    }
    await audit(tenant_id, actor_user_id=actor_user_id, action="gdpr.erase",
                subject_id=oid, reason=reason, **{"contact_deleted": result["contact_deleted"]})
    return result


async def rectify_contact(tenant_id: str, patient_id: str, data: dict, *,
                          actor_user_id: str | None = None) -> dict | None:
    """Art.16 (rectification) of contact data. Only CONTACT_FIELDS are written."""
    from app.repositories.contacts import PatientContactRepository
    oid = _oid(patient_id)
    if not oid:
        raise ValueError("invalid patient_id")
    updated = await PatientContactRepository(tenant_id=tenant_id).upsert(patient_id, data)
    await audit(tenant_id, actor_user_id=actor_user_id, action="gdpr.rectify",
                subject_id=oid, fields=sorted(data.keys()))
    return updated


async def set_processing_flags(tenant_id: str, patient_id: str, *, restrict: bool | None = None,
                               object_marketing: bool | None = None,
                               actor_user_id: str | None = None) -> dict:
    """Art.18 (restriction) + Art.21 (objection to marketing). Sets flags on the record;
    objecting to marketing also withdraws all marketing consent so sends stop immediately."""
    oid = _oid(patient_id)
    if not oid:
        raise ValueError("invalid patient_id")
    set_fields: dict = {}
    if restrict is not None:
        set_fields["processing_restricted"] = bool(restrict)
    if object_marketing is not None:
        set_fields["marketing_objected"] = bool(object_marketing)
    if set_fields:
        await _repo(tenant_id, "patients_anonymized").update_one({"_id": oid}, {"$set": set_fields})
    if object_marketing:
        await PatientConsentRepository(tenant_id=tenant_id).record(
            patient_id=oid, channel="all", status="withdrawn", source="gdpr_objection",
            policy_version=None, actor_user_id=actor_user_id)
    await audit(tenant_id, actor_user_id=actor_user_id, action="gdpr.restrict",
                subject_id=oid, restrict=restrict, object_marketing=object_marketing)
    return {"subject_id": str(oid), **set_fields}
