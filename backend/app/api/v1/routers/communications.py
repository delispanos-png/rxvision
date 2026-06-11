"""Communications router — per-tenant email/SMS config + patient campaigns (newsletter
/ reminders). The pharmacy sets up its OWN sender; sends go only to consented patients."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.db import shared_db
from app.core.deps import TenantContext, require
from app.services import comms, consent

router = APIRouter()
_MODULE = "patient_analytics"
_SECRET_KEYS = ("smtp_password", "apifon_token", "apifon_secret")


class SettingsIn(BaseModel):
    from_name: str | None = None
    from_email: str | None = None
    smtp_host: str | None = None
    smtp_port: int | None = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_use_tls: bool = True
    sms_sender: str | None = None
    apifon_token: str | None = None
    apifon_secret: str | None = None


@router.get("/settings")
async def get_settings(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return comms.public_view(comms.get_config(ctx.tenant_id))


@router.put("/settings")
async def put_settings(body: SettingsIn, ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    existing = comms.get_config(ctx.tenant_id)
    new = body.model_dump()
    # keep stored secrets if the form sent them blank (masked)
    for k in _SECRET_KEYS:
        if not new.get(k) and existing.get(k):
            new[k] = existing[k]
    comms.save_config(ctx.tenant_id, {k: v for k, v in new.items() if v is not None})
    return comms.public_view(comms.get_config(ctx.tenant_id))


@router.post("/test-email")
async def test_email(to: str = Query(...), ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    cfg = comms.get_config(ctx.tenant_id)
    try:
        await comms.send_email(cfg, to, "RxVision — δοκιμαστικό email",
                               "<p>Το email αποστολέα του φαρμακείου σας λειτουργεί. ✅</p>")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return {"ok": True}


@router.post("/test-sms")
async def test_sms(to: str = Query(...), ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    cfg = comms.get_config(ctx.tenant_id)
    try:
        await comms.send_sms(cfg, to, "RxVision: δοκιμαστικό SMS από το φαρμακείο σας.")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return {"ok": True}


async def _segment_patient_ids(tenant_id: str, segment: str, value: str | None):
    """Set of patient _ids matching a smart segment, or None = no restriction (all)."""
    db = shared_db()
    now = datetime.now(tz=timezone.utc)
    if not segment or segment == "all":
        return None
    if segment == "upcoming":
        from datetime import timedelta
        days = int(value or 30)
        ids = await db["future_prescriptions"].distinct("patient_ref", {
            "tenant_id": tenant_id, "status": "pending",
            "expected_open_date": {"$gte": now, "$lt": now + timedelta(days=days)}})
        return set(ids)
    if segment == "icd":
        ids = await db["prescription_executions"].distinct("patient_ref", {"tenant_id": tenant_id, "icd10": value})
        return set(ids)
    if segment == "inactive":
        from datetime import timedelta
        cutoff = now - timedelta(days=int(value or 180))
        recent = set(await db["prescription_executions"].distinct("patient_ref", {"tenant_id": tenant_id, "executed_at": {"$gte": cutoff}}))
        allp = set(await db["prescription_executions"].distinct("patient_ref", {"tenant_id": tenant_id}))
        return allp - recent
    if segment == "substance":
        # Escape user input before it reaches a Mongo $regex — prevents regex injection / ReDoS.
        val = re.escape((value or "").upper())
        rows = await db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": tenant_id}},
            {"$lookup": {"from": "prescription_items", "localField": "_id", "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$lookup": {"from": "products", "localField": "it.product_id", "foreignField": "_id", "as": "p"}},
            {"$set": {"atc": {"$toUpper": {"$ifNull": [{"$first": "$p.atc"}, ""]}},
                      "sub": {"$toUpper": {"$ifNull": [{"$first": "$p.substance"}, ""]}}}},
            {"$match": {"$or": [{"atc": {"$regex": "^" + val}}, {"sub": {"$regex": val}}]}},
            {"$group": {"_id": "$patient_ref"}},
        ]).to_list(length=None)
        return {r["_id"] for r in rows}
    return None


async def _audience(tenant_id: str, channel: str, segment: str = "all", value: str | None = None) -> list[dict]:
    field = "email" if channel == "email" else "mobile"
    q: dict = {"tenant_id": tenant_id, "marketing_consent": True, field: {"$nin": [None, ""]}}
    seg = await _segment_patient_ids(tenant_id, segment, value)
    # Consent ledger is authoritative: exclude anyone whose latest event for this channel
    # is a withdrawal/objection, even if a stale contact flag still says consented (GDPR).
    withdrawn = await consent.withdrawn_patient_ids(tenant_id, channel)
    id_filter: dict = {}
    if seg is not None:
        id_filter["$in"] = list(seg)
    if withdrawn:
        id_filter["$nin"] = list(withdrawn)
    if id_filter:
        q["_id"] = id_filter
    rows = await shared_db()["patient_contacts"].aggregate([
        {"$match": q},
        {"$lookup": {"from": "patients_anonymized", "localField": "_id", "foreignField": "_id", "as": "pp"}},
        {"$set": {"name": {"$first": "$pp.full_name"}}},
        {"$project": {"_id": 0, field: 1, "name": 1}},
    ]).to_list(length=None)
    return rows


@router.get("/audience")
async def audience(channel: Literal["email", "sms"] = "email",
                   segment: str = "all", value: str | None = None,
                   ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    rows = await _audience(ctx.tenant_id, channel, segment, value)
    return {"channel": channel, "segment": segment, "count": len(rows)}


class CampaignIn(BaseModel):
    channel: Literal["email", "sms"]
    subject: str | None = None
    message: str
    segment: str = "all"
    value: str | None = None


def _email_html(message: str, from_name: str | None) -> str:
    body = message.replace("\n", "<br/>")
    return f"""<div style="background:#f1f5f9;padding:24px;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="background:#4f46e5;padding:18px 24px;color:#fff;font-size:18px;font-weight:700;">{from_name or "Το φαρμακείο σας"}</div>
        <div style="padding:24px;color:#0f172a;font-size:15px;line-height:1.6;">{body}</div>
        <div style="padding:16px 24px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">
          Λάβατε αυτό το μήνυμα επειδή είστε πελάτης του φαρμακείου μας. Για διαγραφή, απαντήστε «ΔΙΑΓΡΑΦΗ».
        </div>
      </div>
    </div>"""


@router.post("/send", status_code=202)
async def send_campaign(body: CampaignIn, ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    cfg = comms.get_config(ctx.tenant_id)
    rows = await _audience(ctx.tenant_id, body.channel, body.segment, body.value)
    sent = failed = 0
    field = "email" if body.channel == "email" else "mobile"
    for r in rows[:2000]:
        to = r.get(field)
        first = (r.get("name") or "").split(" ")[-1] if r.get("name") else ""
        text = body.message.replace("{name}", r.get("name") or "").replace("{first}", first)
        try:
            if body.channel == "email":
                await comms.send_email(cfg, to, body.subject or "Ενημέρωση φαρμακείου",
                                       _email_html(text, cfg.get("from_name")))
            else:
                await comms.send_sms(cfg, to, text)
            sent += 1
        except Exception:  # noqa: BLE001
            failed += 1
    await shared_db()["comms_campaigns"].insert_one({
        "tenant_id": ctx.tenant_id, "channel": body.channel, "subject": body.subject,
        "recipients": len(rows), "sent": sent, "failed": failed,
        "by": ctx.email if hasattr(ctx, "email") else None,
        "created_at": datetime.now(tz=timezone.utc),
    })
    return {"recipients": len(rows), "sent": sent, "failed": failed}


@router.get("/history")
async def history(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    cur = shared_db()["comms_campaigns"].find({"tenant_id": ctx.tenant_id}).sort("created_at", -1).limit(30)
    out = []
    async for d in cur:
        d["id"] = str(d.pop("_id"))
        out.append(d)
    return {"items": out}
