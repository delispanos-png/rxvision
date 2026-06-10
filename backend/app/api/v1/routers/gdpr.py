"""GDPR data-subject-rights router (Art.15/16/17/18/20/21) + consent ledger.

Tenant-scoped. GDPR rights are a LEGAL obligation, so endpoints are gated by permission
only (module=None) — they are never paywalled/locked by subscription tier. Every mutating
op is audited with the subject id (see gdpr_service.audit)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import TenantContext, require
from app.repositories.consents import PatientConsentRepository
from app.schemas.gdpr import ConsentIn, EraseIn, RectifyIn, RestrictIn
from app.services import gdpr_service

router = APIRouter()


# Data categories held per patient + retention + legal basis — drives the privacy
# settings page (Art.13/14 transparency). Greek labels for the pharmacist UI.
DATA_MAP = [
    {"category": "Στοιχεία επικοινωνίας", "fields": "όνομα, τηλέφωνο, email, διεύθυνση",
     "purpose": "Επικοινωνία/ενημερώσεις φαρμακείου", "legal_basis": "Συγκατάθεση (Άρθρο 6.1.α)",
     "retention": "Έως ανάκληση συγκατάθεσης ή διαγραφή πελάτη", "collection": "patient_contacts"},
    {"category": "Ψευδωνυμοποιημένη ταυτότητα ασθενούς", "fields": "ΑΜΚΑ (HMAC), ηλικιακή ομάδα, φύλο, περιοχή",
     "purpose": "Στατιστική ανάλυση συνταγών", "legal_basis": "Έννομο συμφέρον / Δημόσια υγεία (Άρθρο 9.2.η/θ)",
     "retention": "Όσο διατηρείται η σχέση + νόμιμη φαρμακευτική διατήρηση", "collection": "patients_anonymized"},
    {"category": "Εκτελέσεις συνταγών (κλινικά)", "fields": "φάρμακα, ICD-10, ποσά, ημερομηνίες",
     "purpose": "Νόμιμη τήρηση φαρμακείου + ανάλυση", "legal_basis": "Νομική υποχρέωση (Άρθρο 6.1.γ)",
     "retention": "Κατά τη φαρμακευτική νομοθεσία (legal hold)", "collection": "prescription_executions"},
    {"category": "Συγκαταθέσεις επικοινωνίας", "fields": "κανάλι, κατάσταση, ημερομηνίες, έκδοση πολιτικής",
     "purpose": "Απόδειξη συγκατάθεσης", "legal_basis": "Νομική υποχρέωση λογοδοσίας (Άρθρο 7.1)",
     "retention": "Όσο ισχύει + εύλογο διάστημα απόδειξης", "collection": "patient_consents"},
    {"category": "Αρχείο ενεργειών GDPR", "fields": "ποιος/πότε/ποιο υποκείμενο",
     "purpose": "Λογοδοσία/ιχνηλασιμότητα", "legal_basis": "Νομική υποχρέωση (Άρθρο 5.2)",
     "retention": "Κατά την πολιτική διατήρησης logs", "collection": "audit_logs"},
]


@router.get("/data-map")
async def data_map(ctx: TenantContext = Depends(require("gdpr:read"))):
    """Summary of personal-data categories held, purpose, legal basis and retention."""
    return {"categories": DATA_MAP}


@router.get("/search")
async def search_subjects(q: str, ctx: TenantContext = Depends(require("gdpr:read"))):
    """Find a data subject by name / phone / email before exercising a right."""
    return {"results": await gdpr_service.search_subjects(ctx.tenant_id, q)}


@router.get("/export/{patient_id}")
async def export_subject(patient_id: str,
                         ctx: TenantContext = Depends(require("gdpr:export"))):
    """Art.15 + Art.20 — full structured export of everything held about one patient."""
    try:
        return await gdpr_service.export_subject(ctx.tenant_id, patient_id, actor_user_id=ctx.user_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@router.post("/erase/{patient_id}")
async def erase_subject(patient_id: str, body: EraseIn,
                        ctx: TenantContext = Depends(require("gdpr:erase"))):
    """Art.17 — erasure with legal hold (strip identifiers, keep statutory record)."""
    if not body.confirm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "confirmation_required")
    try:
        return await gdpr_service.erase_subject(ctx.tenant_id, patient_id,
                                                actor_user_id=ctx.user_id, reason=body.reason)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except LookupError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "subject_not_found")


@router.put("/rectify/{patient_id}")
async def rectify_subject(patient_id: str, body: RectifyIn,
                          ctx: TenantContext = Depends(require("gdpr:rectify"))):
    """Art.16 — correct contact data."""
    data = body.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no_fields")
    try:
        updated = await gdpr_service.rectify_contact(ctx.tenant_id, patient_id, data,
                                                      actor_user_id=ctx.user_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "subject_not_found")
    return updated


@router.post("/restrict/{patient_id}")
async def restrict_subject(patient_id: str, body: RestrictIn,
                           ctx: TenantContext = Depends(require("gdpr:rectify"))):
    """Art.18 (restriction) / Art.21 (objection to marketing)."""
    try:
        return await gdpr_service.set_processing_flags(
            ctx.tenant_id, patient_id, restrict=body.restrict,
            object_marketing=body.object_marketing, actor_user_id=ctx.user_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@router.get("/consents/{patient_id}")
async def get_consents(patient_id: str,
                       ctx: TenantContext = Depends(require("gdpr:read"))):
    """Consent ledger for a patient: current status per channel + full history."""
    repo = PatientConsentRepository(tenant_id=ctx.tenant_id)
    return {"current": await repo.current(patient_id), "history": await repo.history(patient_id)}


@router.post("/consents/{patient_id}")
async def record_consent(patient_id: str, body: ConsentIn,
                         ctx: TenantContext = Depends(require("gdpr:rectify"))):
    """Record a consent grant/withdrawal event (Art.7 accountability)."""
    repo = PatientConsentRepository(tenant_id=ctx.tenant_id)
    try:
        event = await repo.record(patient_id=patient_id, channel=body.channel, status=body.status,
                                  source=body.source, policy_version=body.policy_version,
                                  actor_user_id=ctx.user_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    await gdpr_service.audit(ctx.tenant_id, actor_user_id=ctx.user_id,
                             action=f"gdpr.consent.{body.status}", subject_id=patient_id,
                             channel=body.channel)
    return event
