"""Cloud credentials (Hetzner + Cloudflare) for infrastructure/scaling — stored in Vault,
managed only from the platform back-office. Tokens are never returned, logged or committed.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.deps import PlatformContext, get_platform_admin
from app.services.vault_service import vault

router = APIRouter()

_PATH = "platform/cloud"
_SECRETS = ("hetzner_token", "cloudflare_token")


def _cfg() -> dict:
    return dict(vault.get_secret(_PATH) or {})


class CloudIn(BaseModel):
    hetzner_token: str | None = None
    cloudflare_token: str | None = None


@router.get("")
async def get_cloud(ctx: PlatformContext = Depends(get_platform_admin)):
    """Non-secret status only — never echoes the tokens."""
    c = _cfg()
    return {
        "hetzner_configured": bool(c.get("hetzner_token")),
        "cloudflare_configured": bool(c.get("cloudflare_token")),
    }


@router.put("")
async def put_cloud(body: CloudIn, ctx: PlatformContext = Depends(get_platform_admin)):
    c = _cfg()
    new = body.model_dump()
    # blank field on the form = keep the stored secret (masked round-trip)
    for k in _SECRETS:
        if not new.get(k) and c.get(k):
            new[k] = c[k]
    vault.set_secret(_PATH, {k: v for k, v in new.items() if v})
    return {"ok": True}


@router.delete("")
async def clear_cloud(ctx: PlatformContext = Depends(get_platform_admin)):
    vault.set_secret(_PATH, {})
    return {"ok": True}


@router.post("/verify")
async def verify(ctx: PlatformContext = Depends(get_platform_admin)):
    """Validate the stored tokens against the live APIs (read-only)."""
    c = _cfg()
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
