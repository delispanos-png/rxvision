"""Patient portal API (3rd identity). Every data endpoint is scoped to the patient's OWN record
in their ACTIVE pharmacy (tenant + patient_ref come from the patient token — never from the client)."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, EmailStr, Field

from app.core.db import shared_db
from app.core.deps import PatientContext, get_patient_context
from app.core.ratelimit import rate_limit
from app.repositories.advisor import AdvisorRepository
from app.repositories.patient_portal import (
    AppointmentRepository, AvailabilityRepository, PatientAccountRepository,
    PatientRxRepository, PharmacyServiceRepository, RxRequestRepository,
)
from app.services.hdika_lookup import lookup_prescription
from app.services.patient_auth_service import PatientAuthService, PatientError

router = APIRouter()


# ── schemas ──────────────────────────────────────────────────
class RegisterIn(BaseModel):
    first_name: str = Field(..., min_length=1, max_length=80)
    last_name: str = Field(..., min_length=1, max_length=80)
    email: EmailStr
    phone: str = Field("", max_length=40)
    amka: str = Field(..., min_length=6, max_length=20)
    password: str = Field(..., min_length=8, max_length=128)
    pharmacy: str | None = Field(None, max_length=40)   # «αγαπημένο» tenant from a counter QR


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class SelectIn(BaseModel):
    tenant_id: str


class AvailabilityIn(BaseModel):
    tenant_id: str | None = None                          # target pharmacy (defaults to active)
    medicine_barcode: str | None = Field(None, max_length=40)
    medicine_name: str | None = Field(None, max_length=200)
    query: str = Field("", max_length=300)                # optional free text


class AppointmentIn(BaseModel):
    tenant_id: str | None = None                          # target pharmacy (defaults to active)
    service_id: str | None = None
    service_name: str = Field(..., min_length=2, max_length=120)
    kind: str = Field("service", pattern="^(service|pickup)$")  # pickup = "θα περάσω να την παραλάβω"
    requested_at: datetime
    note: str | None = Field(None, max_length=300)


# ── auth ─────────────────────────────────────────────────────
@router.post("/auth/register", status_code=201,
             dependencies=[Depends(rate_limit("patient_register", limit=5, window_seconds=600))])
async def register(body: RegisterIn):
    try:
        return await PatientAuthService().register(
            first_name=body.first_name, last_name=body.last_name, email=body.email,
            phone=body.phone, amka=body.amka, password=body.password, pharmacy=body.pharmacy)
    except PatientError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": str(exc)})


@router.post("/auth/login",
             dependencies=[Depends(rate_limit("patient_login", limit=10, window_seconds=300))])
async def login(body: LoginIn):
    res = await PatientAuthService().login(body.email, body.password)
    if res is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")
    return res


@router.post("/auth/refresh")
async def refresh(body: RefreshIn):
    res = await PatientAuthService().refresh(body.refresh_token)
    if res is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_refresh")
    return res


@router.post("/auth/select-pharmacy")
async def select_pharmacy(body: SelectIn, ctx: PatientContext = Depends(get_patient_context)):
    token = await PatientAuthService().select_pharmacy(ctx.account_id, body.tenant_id)
    if token is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "not_linked_to_pharmacy")
    return {"access_token": token, "active_tenant": body.tenant_id}


# ── profile + own data ───────────────────────────────────────
@router.get("/me")
async def me(ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.patient_portal import PatientAccountRepository
    repo = PatientAccountRepository()
    acc = await repo.get(ctx.account_id)
    if not acc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "account_not_found")
    return {
        "profile": {"first_name": acc.get("first_name"), "last_name": acc.get("last_name"),
                    "email": acc.get("email"), "phone": acc.get("phone")},
        "active_tenant": ctx.tenant_id,
        "pharmacies": await repo.links(ctx.account_id),
    }


@router.get("/prescriptions")
async def my_prescriptions(ctx: PatientContext = Depends(get_patient_context)):
    repo = PatientRxRepository(tenant_id=ctx.tenant_id)
    return {"items": await repo.my_prescriptions(ctx.patient_ref)}


@router.get("/repeats")
async def my_repeats(ctx: PatientContext = Depends(get_patient_context)):
    repo = PatientRxRepository(tenant_id=ctx.tenant_id)
    return {"items": await repo.my_repeats(ctx.patient_ref)}


@router.get("/summary")
async def my_summary(ctx: PatientContext = Depends(get_patient_context)):
    """KPI snapshot for the portal home (counts, paid, fund-covered, repeats)."""
    return await PatientRxRepository(tenant_id=ctx.tenant_id).summary(ctx.patient_ref)


@router.get("/meds/schedule")
async def meds_schedule(ctx: PatientContext = Depends(get_patient_context)):
    """Εβδομαδιαίο πρόγραμμα λήψης: ενεργές αγωγές με τη δοσολογία του γιατρού + ημ/νία εξάντλησης,
    και calendar grid για όσες έχει ενεργοποιήσει ο ασθενής."""
    return await PatientRxRepository(tenant_id=ctx.tenant_id).medication_schedule(ctx.patient_ref)


class ReminderIn(BaseModel):
    med_key: str
    enabled: bool


@router.post("/meds/reminder")
async def meds_reminder(body: ReminderIn, ctx: PatientContext = Depends(get_patient_context)):
    """Ο ασθενής ενεργοποιεί/απενεργοποιεί ενημερώσεις λήψης για μια συγκεκριμένη αγωγή."""
    return await PatientRxRepository(tenant_id=ctx.tenant_id).set_reminder(ctx.patient_ref, body.med_key, body.enabled)


class IntakeIn(BaseModel):
    med_key: str


@router.post("/meds/taken")
async def meds_taken(body: IntakeIn, ctx: PatientContext = Depends(get_patient_context)):
    """«✓ Το πήρα» → σερί συνέπειας (+ πόντοι ΜΟΝΟ αν το φαρμακείο το έχει ενεργοποιήσει)."""
    return await PatientRxRepository(tenant_id=ctx.tenant_id).log_intake(ctx.patient_ref, body.med_key)


class ReserveIn(BaseModel):
    med_name: str


@router.post("/meds/reserve")
async def meds_reserve(body: ReserveIn, ctx: PatientContext = Depends(get_patient_context)):
    """Κράτηση επανάληψης (click-&-collect) → πέφτει στο worklist του φαρμακείου."""
    from app.repositories.patient_portal import PatientAccountRepository
    acc = await PatientAccountRepository().get(ctx.account_id)
    name = f"{(acc or {}).get('first_name', '')} {(acc or {}).get('last_name', '')}".strip()
    return await PatientRxRepository(tenant_id=ctx.tenant_id).reserve_refill(
        account_id=ctx.account_id, patient_ref=ctx.patient_ref, med_name=body.med_name, patient_name=name)


class SlotTimesIn(BaseModel):
    morning: str | None = None
    noon: str | None = None
    evening: str | None = None
    night: str | None = None


@router.post("/meds/times")
async def meds_times(body: SlotTimesIn, ctx: PatientContext = Depends(get_patient_context)):
    """Προσωποποιημένες ώρες λήψης (πρωί/μεσημέρι/βράδυ/νύχτα)."""
    return await PatientRxRepository(tenant_id=ctx.tenant_id).set_slot_times(ctx.patient_ref, body.model_dump())


@router.get("/pharmacy-hours")
async def pharmacy_hours(ctx: PatientContext = Depends(get_patient_context)):
    """Ζωντανή κατάσταση (ανοιχτό/κλειστό/εφημερία) + εβδομαδιαίο ωράριο του ενεργού φαρμακείου."""
    from app.repositories.pharmacy_availability import PharmacyAvailabilityRepository
    repo = PharmacyAvailabilityRepository(tenant_id=ctx.tenant_id)
    return {"status": await repo.status(), "schedule": await repo.get_schedule()}


@router.get("/renewals")
async def my_renewals(ctx: PatientContext = Depends(get_patient_context)):
    """Διαθέσιμες ανανεώσεις: χρόνιες επαναλαμβανόμενες συνταγές που μπορούν να εκτελεστούν τώρα
    στο ενεργό φαρμακείο (ώστε ο ασθενής να μην ξεχάσει την επανάληψη)."""
    det = await AdvisorRepository(tenant_id=ctx.tenant_id).recall_detail(str(ctx.patient_ref))
    items = []
    for c in det.get("chains", []):
        if c.get("available"):
            since = next((w["due"] for w in c.get("windows", []) if w.get("status") == "available"), None)
            items.append({"key": c.get("key"), "medicine": c.get("medicine"),
                          "doctor": c.get("doctor"), "available": c["available"],
                          "since": since, "intent": c.get("intent")})
    return {"items": items}


class RenewalRespondIn(BaseModel):
    key: str
    decision: str                  # "take" (θα το πάρω) | "skip" (δεν θα το πάρω)
    visit_date: str | None = None  # ISO ημερομηνία επίσκεψης (αν θα το πάρει)
    reason: str | None = None      # λόγος (αν δεν θα το πάρει)


@router.post("/renewals/respond")
async def respond_renewal(body: RenewalRespondIn, ctx: PatientContext = Depends(get_patient_context)):
    """Ο ασθενής δηλώνει αν θα παραλάβει την ανανέωση (+ημ/νία επίσκεψης) ή όχι (+λόγο) — ώστε
    ο φαρμακοποιός να προγραμματίσει παραγγελία/διαθεσιμότητα/παράδοση."""
    from bson import ObjectId
    from bson.errors import InvalidId
    if body.decision not in ("take", "skip"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_decision")
    try:
        pref = ObjectId(ctx.patient_ref)
    except (InvalidId, TypeError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_patient")
    await shared_db()["renewal_intents"].update_one(
        {"tenant_id": ctx.tenant_id, "patient_ref": pref, "key": body.key},
        {"$set": {"decision": body.decision,
                  "visit_date": (body.visit_date or None) if body.decision == "take" else None,
                  "reason": (body.reason or None) if body.decision == "skip" else None,
                  "account_id": ctx.account_id, "updated_at": datetime.now(tz=timezone.utc)}},
        upsert=True)
    return {"ok": True}


@router.get("/prescriptions/{barcode}")
async def prescription_detail(barcode: str, ctx: PatientContext = Depends(get_patient_context)):
    d = await PatientRxRepository(tenant_id=ctx.tenant_id).my_prescription_detail(ctx.patient_ref, barcode)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return d


@router.get("/notifications")
async def notifications(ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PatientAccountRepository().notifications(ctx.account_id)}


# ── web push (VAPID) — phone notifications even when the app is closed ──
class PushKeys(BaseModel):
    p256dh: str = Field(..., max_length=200)
    auth: str = Field(..., max_length=100)


class PushSubIn(BaseModel):
    endpoint: str = Field(..., max_length=1000)
    keys: PushKeys


class PushUnsubIn(BaseModel):
    endpoint: str = Field(..., max_length=1000)


@router.get("/push/key")
async def push_key(ctx: PatientContext = Depends(get_patient_context)):
    from app.core.config import settings
    from app.services import push_service
    return {"public_key": settings.VAPID_PUBLIC_KEY, "enabled": push_service.enabled()}


@router.post("/push/subscribe", status_code=201)
async def push_subscribe(body: PushSubIn, ctx: PatientContext = Depends(get_patient_context)):
    from app.services import push_service
    return {"ok": await push_service.save_subscription(ctx.account_id, body.model_dump())}


@router.post("/push/unsubscribe")
async def push_unsubscribe(body: PushUnsubIn, ctx: PatientContext = Depends(get_patient_context)):
    from app.services import push_service
    await push_service.remove_subscription(body.endpoint)
    return {"ok": True}


# ── pharmacy directory (nearby) + medicine catalogue ─────────
@router.get("/pharmacies/nearby")
async def nearby(lat: float, lon: float, ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PatientAccountRepository().nearby_pharmacies(lat, lon)}


@router.get("/medicines/search")
async def medicines_search(q: str, ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PatientAccountRepository().search_medicines(q)}


@router.get("/medicines/by-barcode")
async def medicine_by_barcode(code: str, ctx: PatientContext = Depends(get_patient_context)):
    m = await PatientAccountRepository().medicine_by_barcode(code)
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "medicine_not_found")
    return m


async def _target(ctx: PatientContext, body_tenant: str | None):
    """Resolve (target_tenant, patient_ref|None, name, phone) for a request to a CHOSEN pharmacy
    (may be a nearby one where the patient has no history → patient_ref is None, contact is used)."""
    repo = PatientAccountRepository()
    target = body_tenant or ctx.tenant_id
    if body_tenant and body_tenant != ctx.tenant_id and not await repo.pharmacy_has_portal(target):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "pharmacy_unavailable")
    acc = await repo.get(ctx.account_id) or {}
    link = await repo.link_for(ctx.account_id, target)
    pref = str(link["patient_ref"]) if link and link.get("patient_ref") else None
    name = f"{acc.get('first_name', '')} {acc.get('last_name', '')}".strip()
    return target, pref, name, acc.get("phone", "")


# ── services / availability / appointments (active OR chosen pharmacy) ──
@router.get("/services")
async def services(tenant_id: str | None = None, ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PharmacyServiceRepository(tenant_id=tenant_id or ctx.tenant_id).list_active()}


@router.post("/availability", status_code=201)
async def ask_availability(body: AvailabilityIn, ctx: PatientContext = Depends(get_patient_context)):
    qtext = body.medicine_name or body.query
    if not qtext or len(qtext.strip()) < 2:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "medicine_or_query_required")
    target, pref, name, phone = await _target(ctx, body.tenant_id)
    rid = await AvailabilityRepository(tenant_id=target).create(
        account_id=ctx.account_id, query=qtext, patient_ref=pref, patient_name=name,
        patient_phone=phone, medicine_barcode=body.medicine_barcode, medicine_name=body.medicine_name)
    return {"id": rid, "status": "open"}


@router.get("/availability")
async def my_availability(ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PatientAccountRepository().my_availability(ctx.account_id)}


@router.post("/appointments", status_code=201)
async def book_appointment(body: AppointmentIn, ctx: PatientContext = Depends(get_patient_context)):
    target, pref, name, phone = await _target(ctx, body.tenant_id)
    aid = await AppointmentRepository(tenant_id=target).create(
        account_id=ctx.account_id, service_id=body.service_id, service_name=body.service_name,
        requested_at=body.requested_at, note=body.note, patient_ref=pref,
        patient_name=name, patient_phone=phone, kind=body.kind)
    return {"id": aid, "status": "requested"}


@router.get("/appointments")
async def my_appointments(ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PatientAccountRepository().my_appointments(ctx.account_id)}


# ── «Ανάθεση συνταγής» — by barcode OR a photo of the doctor's Rx ───────────
class RxRequestIn(BaseModel):
    barcode: str
    note: str | None = None
    tenant_id: str | None = None


@router.post("/rx-request", status_code=201)
async def rx_request_barcode(body: RxRequestIn, ctx: PatientContext = Depends(get_patient_context)):
    bc = (body.barcode or "").strip()
    if len(bc) < 4:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "barcode_required")
    target, pref, name, phone = await _target(ctx, body.tenant_id)
    # live ΗΔΥΚΑ check via the pharmacy's own connection — verify + enrich the barcode
    cda = await lookup_prescription(target, bc)
    rid = await RxRequestRepository(tenant_id=target).create(
        account_id=ctx.account_id, patient_ref=pref, patient_name=name, patient_phone=phone,
        kind="barcode", barcode=bc, note=body.note, cda=cda)
    return {"id": rid, "status": "new", "cda": cda}


_MAX_RX_PHOTO = 12 * 1024 * 1024
_RX_PHOTO_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"}


@router.post("/rx-request/photo", status_code=201)
async def rx_request_photo(file: UploadFile = File(...), note: str | None = Form(None),
                           tenant_id: str | None = Form(None),
                           ctx: PatientContext = Depends(get_patient_context)):
    if (file.content_type or "") not in _RX_PHOTO_TYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "bad_type")
    content = await file.read()
    if len(content) > _MAX_RX_PHOTO:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "too_large")
    target, pref, name, phone = await _target(ctx, tenant_id)
    rid = await RxRequestRepository(tenant_id=target).create(
        account_id=ctx.account_id, patient_ref=pref, patient_name=name, patient_phone=phone,
        kind="photo", note=note, image=content, content_type=file.content_type)
    return {"id": rid, "status": "new"}


@router.get("/rx-requests")
async def my_rx_requests(ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await RxRequestRepository(tenant_id=ctx.tenant_id).mine(ctx.account_id)}


# ── οι μετρήσεις μου (πίεση/ζάχαρο/βάρος + ύψος) ────────────────────────────
@router.get("/health")
async def my_health(ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.contacts import PatientContactRepository
    repo = PatientContactRepository(tenant_id=ctx.tenant_id)
    contact = await repo.get(ctx.patient_ref) or {}
    meas = await repo.measurements(ctx.patient_ref)
    return {"height_cm": contact.get("height_cm"), **meas}


# ── loyalty wallet (πορτοφόλι επιβράβευσης) ────────────────────────────────
@router.get("/loyalty")
async def my_loyalty(ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.loyalty import LoyaltyRepository
    repo = LoyaltyRepository(tenant_id=ctx.tenant_id)
    cfg = await repo.config()
    if not cfg.get("enabled"):
        return {"enabled": False}
    if not await repo.is_enrolled(ctx.patient_ref):
        return {"enabled": True, "enrolled": False, "terms": cfg.get("terms")}
    member = await repo.member(ctx.patient_ref)
    rewards = await repo.rewards(only_active=True)
    return {"enabled": True, "enrolled": True, "member": member, "rewards": rewards, "terms": cfg.get("terms")}


@router.post("/loyalty/join", status_code=201)
async def join_loyalty(ctx: PatientContext = Depends(get_patient_context)):
    """Patient accepts the terms electronically and joins the programme."""
    from app.repositories.loyalty import LoyaltyRepository
    repo = LoyaltyRepository(tenant_id=ctx.tenant_id)
    cfg = await repo.config()
    if not cfg.get("enabled"):
        raise HTTPException(status.HTTP_409_CONFLICT, "loyalty_off")
    return await repo.enroll(ctx.patient_ref, method="electronic")
