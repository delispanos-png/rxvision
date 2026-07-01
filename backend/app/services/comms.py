"""Central patient communications — ALL pharmacies send through the platform's OWN channels:

  • Email  → the platform SMTP (`platform_settings._id="smtp"`), From = central address but the
             DISPLAY NAME is the pharmacy and Reply-To is the pharmacy's email.
  • SMS    → central Apifon account (`platform_settings._id="comms"`), sender "RxVision".
  • Viber  → central Apifon IM (Viber) with SMS fallback off, same sender.

Every send is metered & charged to the pharmacy's prepaid credit wallet (message_wallet); if the send
fails after charging, the credits are refunded. Pharmacies no longer configure their own SMTP/SMS.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone

import httpx

from app.core.db import shared_db
from app.services import mailer, message_wallet

_APIFON_BASE = "https://ars.apifon.com"


async def _pharmacy(tenant_id: str) -> dict:
    """Sender identity shown to the patient: the pharmacy's name (email display name / reply-to)."""
    t = await shared_db()["tenants"].find_one(
        {"_id": tenant_id}, {"name": 1, "company": 1, "billing_profile": 1}) or {}
    comp = t.get("company") or {}
    bill = t.get("billing_profile") or {}
    name = comp.get("name") or bill.get("name") or t.get("name") or "Φαρμακείο"
    email = bill.get("email") or comp.get("email") or bill.get("billing_email")
    return {"name": name, "reply_to": email}


async def _apifon() -> dict:
    c = await shared_db()["platform_settings"].find_one({"_id": "comms"}) or {}
    return {"token": c.get("apifon_token"), "secret": c.get("apifon_secret"),
            "sender": c.get("sms_sender") or "RxVision"}


# ── Email (central SMTP, pharmacy display name + reply-to) ───────────────────
async def send_email(tenant_id: str, to: str, subject: str, html: str) -> None:
    ch = await message_wallet.charge(tenant_id, "email", 1, ref=to)   # raises InsufficientCredits
    try:
        cfg = await mailer.get_smtp(masked=False)
        if not cfg or not cfg.get("host"):
            raise RuntimeError("Δεν έχει ρυθμιστεί το κεντρικό email της πλατφόρμας.")
        ph = await _pharmacy(tenant_id)
        cfg = {**cfg, "from_name": ph["name"]}                        # From shows the pharmacy name
        await asyncio.to_thread(mailer._send_one, cfg, to, subject, html, ph["reply_to"])
    except Exception:
        await message_wallet.refund(tenant_id, "email", ch["cost"], ref=to)
        raise


# ── Apifon transport (ApifonWS HMAC) — shared by SMS + Viber ────────────────
async def _apifon_post(path: str, body: str) -> None:
    ap = await _apifon()
    token, secret = ap["token"], ap["secret"]
    if not (token and secret):
        raise RuntimeError("Δεν έχει ρυθμιστεί ο πάροχος μηνυμάτων (Apifon) στην πλατφόρμα.")
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
        r = await client.post(_APIFON_BASE + path, content=body, headers=headers)
        if r.status_code >= 300:
            raise RuntimeError(f"Apifon error {r.status_code}: {r.text[:200]}")


def _body(text: str, sender: str, to: str) -> str:
    return ('{"message":{"text":' + _json(text) + ',"sender_id":' + _json(sender) + "},"
            '"subscribers":[{"number":' + _json(_normalize(to)) + "}]}")


async def send_sms(tenant_id: str, to: str, text: str) -> None:
    ap = await _apifon()
    ch = await message_wallet.charge(tenant_id, "sms", 1, ref=to)
    try:
        await _apifon_post("/services/api/v1/sms/send", _body(text, ap["sender"], to))
    except Exception:
        await message_wallet.refund(tenant_id, "sms", ch["cost"], ref=to)
        raise


async def send_viber(tenant_id: str, to: str, text: str) -> None:
    """Central Apifon IM (Viber). Text-only, no SMS fallback (that would double-charge)."""
    ap = await _apifon()
    ch = await message_wallet.charge(tenant_id, "viber", 1, ref=to)
    try:
        await _apifon_post("/services/api/v1/im/send", _body(text, ap["sender"], to))
    except Exception:
        await message_wallet.refund(tenant_id, "viber", ch["cost"], ref=to)
        raise


async def admin_test_send(channel: str, to: str, text: str) -> None:
    """Platform-admin test send via the CENTRAL provider — NOT charged to any wallet. Verifies the
    Apifon (SMS/Viber) or SMTP (email) config works."""
    if channel == "email":
        subj = "RxVision — δοκιμαστικό email (admin)"
        await mailer.send_email(to, subj, f"<p>{text}</p>")
        return
    ap = await _apifon()
    path = "/services/api/v1/im/send" if channel == "viber" else "/services/api/v1/sms/send"
    await _apifon_post(path, _body(text, ap["sender"], to))


def _json(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def _normalize(num: str) -> str:
    n = "".join(ch for ch in (num or "") if ch.isdigit() or ch == "+")
    if n.startswith("00"):
        n = "+" + n[2:]
    if not n.startswith("+") and n.startswith("69"):
        n = "+30" + n  # Greek mobile
    return n.lstrip("+")
