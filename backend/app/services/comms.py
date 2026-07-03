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
import json

import httpx

from app.core.db import shared_db
from app.services import mailer, message_wallet

_APIFON_BASE = "https://ars.apifon.com"
_APIFON_OAUTH = "https://ids.apifon.com/oauth2/token"
# OAuth2 bearer-token cache (client_credentials). Apifon expires_in is huge (~years) but we cap the
# cache and refetch on a 401. Per-process cache (each api/worker process fetches once).
# Per-account token cache (keyed by client_id) — SMS & Viber μπορεί να είναι ΔΙΑΦΟΡΕΤΙΚΟΙ λογαριασμοί
# Apifon (π.χ. SMS→Pharmacy1 που παραδίδει Ελλάδα, Viber→CloudOn που έχει IM gateway).
_token_cache: dict = {}


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
    from app.services.platform_secrets import decrypt_doc
    c = decrypt_doc("comms", await shared_db()["platform_settings"].find_one({"_id": "comms"})) or {}
    dflt_id, dflt_sec = c.get("apifon_token"), c.get("apifon_secret")
    return {
        # default / Viber / balance account (IM gateway) — π.χ. CloudOn
        "token": dflt_id, "secret": dflt_sec,
        "viber_sender": c.get("viber_sender") or c.get("sms_sender") or "RxVision",
        # SMS account — μπορεί να είναι ΞΕΧΩΡΙΣΤΟΣ λογαριασμός που παραδίδει SMS Ελλάδας (π.χ. Pharmacy1)·
        # αν δεν έχει οριστεί, πέφτει στον default.
        "sms_token": c.get("apifon_sms_token") or dflt_id,
        "sms_secret": c.get("apifon_sms_secret") or dflt_sec,
        "sender": c.get("sms_sender") or "RxVision"}


async def apifon_balance() -> dict:
    """Το ΔΙΚΟ ΜΑΣ υπόλοιπο στον κεντρικό λογαριασμό Apifon (POST /services/api/v1/balance).
    → {balance, reserved, plafon, subscriptions}. Για το admin tab «Πορτοφόλι Apifon»."""
    ap = await _apifon()
    if not (ap["token"] and ap["secret"]):
        raise RuntimeError("Δεν έχει ρυθμιστεί ο πάροχος (Apifon).")
    tok = await _apifon_token(ap["token"], ap["secret"])
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(_APIFON_BASE + "/services/api/v1/balance", content="{}",
                              headers={"Content-Type": "application/json",
                                       "Authorization": f"Bearer {tok}"})
    if r.status_code >= 300:
        raise RuntimeError(f"Apifon balance error {r.status_code}: {r.text[:200]}")
    return r.json()


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


# ── Apifon transport (OAuth2 client_credentials → Bearer) — shared by SMS + Viber ────────────
# Τα Apifon credentials είναι client_id/client_secret (OAuth2, docs.apifon.com/authentication.html),
# ΟΧΙ ApifonWS HMAC token/secret. Παίρνουμε bearer από το Identity Service και το βάζουμε ΜΟΝΟ στο
# Authorization header — καμία υπογραφή/timestamp. (Το παλιό HMAC έβγαζε 401 με αυτά τα creds.)
async def _apifon_token(client_id: str, client_secret: str, *, force: bool = False) -> str:
    import time
    now = time.time()
    ent = _token_cache.get(client_id)
    if not force and ent and ent["exp"] > now + 60:
        return ent["token"]
    # ΚΡΙΣΙΜΟ (2026-07-02): ΧΩΡΙΣ `scope`. Όταν ζητούσαμε scope "accountInfo imGateway smsGateway"
    # ο λογαριασμός εξέδιδε token με περιορισμένα δικαιώματα → SMS send έβγαζε 401 (το Viber δούλευε).
    # Το working PharmacyOne app ζητά token χωρίς scope → πλήρη δικαιώματα → SMS παραδίδεται. Verified
    # live: ίδια creds με scope=401, χωρίς scope=200 & το SMS ήρθε στο κινητό.
    form = {"grant_type": "client_credentials", "client_id": client_id,
            "client_secret": client_secret}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(_APIFON_OAUTH, data=form,
                              headers={"Content-Type": "application/x-www-form-urlencoded"})
    if r.status_code >= 300:
        raise RuntimeError(f"Apifon OAuth error {r.status_code}: {r.text[:200]}")
    j = r.json()
    tok = j["access_token"]
    _token_cache[client_id] = {"token": tok, "exp": now + min(int(j.get("expires_in", 3600)), 86400)}
    return tok


async def _apifon_post(path: str, body: str, cid: str, csec: str) -> None:
    if not (cid and csec):
        raise RuntimeError("Δεν έχει ρυθμιστεί ο πάροχος μηνυμάτων (Apifon) στην πλατφόρμα.")
    for attempt in range(2):                # refetch token once on a 401 (stale token)
        tok = await _apifon_token(cid, csec, force=(attempt == 1))
        from datetime import datetime, timezone
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(_APIFON_BASE + path, content=body,
                                  headers={"Content-Type": "application/json; charset=utf-8",
                                           "Authorization": f"Bearer {tok}",
                                           "X-ApifonWS-Date": datetime.now(timezone.utc)
                                           .strftime("%a, %d %b %Y %H:%M:%S GMT")})
        if r.status_code == 401 and attempt == 0:
            continue
        if r.status_code >= 300:
            raise RuntimeError(f"Apifon error {r.status_code}: {r.text[:200]}")
        return


def _body(text: str, sender: str, to: str) -> str:
    """SMS body (SMS Gateway): message.text/sender_id + subscribers."""
    return ('{"message":{"text":' + _json(text) + ',"sender_id":' + _json(sender) + "},"
            '"subscribers":[{"number":' + _json(_normalize(to)) + "}]}")


def _im_body(text: str, sender: str, to: str) -> str:
    """Viber/IM body (IM Gateway): το περιεχόμενο πάει ΜΕΣΑ στο im_channel (verified live 2026-07-01:
    im_channels:[{id:viber,text,sender_id}] → 200). Το top-level message ΔΕΝ εφαρμόζεται στο viber."""
    return ('{"subscribers":[{"number":' + _json(_normalize(to)) + "}],"
            '"im_channels":[{"id":"viber","text":' + _json(text) + ',"sender_id":' + _json(sender) + "}]}")


async def send_sms(tenant_id: str, to: str, text: str) -> None:
    ap = await _apifon()
    ch = await message_wallet.charge(tenant_id, "sms", 1, ref=to)
    try:
        await _apifon_post("/services/api/v1/sms/send", _body(text, ap["sender"], to),
                           ap["sms_token"], ap["sms_secret"])
    except Exception:
        await message_wallet.refund(tenant_id, "sms", ch["cost"], ref=to)
        raise


async def send_otp_sms(to: str, text: str) -> None:
    """Platform-level SMS for security OTPs (portal registration ownership proof). Uses the central
    Apifon SMS account WITHOUT per-tenant wallet metering — it is a platform action, not a pharmacy's
    marketing message, and must never be blocked by a pharmacy's wallet balance. Low volume."""
    ap = await _apifon()
    await _apifon_post("/services/api/v1/sms/send", _body(text, ap["sender"], to),
                       ap["sms_token"], ap["sms_secret"])


async def send_viber(tenant_id: str, to: str, text: str) -> None:
    """Central Apifon IM (Viber). Text-only, no SMS fallback (that would double-charge)."""
    ap = await _apifon()
    ch = await message_wallet.charge(tenant_id, "viber", 1, ref=to)
    try:
        await _apifon_post("/services/api/v1/im/send", _im_body(text, ap["viber_sender"], to),
                           ap["token"], ap["secret"])
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
    if channel == "viber":
        await _apifon_post("/services/api/v1/im/send", _im_body(text, ap["viber_sender"], to),
                           ap["token"], ap["secret"])
    else:
        await _apifon_post("/services/api/v1/sms/send", _body(text, ap["sender"], to),
                           ap["sms_token"], ap["sms_secret"])


def _json(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def _normalize(num: str) -> str:
    n = "".join(ch for ch in (num or "") if ch.isdigit() or ch == "+")
    if n.startswith("00"):
        n = "+" + n[2:]
    if not n.startswith("+") and n.startswith("69"):
        n = "+30" + n  # Greek mobile
    return n.lstrip("+")
