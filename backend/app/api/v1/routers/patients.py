"""Patient analytics router — anonymized aggregates + retention."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status

from pydantic import BaseModel, Field

from app.core.deps import TenantContext, require
from app.repositories.contacts import PatientContactRepository
from app.repositories.patients import PatientExecutionsRepository, PatientRepository
from app.services.contacts_import import build_template_xlsx, parse_contacts_xlsx

router = APIRouter()

_MODULE = "patient_analytics"


class ContactIn(BaseModel):
    phone: str | None = None
    mobile: str | None = None
    email: str | None = None
    address: str | None = None
    city: str | None = None
    postal_code: str | None = None
    notes: str | None = None
    observations: str | None = None   # «Παρατηρήσεις» — ελεύθερο κείμενο φαρμακοποιού
    marketing_consent: bool = False
    preferred_channel: str | None = Field(default=None, description="email|sms|phone")
    active: bool = True
    inactive_reason: str | None = Field(default=None, description="deceased|moved|stopped|other")
    reactivation_reason: str | None = None
    height_cm: float | None = None
    discontinuation_reason: str | None = None


@router.get("/search")
async def search_patients(
    q: str = Query(..., min_length=2),
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    return {"items": await PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).search(q)}


# ── Νέος πελάτης με ΑΜΚΑ (άντληση ΗΔΥΚΑ + καρτέλα χωρίς κίνηση, για την πύλη) ──────────────
class AmkaLookupIn(BaseModel):
    amka: str


class OnboardIn(BaseModel):
    amka: str
    full_name: str | None = None
    sex: str | None = None
    birth_year: int | None = None
    area: str | None = None
    mobile: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    city: str | None = None
    postal_code: str | None = None
    consent: bool = False


def _valid_amka(a: str) -> bool:
    a = (a or "").strip()
    return a.isdigit() and len(a) == 11


@router.post("/lookup")
async def lookup_patient(body: AmkaLookupIn,
                         ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Άντληση στοιχείων πελάτη από ΗΔΥΚΑ με ΑΜΚΑ (ΧΩΡΙΣ εγγραφή) — για preview στο onboarding."""
    if not _valid_amka(body.amka):
        return {"found": False, "error": "bad_amka_format"}
    from app.services.patient_lookup import fetch_hdika_patient
    return await fetch_hdika_patient(ctx.tenant_id, body.amka.strip())


@router.post("/onboard")
async def onboard_patient(body: OnboardIn,
                          ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Δημιουργία «καρτέλας χωρίς κίνηση» για νέο πελάτη (πύλη). Απαιτεί συγκατάθεση πελάτη (GDPR)."""
    if not _valid_amka(body.amka):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_amka_format")
    if not body.consent:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "consent_required")
    return await PatientRepository(tenant_id=ctx.tenant_id).onboard(
        amka=body.amka.strip(), full_name=body.full_name, sex=body.sex,
        birth_year=body.birth_year, area=body.area, mobile=body.mobile, phone=body.phone,
        email=body.email, address=body.address, city=body.city, postal_code=body.postal_code)


@router.get("/{patient_id}/contact")
async def get_contact(
    patient_id: str,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    return await PatientContactRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).get(patient_id) or {}


@router.put("/{patient_id}/contact")
async def put_contact(
    patient_id: str,
    body: ContactIn,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    # Χειροκίνητη αποθήκευση από φαρμακοποιό = ρητή επιβεβαίωση στοιχείων (source=pharmacist, verified).
    saved = await PatientContactRepository(tenant_id=ctx.tenant_id).save_contact(
        patient_id, body.model_dump(), source="pharmacist", verify=True)
    if saved is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    return saved


@router.get("/{patient_id}/contact-status")
async def contact_status(
    patient_id: str,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    """Κατάσταση στοιχείων επικοινωνίας (verified / needs_confirmation / προέλευση / ημ/νία) —
    για badge καρτέλας & απόφαση pop-up ταμείου."""
    return await PatientContactRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).contact_status(patient_id)


@router.post("/{patient_id}/contact/from-hdika")
async def contact_from_hdika(
    patient_id: str,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    """Άντληση στοιχείων επικοινωνίας από ΗΔΥΚΑ για ΕΝΑΝ ασθενή → γεμίζει μόνο κενά πεδία
    (ΧΩΡΙΣ συγκατάθεση, ΧΩΡΙΣ επιβεβαίωση). Χρειάζεται το ΑΜΚΑ του ασθενή."""
    from app.repositories.patients import PatientRepository
    pa = await PatientRepository(tenant_id=ctx.tenant_id).get_amka(patient_id)
    if not pa:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_or_amka_not_found")
    from app.services.patient_lookup import fetch_hdika_patient
    res = await fetch_hdika_patient(ctx.tenant_id, pa)
    if not res.get("found"):
        if res.get("error") == "deceased":     # ΗΔΥΚΑ δηλώνει θάνατο → κάρτα ανενεργή «θανών»
            from app.services.patient_lifecycle import mark_deceased
            await mark_deceased(ctx.tenant_id, pa)
            return {"found": False, "error": "deceased", "deceased": True, "filled": []}
        return {"found": False, "error": res.get("error"), "filled": []}
    repo = PatientContactRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    applied = await repo.apply_idyka(patient_id, res)
    status_now = await repo.contact_status(patient_id)
    return {"found": True, **(applied or {}), "status": status_now}


@router.get("/contacts/needs-confirmation")
async def contacts_needs_confirmation(
    q: str | None = Query(None),
    limit: int = Query(300, ge=1, le=1000),
    skip: int = Query(0, ge=0),
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    """Λίστα πελατών που θέλουν (επαν)επιβεβαίωση στοιχείων επικοινωνίας (μόνο-ΗΔΥΚΑ/ανεπιβεβαίωτα/παλιά)."""
    return await PatientContactRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).needs_confirmation_list(
        limit=limit, skip=skip, q=q)


@router.get("/contacts/bulk-hdika")
async def bulk_hdika_status(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Κατάσταση/πρόοδος του μαζικού ΗΔΥΚΑ backfill στοιχείων επικοινωνίας."""
    from app.core.db import shared_db
    from app.repositories.base import jsonsafe
    job = await shared_db()["contact_backfill_jobs"].find_one({"_id": ctx.tenant_id})
    return jsonsafe(job) or {"status": "idle"}


@router.post("/contacts/bulk-hdika")
async def bulk_hdika_start(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Έναρξη μαζικής αρχικοποίησης στοιχείων επικοινωνίας από ΗΔΥΚΑ — ΜΟΝΟ για όσους λείπουν
    στοιχεία, background & throttled. Δεν ξεκινά δεύτερο αν τρέχει ήδη."""
    from datetime import datetime, timezone, timedelta
    from app.core.db import shared_db
    db = shared_db()
    job = await db["contact_backfill_jobs"].find_one({"_id": ctx.tenant_id})
    if job and job.get("status") in ("running", "queued"):
        fresh = job.get("updated_at") and job["updated_at"] > datetime.now(tz=timezone.utc) - timedelta(minutes=15)
        if fresh:
            return {"status": "already_running", "job": {"done": job.get("done"), "total": job.get("total")}}
    await db["contact_backfill_jobs"].update_one(
        {"_id": ctx.tenant_id},
        {"$set": {"status": "queued", "queued_at": datetime.now(tz=timezone.utc),
                  "updated_at": datetime.now(tz=timezone.utc)}}, upsert=True)
    from app.workers.contacts_backfill import backfill_contacts_from_hdika
    backfill_contacts_from_hdika.delay(ctx.tenant_id)
    return {"status": "queued"}


# ── Θανόντες: έλεγχος ΗΔΥΚΑ + λίστα ανοιχτών υπολοίπων ──────────────────────────────────────
@router.get("/deaths/sweep")
async def death_sweep_status(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Κατάσταση/πρόοδος του ελέγχου θανόντων από ΗΔΥΚΑ."""
    from app.core.db import shared_db
    from app.repositories.base import jsonsafe
    job = await shared_db()["death_sweep_jobs"].find_one({"_id": ctx.tenant_id})
    return jsonsafe(job) or {"status": "idle"}


@router.post("/deaths/sweep")
async def death_sweep_start(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Έναρξη ελέγχου θανόντων από ΗΔΥΚΑ (background, throttled). Δεν ξεκινά δεύτερο αν τρέχει ήδη."""
    from datetime import datetime, timezone, timedelta
    from app.core.db import shared_db
    db = shared_db()
    job = await db["death_sweep_jobs"].find_one({"_id": ctx.tenant_id})
    if job and job.get("status") in ("running", "queued"):
        fresh = job.get("updated_at") and job["updated_at"] > datetime.now(tz=timezone.utc) - timedelta(minutes=15)
        if fresh:
            return {"status": "already_running", "job": {"done": job.get("done"), "total": job.get("total")}}
    await db["death_sweep_jobs"].update_one(
        {"_id": ctx.tenant_id}, {"$set": {"status": "queued", "updated_at": datetime.now(tz=timezone.utc)}}, upsert=True)
    from app.workers.death_sweep import death_sweep
    death_sweep.delay(ctx.tenant_id)
    return {"status": "queued"}


@router.get("/deaths/balances")
async def deceased_balances_list(
    include_settled: bool = Query(False),
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    """Θανόντες με ανοιχτό υπόλοιπο (loyalty + ανεξόφλητες παραγγελίες) — για διεκδίκηση/κλείσιμο."""
    from app.services.deceased_balances import deceased_balances
    return await deceased_balances(ctx.tenant_id, include_settled=include_settled, demo=ctx.demo)


class SettleIn(BaseModel):
    settled: bool = True


@router.post("/deaths/{patient_id}/settle")
async def deceased_settle(
    patient_id: str, body: SettleIn,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    """Σημείωσε το υπόλοιπο ενός θανόντα ως τακτοποιημένο (διεκδικήθηκε/κλείστηκε)."""
    from app.services.deceased_balances import set_settled
    return await set_settled(ctx.tenant_id, patient_id, body.settled, by=getattr(ctx, "user_id", None))


# ── Εισαγωγή ασφαλισμένων από Excel — ταίριασμα με ΑΜΚΑ, ενημέρωση υπαρχόντων ──
@router.get("/import/template")
async def import_template(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return Response(
        content=build_template_xlsx(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="rxvision_asfalismenoi_template.xlsx"'},
    )


@router.post("/import")
async def import_insured(
    file: UploadFile = File(...),
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    data = await file.read(8_000_001)   # read at most cap+1 → no unbounded memory
    if len(data) > 8_000_000:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Πολύ μεγάλο αρχείο (>8MB).")
    rows, err = parse_contacts_xlsx(data)
    if err:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, err)
    if not rows:
        return {"updated": 0, "skipped": 0, "total": 0, "skipped_sample": []}
    return await PatientContactRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).import_insured(rows)


class HeightIn(BaseModel):
    height_cm: float | None = Field(None, ge=0, le=300)


@router.patch("/{patient_id}/height")
async def set_height(patient_id: str, body: HeightIn,
                     ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    # partial update — upsert reads the raw dict so only height_cm changes (no field clobber)
    return await PatientContactRepository(tenant_id=ctx.tenant_id).upsert(
        patient_id, {"height_cm": body.height_cm}) or {}


class MeasurementIn(BaseModel):
    kind: Literal["bp", "glucose", "weight"]
    systolic: int | None = Field(None, ge=40, le=300)
    diastolic: int | None = Field(None, ge=20, le=200)
    value: float | None = Field(None, ge=0, le=1000)
    at: datetime | None = None
    note: str | None = None


@router.get("/{patient_id}/measurements")
async def get_measurements(patient_id: str,
                           ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await PatientContactRepository(tenant_id=ctx.tenant_id).measurements(patient_id)


@router.post("/{patient_id}/measurements", status_code=201)
async def add_measurement(patient_id: str, body: MeasurementIn,
                          ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    res = await PatientContactRepository(tenant_id=ctx.tenant_id).add_measurement(
        patient_id, body.kind, systolic=body.systolic, diastolic=body.diastolic,
        value=body.value, at=body.at, note=body.note)
    if res is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_measurement")
    return res


@router.delete("/{patient_id}/measurements/{measurement_id}")
async def delete_measurement(patient_id: str, measurement_id: str,
                             ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    res = await PatientContactRepository(tenant_id=ctx.tenant_id).delete_measurement(patient_id, measurement_id)
    return res or {}


# ── πρόγραμμα λήψης φαρμάκων — ο ΦΑΡΜΑΚΟΠΟΙΟΣ το ρυθμίζει για τον ασθενή (ίδια λογική με την πύλη) ──
@router.get("/{patient_id}/med-schedule")
async def get_med_schedule(patient_id: str,
                           ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    from app.repositories.patient_portal import PatientRxRepository
    return await PatientRxRepository(tenant_id=ctx.tenant_id).medication_schedule(patient_id)


class MedReminderIn(BaseModel):
    med_key: str
    enabled: bool
    time: str | None = None
    meal: str | None = None
    interval_hours: int | None = None


@router.post("/{patient_id}/med-reminder")
async def set_med_reminder(patient_id: str, body: MedReminderIn,
                           ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    from app.repositories.patient_portal import PatientRxRepository
    return await PatientRxRepository(tenant_id=ctx.tenant_id).set_reminder(
        patient_id, body.med_key, body.enabled, body.time, body.meal, body.interval_hours)


@router.get("/detail/{patient_id}")
async def patient_detail(
    patient_id: str,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    """Drill-down: one patient's profile + therapeutic categories / ICD-10 / medicines."""
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    detail = await repo.patient_detail(patient_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    return detail


@router.get("/aggregate")
async def aggregate(
    by: Literal["age_group", "sex", "area", "lifecycle"] = "age_group",
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    repo = PatientRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    buckets = await repo.aggregate_by(by=by)
    # rows: {label, value=patient count} — shape the Ασφαλισμένοι charts expect
    rows = [{"label": b.get("key") or "—", "value": b.get("patients", 0)} for b in buckets]
    return {"by": by, "rows": rows}


@router.get("/retention")
async def retention(
    cohort: str | None = None,
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    repo = PatientRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    rows = await repo.retention(cohort=cohort)
    # Καμπύλη διατήρησης: σημείο ανά ορίζοντα (μήνες) με % που παρέμειναν ενεργοί + βάση (eligible).
    points = [{"months": r.get("months", 0), "retained_pct": r.get("pct", 0.0),
               "eligible": r.get("eligible", 0)} for r in rows]
    return {"cohort": cohort, "points": points}


@router.get("/list")
async def per_patient(
    sort: Literal["value", "claimed", "profit", "rx"] = "value",
    limit: int = Query(100, ge=1, le=500),
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    sex: str | None = Query(None, description="M|F"),
    age_groups: str | None = Query(None, description="comma-separated age groups"),
    area: str | None = Query(None),
    lifecycle: str | None = Query(None, description="active|new|inactive"),
    rx_min: int | None = Query(None, ge=0),
    value_min: float | None = Query(None, description="euros"),
    profit_min: float | None = Query(None, description="euros"),
    status_filter: str | None = Query(None, alias="status", description="active|inactive"),
    reason: str | None = Query(None, description="deceased|moved|stopped|other"),
    has_contact: bool | None = Query(None),
    consent: bool | None = Query(None),
    ctx: TenantContext = Depends(require("patients:read", module=_MODULE)),
):
    """Concept doc §2 — per-patient rx/value/claimed/profit + «ενεργός από», με πλήρη φίλτρα."""
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    filters = {
        "sex": sex or None,
        "age_groups": [a for a in (age_groups or "").split(",") if a.strip()] or None,
        "area": area or None,
        "lifecycle": lifecycle or None,
        "rx_min": rx_min,
        "value_min": int(round(value_min * 100)) if value_min is not None else None,
        "profit_min": int(round(profit_min * 100)) if profit_min is not None else None,
        "status": status_filter or None,
        "reason": reason or None,
        "has_contact": has_contact or None,
        "consent": consent or None,
    }
    items = await repo.per_patient(date_from=date_from, date_to=date_to,
                                   sort=sort, limit=limit, filters=filters)
    return {"sort": sort, "items": items}


# ── Μεταφορά πελάτη ΣΕ ΕΜΑΣ — το ΝΕΟ φαρμακείο κάνει το αίτημα, ο ΠΕΛΑΤΗΣ το εγκρίνει ──────
# Δεν μεταφέρονται εκτελέσεις (μένουν στο φαρμακείο όπου έγιναν)· αντιγράφονται πρόγραμμα
# λήψης / μετρήσεις / στοιχεία επικοινωνίας μόλις ο πελάτης δώσει τη συγκατάθεσή του.
class TransferRequestIn(BaseModel):
    amka: str = Field(..., min_length=11, max_length=11)
    reason: Literal["moved", "customer_choice", "proximity", "other"]   # υποχρεωτική αιτιολόγηση
    note: str | None = Field(None, max_length=300)                      # προαιρετικό σχόλιο


@router.get("/transfer-reasons")
async def transfer_reasons(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    from app.repositories.patient_transfer import REASONS
    return {"items": [{"value": k, "label": v} for k, v in REASONS.items()]}


@router.post("/transfer-request", status_code=201)
async def request_transfer(body: TransferRequestIn,
                           ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    if not _valid_amka(body.amka):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_amka_format")
    from app.repositories.patient_transfer import PatientTransferRepository
    res = await PatientTransferRepository(demo=ctx.demo).request(
        to_tenant_id=ctx.tenant_id, amka=body.amka.strip(),
        reason=body.reason, note=body.note,
        requested_by=getattr(ctx, "user_id", None))
    if not res.get("ok"):
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": res.get("error")})
    return res


@router.get("/transfer-requests")
async def list_transfers(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    from app.repositories.patient_transfer import PatientTransferRepository
    return {"items": await PatientTransferRepository(demo=ctx.demo).list_for_tenant(ctx.tenant_id)}


# ── Ενημερώσεις ΠΡΟΣ ΕΜΑΣ: πελάτης μας άλλαξε φαρμακείο εξυπηρέτησης ──
@router.get("/transfer-notices")
async def transfer_notices(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    from app.repositories.patient_transfer import PatientTransferRepository
    return {"items": await PatientTransferRepository(demo=ctx.demo).notices_for_tenant(ctx.tenant_id)}


@router.post("/transfer-notices/{notice_id}/read")
async def read_notice(notice_id: str,
                      ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    from app.repositories.patient_transfer import PatientTransferRepository
    return await PatientTransferRepository().mark_notice_read(notice_id, ctx.tenant_id)
