"""Διαγραφή από προωθητικά μηνύματα — «δεν θέλω άλλα τέτοια».

Νομική υποχρέωση σε κάθε προωθητικό email, και **δεν υπήρχε καθόλου**. Ο σύνδεσμος πρέπει να
δουλεύει ΧΩΡΙΣ σύνδεση: ο άνθρωπος που θέλει να φύγει δεν πρέπει να χρειάζεται λογαριασμό.

ΑΣΦΑΛΕΙΑ: το token είναι HMAC με το pepper του φαρμακείου. Δεν περιέχει ΑΜΚΑ ούτε όνομα, δεν
αποκαλύπτει τίποτα αν διαρρεύσει, και δεν μπορεί να κατασκευαστεί για άλλον ασθενή.

ΣΗΜΑΝΤΙΚΟ: η διαγραφή αφορά ΜΟΝΟ τα προωθητικά. Παραγγελίες, ραντεβού και τιμολόγια συνεχίζουν
— είναι λειτουργικά μηνύματα (ESSENTIAL_KINDS) και ο άνθρωπος τα περιμένει.
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db
from app.services.vault_service import vault


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def make_token(tenant_id: str, patient_ref) -> str:
    """`<tenant>.<patient>.<υπογραφή>` — σύντομο, χωρίς προσωπικά δεδομένα."""
    pid = str(patient_ref)
    sig = hmac.new(vault.tenant_pepper(tenant_id).encode(), f"{tenant_id}|{pid}".encode(),
                   hashlib.sha256).hexdigest()[:24]
    return f"{tenant_id}.{pid}.{sig}"


def _verify(token: str) -> tuple[str, str] | None:
    try:
        tenant_id, pid, sig = str(token).rsplit(".", 2)
    except ValueError:
        return None
    try:
        expect = hmac.new(vault.tenant_pepper(tenant_id).encode(), f"{tenant_id}|{pid}".encode(),
                          hashlib.sha256).hexdigest()[:24]
    except Exception:                                      # noqa: BLE001 — άγνωστο φαρμακείο
        return None
    return (tenant_id, pid) if hmac.compare_digest(sig, expect) else None


async def describe(token: str) -> dict:
    """Τι θα δει η σελίδα πριν αποφασίσει — ΠΟΤΕ το όνομα ή το ΑΜΚΑ του."""
    v = _verify(token)
    if not v:
        return {"ok": False, "error": "bad_token"}
    tenant_id, pid = v
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"name": 1, "company": 1})
    c = await shared_db()["patient_contacts"].find_one(
        {"tenant_id": tenant_id, "_id": _oid(pid)}, {"unsubscribed_at": 1})
    name = ((t or {}).get("company") or {}).get("name") or (t or {}).get("name") or ""
    return {"ok": True, "pharmacy": name, "already": bool((c or {}).get("unsubscribed_at"))}


def _oid(v):
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return v


async def apply(token: str, *, scope: str = "all") -> dict:
    """scope: `all` = κανένα προωθητικό · `<channel>` = μόνο αυτό το κανάλι.

    Δίνουμε και τα δύο επίτηδες: αν η μόνη έξοδος είναι «κόψ' τα όλα», τα κόβουν όλοι.
    """
    v = _verify(token)
    if not v:
        return {"ok": False, "error": "bad_token"}
    tenant_id, pid = v
    db = shared_db()
    now = _now()
    if scope == "all":
        await db["patient_contacts"].update_one(
            {"tenant_id": tenant_id, "_id": _oid(pid)},
            {"$set": {"unsubscribed_at": now, "marketing_consent": False}})
    else:
        from app.services import consent as consent_svc
        await db["patient_consent_log"].insert_one({
            "tenant_id": tenant_id, "patient_ref": _oid(pid), "channel": scope,
            "action": "withdraw", "source": "unsubscribe_link", "at": now})
        _ = consent_svc
    await db["audit_logs"].insert_one({
        "tenant_id": tenant_id, "action": "marketing_unsubscribe", "scope": scope,
        "patient_ref": _oid(pid), "at": now, "source": "public_link"})
    return {"ok": True, "scope": scope}


def footer_html(tenant_id: str, patient_ref, base_url: str) -> str:
    """Το υποσέλιδο κάθε ΠΡΟΩΘΗΤΙΚΟΥ email. Ανθρώπινη διατύπωση, όχι «Unsubscribe»."""
    url = f"{base_url.rstrip('/')}/u/{make_token(tenant_id, patient_ref)}"
    return (f'<p style="margin:22px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;'
            f'border-top:1px solid #e2e8f0;padding-top:14px;">'
            f'Λαμβάνεις αυτό το μήνυμα επειδή είσαι πελάτης του φαρμακείου. '
            f'<a href="{url}" style="color:#64748b;">Δεν θέλω άλλα τέτοια μηνύματα</a>.<br>'
            f'Οι ενημερώσεις για παραγγελίες και ραντεβού δεν σταματούν — δεν είναι διαφημιστικά.'
            f'</p>')
