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
from app.services import comms, consent, message_wallet

router = APIRouter()
_MODULE = "patient_analytics"


@router.get("/settings")
async def get_settings(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Central model: no per-pharmacy SMTP/SMS config anymore — just the prepaid credit wallet status."""
    return {"central": True, **await message_wallet.usage_summary(ctx.tenant_id)}


@router.get("/wallet")
async def wallet(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return {**await message_wallet.usage_summary(ctx.tenant_id),
            "ledger": await message_wallet.ledger(ctx.tenant_id, limit=50)}


async def _test_send(channel: str, to: str, tenant_id: str):
    try:
        if channel == "email":
            await comms.send_email(tenant_id, to, "RxVision — δοκιμαστικό email",
                                   "<p>Το κεντρικό email της πλατφόρμας λειτουργεί για το φαρμακείο σου. ✅</p>")
        elif channel == "viber":
            await comms.send_viber(tenant_id, to, "RxVision: δοκιμαστικό Viber από το φαρμακείο σου.")
        else:
            await comms.send_sms(tenant_id, to, "RxVision: δοκιμαστικό SMS από το φαρμακείο σου.")
    except message_wallet.InsufficientCredits:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "Ανεπαρκές υπόλοιπο μηνυμάτων.")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return {"ok": True}


@router.post("/test-email")
async def test_email(to: str = Query(...), ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _test_send("email", to, ctx.tenant_id)


@router.post("/test-sms")
async def test_sms(to: str = Query(...), ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _test_send("sms", to, ctx.tenant_id)


@router.post("/test-viber")
async def test_viber(to: str = Query(...), ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _test_send("viber", to, ctx.tenant_id)


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
        val = re.escape((value or "").upper())  # escape → no ReDoS on shared Mongo
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
async def audience(channel: Literal["email", "sms", "viber"] = "email",
                   segment: str = "all", value: str | None = None,
                   ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    rows = await _audience(ctx.tenant_id, channel, segment, value)
    return {"channel": channel, "segment": segment, "count": len(rows)}


class CampaignIn(BaseModel):
    channel: Literal["email", "sms", "viber"]
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
    ph = await comms._pharmacy(ctx.tenant_id)
    rows = await _audience(ctx.tenant_id, body.channel, body.segment, body.value)
    sent = failed = 0
    stopped = False
    field = "email" if body.channel == "email" else "mobile"
    for r in rows[:2000]:
        to = r.get(field)
        first = (r.get("name") or "").split(" ")[-1] if r.get("name") else ""
        text = body.message.replace("{name}", r.get("name") or "").replace("{first}", first)
        try:
            if body.channel == "email":
                await comms.send_email(ctx.tenant_id, to, body.subject or "Ενημέρωση φαρμακείου",
                                       _email_html(text, ph["name"]))
            elif body.channel == "viber":
                await comms.send_viber(ctx.tenant_id, to, text)
            else:
                await comms.send_sms(ctx.tenant_id, to, text)
            sent += 1
        except message_wallet.InsufficientCredits:
            stopped = True   # wallet empty → stop the campaign, report what went out
            break
        except Exception:  # noqa: BLE001
            failed += 1
    await shared_db()["comms_campaigns"].insert_one({
        "tenant_id": ctx.tenant_id, "channel": body.channel, "subject": body.subject,
        "recipients": len(rows), "sent": sent, "failed": failed,
        "by": ctx.email if hasattr(ctx, "email") else None,
        "created_at": datetime.now(tz=timezone.utc),
    })
    return {"recipients": len(rows), "sent": sent, "failed": failed,
            "stopped_no_credits": stopped, "balance_cents": await message_wallet.balance(ctx.tenant_id)}


@router.get("/history")
async def history(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    cur = shared_db()["comms_campaigns"].find({"tenant_id": ctx.tenant_id}).sort("created_at", -1).limit(30)
    out = []
    async for d in cur:
        d["id"] = str(d.pop("_id"))
        out.append(d)
    return {"items": out}
