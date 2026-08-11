"""Trial leads — «κύκλωμα» πρώην δοκιμαστικών πελατών.

Όταν μια ΔΟΚΙΜΑΣΤΙΚΗ συνδρομή λήξει >N ημέρες (default 20) & δεν μετατραπεί, ο λογαριασμός διαγράφεται
(purge_expired_trials) ΑΛΛΑ ΠΡΙΝ αρχειοθετούμε εδώ το ΑΦΜ + στοιχεία επικοινωνίας:
  1) ΑΦΜ → μπλοκ επανα-λήψης ΔΩΡΕΑΝ trial (μπορεί να αγοράσει ΠΛΗΡΩΜΕΝΟ πακέτο),
  2) βάση leads → στέλνουμε προσφορές για να τους κάνουμε πελάτες.

Collection: `trial_leads` (platform-level· _id = ΑΦΜ αν υπάρχει, αλλιώς email). status:
lead → contacted → converted / unsubscribed.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db

DEFAULT_PURGE_DAYS = 20


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def config(db=None) -> dict:
    db = db if db is not None else shared_db()
    doc = await db["platform_settings"].find_one({"_id": "trial_leads"}) or {}
    return {
        "purge_days": int(doc.get("purge_days", DEFAULT_PURGE_DAYS) or DEFAULT_PURGE_DAYS),
        "purge_enabled": bool(doc.get("purge_enabled", True)),
        "offer_subject": doc.get("offer_subject") or "Προσφορά για το φαρμακείο σας — RxVision",
        "offer_body": doc.get("offer_body") or (
            "Γεια σας,\n\nΕίδαμε ότι δοκιμάσατε το RxVision. Θα θέλαμε να σας κάνουμε μια ειδική "
            "προσφορά για να συνεχίσετε. Απαντήστε σε αυτό το email ή επισκεφθείτε το rxvision.gr.\n\n"
            "Με εκτίμηση,\nΗ ομάδα RxVision"),
    }


def _lead_key(afm: str | None, email: str | None) -> str | None:
    return (afm or "").strip() or (email or "").strip().lower() or None


def _contact_from_tenant(t: dict, sub: dict | None) -> dict:
    bp = t.get("billing_profile") or {}
    comp = t.get("company") or {}
    afm = (bp.get("afm") or comp.get("afm") or "").strip() or None
    email = (bp.get("email") or bp.get("billing_email") or comp.get("email")
             or t.get("contact_email") or "").strip().lower() or None
    phone = (bp.get("phone") or comp.get("phone") or t.get("contact_phone") or "").strip() or None
    contact_name = bp.get("name") or comp.get("name") or None
    return {
        "afm": afm, "email": email, "phone": phone, "contact_name": contact_name,
        "pharmacy_name": t.get("name"), "country": t.get("country", "GR"),
        "trial_started": (sub or {}).get("started_at") or t.get("created_at"),
        "trial_expired": (sub or {}).get("current_period_end") or (sub or {}).get("expired_at"),
    }


async def archive_from_tenant(tenant_id: str, *, db=None, reason: str = "trial_purged") -> str | None:
    """Αρχειοθετεί ΑΦΜ + επικοινωνία στη βάση leads (πριν τη διαγραφή του tenant). Returns lead key."""
    db = db if db is not None else shared_db()
    t = await db["tenants"].find_one({"_id": tenant_id})
    if not t:
        return None
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id})
    c = _contact_from_tenant(t, sub)
    key = _lead_key(c["afm"], c["email"])
    if not key:
        key = f"tid:{tenant_id}"      # χωρίς ΑΦΜ/email → κράτα κάτι μοναδικό
    await db["trial_leads"].update_one(
        {"_id": key},
        {"$set": {**c, "reason": reason, "purged_at": _now(),
                  "original_tenant_id": tenant_id, "updated_at": _now()},
         "$setOnInsert": {"status": "lead", "offers_sent": 0, "created_at": _now()}},
        upsert=True)
    return key


async def afm_had_trial(afm: str | None, email: str | None = None) -> bool:
    """Έχει ΑΥΤΟ το ΑΦΜ (ή email) πάρει ΗΔΗ δοκιμαστική στο παρελθόν; (μπλοκ επανα-trial)."""
    db = shared_db()
    ors = []
    if (afm or "").strip():
        ors.append({"afm": afm.strip()})
    if (email or "").strip():
        ors.append({"email": email.strip().lower()})
    if not ors:
        return False
    return await db["trial_leads"].count_documents({"$or": ors, "status": {"$ne": "converted"}}) > 0


# ── admin: λίστα / προσφορές / status ────────────────────────────────────────
async def list_leads(status: str | None = None, limit: int = 500) -> list[dict]:
    db = shared_db()
    flt = {"status": status} if status and status != "all" else {}
    return [r async for r in db["trial_leads"].find(flt).sort("purged_at", -1).limit(limit)]


async def counts() -> dict:
    db = shared_db()
    out = {"lead": 0, "contacted": 0, "converted": 0, "unsubscribed": 0, "total": 0}
    async for r in db["trial_leads"].aggregate([{"$group": {"_id": "$status", "n": {"$sum": 1}}}]):
        out[r["_id"] or "lead"] = r["n"]
        out["total"] += r["n"]
    return out


async def set_status(lead_id: str, status: str) -> dict:
    if status not in ("lead", "contacted", "converted", "unsubscribed"):
        return {"ok": False, "error": "bad_status"}
    r = await shared_db()["trial_leads"].update_one(
        {"_id": lead_id}, {"$set": {"status": status, "updated_at": _now()}})
    return {"ok": bool(r.matched_count)}


async def delete_lead(lead_id: str) -> dict:
    r = await shared_db()["trial_leads"].delete_one({"_id": lead_id})
    return {"ok": bool(r.deleted_count)}


def _offer_html(body: str, name: str | None) -> str:
    greeting = f"Αγαπητό {name}," if name else "Γεια σας,"
    text = body.replace("{name}", name or "").replace("\n", "<br/>")
    return (f'<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">'
            f'<div style="background:#4f46e5;padding:16px 22px;color:#fff;font-size:18px;font-weight:700;">RxVision</div>'
            f'<div style="padding:22px;font-size:15px;line-height:1.6;">{text}</div>'
            f'<div style="padding:14px 22px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">'
            f'Λάβατε αυτό το email επειδή δοκιμάσατε το RxVision. Για διαγραφή, απαντήστε «ΔΙΑΓΡΑΦΗ».</div></div>')


async def send_offer(lead_id: str, subject: str | None = None, body: str | None = None) -> dict:
    """Στέλνει προσφορά (email) σε έναν lead μέσω του κεντρικού mailer· ενημερώνει offers_sent/status."""
    db = shared_db()
    lead = await db["trial_leads"].find_one({"_id": lead_id})
    if not lead:
        return {"ok": False, "error": "not_found"}
    if lead.get("status") == "unsubscribed":
        return {"ok": False, "error": "unsubscribed"}
    email = lead.get("email")
    if not email:
        return {"ok": False, "error": "no_email"}
    cfg = await config(db)
    subj = subject or cfg["offer_subject"]
    body = body or cfg["offer_body"]
    from app.services import mailer
    await mailer.send_email(email, subj, _offer_html(body, lead.get("contact_name") or lead.get("pharmacy_name")))
    await db["trial_leads"].update_one(
        {"_id": lead_id},
        {"$inc": {"offers_sent": 1}, "$set": {"last_offer_at": _now(), "updated_at": _now(),
                                              "status": "contacted" if lead.get("status") == "lead" else lead.get("status")}})
    return {"ok": True, "email": email}
