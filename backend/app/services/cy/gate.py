"""Η ΜΙΑ πύλη του κυπριακού κομματιού.

Ένα κυπριακό endpoint απαντά ΜΟΝΟ όταν ισχύουν ΚΑΙ τα δύο:
1. ο διακόπτης `platform_settings/cy.enabled` είναι ανοιχτός (κλείνει με ένα κλικ, χωρίς deploy)·
2. το φαρμακείο του χρήστη έχει `country == "CY"`.

Σε κάθε άλλη περίπτωση: 404 — ένα ελληνικό φαρμακείο δεν μαθαίνει καν ότι υπάρχει.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, status

from app.core.db import shared_db
from app.core.deps import TenantContext, get_current_context

SETTINGS_ID = "cy"


async def cy_enabled() -> bool:
    doc = await shared_db()["platform_settings"].find_one({"_id": SETTINGS_ID}, {"enabled": 1})
    return bool((doc or {}).get("enabled"))


async def set_cy_enabled(enabled: bool) -> bool:
    from datetime import datetime, timezone
    await shared_db()["platform_settings"].update_one(
        {"_id": SETTINGS_ID},
        {"$set": {"enabled": bool(enabled), "updated_at": datetime.now(tz=timezone.utc)}},
        upsert=True)
    return bool(enabled)


async def tenant_country(tenant_id: str) -> str:
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"country": 1})
    return ((t or {}).get("country") or "GR").upper()


async def require_cy(ctx: TenantContext = Depends(get_current_context)) -> TenantContext:
    if not await cy_enabled() or await tenant_country(ctx.tenant_id) != "CY":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found")
    return ctx
