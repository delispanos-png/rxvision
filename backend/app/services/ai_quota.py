"""Ημερήσιο όριο AI ερωτημάτων ΑΝΑ φαρμακείο (PharmaCat/Copilot/Advice).

Το AI key είναι ΚΕΝΤΡΙΚΟ (πλατφόρμα) — όλα τα φαρμακεία αντλούν από αυτό. Για να ελεγχθεί το κόστος,
κάθε φαρμακείο έχει ημερήσιο όριο ΝΕΩΝ ερωτημάτων (τα cache-hits ΔΕΝ μετρούν):
  • Βασικό: `AI_DEFAULT_DAILY` (χωρίς extra χρέωση) — ίδια λογική με τη διατήρηση δεδομένων.
  • Extra: μεγαλύτερο όριο = πρόσθετη υπηρεσία, κλιμακωτά ανά «μπλοκ».

Μετρητής: `llm_daily_usage` doc `_id="ai:{tenant}:{YYYY-MM-DD}"` (κοινό με το prescriptor cap).
"""

from __future__ import annotations

from datetime import datetime, timezone

from pymongo import ReturnDocument

from app.core.db import shared_db

AI_DEFAULT_DAILY = 50            # βασικό όριο ερωτημάτων/μέρα (χωρίς χρέωση)
AI_MAX_DAILY = 2000             # ασφαλές ταβάνι
AI_BLOCK = 25                   # κάθε +25 ερωτήματα/μέρα = 1 χρεώσιμο «μπλοκ»
DEFAULT_PRICE_PER_BLOCK = 500   # cents/μήνα ανά μπλοκ (default 5€/μ)


def _day() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")


def clamp_limit(v) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return AI_DEFAULT_DAILY
    return max(AI_DEFAULT_DAILY, min(AI_MAX_DAILY, n))


async def tenant_daily_limit(db, tenant_id: str) -> int:
    t = await db["tenants"].find_one({"_id": tenant_id}, {"ai_daily_limit": 1})
    v = (t or {}).get("ai_daily_limit")
    return clamp_limit(v) if v else AI_DEFAULT_DAILY


async def usage_today(db, tenant_id: str) -> int:
    doc = await db["llm_daily_usage"].find_one({"_id": f"ai:{tenant_id}:{_day()}"})
    return int((doc or {}).get("n", 0))


async def effective_limit(db, tenant_id: str) -> tuple[int, bool]:
    """Πραγματικό ημερήσιο όριο + αν υπάρχει κάρτα. Χωρίς αποθηκευμένη κάρτα το όριο ΚΑΠΑΡΕΤΑΙ
    στο βασικό (τα χρεώσιμα extras ξεκλειδώνουν μόνο με κάρτα)."""
    from app.services import billing_service
    stored = await tenant_daily_limit(db, tenant_id)
    has_card = await billing_service.card_on_file(tenant_id)
    return (stored if has_card else min(stored, AI_DEFAULT_DAILY)), has_card


async def check_and_consume(tenant_id: str) -> tuple[bool, int, int, str | None]:
    """Χρέωσε 1 ερώτημα για σήμερα. Επιστρέφει (allowed, used, limit, reason).
    reason: None όταν επιτρέπεται· "card_required" (χωρίς κάρτα → βάλε κάρτα για περισσότερα)·
    "quota_exceeded" (έχει κάρτα αλλά έφτασε το δικό του ταβάνι → ανέβασε όριο).
    Αν ξεπερνά το όριο → allowed=False και ΔΕΝ καταναλώνεται (rollback)."""
    if not tenant_id:
        return (True, 0, AI_DEFAULT_DAILY, None)   # χωρίς tenant → μη περιοριστικό (ασφάλεια)
    db = shared_db()
    limit, has_card = await effective_limit(db, tenant_id)
    key = f"ai:{tenant_id}:{_day()}"
    doc = await db["llm_daily_usage"].find_one_and_update(   # tenant-ok: platform usage meter
        {"_id": key}, {"$inc": {"n": 1}, "$setOnInsert": {"at": datetime.now(tz=timezone.utc)}},
        upsert=True, return_document=ReturnDocument.AFTER)
    used = int((doc or {}).get("n", 0))
    if used > limit:
        await db["llm_daily_usage"].update_one({"_id": key}, {"$inc": {"n": -1}})   # μη μετρήσεις το μπλοκαρισμένο
        return (False, limit, limit, "quota_exceeded" if has_card else "card_required")
    return (True, used, limit, None)


# ── Τιμολόγηση extra ορίου (κλιμακωτά, όπως το retention) ──────────────────────────────────
def extra_blocks(limit: int) -> int:
    m = clamp_limit(limit)
    return max(0, -(-(m - AI_DEFAULT_DAILY) // AI_BLOCK))   # ceil((limit-50)/25)


async def price_per_block(db=None) -> int:
    db = db if db is not None else shared_db()
    doc = await db["platform_settings"].find_one({"_id": "ai_quota"})
    v = (doc or {}).get("price_per_block_cents")
    return int(v) if v is not None else DEFAULT_PRICE_PER_BLOCK


async def ai_surcharge_monthly(db, tenant_id: str) -> int:
    """Μηνιαία επιβάρυνση (cents) για extended AI όριο (0 στο βασικό)."""
    limit = await tenant_daily_limit(db, tenant_id)
    return extra_blocks(limit) * await price_per_block(db)
