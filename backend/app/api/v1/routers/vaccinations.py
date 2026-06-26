"""Seasonal-flu vaccination analytics + the vaccination CAMPAIGN circuit («κύκλωμα εμβολιασμών»):
read-only analytics over `vaccinations`, plus campaign config, a prioritised patient worklist,
age-group notifications, and one-click appointment booking that surfaces in the patient portal."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.db import shared_db
from app.core.deps import TenantContext, require
from app.repositories.patient_portal import (
    AppointmentRepository,
    PatientAccountRepository,
    PharmacyServiceRepository,
)
from app.repositories.vaccination_campaigns import VaccinationCampaignRepository
from app.services import comms, consent, push_service

router = APIRouter()
_MODULE = "prescription_analytics"
_PERM = "prescriptions:read"


@router.get("/summary")
async def summary(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module=_MODULE)),
):
    db = shared_db()
    # Αντιγριπικά: χορηγημένα από φαρμακοποιό (INFLUENZA) + συνταγογραφημένα από γιατρό (PRESCRIPTION).
    base = {"tenant_id": ctx.tenant_id, "source": {"$in": ["INFLUENZA", "PRESCRIPTION"]},
            "executed_at": {"$gte": date_from, "$lt": date_to}}
    active = {**base, "cancelled": {"$ne": True}}

    async def grp(field: str, limit: int = 20):
        return [r async for r in db["vaccinations"].aggregate([
            {"$match": active}, {"$group": {"_id": f"${field}", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}}, {"$limit": limit}])]

    by_month = [r async for r in db["vaccinations"].aggregate([
        {"$match": active},
        {"$group": {"_id": {"$dateToString": {"format": "%Y-%m", "date": "$executed_at"}}, "n": {"$sum": 1}}},
        {"$sort": {"_id": 1}}])]
    return {
        "total": await db["vaccinations"].count_documents(active),
        "cancelled": await db["vaccinations"].count_documents({**base, "cancelled": True}),
        "by_vaccine": [{"name": r["_id"] or "—", "count": r["n"]} for r in await grp("vaccine_name")],
        "by_risk_group": [{"name": r["_id"] or "—", "count": r["n"]} for r in await grp("high_risk_group")],
        "by_age": [{"group": r["_id"] or "—", "count": r["n"]} for r in await grp("patient_age_group", 12)],
        "by_month": [{"month": r["_id"], "count": r["n"]} for r in by_month],
    }


@router.get("")
async def list_vaccinations(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    include_cancelled: bool = Query(False),
    barcode: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    ctx: TenantContext = Depends(require("prescriptions:read", module=_MODULE)),
):
    from app.repositories.base import jsonsafe
    db = shared_db()
    q: dict = {"tenant_id": ctx.tenant_id, "source": {"$in": ["INFLUENZA", "PRESCRIPTION"]}}
    if barcode and barcode.strip():
        # match either the vaccination's own barcode OR the treatment id (external_id) —
        # 199 records have no 92… barcode and the Συνταγές row falls back to external_id.
        # Search ignores the date window.
        term = barcode.strip()
        q["$or"] = [{"barcode": term}, {"external_id": term}]
    else:
        q["executed_at"] = {"$gte": date_from, "$lt": date_to}
        if not include_cancelled:
            q["cancelled"] = {"$ne": True}
    items = [r async for r in db["vaccinations"].find(q, {"_id": 0, "patient_ref": 0})
             .sort("executed_at", -1).skip((page - 1) * page_size).limit(page_size)]
    return {"page": page, "page_size": page_size, "items": jsonsafe(items)}


# ── Campaign circuit («κύκλωμα εμβολιασμών») ──────────────────────────────────

class RolloutBand(BaseModel):
    age_group: str
    opens_at: datetime          # από
    closes_at: datetime | None = None  # έως (None = ως το τέλος της περιόδου)


class CampaignIn(BaseModel):
    name: str | None = None
    season: str | None = None
    period_start: datetime | None = None
    period_end: datetime | None = None
    rollout: list[RolloutBand] | None = None
    priority_icd: list[str] | None = None


@router.get("/campaign")
async def get_campaign(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await VaccinationCampaignRepository(tenant_id=ctx.tenant_id).get_current()


@router.put("/campaign")
async def put_campaign(body: CampaignIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    fields = body.model_dump(exclude_none=True)  # rollout bands already plain dicts here
    return await VaccinationCampaignRepository(tenant_id=ctx.tenant_id).upsert_current(fields)


@router.get("/worklist")
async def worklist(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    age_groups: str | None = Query(None, description="comma-separated age bands"),
    status: Literal["pending", "done", "all"] = "pending",
    open_only: bool = False,
    high_risk_only: bool = False,
    search: str | None = None,
    vacc_from: datetime | None = None,
    vacc_to: datetime | None = None,
    ctx: TenantContext = Depends(require(_PERM, module=_MODULE)),
):
    ags = [a for a in (age_groups or "").split(",") if a] or None
    return await VaccinationCampaignRepository(tenant_id=ctx.tenant_id).worklist(
        page=page, page_size=page_size, age_groups=ags, status=status,
        open_only=open_only, high_risk_only=high_risk_only, search=search,
        vacc_from=vacc_from, vacc_to=vacc_to)


def _vacc_email_html(message: str, from_name: str | None) -> str:
    body = message.replace("\n", "<br/>")
    return f"""<div style="background:#f1f5f9;padding:24px;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="background:#0284c7;padding:18px 24px;color:#fff;font-size:18px;font-weight:700;">💉 {from_name or "Το φαρμακείο σας"}</div>
        <div style="padding:24px;color:#0f172a;font-size:15px;line-height:1.6;">{body}</div>
        <div style="padding:16px 24px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">
          Λάβατε αυτό το μήνυμα ως πελάτης του φαρμακείου μας. Για διαγραφή, απαντήστε «ΔΙΑΓΡΑΦΗ».
        </div>
      </div>
    </div>"""


class NotifyIn(BaseModel):
    channel: Literal["sms", "email", "push"]
    age_groups: list[str] = []
    open_only: bool = False
    high_risk_only: bool = False
    subject: str | None = None
    message: str
    dry_run: bool = False


@router.post("/notify")
async def notify(body: NotifyIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Invite PENDING patients (optionally a subset of age bands / open bands / high-risk) to vaccinate.
    SMS/email respect marketing consent + the withdrawal ledger; push reaches portal accounts."""
    repo = VaccinationCampaignRepository(tenant_id=ctx.tenant_id)
    wl = await repo.worklist(page=1, page_size=5000, age_groups=body.age_groups or None,
                             status="pending", open_only=body.open_only,
                             high_risk_only=body.high_risk_only)
    field = "mobile" if body.channel == "sms" else "email" if body.channel == "email" else None

    targets: list[dict] = []
    if body.channel in ("sms", "email"):
        withdrawn = {str(x) for x in await consent.withdrawn_patient_ids(ctx.tenant_id, body.channel)}
        for r in wl["items"]:
            if not r.get("consent") or r["patient_ref"] in withdrawn or not r.get(field):
                continue
            targets.append(r)
    else:  # push — every pending patient that has a portal account (resolved at send time)
        targets = list(wl["items"])

    if body.dry_run:
        return {"recipients": len(targets), "channel": body.channel, "dry_run": True}

    cfg = comms.get_config(ctx.tenant_id)
    accounts = PatientAccountRepository()
    sent = failed = 0
    for r in targets[:2000]:
        first = (r.get("name") or "").split(" ")[0] if r.get("name") else ""
        text = (body.message or "").replace("{name}", r.get("name") or "").replace("{first}", first)
        try:
            if body.channel == "email":
                await comms.send_email(cfg, r["email"], body.subject or "Πρόσκληση εμβολιασμού γρίπης",
                                       _vacc_email_html(text, cfg.get("from_name")))
            elif body.channel == "sms":
                await comms.send_sms(cfg, r["mobile"], text)
            else:
                acc = await accounts.get_by_amka(r.get("amka") or "")
                n = await push_service.send_to_account(
                    acc["_id"], title=body.subject or "💉 Εμβολιασμός γρίπης", body=text,
                    url="/portal") if acc else 0
                if not n:
                    failed += 1
                    continue
            sent += 1
        except Exception:  # noqa: BLE001 — one bad recipient must not abort the batch
            failed += 1

    await shared_db()["comms_campaigns"].insert_one({
        "tenant_id": ctx.tenant_id, "channel": body.channel, "kind": "vaccination",
        "subject": body.subject, "recipients": len(targets), "sent": sent, "failed": failed,
        "by": getattr(ctx, "email", None), "created_at": datetime.now(tz=timezone.utc)})
    return {"recipients": len(targets), "sent": sent, "failed": failed}


class ApptIn(BaseModel):
    patient_ref: str
    when: datetime
    note: str | None = None
    service_name: str | None = None


@router.post("/appointment")
async def book_appointment(body: ApptIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Book a vaccination appointment for a patient → becomes a pharmacy service and (if the patient
    has a my.rxvision.gr account) shows up in their portal, already confirmed by the pharmacist."""
    db = shared_db()
    try:
        pid = ObjectId(body.patient_ref)
    except Exception:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid patient_ref")
    pat = await db["patients_anonymized"].find_one({"tenant_id": ctx.tenant_id, "_id": pid})
    if not pat:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient not found")
    amka = pat.get("amka") or ""
    name = pat.get("full_name") or ""
    contact = await db["patient_contacts"].find_one({"tenant_id": ctx.tenant_id, "_id": pid}) or {}
    phone = contact.get("mobile") or contact.get("phone") or ""

    svc_repo = PharmacyServiceRepository(tenant_id=ctx.tenant_id)
    svc = next((s for s in await svc_repo.list_all() if s.get("kind") == "vaccination"), None)
    svc_name = body.service_name or (svc.get("name") if svc else None) or "Εμβολιασμός Γρίπης"
    sid = svc.get("_id") if svc else await svc_repo.create(
        {"name": svc_name, "kind": "vaccination",
         "description": "Αντιγριπικός εμβολιασμός", "duration_min": 15})

    acc = await PatientAccountRepository().get_by_amka(amka) if amka else None
    appt_repo = AppointmentRepository(tenant_id=ctx.tenant_id)
    appt_id = await appt_repo.create(
        account_id=(acc["_id"] if acc else None), service_id=sid, service_name=svc_name,
        requested_at=body.when, note=body.note, patient_ref=str(pid),
        patient_name=name, patient_phone=phone, kind="vaccination")
    await appt_repo.set_status(appt_id, "confirmed")  # pharmacist-initiated ⇒ already confirmed
    if acc:
        await push_service.send_to_account(
            acc["_id"], title="✅ Ραντεβού εμβολιασμού",
            body=f"{svc_name} — {body.when.strftime('%d/%m %H:%M')}", url="/portal")
    return {"id": appt_id, "portal_visible": bool(acc), "service_name": svc_name}
