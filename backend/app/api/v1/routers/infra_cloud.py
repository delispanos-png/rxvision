"""Cloud credentials (Hetzner + Cloudflare) for infrastructure/scaling — stored in Vault,
managed only from the platform back-office. Tokens are never returned, logged or committed.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.db import shared_db
from app.core.deps import PlatformContext, get_platform_admin

router = APIRouter()

_SECRETS = ("hetzner_token", "cloudflare_token")


async def _cfg() -> dict:
    # stored in platform_settings (shared DB, auth-protected) like the SMTP config —
    # the app's Vault policy is scoped to tenants/* only.
    return await shared_db()["platform_settings"].find_one({"_id": "cloud"}) or {}


async def _save(cfg: dict) -> None:
    cfg["_id"] = "cloud"
    await shared_db()["platform_settings"].update_one({"_id": "cloud"}, {"$set": cfg}, upsert=True)


class CloudIn(BaseModel):
    hetzner_token: str | None = None
    cloudflare_token: str | None = None


@router.get("")
async def get_cloud(ctx: PlatformContext = Depends(get_platform_admin)):
    """Non-secret status only — never echoes the tokens."""
    c = await _cfg()
    return {
        "hetzner_configured": bool(c.get("hetzner_token")),
        "cloudflare_configured": bool(c.get("cloudflare_token")),
    }


@router.put("")
async def put_cloud(body: CloudIn, ctx: PlatformContext = Depends(get_platform_admin)):
    c = await _cfg()
    new = body.model_dump()
    # blank field on the form = keep the stored secret (masked round-trip)
    for k in _SECRETS:
        if not new.get(k) and c.get(k):
            new[k] = c[k]
    await _save({k: v for k, v in new.items() if v and k in _SECRETS})
    return {"ok": True}


@router.delete("")
async def clear_cloud(ctx: PlatformContext = Depends(get_platform_admin)):
    await _save({"hetzner_token": None, "cloudflare_token": None})
    return {"ok": True}


@router.post("/verify")
async def verify(ctx: PlatformContext = Depends(get_platform_admin)):
    """Validate the stored tokens against the live APIs (read-only)."""
    c = await _cfg()
    out: dict = {}
    if c.get("hetzner_token"):
        try:
            async with httpx.AsyncClient(timeout=15) as cl:
                r = await cl.get("https://api.hetzner.cloud/v1/servers",
                                 headers={"Authorization": f"Bearer {c['hetzner_token']}"})
            out["hetzner_ok"] = r.status_code == 200
            out["hetzner_servers"] = [s["name"] for s in r.json().get("servers", [])] if r.status_code == 200 else []
        except Exception as exc:  # noqa: BLE001
            out["hetzner_ok"] = False
            out["hetzner_error"] = str(exc)[:120]
    if c.get("cloudflare_token"):
        try:
            async with httpx.AsyncClient(timeout=15) as cl:
                r = await cl.get("https://api.cloudflare.com/client/v4/zones",
                                 headers={"Authorization": f"Bearer {c['cloudflare_token']}"})
            data = r.json()
            out["cloudflare_ok"] = bool(data.get("success"))
            out["cloudflare_zones"] = [z["name"] for z in data.get("result", [])] if data.get("success") else []
        except Exception as exc:  # noqa: BLE001
            out["cloudflare_ok"] = False
            out["cloudflare_error"] = str(exc)[:120]
    if not out:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Δεν έχουν αποθηκευτεί tokens.")
    return out
