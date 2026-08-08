"""Όρια AI ερωτημάτων ΑΝΑ φαρμακείο (PharmaCat/Copilot/Advice) — ΕΝΙΑΙΑ γλώσσα με τα ΠΑΚΕΤΑ.

Το AI key είναι ΚΕΝΤΡΙΚΟ (πλατφόρμα). Κάθε φαρμακείο δικαιούται έναν αριθμό ΔΩΡΕΑΝ ερωτημάτων που
ΟΡΙΖΕΤΑΙ ΑΠΟ ΤΟ ΠΑΚΕΤΟ ΤΟΥ (`packages.ai_included` + `ai_included_period` = "month" σύνολο/μήνα ή
"day" ανά ημέρα). Πάνω από αυτό → αγορά επιπλέον (AI credits — Phase C). Τα cache-hits ΜΕΤΡΟΥΝ κι αυτά
(source="cache"), αλλά κρατάμε breakdown ΓΙΑ ΕΜΑΣ (n_llm/n_cache).

Fallback: αν το πακέτο δεν έχει ορίσει `ai_included`, ισχύει το καθολικό `base_daily_free` (ημερήσιο).

Μετρητής: `llm_daily_usage` doc `_id="ai:{tenant}:{YYYY-MM-DD}"` (κοινό με το prescriptor cap)· μηνιαία
μέτρηση = άθροισμα των ημερήσιων docs του μήνα.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from pymongo import ReturnDocument

from app.core.db import shared_db

AI_DEFAULT_DAILY = 50            # καθολικό fallback (χωρίς ρύθμιση) — ημερήσιο
AI_MAX_DAILY = 20000            # ασφαλές ταβάνι για το ρυθμιζόμενο base


def _day() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")


async def base_daily_free(db=None) -> int:
    """Καθολικό δωρεάν ημερήσιο fallback (μόνο για πακέτα ΧΩΡΙΣ ai_included). Ρυθμιζόμενο από τον
    platform admin (`platform_settings._id="ai_quota".base_daily_free`)· default `AI_DEFAULT_DAILY`."""
    db = db if db is not None else shared_db()
    doc = await db["platform_settings"].find_one({"_id": "ai_quota"})
    v = (doc or {}).get("base_daily_free")
    try:
        return max(0, min(AI_MAX_DAILY, int(v)))
    except (TypeError, ValueError):
        return AI_DEFAULT_DAILY


async def included_allowance(db, tenant_id: str) -> tuple[int, str]:
    """Δωρεάν AI allowance ΑΠΟ ΤΟ ΠΑΚΕΤΟ του φαρμακείου: (πλήθος, περίοδος 'month'|'day'). Αν το πακέτο
    δεν έχει ορίσει `ai_included` → fallback στο καθολικό base_daily_free (ημερήσιο)."""
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}, {"plan": 1})
    plan = (sub or {}).get("plan")
    if plan:
        pkg = await db["packages"].find_one({"_id": plan}, {"ai_included": 1, "ai_included_period": 1})
        if pkg and pkg.get("ai_included") is not None:
            period = pkg.get("ai_included_period") if pkg.get("ai_included_period") in ("month", "day") else "month"
            try:
                return max(0, int(pkg["ai_included"])), period
            except (TypeError, ValueError):
                pass
    return await base_daily_free(db), "day"


async def _used_in_period(db, tenant_id: str, period: str) -> int:
    if period == "month":
        prefix = f"ai:{tenant_id}:{datetime.now(tz=timezone.utc).strftime('%Y-%m')}"
        rows = await db["llm_daily_usage"].aggregate([
            {"$match": {"_id": {"$regex": "^" + re.escape(prefix)}}},
            {"$group": {"_id": None, "n": {"$sum": "$n"}}}]).to_list(length=1)
        return int(rows[0]["n"]) if rows else 0
    doc = await db["llm_daily_usage"].find_one({"_id": f"ai:{tenant_id}:{_day()}"})
    return int((doc or {}).get("n", 0))


async def usage_today(db, tenant_id: str) -> int:
    doc = await db["llm_daily_usage"].find_one({"_id": f"ai:{tenant_id}:{_day()}"})
    return int((doc or {}).get("n", 0))


async def usage_breakdown_today(db, tenant_id: str) -> dict:
    """Σημερινή χρήση σπασμένη ανά πηγή: total, ai (πραγματική AI κλήση), local (τοπική βάση γνώσεων)."""
    doc = await db["llm_daily_usage"].find_one({"_id": f"ai:{tenant_id}:{_day()}"}) or {}
    return {"total": int(doc.get("n", 0)), "ai": int(doc.get("n_llm", 0)), "local": int(doc.get("n_cache", 0))}


async def status_for(db, tenant_id: str) -> dict:
    """Εικόνα ορίου AI για ΕΝΑ φαρμακείο, στη γλώσσα των πακέτων: πόσα δικαιούται (included) στην
    περίοδό του και πόσα έχει καταναλώσει (used) στην ΤΡΕΧΟΥΣΑ περίοδο."""
    included, period = await included_allowance(db, tenant_id)
    used = await _used_in_period(db, tenant_id, period)
    return {"included": included, "period": period, "used": used,
            "remaining": max(0, included - used)}


async def check_and_consume(tenant_id: str, source: str = "llm") -> tuple[bool, int, int, str | None]:
    """Χρέωσε 1 ερώτημα στην τρέχουσα περίοδο (μήνα ή ημέρα, βάσει πακέτου). Επιστρέφει
    (allowed, used, included, reason). reason: None όταν επιτρέπεται· "quota_exceeded" όταν εξαντλήθηκε
    το included του πακέτου (→ αγορά AI credits). Αν ξεπερνά → allowed=False & rollback."""
    if not tenant_id:
        return (True, 0, AI_DEFAULT_DAILY, None)   # χωρίς tenant → μη περιοριστικό (ασφάλεια)
    db = shared_db()
    included, period = await included_allowance(db, tenant_id)
    key = f"ai:{tenant_id}:{_day()}"
    sub = "n_cache" if source == "cache" else "n_llm"
    doc = await db["llm_daily_usage"].find_one_and_update(   # tenant-ok: platform usage meter
        {"_id": key}, {"$inc": {"n": 1, sub: 1}, "$setOnInsert": {"at": datetime.now(tz=timezone.utc)}},
        upsert=True, return_document=ReturnDocument.AFTER)
    used = await _used_in_period(db, tenant_id, period) if period == "month" else int((doc or {}).get("n", 0))
    if used > included:
        await db["llm_daily_usage"].update_one({"_id": key}, {"$inc": {"n": -1, sub: -1}})   # rollback
        return (False, included, included, "quota_exceeded")
    return (True, used, included, None)
