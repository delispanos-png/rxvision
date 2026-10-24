"""Στοιχεία τιμολόγησης από την ΗΔΥΚΑ όταν ο πελάτης δεν τα έδωσε (24/10/2026).

ΓΙΑΤΙ: η αυτοεγγραφή δεχόταν φαρμακείο χωρίς ΑΦΜ (ΦΑΡΜΑΚΕΙΟ ΑΡΧΟΝΤΑΚΗ). Η σύνδεση ΗΔΥΚΑ όμως
ΞΕΡΕΙ το ΑΦΜ του φαρμακείου (`fetch_user_info` → taxRegistryNo) — απλώς δεν το αντέγραφε κανείς
στα στοιχεία τιμολόγησης. Εδώ γίνεται αυτό, ώστε να βγαίνει παραστατικό αν ο πελάτης συνεχίσει.

ΚΑΝΟΝΕΣ:
  · ΜΟΝΟ αν το φαρμακείο ΔΕΝ έχει ήδη ΑΦΜ — ποτέ δεν αντικαθιστούμε ό,τι έγραψε ο πελάτης/admin.
  · ΜΟΝΟ έγκυρο ΑΦΜ (ψηφίο ελέγχου).
  · Τα υπόλοιπα (ΔΟΥ, διεύθυνση, Τ.Κ., πόλη, τίτλος) από την ΑΑΔΕ — και πάλι ΜΟΝΟ σε κενά πεδία.
  · Το lead ξαναγράφεται στο κλειδί ΑΦΜ (`lead_key`: ΑΦΜ → email), αλλιώς θα εμφανιζόταν ΔΙΠΛΟ
    και ο φραγμός επανα-δοκιμής (`afm_had_trial`) δεν θα έβλεπε το ΑΦΜ.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from app.core.db import shared_db
from app.utils import afm as afm_util

logger = logging.getLogger(__name__)

_FROM_AADE = ("doy", "address", "postal_code", "city", "title")


async def fill_from_hdika(tenant_id: str, discovered: dict) -> dict:
    """Best-effort· επιστρέφει τι συμπληρώθηκε. Ποτέ δεν σηκώνει εξαίρεση στον καλούντα."""
    try:
        return await _fill(tenant_id, discovered or {})
    except Exception as exc:  # noqa: BLE001 — η σύνδεση ΗΔΥΚΑ δεν πρέπει να αποτύχει γι' αυτό
        logger.warning("billing fill from ΗΔΥΚΑ failed for %s: %s", tenant_id, exc)
        return {"filled": False, "error": type(exc).__name__}


async def _fill(tenant_id: str, discovered: dict) -> dict:
    afm = afm_util.normalize(discovered.get("afm"))
    if not afm_util.is_valid(afm):
        return {"filled": False, "reason": "no_valid_afm"}
    db = shared_db()
    t = await db["tenants"].find_one({"_id": tenant_id}, {"billing_profile": 1, "company": 1})
    if not t:
        return {"filled": False, "reason": "no_tenant"}
    bp, co = t.get("billing_profile") or {}, t.get("company") or {}
    if afm_util.normalize(bp.get("afm")) or afm_util.normalize(co.get("afm")):
        return {"filled": False, "reason": "already_has_afm"}

    vals: dict = {"afm": afm}
    if discovered.get("address"):
        vals["address"] = discovered["address"]
    if discovered.get("city"):
        vals["city"] = discovered["city"]
    try:
        from app.services.aade_service import lookup
        a = await lookup(afm)
        if a.get("ok"):
            for k in _FROM_AADE:
                if a.get(k):
                    vals[k] = a[k]     # η ΑΑΔΕ υπερισχύει της ΗΔΥΚΑ για διεύθυνση (επίσημη έδρα)
    except Exception as exc:  # noqa: BLE001 — χωρίς ΑΑΔΕ κρατάμε τουλάχιστον το ΑΦΜ
        logger.info("AADE lookup skipped for %s: %s", tenant_id, exc)

    upd: dict = {}
    for k, v in vals.items():
        for root, cur in (("billing_profile", bp), ("company", co)):
            if not str(cur.get(k) or "").strip():
                upd[f"{root}.{k}"] = v
    now = datetime.now(timezone.utc)
    upd["billing_profile.afm_source"] = "hdika"
    upd["updated_at"] = now
    await db["tenants"].update_one({"_id": tenant_id}, {"$set": upd})
    await _rekey_lead(db, tenant_id, afm)
    logger.info("billing profile of %s filled from ΗΔΥΚΑ/ΑΑΔΕ: %s", tenant_id, sorted(vals))
    return {"filled": True, "fields": sorted(vals)}


async def _rekey_lead(db, tenant_id: str, afm: str) -> None:
    """Lead με κλειδί email → κλειδί ΑΦΜ, με ΟΛΟ το ιστορικό του (το `_id` δεν αλλάζει επί τόπου)."""
    old = await db["leads"].find_one({"tenant_id": tenant_id, "_id": {"$ne": afm}})
    if not old:
        return
    if await db["leads"].find_one({"_id": afm}):
        await db["leads"].update_one({"_id": afm}, {"$set": {"tenant_id": tenant_id, "afm": afm}})
    else:
        await db["leads"].insert_one({**old, "_id": afm, "afm": afm})
    await db["leads"].delete_one({"_id": old["_id"]})
