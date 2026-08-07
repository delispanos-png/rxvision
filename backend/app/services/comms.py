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
from datetime import datetime, timezone

import httpx

from app.core.db import shared_db


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)
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


async def check_central_balance() -> dict:
    """Ειδοποίησε τον platform admin όταν το ΚΕΝΤΡΙΚΟ υπόλοιπο Apifon πέσει κάτω από όριο, ώστε να μη
    «στερέψει» ο κοινός λογαριασμός και διακοπούν ΟΛΑ τα φαρμακεία. Idempotent: μία ειδοποίηση μέχρι
    να ανακάμψει (flag `central_low_alerted`). Όριο & email admin: platform_settings.comms."""
    from app.services.platform_secrets import decrypt_doc
    db = shared_db()
    cfg = decrypt_doc("comms", await db["platform_settings"].find_one({"_id": "comms"})) or {}
    threshold = float(cfg.get("central_low_balance") or 0)
    if threshold <= 0:
        return {"skipped": "no_threshold"}
    try:
        bal = await apifon_balance()
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:150]}
    balance = float(bal.get("balance") or 0)
    alerted = bool(cfg.get("central_low_alerted"))
    upd = {"central_balance_last": balance, "central_balance_checked_at": _now()}
    if balance < threshold and not alerted:
        admin_email = cfg.get("admin_alert_email") or "delis.panos@gmail.com"
        from app.services import mailer
        try:
            await mailer.send_email(
                admin_email, "⚠️ RxVision — Χαμηλό κεντρικό υπόλοιπο Apifon",
                f"<p>Το <b>κεντρικό</b> υπόλοιπο Apifon έπεσε στα <b>{balance}</b> (όριο {threshold}).</p>"
                "<p>Κάνε ανανέωση μονάδων στον λογαριασμό Apifon για να μη διακοπούν τα μηνύματα των "
                "φαρμακείων (όλα αντλούν από αυτόν τον κοινό λογαριασμό).</p><p>— RxVision</p>")
        except Exception:  # noqa: BLE001
            pass
        upd["central_low_alerted"] = True
    elif balance >= threshold and alerted:
        upd["central_low_alerted"] = False   # ανάκαμψη → reset (θα ξαναειδοποιήσει αν ξαναπέσει)
    await db["platform_settings"].update_one({"_id": "comms"}, {"$set": upd}, upsert=True)
    return {"balance": balance, "threshold": threshold, "low": balance < threshold}


# ── Email (central SMTP, pharmacy display name + reply-to) ───────────────────
async def send_email(tenant_id: str, to: str, subject: str, html: str, *,
                     patient_ref: str | None = None, campaign_id: str | None = None,
                     kind: str = "message", charge: bool = True) -> None:
    ch = await message_wallet.charge(tenant_id, "email", 1, ref=to) if charge else {"cost": 0}  # raises InsufficientCredits
    try:
        cfg = await mailer.get_smtp(masked=False)
        if not cfg or not cfg.get("host"):
            raise RuntimeError("Δεν έχει ρυθμιστεί το κεντρικό email της πλατφόρμας.")
        ph = await _pharmacy(tenant_id)
        cfg = {**cfg, "from_name": ph["name"]}                        # From shows the pharmacy name
        await asyncio.to_thread(mailer._send_one, cfg, to, subject, html, ph["reply_to"])
    except Exception as exc:
        if charge:
            await message_wallet.refund(tenant_id, "email", ch["cost"], ref=to)
        await _log_message(tenant_id, "email", to, cost_cents=0, status="failed", subject=subject,
                           patient_ref=patient_ref, campaign_id=campaign_id, kind=kind, error=exc)
        raise
    # email: το SMTP δέχτηκε → «sent» (bounce/παράδοση δεν ανιχνεύεται χωρίς bounce-handling)
    await _log_message(tenant_id, "email", to, cost_cents=ch["cost"], status="sent", subject=subject,
                       patient_ref=patient_ref, campaign_id=campaign_id, kind=kind)


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


async def _apifon_post(path: str, body: str, cid: str, csec: str) -> dict:
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
        try:                                 # κράτα την απόκριση → provider message id (για DLR/παράδοση)
            return r.json() if r.text else {}
        except Exception:  # noqa: BLE001
            return {}
    return {}


def _extract_msg_id(resp) -> str | None:
    """Provider message id από την απόκριση Apifon — αμυντικά (κρατιέται για matching στο DLR webhook)."""
    if not isinstance(resp, dict):
        return None
    if resp.get("request_id"):
        return str(resp["request_id"])
    results = resp.get("results")
    if isinstance(results, dict):
        for v in results.values():
            if isinstance(v, dict) and (v.get("message_id") or v.get("id")):
                return str(v.get("message_id") or v.get("id"))
    if isinstance(results, list) and results and isinstance(results[0], dict):
        r0 = results[0]
        return str(r0.get("message_id") or r0.get("id") or "") or None
    return str(resp.get("id") or "") or None


async def _log_message(tenant_id: str, channel: str, recipient: str, *, cost_cents: int, status: str,
                       provider_message_id: str | None = None, subject: str | None = None,
                       patient_ref: str | None = None, campaign_id: str | None = None,
                       kind: str = "message", error=None) -> None:
    """Καταγραφή ΑΝΑ μήνυμα: ποιος, κανάλι, κόστος, status (sent/failed· delivered/undelivered από DLR)."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    doc: dict = {"tenant_id": tenant_id, "channel": channel, "recipient": recipient,
                 "cost_cents": int(cost_cents or 0), "status": status, "kind": kind,
                 "created_at": now, "updated_at": now}
    if provider_message_id:
        doc["provider_message_id"] = provider_message_id
    if subject:
        doc["subject"] = subject[:200]
    if patient_ref:
        doc["patient_ref"] = patient_ref
    if campaign_id:
        doc["campaign_id"] = campaign_id
    if error is not None:
        doc["error"] = str(error)[:300]
    try:
        await shared_db()["sent_messages"].insert_one(doc)
    except Exception:  # noqa: BLE001 — το log δεν πρέπει ΠΟΤΕ να σπάσει την αποστολή
        pass


def _body(text: str, sender: str, to: str) -> str:
    """SMS body (SMS Gateway): message.text/sender_id + subscribers."""
    return ('{"message":{"text":' + _json(text) + ',"sender_id":' + _json(sender) + "},"
            '"subscribers":[{"number":' + _json(_normalize(to)) + "}]}")


def _im_body(text: str, sender: str, to: str) -> str:
    """Viber/IM body (IM Gateway): το περιεχόμενο πάει ΜΕΣΑ στο im_channel (verified live 2026-07-01:
    im_channels:[{id:viber,text,sender_id}] → 200). Το top-level message ΔΕΝ εφαρμόζεται στο viber."""
    return ('{"subscribers":[{"number":' + _json(_normalize(to)) + "}],"
            '"im_channels":[{"id":"viber","text":' + _json(text) + ',"sender_id":' + _json(sender) + "}]}")


# ── Per-tenant sender IDs (η επωνυμία ΚΑΘΕ φαρμακείου ως αποστολέας — απαιτεί έγκριση Apifon) ──────
async def tenant_sender_config(tenant_id: str) -> dict:
    """Sender IDs του φαρμακείου + κατάσταση έγκρισης (για UI φαρμακείου/admin)."""
    d = await shared_db()["tenant_comms"].find_one({"_id": tenant_id}) or {}
    return {"sms_sender": d.get("sms_sender") or "", "sms_sender_approved": bool(d.get("sms_sender_approved")),
            "viber_sender": d.get("viber_sender") or "", "viber_sender_approved": bool(d.get("viber_sender_approved"))}


async def _resolved_sender(tenant_id: str, channel: str, default: str) -> str:
    """Ο ΕΓΚΕΚΡΙΜΕΝΟΣ sender του φαρμακείου (αν υπάρχει), αλλιώς ο κεντρικός default (RxVision).
    Ένας μη-εγκεκριμένος sender ΔΕΝ χρησιμοποιείται (η Apifon θα τον απέρριπτε)."""
    d = await shared_db()["tenant_comms"].find_one({"_id": tenant_id}) or {}
    key = "sms" if channel == "sms" else "viber"
    if d.get(f"{key}_sender") and d.get(f"{key}_sender_approved"):
        return d[f"{key}_sender"]
    return default


async def request_tenant_sender(tenant_id: str, channel: str, sender: str) -> dict:
    """Το φαρμακείο ΖΗΤΑΕΙ όνομα αποστολέα → αποθηκεύεται ως pending (approved=False) μέχρι ο admin το
    εγκρίνει (αφού το δηλώσει στην Apifon). Κενό = επαναφορά στον κεντρικό."""
    key = "sms" if channel == "sms" else "viber"
    s = (sender or "").strip()[:20]
    await shared_db()["tenant_comms"].update_one(
        {"_id": tenant_id}, {"$set": {f"{key}_sender": s, f"{key}_sender_approved": False,
                                      f"{key}_sender_requested_at": _now()}}, upsert=True)
    return await tenant_sender_config(tenant_id)


async def approve_tenant_sender(tenant_id: str, channel: str, approved: bool) -> dict:
    """Ο platform admin εγκρίνει/απορρίπτει τον sender ενός φαρμακείου (αφού εγκριθεί στην Apifon)."""
    key = "sms" if channel == "sms" else "viber"
    await shared_db()["tenant_comms"].update_one(
        {"_id": tenant_id}, {"$set": {f"{key}_sender_approved": bool(approved), f"{key}_sender_approved_at": _now()}},
        upsert=True)
    return await tenant_sender_config(tenant_id)


async def pending_sender_requests() -> list[dict]:
    """ΟΛΑ τα φαρμακεία που έχουν ζητήσει sender (εκκρεμή Ή εγκεκριμένα) — ώστε ο admin να συνεχίζει να
    τα βλέπει, να τα ανακαλεί ή να τα διαγράφει (π.χ. αν το φαρμακείο θέλει αλλαγή ονόματος)."""
    db = shared_db()
    out = []
    async for d in db["tenant_comms"].find({"$or": [
            {"sms_sender": {"$nin": [None, ""]}},
            {"viber_sender": {"$nin": [None, ""]}}]}):
        t = await db["tenants"].find_one({"_id": d["_id"]}, {"name": 1})
        out.append({"tenant_id": d["_id"], "name": (t or {}).get("name"),
                    "sms_sender": d.get("sms_sender") or "", "sms_sender_approved": bool(d.get("sms_sender_approved")),
                    "viber_sender": d.get("viber_sender") or "", "viber_sender_approved": bool(d.get("viber_sender_approved"))})
    return out


async def clear_tenant_sender(tenant_id: str, channel: str) -> dict:
    """Διαγραφή του custom sender ενός φαρμακείου → επαναφορά στο κεντρικό (RxVision)."""
    key = "sms" if channel == "sms" else "viber"
    await shared_db()["tenant_comms"].update_one(
        {"_id": tenant_id}, {"$unset": {f"{key}_sender": "", f"{key}_sender_approved": "",
                                        f"{key}_sender_requested_at": "", f"{key}_sender_approved_at": ""}})
    return await tenant_sender_config(tenant_id)


async def send_sms(tenant_id: str, to: str, text: str, *, patient_ref: str | None = None,
                   campaign_id: str | None = None, kind: str = "message", charge: bool = True) -> None:
    ap = await _apifon()
    sender = await _resolved_sender(tenant_id, "sms", ap["sender"])
    ch = await message_wallet.charge(tenant_id, "sms", 1, ref=to) if charge else {"cost": 0}
    try:
        resp = await _apifon_post("/services/api/v1/sms/send", _body(text, sender, to),
                                  ap["sms_token"], ap["sms_secret"])
    except Exception as exc:
        if charge:
            await message_wallet.refund(tenant_id, "sms", ch["cost"], ref=to)
        await _log_message(tenant_id, "sms", to, cost_cents=0, status="failed",
                           patient_ref=patient_ref, campaign_id=campaign_id, kind=kind, error=exc)
        raise
    await _log_message(tenant_id, "sms", to, cost_cents=ch["cost"], status="sent",
                       provider_message_id=_extract_msg_id(resp),
                       patient_ref=patient_ref, campaign_id=campaign_id, kind=kind)


async def send_otp_sms(to: str, text: str) -> None:
    """Platform-level SMS for security OTPs (portal registration ownership proof). Uses the central
    Apifon SMS account WITHOUT per-tenant wallet metering — it is a platform action, not a pharmacy's
    marketing message, and must never be blocked by a pharmacy's wallet balance. Low volume."""
    ap = await _apifon()
    await _apifon_post("/services/api/v1/sms/send", _body(text, ap["sender"], to),
                       ap["sms_token"], ap["sms_secret"])


async def send_viber(tenant_id: str, to: str, text: str, *, patient_ref: str | None = None,
                     campaign_id: str | None = None, kind: str = "message", charge: bool = True) -> None:
    """Central Apifon IM (Viber). Text-only. Το Viber→SMS fallback γίνεται στο DLR webhook όταν το
    Viber δεν παραδοθεί (όχι εδώ — θα ήταν διπλή χρέωση)."""
    ap = await _apifon()
    sender = await _resolved_sender(tenant_id, "viber", ap["viber_sender"])
    ch = await message_wallet.charge(tenant_id, "viber", 1, ref=to) if charge else {"cost": 0}
    try:
        resp = await _apifon_post("/services/api/v1/im/send", _im_body(text, sender, to),
                                  ap["token"], ap["secret"])
    except Exception as exc:
        if charge:
            await message_wallet.refund(tenant_id, "viber", ch["cost"], ref=to)
        await _log_message(tenant_id, "viber", to, cost_cents=0, status="failed",
                           patient_ref=patient_ref, campaign_id=campaign_id, kind=kind, error=exc)
        raise
    await _log_message(tenant_id, "viber", to, cost_cents=ch["cost"], status="sent",
                       provider_message_id=_extract_msg_id(resp),
                       patient_ref=patient_ref, campaign_id=campaign_id, kind=kind)


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


# ── reusable campaign engine (shared by the /communications router AND Copilot routines) ──────────
def _campaign_email_html(message: str, from_name: str | None) -> str:
    body = message.replace("\n", "<br/>")
    return (f'<div style="background:#f1f5f9;padding:24px;font-family:Arial,Helvetica,sans-serif;">'
            f'<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;'
            f'box-shadow:0 1px 4px rgba(0,0,0,.08);">'
            f'<div style="background:#4f46e5;padding:18px 24px;color:#fff;font-size:18px;font-weight:700;">'
            f'{from_name or "Το φαρμακείο σας"}</div>'
            f'<div style="padding:24px;color:#0f172a;font-size:15px;line-height:1.6;">{body}</div>'
            f'<div style="padding:16px 24px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">'
            f'Λάβατε αυτό το μήνυμα επειδή είστε πελάτης του φαρμακείου μας. Για διαγραφή, απαντήστε «ΔΙΑΓΡΑΦΗ».'
            f'</div></div></div>')


async def segment_patient_ids(tenant_id: str, segment: str, value: str | None):
    """Set of patient _ids matching a smart segment, or None = no restriction (all)."""
    import re
    from datetime import timedelta
    db = shared_db()
    now = _now()
    if not segment or segment == "all":
        return None
    if segment == "upcoming":
        days = int(value or 30)
        ids = await db["future_prescriptions"].distinct("patient_ref", {
            "tenant_id": tenant_id, "status": "pending",
            "expected_open_date": {"$gte": now, "$lt": now + timedelta(days=days)}})
        return set(ids)
    if segment == "icd":
        ids = await db["prescription_executions"].distinct("patient_ref", {"tenant_id": tenant_id, "icd10": value})
        return set(ids)
    if segment == "inactive":
        cutoff = now - timedelta(days=int(value or 180))
        recent = set(await db["prescription_executions"].distinct("patient_ref", {"tenant_id": tenant_id, "executed_at": {"$gte": cutoff}}))
        allp = set(await db["prescription_executions"].distinct("patient_ref", {"tenant_id": tenant_id}))
        return allp - recent
    if segment == "substance":
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


async def campaign_audience(tenant_id: str, channel: str, segment: str = "all", value: str | None = None) -> list[dict]:
    """Consented recipients (marketing_consent + NOT in the withdrawal ledger for this channel) with a
    contact for `channel`, restricted to a smart segment. GDPR: the consent ledger is authoritative."""
    from app.services import consent
    field = "email" if channel == "email" else "mobile"
    q: dict = {"tenant_id": tenant_id, "marketing_consent": True, field: {"$nin": [None, ""]}}
    seg = await segment_patient_ids(tenant_id, segment, value)
    withdrawn = await consent.withdrawn_patient_ids(tenant_id, channel)
    id_filter: dict = {}
    if seg is not None:
        id_filter["$in"] = list(seg)
    if withdrawn:
        id_filter["$nin"] = list(withdrawn)
    if id_filter:
        q["_id"] = id_filter
    return await shared_db()["patient_contacts"].aggregate([
        {"$match": q},
        {"$lookup": {"from": "patients_anonymized", "localField": "_id", "foreignField": "_id", "as": "pp"}},
        {"$set": {"name": {"$first": "$pp.full_name"}, "patient_id": "$_id"}},
        {"$project": {"_id": 0, field: 1, "name": 1, "patient_id": 1}},
    ]).to_list(length=None)


async def run_campaign(tenant_id: str, *, channel: str, message: str, subject: str | None = None,
                       segment: str = "all", value: str | None = None, by: str | None = None,
                       source: str = "campaign", limit: int = 2000) -> dict:
    """Resolve the consented audience and send `message` to each via `channel`. Charges the wallet per
    message and stops cleanly if credits run out. Logs a comms_campaigns row. Returns a send summary."""
    from bson import ObjectId
    ph = await _pharmacy(tenant_id)
    rows = await campaign_audience(tenant_id, channel, segment, value)
    cid = ObjectId()
    field = "email" if channel == "email" else "mobile"
    sent = failed = 0
    stopped = False
    for r in rows[:limit]:
        to = r.get(field)
        pref = str(r.get("patient_id") or "") or None
        first = (r.get("name") or "").split(" ")[-1] if r.get("name") else ""
        text = (message or "").replace("{name}", r.get("name") or "").replace("{first}", first)
        try:
            if channel == "email":
                await send_email(tenant_id, to, subject or "Ενημέρωση φαρμακείου",
                                 _campaign_email_html(text, ph.get("name")),
                                 patient_ref=pref, campaign_id=str(cid), kind=source)
            elif channel == "viber":
                await send_viber(tenant_id, to, text, patient_ref=pref, campaign_id=str(cid), kind=source)
            else:
                await send_sms(tenant_id, to, text, patient_ref=pref, campaign_id=str(cid), kind=source)
            sent += 1
        except message_wallet.InsufficientCredits:
            stopped = True
            break
        except Exception:  # noqa: BLE001
            failed += 1
    await shared_db()["comms_campaigns"].insert_one({
        "_id": cid, "tenant_id": tenant_id, "channel": channel, "subject": subject,
        "recipients": len(rows), "sent": sent, "failed": failed, "source": source,
        "by": by, "created_at": _now()})
    return {"campaign_id": str(cid), "recipients": len(rows), "sent": sent, "failed": failed,
            "stopped_no_credits": stopped, "balance_cents": await message_wallet.balance(tenant_id)}
