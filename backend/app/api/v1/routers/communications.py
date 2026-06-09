"""Communications router — per-tenant email/SMS config + patient campaigns (newsletter
/ reminders). The pharmacy sets up its OWN sender; sends go only to consented patients."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.db import shared_db
from app.core.deps import TenantContext, require
from app.services import comms

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


async def _audience(tenant_id: str, channel: str) -> list[dict]:
    field = "email" if channel == "email" else "mobile"
    cur = shared_db()["patient_contacts"].find(
        {"tenant_id": tenant_id, "marketing_consent": True, field: {"$nin": [None, ""]}},
        {field: 1, "_id": 0})
    return [d async for d in cur]


@router.get("/audience")
async def audience(channel: Literal["email", "sms"] = "email",
                   ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    rows = await _audience(ctx.tenant_id, channel)
    return {"channel": channel, "count": len(rows)}


class CampaignIn(BaseModel):
    channel: Literal["email", "sms"]
    subject: str | None = None
    message: str


@router.post("/send", status_code=202)
async def send_campaign(body: CampaignIn, ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    cfg = comms.get_config(ctx.tenant_id)
    rows = await _audience(ctx.tenant_id, body.channel)
    sent = failed = 0
    field = "email" if body.channel == "email" else "mobile"
    html = "<div style='font-family:Arial'>" + body.message.replace("\n", "<br/>") + "</div>"
    for r in rows[:1000]:
        to = r.get(field)
        try:
            if body.channel == "email":
                await comms.send_email(cfg, to, body.subject or "Ενημέρωση φαρμακείου", html)
            else:
                await comms.send_sms(cfg, to, body.message)
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
