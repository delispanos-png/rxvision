"""Tenant communications — the pharmacy's OWN email (SMTP) + SMS (Apifon) channels,
for patient newsletters/reminders. Secrets live in Vault under tenants/{id}/comms.
Email reuses the SMTP sender; SMS targets the Apifon REST API."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
from datetime import datetime, timezone

import httpx

from app.services import mailer
from app.services.vault_service import vault

_PATH = "comms"


def get_config(tenant_id: str) -> dict:
    return dict(vault.get_secret(f"tenants/{tenant_id}/{_PATH}") or {})


def save_config(tenant_id: str, cfg: dict) -> None:
    vault.set_tenant_credentials(tenant_id, _PATH, cfg)


def public_view(cfg: dict) -> dict:
    """Non-secret status for the settings UI (never returns passwords/keys)."""
    return {
        "email_configured": bool(cfg.get("smtp_host") and cfg.get("from_email")),
        "from_name": cfg.get("from_name"),
        "from_email": cfg.get("from_email"),
        "smtp_host": cfg.get("smtp_host"),
        "smtp_port": cfg.get("smtp_port", 587),
        "smtp_username": cfg.get("smtp_username"),
        "smtp_use_tls": cfg.get("smtp_use_tls", True),
        "sms_configured": bool(cfg.get("apifon_token") and cfg.get("sms_sender")),
        "sms_sender": cfg.get("sms_sender"),
    }


def _smtp_cfg(cfg: dict) -> dict:
    return {
        "host": cfg.get("smtp_host"), "port": int(cfg.get("smtp_port", 587)),
        "username": cfg.get("smtp_username"), "password": cfg.get("smtp_password", ""),
        "use_tls": cfg.get("smtp_use_tls", True),
        "from_email": cfg.get("from_email"), "from_name": cfg.get("from_name", "Φαρμακείο"),
    }


async def send_email(cfg: dict, to: str, subject: str, html: str) -> None:
    if not (cfg.get("smtp_host") and cfg.get("from_email")):
        raise RuntimeError("Δεν έχει ρυθμιστεί email αποστολέα.")
    await asyncio.to_thread(mailer._send_one, _smtp_cfg(cfg), to, subject, html)


async def send_sms(cfg: dict, to: str, text: str) -> None:
    """Apifon REST v1 SMS. Requires apifon_token + apifon_secret + sms_sender."""
    token, secret, sender = cfg.get("apifon_token"), cfg.get("apifon_secret"), cfg.get("sms_sender")
    if not (token and secret and sender):
        raise RuntimeError("Δεν έχει ρυθμιστεί πάροχος SMS.")
    path = "/services/api/v1/sms/send"
    body = (
        '{"message":{"text":' + _json_str(text) + ',"sender_id":' + _json_str(sender) + "},"
        '"subscribers":[{"number":' + _json_str(_normalize(to)) + "}]}"
    )
    content_md5 = base64.b64encode(hashlib.md5(body.encode()).digest()).decode()
    date = datetime.now(tz=timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")
    to_sign = f"POST\n{content_md5}\napplication/json\n{date}\n{path}"
    sig = base64.b64encode(hmac.new(secret.encode(), to_sign.encode(), hashlib.sha256).digest()).decode()
    headers = {
        "Content-Type": "application/json", "Content-MD5": content_md5,
        "X-ApifonWS-Date": date, "Date": date,
        "Authorization": f"ApifonWS {token}:{sig}",
    }
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post("https://ars.apifon.com" + path, content=body, headers=headers)
        if r.status_code >= 300:
            raise RuntimeError(f"Apifon error {r.status_code}: {r.text[:200]}")


def _json_str(s: str) -> str:
    import json
    return json.dumps(s, ensure_ascii=False)


def _normalize(num: str) -> str:
    n = "".join(ch for ch in (num or "") if ch.isdigit() or ch == "+")
    if n.startswith("00"):
        n = "+" + n[2:]
    if not n.startswith("+") and n.startswith("69"):
        n = "+30" + n  # Greek mobile
    return n.lstrip("+")
