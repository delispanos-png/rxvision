"""Ημερήσιο όριο AI ερωτημάτων ΑΝΑ φαρμακείο (PharmaCat/Copilot/Advice).

Το AI key είναι ΚΕΝΤΡΙΚΟ (πλατφόρμα) — όλα τα φαρμακεία αντλούν από αυτό. Για να ελεγχθεί το κόστος,
κάθε φαρμακείο έχει ημερήσιο όριο ΝΕΩΝ ερωτημάτων (τα cache-hits ΔΕΝ μετρούν):
  • Βασικό: `AI_DEFAULT_DAILY` (χωρίς extra χρέωση) — ίδια λογική με τη διατήρηση δεδομένων.
  • Extra: μεγαλύτερο όριο = πρόσθετη υπηρεσία, κλιμακωτά ανά «μπλοκ».

Μετρητής: `llm_daily_usage` doc `_id="ai:{tenant}:{YYYY-MM-DD}"` (κοινό με το prescriptor cap).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from pymongo import ReturnDocument

from app.core.db import shared_db

AI_DEFAULT_DAILY = 50            # βασικό όριο ερωτημάτων/μέρα (χωρίς χρέωση)
AI_MAX_DAILY = 2000             # ασφαλές ταβάνι
AI_BLOCK = 25                   # κάθε +25 ερωτήματα/μέρα = 1 χρεώσιμο «μπλοκ»
DEFAULT_PRICE_PER_BLOCK = 500   # cents/μήνα ανά μπλοκ (default 5€/μ)


def _day() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")


async def base_daily_free(db=None) -> int:
    """Το δωρεάν βασικό όριο ερωτημάτων/μέρα (χωρίς χρέωση). Ρυθμιζόμενο από τον platform admin
    (`platform_settings._id="ai_quota".base_daily_free`)· default `AI_DEFAULT_DAILY`."""
    db = db if db is not None else shared_db()
    doc = await db["platform_settings"].find_one({"_id": "ai_quota"})
    v = (doc or {}).get("base_daily_free")
    try:
        return max(0, min(AI_MAX_DAILY, int(v)))
    except (TypeError, ValueError):
        return AI_DEFAULT_DAILY


def clamp_limit(v, base: int = AI_DEFAULT_DAILY) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return base
    return max(base, min(AI_MAX_DAILY, n))


async def tenant_daily_limit(db, tenant_id: str) -> int:
    base = await base_daily_free(db)
    t = await db["tenants"].find_one({"_id": tenant_id}, {"ai_daily_limit": 1})
    v = (t or {}).get("ai_daily_limit")
    return clamp_limit(v, base) if v else base


async def included_allowance(db, tenant_id: str) -> tuple[int, str]:
    """Δωρεάν AI allowance ΑΠΟ ΤΟ ΠΑΚΕΤΟ του φαρμακείου: (πλήθος, περίοδος 'month'|'day'). Αν το πακέτο
    δεν έχει ορίσει `ai_included` → fallback στο καθολικό base_daily_free (ημερήσιο) — άρα καμία αλλαγή
    συμπεριφοράς μέχρι να μπουν τα included ανά πακέτο."""
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
    """Σημερινή χρήση σπασμένη ανά πηγή: total (μετράει στο όριο), ai (πραγματική AI κλήση),
    local (σερβιρίστηκε από την τοπική βάση γνώσεων). Και τα δύο μετρούν στο ημερήσιο όριο."""
    doc = await db["llm_daily_usage"].find_one({"_id": f"ai:{tenant_id}:{_day()}"}) or {}
    return {"total": int(doc.get("n", 0)), "ai": int(doc.get("n_llm", 0)), "local": int(doc.get("n_cache", 0))}


async def effective_limit(db, tenant_id: str) -> tuple[int, bool]:
    """Πραγματικό ημερήσιο όριο + αν υπάρχει κάρτα. Χωρίς αποθηκευμένη κάρτα το όριο ΚΑΠΑΡΕΤΑΙ
    στο βασικό (τα χρεώσιμα extras ξεκλειδώνουν μόνο με κάρτα)."""
    from app.services import billing_service
    base = await base_daily_free(db)
    stored = await tenant_daily_limit(db, tenant_id)
    has_card = await billing_service.card_on_file(tenant_id)
    return (stored if has_card else min(stored, base)), has_card


async def check_and_consume(tenant_id: str, source: str = "llm") -> tuple[bool, int, int, str | None]:
    """Χρέωσε 1 ερώτημα για σήμερα. `source`: "llm" (πραγματική AI κλήση) ή "cache" (τοπική βάση) —
    και τα δύο μετρούν στο ίδιο ημερήσιο όριο, αλλά κρατάμε breakdown ΓΙΑ ΕΜΑΣ (n_llm/n_cache· ο
    πελάτης βλέπει μόνο το σύνολο). Επιστρέφει (allowed, used, limit, reason).
    reason: None όταν επιτρέπεται· "card_required" (χωρίς κάρτα)· "quota_exceeded" (έφτασε το ταβάνι).
    Αν ξεπερνά το όριο → allowed=False και ΔΕΝ καταναλώνεται (rollback)."""
    if not tenant_id:
        return (True, 0, AI_DEFAULT_DAILY, None)   # χωρίς tenant → μη περιοριστικό (ασφάλεια)
    db = shared_db()
    from app.services import billing_service
    included, period = await included_allowance(db, tenant_id)
    has_card = await billing_service.card_on_file(tenant_id)
    limit = included
    # Ημερήσιο πακέτο: κρατάμε το υπάρχον «paid daily override» (ξεκλειδώνει μεγαλύτερο cap ΜΟΝΟ με κάρτα).
    if period == "day":
        t = await db["tenants"].find_one({"_id": tenant_id}, {"ai_daily_limit": 1})
        override = (t or {}).get("ai_daily_limit")
        if override and has_card:
            try:
                limit = max(included, int(override))
            except (TypeError, ValueError):
                pass
    key = f"ai:{tenant_id}:{_day()}"
    sub = "n_cache" if source == "cache" else "n_llm"
    doc = await db["llm_daily_usage"].find_one_and_update(   # tenant-ok: platform usage meter
        {"_id": key}, {"$inc": {"n": 1, sub: 1}, "$setOnInsert": {"at": datetime.now(tz=timezone.utc)}},
        upsert=True, return_document=ReturnDocument.AFTER)
    used = await _used_in_period(db, tenant_id, period) if period == "month" else int((doc or {}).get("n", 0))
    if used > limit:
        await db["llm_daily_usage"].update_one({"_id": key}, {"$inc": {"n": -1, sub: -1}})   # rollback το μπλοκαρισμένο
        return (False, limit, limit, "quota_exceeded" if has_card else "card_required")
    return (True, used, limit, None)


# ── Τιμολόγηση extra ορίου (κλιμακωτά, όπως το retention) ──────────────────────────────────
def extra_blocks(limit: int, base: int = AI_DEFAULT_DAILY) -> int:
    m = clamp_limit(limit, base)
    return max(0, -(-(m - base) // AI_BLOCK))   # ceil((limit-base)/25)


async def price_per_block(db=None) -> int:
    db = db if db is not None else shared_db()
    doc = await db["platform_settings"].find_one({"_id": "ai_quota"})
    v = (doc or {}).get("price_per_block_cents")
    return int(v) if v is not None else DEFAULT_PRICE_PER_BLOCK


async def ai_surcharge_monthly(db, tenant_id: str) -> int:
    """Μηνιαία επιβάρυνση (cents) για extended AI όριο (0 στο βασικό)."""
    base = await base_daily_free(db)
    limit = await tenant_daily_limit(db, tenant_id)
    return extra_blocks(limit, base) * await price_per_block(db)
