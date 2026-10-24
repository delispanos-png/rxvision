"""Σύνδεσμος «ένα κλικ» για νέο κωδικό ΗΔΥΚΑ (απόφαση ιδιοκτήτη 24/10/2026).

ΓΙΑΤΙ: ο κωδικός ΗΔΥΚΑ αλλάζει κάθε μήνα· μέχρι να τον ξαναγράψει ο φαρμακοποιός στο RxVision ο
συγχρονισμός είναι σταματημένος. Να συνδεθεί, να βρει Ρυθμίσεις → Διασύνδεση ΗΔΥΚΑ, από το κινητό,
είναι αρκετή τριβή ώστε φαρμακεία να μένουν παγωμένα μέρες. Εδώ: το SMS/email φέρνει σύνδεσμο
→ ΕΝΑ πεδίο → ο συγχρονισμός ξαναρχίζει.

ΑΣΦΑΛΕΙΑ (ο σύνδεσμος ανοίγει ΧΩΡΙΣ σύνδεση):
  · Τυχαίο token 256 bit· στη βάση ΜΟΝΟ το SHA-256 του (διαρροή βάσης ≠ χρήσιμοι σύνδεσμοι).
  · Λήγει σε 48 ώρες · ΜΙΑΣ χρήσης · το πολύ 3 λάθος κωδικοί (η ΗΔΥΚΑ κλειδώνει μετά από λίγες
    αποτυχίες — δεν γινόμαστε εμείς η αιτία).
  · Ο νέος κωδικός ΔΟΚΙΜΑΖΕΤΑΙ στην ΗΔΥΚΑ ΠΡΙΝ αποθηκευτεί· λάθος κωδικός δεν πατάει τον σωστό.
  · Δείχνει ΜΟΝΟ την επωνυμία του φαρμακείου (για να ξέρει ότι είναι το σωστό) — κανένα άλλο στοιχείο.
  · Το token ταξιδεύει στο #fragment του URL → δεν γράφεται σε logs/Referer.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from app.core.db import shared_db

COLL = "hdika_password_links"
TTL = timedelta(hours=48)
MAX_ATTEMPTS = 3
BASE_URL = "https://app.rxvision.gr/hdika-update"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _h(token: str) -> str:
    return hashlib.sha256((token or "").encode()).hexdigest()


async def create_link(tenant_id: str) -> str:
    token = secrets.token_urlsafe(32)
    now = _now()
    await shared_db()[COLL].insert_one({"_id": _h(token), "tenant_id": tenant_id, "created_at": now,
                                        "expires_at": now + TTL, "attempts": 0, "used_at": None})
    return f"{BASE_URL}#t={token}"


async def _valid(token: str) -> dict | None:
    d = await shared_db()[COLL].find_one({"_id": _h(token)})
    if not d or d.get("used_at") or (d.get("attempts") or 0) >= MAX_ATTEMPTS:
        return None
    exp = d.get("expires_at")
    if not exp or exp.replace(tzinfo=timezone.utc) < _now():
        return None
    return d


async def check(token: str) -> dict:
    d = await _valid(token)
    if not d:
        return {"ok": False, "error": "invalid_or_expired"}
    t = await shared_db()["tenants"].find_one({"_id": d["tenant_id"]}, {"name": 1}) or {}
    return {"ok": True, "pharmacy_name": t.get("name") or "",
            "attempts_left": MAX_ATTEMPTS - int(d.get("attempts") or 0)}


async def submit(token: str, password: str) -> dict:
    """Δοκιμή του νέου κωδικού στην ΗΔΥΚΑ → μόνο αν περάσει: αποθήκευση + άρση παύσης."""
    import asyncio

    from app.api.v1.routers.ingestion import _effective_hdika_creds, _record_connect
    from app.repositories.tenants import TenantRepository
    from app.services.ingestion.hdika_client import HdikaAuthError, HdikaClient
    from app.services.vault_service import vault

    password = (password or "").strip()
    if not password:
        return {"ok": False, "error": "empty"}
    d = await _valid(token)
    if not d:
        return {"ok": False, "error": "invalid_or_expired"}
    tid = d["tenant_id"]
    db = shared_db()
    # Μετράμε την προσπάθεια ΠΡΙΝ χτυπήσουμε την ΗΔΥΚΑ (ατομικά) — όριο κλειδώματος ακόμη και σε
    # παράλληλα αιτήματα.
    r = await db[COLL].update_one({"_id": d["_id"], "attempts": {"$lt": MAX_ATTEMPTS}, "used_at": None},
                                  {"$inc": {"attempts": 1}})
    if not r.modified_count:
        return {"ok": False, "error": "invalid_or_expired"}

    creds = dict(await _effective_hdika_creds(tid))
    creds["password"] = password

    def _try() -> None:
        cl = HdikaClient(creds)
        try:
            cl.authenticate()
        finally:
            cl.close()
    try:
        await asyncio.to_thread(_try)
    except HdikaAuthError as exc:
        await _record_connect(tid, False, f"σύνδεσμος SMS: {exc}", step="link")
        left = MAX_ATTEMPTS - int(d.get("attempts") or 0) - 1
        return {"ok": False, "error": "wrong_password", "attempts_left": max(left, 0)}
    except Exception as exc:  # noqa: BLE001 — ΗΔΥΚΑ κάτω: ΔΕΝ χρεώνουμε την προσπάθεια
        await db[COLL].update_one({"_id": d["_id"]}, {"$inc": {"attempts": -1}})
        await _record_connect(tid, False, f"σύνδεσμος SMS (ΗΔΥΚΑ μη διαθέσιμη): {exc}", step="link")
        return {"ok": False, "error": "hdika_unavailable"}

    # Σωστός → αποθήκευση ΜΟΝΟ του κωδικού στα δικά του διαπιστευτήρια (Vault) + άρση παύσης
    own = dict(vault.get_secret(f"tenants/{tid}/hdika") or {})
    own["password"] = password
    vault.set_tenant_credentials(tid, "hdika", own)
    await TenantRepository(tenant_id=tid).patch_ingestion_config("hdika", {
        "auth_paused": False, "auth_error_msg": None, "auth_error_at": None,
        "auth_notify_count": 0, "auth_notify_last_at": None, "auth_sms_at": None, "auth_recheck_at": None})
    await db[COLL].update_one({"_id": d["_id"]}, {"$set": {"used_at": _now()}})
    # οι υπόλοιποι ανοιχτοί σύνδεσμοι του ίδιου φαρμακείου ακυρώνονται (ο κωδικός άλλαξε ήδη)
    await db[COLL].update_many({"tenant_id": tid, "used_at": None}, {"$set": {"used_at": _now()}})
    await _record_connect(tid, True, step="link")
    return {"ok": True}
