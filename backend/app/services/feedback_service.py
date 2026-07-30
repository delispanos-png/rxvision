"""Trial-churn feedback campaign + χειροκίνητα εκπτωτικά coupons.

Ροή: ληγμένο trial που ΔΕΝ ανανεώθηκε → 10 ημέρες μετά → email με link σε δημόσια φόρμα
αξιολόγησης. Οι απαντήσεις αποθηκεύονται (collection `feedback`) & τις βλέπει ο admin. Ο admin
μπορεί χειροκίνητα να στείλει σε κάποιον εκπτωτικό coupon (collection `coupons`) για να πάρει
συνδρομή. (Auto-coupon βάσει απαντήσεων → μελλοντικά.)
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone

from app.core.db import shared_db

FEEDBACK_DELAY_DAYS = 10          # πόσες μέρες μετά τη λήξη trial στέλνουμε το email
_BASE = "https://app.rxvision.gr"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _owner_email(tenant: dict) -> str | None:
    bp = (tenant or {}).get("billing_profile") or {}
    email = bp.get("email") or bp.get("billing_email")
    if email:
        return email
    tid = (tenant or {}).get("_id")
    if not tid:
        return None
    u = await shared_db()["users"].find_one({"tenant_id": tid}, sort=[("created_at", 1)])
    return (u or {}).get("email")


# ── Campaign: εύρεση churned trials & αποστολή email ──────────────────────────────────────
async def send_feedback_emails() -> dict:
    """Καλείται από daily beat. Βρίσκει ληγμένα trials (10μ+ πριν, μη-ανανεωμένα, μη-σταλμένα)
    → φτιάχνει feedback token + στέλνει email. Idempotent (flag feedback_sent_at στη συνδρομή)."""
    db = shared_db()
    cutoff = _now() - timedelta(days=FEEDBACK_DELAY_DAYS)
    sent = 0
    async for sub in db["subscriptions"].find({
        "status": "expired",
        "$or": [{"plan": "trial"}, {"payment_status": "trial"}],
        "feedback_sent_at": {"$exists": False},
        "current_period_end": {"$lte": cutoff},
    }):
        tid = sub["tenant_id"]
        tenant = await db["tenants"].find_one({"_id": tid}) or {}
        email = await _owner_email(tenant)
        # μαρκάρουμε ΠΑΝΤΑ (ακόμα κι αν λείπει email) ώστε να μην ξαναπροσπαθεί κάθε μέρα
        await db["subscriptions"].update_one({"_id": sub["_id"]}, {"$set": {"feedback_sent_at": _now()}})
        if not email:
            continue
        token = uuid.uuid4().hex
        name = tenant.get("name") or tid
        await db["feedback"].insert_one({
            "_id": token, "tenant_id": tid, "pharmacy_name": name, "owner_email": email,
            "status": "sent", "created_at": _now()})
        link = f"{_BASE}/feedback/{token}"
        html = (f"<p>Αγαπητέ/ή {name},</p>"
                f"<p>Δοκίμασες το <b>RxVision</b> και θα θέλαμε πολύ τη γνώμη σου — μας βοηθά να το "
                f"κάνουμε καλύτερο για τα φαρμακεία.</p>"
                f"<p>Χρειάζεται μόλις 2 λεπτά:</p>"
                f"<p><a href=\"{link}\" style=\"background:#4f46e5;color:#fff;padding:10px 18px;"
                f"border-radius:8px;text-decoration:none\">Συμπλήρωσε την αξιολόγηση</a></p>"
                f"<p style=\"color:#64748b;font-size:12px\">Ή αντιγράψε: {link}</p>")
        try:
            from app.services import mailer
            await mailer.send_email(email, "RxVision — Η γνώμη σου μετράει (2 λεπτά)", html)
            sent += 1
        except Exception:  # noqa: BLE001
            pass
    return {"sent": sent}


# ── Δημόσια φόρμα ─────────────────────────────────────────────────────────────────────────
async def get_form(token: str) -> dict | None:
    fb = await shared_db()["feedback"].find_one({"_id": token})
    if not fb:
        return None
    return {"pharmacy_name": fb.get("pharmacy_name"), "status": fb.get("status")}


_ANSWER_FIELDS = ("strong_points", "weak_points", "would_choose", "pricing_view",
                  "churn_reason", "most_useful", "missing", "nps", "competitor",
                  "contact_ok", "contact_phone")


async def submit(token: str, answers: dict) -> bool:
    db = shared_db()
    fb = await db["feedback"].find_one({"_id": token})
    if not fb or fb.get("status") == "submitted":
        return False
    clean = {k: answers.get(k) for k in _ANSWER_FIELDS if k in answers}
    await db["feedback"].update_one({"_id": token}, {"$set": {
        "answers": clean, "status": "submitted", "submitted_at": _now()}})
    return True


# ── Admin ─────────────────────────────────────────────────────────────────────────────────
async def list_feedback() -> list[dict]:
    db = shared_db()
    out = []
    async for f in db["feedback"].find({}).sort("created_at", -1).limit(500):
        out.append({k: f.get(k) for k in ("_id", "tenant_id", "pharmacy_name", "owner_email",
                    "status", "created_at", "submitted_at", "answers", "coupon_code")})
    return out


# ── Coupons (χειροκίνητα από admin· redemption στο renewal/signup) ─────────────────────────
def _coupon_code() -> str:
    return "RXV-" + secrets.token_hex(4).upper()   # π.χ. RXV-9F3A2B10


async def issue_coupon(tenant_id: str, discount_pct: int, days: int = 14,
                       feedback_token: str | None = None) -> dict:
    """Ο admin εκδίδει εκπτωτικό coupon σε φαρμακείο & το στέλνει email. Ισχύει για ανανέωση/συνδρομή."""
    db = shared_db()
    pct = max(1, min(90, int(discount_pct)))
    code = _coupon_code()
    tenant = await db["tenants"].find_one({"_id": tenant_id}) or {}
    email = await _owner_email(tenant)
    await db["coupons"].insert_one({
        "_id": code, "tenant_id": tenant_id, "discount_pct": pct,
        "valid_until": _now() + timedelta(days=int(days)), "status": "active",
        "feedback_token": feedback_token, "created_at": _now()})
    if feedback_token:
        await db["feedback"].update_one({"_id": feedback_token}, {"$set": {"coupon_code": code}})
    if email:
        link = f"{_BASE}/login"
        html = (f"<p>Αγαπητέ/ή {tenant.get('name') or ''},</p>"
                f"<p>Ευχαριστούμε για τον χρόνο σου! Σου προσφέρουμε <b>{pct}% έκπτωση</b> για να "
                f"ξεκινήσεις συνδρομή στο RxVision.</p>"
                f"<p>Κωδικός: <b style=\"font-size:18px\">{code}</b> (ισχύει έως "
                f"{(_now() + timedelta(days=int(days))).strftime('%d/%m/%Y')})</p>"
                f"<p>Συνδέσου και βάλε τον κωδικό στην ανανέωση: <a href=\"{link}\">{link}</a></p>")
        try:
            from app.services import mailer
            await mailer.send_email(email, f"RxVision — {pct}% έκπτωση για σένα", html)
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "code": code, "discount_pct": pct}


async def validate_coupon(code: str, tenant_id: str | None = None) -> dict | None:
    """Επιστρέφει {code, discount_pct} αν ισχύει (active, μη-ληγμένο, σωστό tenant), αλλιώς None."""
    if not code:
        return None
    c = await shared_db()["coupons"].find_one({"_id": code.strip().upper()})
    if not c or c.get("status") != "active":
        return None
    if c.get("valid_until") and c["valid_until"] < _now():
        return None
    if c.get("tenant_id") and tenant_id and c["tenant_id"] != tenant_id:
        return None
    return {"code": c["_id"], "discount_pct": int(c.get("discount_pct", 0))}


async def apply_discount(amount_cents: int, code: str | None, tenant_id: str | None = None) -> tuple[int, dict | None]:
    """Επιστρέφει (νέο ποσό, coupon-info|None). Το coupon δεν «καίγεται» εδώ — μόνο στο redeem_coupon."""
    v = await validate_coupon(code or "", tenant_id)
    if not v:
        return amount_cents, None
    discounted = max(30, int(round(amount_cents * (100 - v["discount_pct"]) / 100)))  # ≥ €0,30 min
    return discounted, v


async def redeem_coupon(code: str) -> None:
    """Μαρκάρει το coupon ως χρησιμοποιημένο (μετά από επιτυχή πληρωμή)."""
    await shared_db()["coupons"].update_one(
        {"_id": (code or "").strip().upper(), "status": "active"},
        {"$set": {"status": "used", "used_at": _now()}})
