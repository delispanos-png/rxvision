"""Self-service «extras» για τον φαρμακοποιό — αυξημένο AI όριο & extended διατήρηση δεδομένων.

Μοντέλο: τα χρεώσιμα extras (πάνω από το βασικό) ΞΕΚΛΕΙΔΩΝΟΥΝ μόνο με αποθηκευμένη κάρτα
(`billing_service.card_on_file`). Η επιβάρυνση είναι ΠΑΓΙΟ/μήνα που μπαίνει στη συνδρομή
(`addons_total`) και χρεώνεται με την κάρτα κάθε κύκλο (billing_service.bill_due).

Χωρίς κάρτα ο φαρμακοποιός κλειδώνεται στο βασικό (50 AI/μέρα, 36μ) — δεν αποκλείεται η χρήση,
απλά δεν μπορεί να ανεβάσει τα όρια μέχρι να καταχωρίσει κάρτα.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db
from app.services import ai_quota, billing_service
from app.services import data_retention as dr


class CardRequired(Exception):
    """Ζητήθηκε extra πάνω από το βασικό χωρίς αποθηκευμένη κάρτα."""


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def get_extras(tenant_id: str) -> dict:
    """Πλήρης εικόνα για τη σελίδα «Χρέωση → Extras» του φαρμακοποιού."""
    db = shared_db()
    has_card = await billing_service.card_on_file(tenant_id)
    ai_limit = await ai_quota.tenant_daily_limit(db, tenant_id)
    months = await dr.tenant_retention_months(db, tenant_id)
    sub = await db["subscriptions"].find_one(
        {"tenant_id": tenant_id}, {"billing_cycle": 1, "currency": 1, "addons_total": 1}) or {}
    return {
        "card_on_file": has_card,
        "billing_cycle": sub.get("billing_cycle", "monthly"),
        "currency": sub.get("currency", "EUR"),
        "addons_total_cents": int(sub.get("addons_total", 0) or 0),
        "ai": {
            "limit": ai_limit,
            "used_today": await ai_quota.usage_today(db, tenant_id),
            "default": ai_quota.AI_DEFAULT_DAILY,
            "max": ai_quota.AI_MAX_DAILY,
            "block": ai_quota.AI_BLOCK,
            "price_per_block_cents": await ai_quota.price_per_block(db),
            "surcharge_cents": await ai_quota.ai_surcharge_monthly(db, tenant_id),
        },
        "retention": {
            "months": months,
            "default": dr.DEFAULT_RETENTION_MONTHS,
            "max": dr.MAX_RETENTION_MONTHS,
            "price_per_year_cents": await dr.retention_price_per_year(db),
            "surcharge_cents": await dr.retention_surcharge_monthly(db, tenant_id),
        },
    }


async def set_ai_limit(tenant_id: str, limit: int) -> dict:
    """Ο φαρμακοποιός αλλάζει το ημερήσιο AI όριό του. >βασικό ⇒ απαιτείται κάρτα."""
    clamped = ai_quota.clamp_limit(limit)
    if clamped > ai_quota.AI_DEFAULT_DAILY and not await billing_service.card_on_file(tenant_id):
        raise CardRequired("ai_limit")
    await shared_db()["tenants"].update_one(
        {"_id": tenant_id}, {"$set": {"ai_daily_limit": clamped, "updated_at": _now()}})
    from app.services import addon_service
    await addon_service._recompute_total(tenant_id)
    return await get_extras(tenant_id)


async def set_retention(tenant_id: str, months: int) -> dict:
    """Ο φαρμακοποιός αλλάζει το παράθυρο διατήρησης. >βασικό ⇒ απαιτείται κάρτα.
    (Η ΜΕΙΩΣΗ πίσω στο βασικό επιτρέπεται πάντα — δεν κόβει δεδομένα άμεσα, το beat καθαρίζει.)"""
    clamped = dr.clamp_months(months)
    if clamped > dr.DEFAULT_RETENTION_MONTHS and not await billing_service.card_on_file(tenant_id):
        raise CardRequired("retention")
    await shared_db()["tenants"].update_one(
        {"_id": tenant_id}, {"$set": {"retention_months": clamped, "updated_at": _now()}})
    from app.services import addon_service
    await addon_service._recompute_total(tenant_id)
    return await get_extras(tenant_id)
