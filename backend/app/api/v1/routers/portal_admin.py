"""Pharmacist-side management of the patient portal (tenant identity). Each pharmacist manages
ONLY their own portal: availability questions, appointments, and the bookable-services catalogue.
Gated by the `patient_portal` module."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.core.db import shared_db
from app.core.deps import TenantContext, require
from app.repositories.patient_portal import (
    AppointmentRepository, AvailabilityRepository, PatientAccountRepository,
    PharmacyServiceRepository, RxRequestRepository,
)

router = APIRouter()
_MODULE = "patient_portal"
_PERM = "portal:manage"


class LocationIn(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    address: str | None = Field(None, max_length=200)


@router.get("/location")
async def get_location(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    t = await shared_db()["tenants"].find_one({"_id": ctx.tenant_id}, {"location": 1})  # tenant-ok: own tenant
    return (t or {}).get("location") or {}


@router.post("/location")
async def set_location(body: LocationIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    await shared_db()["tenants"].update_one(  # tenant-ok: own tenant only
        {"_id": ctx.tenant_id},
        {"$set": {"location": {"lat": body.lat, "lon": body.lon, "address": body.address}}})
    return {"ok": True}


class AnswerIn(BaseModel):
    answer: str = Field(..., min_length=1, max_length=600)


class StatusIn(BaseModel):
    status: str = Field(..., pattern="^(requested|confirmed|ready|done|cancelled)$")


class ServiceSlot(BaseModel):
    day: int = Field(..., ge=0, le=6)                   # 0=Δευτέρα … 6=Κυριακή
    start: str = Field(..., pattern=r"^\d{2}:\d{2}$")   # "HH:MM"
    end: str = Field(..., pattern=r"^\d{2}:\d{2}$")


class ServiceDateRange(BaseModel):
    """One-off event window — specific calendar dates + hours (π.χ. εταιρικό event 15–16/11, 10:00–18:00)."""
    start_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")  # "YYYY-MM-DD"
    end_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    start: str = Field(..., pattern=r"^\d{2}:\d{2}$")
    end: str = Field(..., pattern=r"^\d{2}:\d{2}$")


class ServiceAvailability(BaseModel):
    mode: str = Field("always", pattern="^(always|custom)$")  # always = ωράριο φαρμακείου
    slots: list[ServiceSlot] = Field(default_factory=list, max_length=40)            # εβδομαδιαίο
    date_ranges: list[ServiceDateRange] = Field(default_factory=list, max_length=60)  # συγκεκριμένες ημ/νίες


class ServiceIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    description: str | None = Field(None, max_length=400)
    kind: str = Field("service", max_length=40)         # service | vaccination
    duration_min: int = Field(15, ge=5, le=240)
    active: bool = True
    availability: ServiceAvailability = Field(default_factory=ServiceAvailability)


@router.get("/portal-customers")
async def portal_customers(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Adoption picture: how many of the pharmacy's patients are registered in the portal + how
    many remain to invite."""
    return await PatientAccountRepository().portal_customers(ctx.tenant_id)


# ── live "pending" feed (polled by the panel to pop up new requests) ──
@router.get("/pending")
async def pending(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Unhandled patient requests for THIS pharmacy: open availability questions + requested
    appointments. The panel polls this and pops up a toast for each newly-seen item."""
    av = await AvailabilityRepository(tenant_id=ctx.tenant_id).inbox(only_open=True)
    ap = await AppointmentRepository(tenant_id=ctx.tenant_id).pending()
    rx = await RxRequestRepository(tenant_id=ctx.tenant_id).pending()
    items = [
        {"id": a["_id"], "kind": "availability",
         "title": a.get("medicine_name") or a.get("query") or "Ερώτηση διαθεσιμότητας",
         "who": a.get("patient_name") or "", "when": a.get("created_at")}
        for a in av
    ] + [
        {"id": a["_id"], "kind": "pickup" if a.get("kind") == "pickup" else "appointment",
         "title": a.get("service_name") or "Ραντεβού",
         "who": a.get("patient_name") or "", "when": a.get("requested_at")}
        for a in ap
    ] + [
        {"id": r["_id"], "kind": "rx_request",
         "title": ("Ανάθεση συνταγής — barcode " + str(r.get("barcode"))) if r.get("kind") == "barcode"
                  else "Ανάθεση συνταγής — φωτογραφία",
         "who": r.get("patient_name") or "", "when": r.get("created_at")}
        for r in rx
    ]
    return {"items": items, "count": len(items)}


# ── «Ανάθεση συνταγής» requests (barcode + photo) ──────────────────────────
@router.get("/rx-requests")
async def rx_requests(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await RxRequestRepository(tenant_id=ctx.tenant_id).list_all()}


class RxStatusIn(BaseModel):
    status: str = Field(..., pattern="^(new|in_progress|done|rejected)$")


@router.post("/rx-requests/{req_id}/status")
async def set_rx_status(req_id: str, body: RxStatusIn,
                        ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await RxRequestRepository(tenant_id=ctx.tenant_id).set_status(req_id, body.status) or {"ok": False}


class RxReplyIn(BaseModel):
    reply: str = Field(..., min_length=1, max_length=600)
    available_date: str | None = Field(None, max_length=20)


@router.post("/rx-requests/{req_id}/reply")
async def reply_rx_request(req_id: str, body: RxReplyIn,
                           ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    doc = await RxRequestRepository(tenant_id=ctx.tenant_id).reply(req_id, body.reply, body.available_date)
    if doc and doc.get("account_id"):
        from app.services import push_service
        extra = f" (διαθ. {body.available_date})" if body.available_date else ""
        await push_service.send_to_account(doc["account_id"], title="💬 Απάντηση για τη συνταγή σου",
                                           body=f"{body.reply}{extra}", url="/portal")
    return {"ok": bool(doc)}


_RX_SERVE = {"image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/png": "image/png",
             "image/webp": "image/webp", "image/heic": "image/heic", "image/heif": "image/heif",
             "application/pdf": "application/pdf"}


@router.get("/rx-requests/{req_id}/image")
async def rx_request_image(req_id: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    content, ctype = await RxRequestRepository(tenant_id=ctx.tenant_id).image(req_id)
    if content is None:
        return Response(status_code=404)
    return Response(content=content, media_type=_RX_SERVE.get(ctype or "", "application/octet-stream"),
                    headers={"X-Content-Type-Options": "nosniff"})


# ── availability inbox ───────────────────────────────────────
@router.get("/availability")
async def availability_inbox(only_open: bool = False,
                             ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await AvailabilityRepository(tenant_id=ctx.tenant_id).inbox(only_open=only_open)}


@router.post("/availability/{request_id}/answer")
async def answer_availability(request_id: str, body: AnswerIn,
                              ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    doc = await AvailabilityRepository(tenant_id=ctx.tenant_id).answer(request_id, body.answer)
    if doc and doc.get("account_id"):
        from app.services import push_service
        med = doc.get("medicine_name") or doc.get("query") or "το φάρμακο"
        await push_service.send_to_account(doc["account_id"], title="💬 Απάντηση διαθεσιμότητας",
                                           body=f"{med}: {body.answer}", url="/portal")
    return {"ok": True}


# ── appointments ─────────────────────────────────────────────
@router.get("/appointments")
async def appointments(upcoming: bool = False,
                       ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await AppointmentRepository(tenant_id=ctx.tenant_id).list_all(upcoming=upcoming)}


@router.post("/appointments/{appt_id}/status")
async def appointment_status(appt_id: str, body: StatusIn,
                             ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    doc = await AppointmentRepository(tenant_id=ctx.tenant_id).set_status(appt_id, body.status)
    if doc and doc.get("account_id") and body.status in ("ready", "confirmed"):
        from app.services import push_service
        is_pickup = doc.get("kind") == "pickup"
        label = doc.get("service_name") or ("Παραλαβή" if is_pickup else "Ραντεβού")
        if body.status == "ready" and is_pickup:
            title = "📦 Έτοιμη για παραλαβή"
        elif is_pickup:
            title = "✅ Επιβεβαιώθηκε η παραλαβή"
        else:
            title = "✅ Επιβεβαιώθηκε το ραντεβού σου"
        await push_service.send_to_account(doc["account_id"], title=title, body=label, url="/portal")
    return {"ok": True}


# ── services catalogue ───────────────────────────────────────
@router.get("/services")
async def services(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await PharmacyServiceRepository(tenant_id=ctx.tenant_id).list_all()}


@router.post("/services", status_code=201)
async def create_service(body: ServiceIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    sid = await PharmacyServiceRepository(tenant_id=ctx.tenant_id).create(body.model_dump())
    return {"id": sid}


@router.patch("/services/{service_id}")
async def update_service(service_id: str, body: ServiceIn,
                         ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    await PharmacyServiceRepository(tenant_id=ctx.tenant_id).set(service_id, body.model_dump())
    return {"ok": True}


class ServicePatchIn(BaseModel):
    active: bool


@router.post("/services/{service_id}/active")
async def toggle_service(service_id: str, body: ServicePatchIn,
                         ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    await PharmacyServiceRepository(tenant_id=ctx.tenant_id).set(service_id, {"active": body.active})
    return {"ok": True}


@router.delete("/services/{service_id}")
async def delete_service(service_id: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    await PharmacyServiceRepository(tenant_id=ctx.tenant_id).delete(service_id)
    return {"ok": True}
