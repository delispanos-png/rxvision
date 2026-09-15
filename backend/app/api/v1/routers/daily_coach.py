"""«Ο Σύμβουλός σου» — ξεχωριστό κύκλωμα (module `daily_coach`, αγοράζεται ως extra).

Δεν περιλαμβάνεται σε κανένα πακέτο: το gate είναι το ίδιο `require(..., module=...)` που
χρησιμοποιεί όλη η εφαρμογή, άρα χωρίς ενεργό add-on το κύκλωμα ούτε καν φαίνεται.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.db import shared_db
from app.core.deps import TenantContext, require
from app.repositories.daily_coach import DailyCoachRepository

router = APIRouter()
_MODULE = "daily_coach"


def _repo(ctx: TenantContext) -> DailyCoachRepository:
    return DailyCoachRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


async def _who(ctx: TenantContext) -> str | None:
    """Το μικρό όνομα του συνδεδεμένου — ο σύμβουλος μιλάει σε άνθρωπο, όχι σε «χρήστη»."""
    from bson import ObjectId
    uid = ObjectId(ctx.user_id) if ObjectId.is_valid(ctx.user_id) else ctx.user_id
    u = await shared_db()["users"].find_one({"_id": uid, "tenant_id": ctx.tenant_id}, {"full_name": 1})
    return (u or {}).get("full_name")


@router.get("/today")
async def today(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Η σημερινή κουβέντα: χαιρετισμός, τι ξέφυγε, τι πήγε καλά, τι να κάνεις τώρα."""
    return await _repo(ctx).build(user_name=await _who(ctx))


class MarkIn(BaseModel):
    action: str = "done"          # done = το έκλεισα σήμερα · dismiss = δεν με αφορά (30 μέρες)


@router.post("/findings/{key:path}/mark")
async def mark(key: str, body: MarkIn,
               ctx: TenantContext = Depends(require("patients:write", module=_MODULE))):
    return await _repo(ctx).mark(key, body.action, by=getattr(ctx, "user_id", None))


@router.get("/history")
async def history(days: int = Query(30, ge=7, le=120),
                  ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Η γραμμή αυτοβελτίωσης — πόσα ξέφευγαν πριν, πόσα ξεφεύγουν τώρα."""
    return {"items": await _repo(ctx).history(days)}
