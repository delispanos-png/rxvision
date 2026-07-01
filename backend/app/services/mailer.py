"""Platform mailer — SMTP config (platform_settings) + newsletter delivery.

SMTP credentials live in `platform_settings` doc _id="smtp". Real delivery via
smtplib (blocking) wrapped in asyncio.to_thread so the event loop stays free.
GET masks the password; sending uses the stored one.
"""

from __future__ import annotations

import asyncio
import smtplib
import ssl
from datetime import datetime, timezone
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr

from app.core.db import shared_db


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def get_smtp(*, masked: bool = True) -> dict | None:
    doc = await shared_db()["platform_settings"].find_one({"_id": "smtp"})
    if not doc:
        return None
    if masked:
        pw = doc.get("password") or ""
        doc = {**doc, "password": ("•" * 6 if pw else ""), "has_password": bool(pw)}
    return doc


async def save_smtp(cfg: dict) -> None:
    db = shared_db()
    existing = await db["platform_settings"].find_one({"_id": "smtp"})
    # keep existing password if the caller didn't send a new one
    if not cfg.get("password") and existing:
        cfg["password"] = existing.get("password", "")
    cfg["_id"] = "smtp"
    cfg["updated_at"] = _now()
    await db["platform_settings"].update_one({"_id": "smtp"}, {"$set": cfg}, upsert=True)


def _send_one(cfg: dict, to: str, subject: str, html: str, reply_to: str | None = None) -> None:
    msg = MIMEText(html, "html", "utf-8")
    # Headers must be RFC2047-encoded or as_string() blows up on non-ASCII (Greek subjects/names).
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr((str(Header(cfg.get("from_name", "RxVision"), "utf-8")), cfg["from_email"]))
    msg["To"] = to
    if reply_to or cfg.get("reply_to"):
        msg["Reply-To"] = reply_to or cfg["reply_to"]
    port = int(cfg.get("port", 587))
    ctx = ssl.create_default_context()
    # Port 465 = implicit TLS (SMTPS) → SMTP_SSL. Port 587/25 = STARTTLS upgrade.
    if port == 465:
        server = smtplib.SMTP_SSL(cfg["host"], port, timeout=20, context=ctx)
    else:
        server = smtplib.SMTP(cfg["host"], port, timeout=20)
        if cfg.get("use_tls", True):
            server.ehlo()
            server.starttls(context=ctx)
            server.ehlo()
    try:
        if cfg.get("username"):
            server.login(cfg["username"], cfg.get("password", ""))
        server.sendmail(cfg["from_email"], [to], msg.as_string())
    finally:
        try:
            server.quit()
        except Exception:  # noqa: BLE001
            pass


async def send_email(to: str, subject: str, html: str) -> None:
    cfg = await get_smtp(masked=False)
    if not cfg or not cfg.get("host"):
        raise RuntimeError("smtp_not_configured")
    await asyncio.to_thread(_send_one, cfg, to, subject, html)


async def send_bulk(recipients: list[str], subject: str, html: str) -> dict:
    """Send to many; never raise per-recipient — count sent/failed."""
    cfg = await get_smtp(masked=False)
    if not cfg or not cfg.get("host"):
        raise RuntimeError("smtp_not_configured")
    sent = failed = 0
    for to in recipients:
        try:
            await asyncio.to_thread(_send_one, cfg, to, subject, html)
            sent += 1
        except Exception:  # noqa: BLE001
            failed += 1
    return {"sent": sent, "failed": failed}


async def send_messages(messages: list[dict]) -> dict:
    """Send per-recipient personalized messages [{to, subject, html}]; count sent/failed."""
    cfg = await get_smtp(masked=False)
    if not cfg or not cfg.get("host"):
        raise RuntimeError("smtp_not_configured")
    sent = failed = 0
    for m in messages:
        try:
            await asyncio.to_thread(_send_one, cfg, m["to"], m["subject"], m["html"])
            sent += 1
        except Exception:  # noqa: BLE001
            failed += 1
    return {"sent": sent, "failed": failed}
