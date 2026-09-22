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


# Τα σήματα «Λειτουργία & Κέρδος» (τζίρος, περιθώριο, απόθεμα) κρύβονται πίσω από το ΥΠΑΡΧΟΝ
# δικαίωμα «Ανάγνωση κερδοφορίας» — δεν φτιάχνουμε νέα έννοια για το ίδιο πράγμα, και ο
# φαρμακοποιός το βρίσκει στους Ρόλους εκεί που ήδη το ψάχνει.
_BUSINESS_PERM = "profitability:read"


def _sees_business(ctx: TenantContext) -> bool:
    perms = ctx.permissions or set()
    return _BUSINESS_PERM in perms or "*" in perms


@router.get("/today")
async def today(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Η σημερινή κουβέντα: χαιρετισμός, τι ξέφυγε, τι πήγε καλά, τι να κάνεις τώρα.

    Χωρίς δικαίωμα κερδοφορίας η σελίδα ΔΕΝ κλειδώνει — απλώς δεν περιλαμβάνει τα οικονομικά.
    Ο πάγκος πρέπει να βλέπει τους ασθενείς του· ο τζίρος είναι άλλη κουβέντα.
    """
    return await _repo(ctx).build(user_name=await _who(ctx), business=_sees_business(ctx))


class MarkIn(BaseModel):
    action: str = "done"          # done = το έκλεισα σήμερα · dismiss = δεν με αφορά (30 μέρες)


# ΔΙΚΑΙΩΜΑ: `patients:read`, ΟΧΙ `patients:write`. Το «Το έκανα» δεν αλλάζει δεδομένα ασθενή —
# αλλάζει την κατάσταση του ΙΔΙΟΥ του ευρήματος. Το `patients:write` το έχει μόνο ο ιδιοκτήτης,
# οπότε θα κλείδωνε τη λίστα από ακριβώς τους ανθρώπους που τη δουλεύουν (πάγκος, φαρμακοποιοί).
@router.post("/findings/{key:path}/mark")
async def mark(key: str, body: MarkIn,
               ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).mark(key, body.action, by=getattr(ctx, "user_id", None))


# ── Ο Σύμβουλος στο ταμείο ───────────────────────────────────────────────────────────────────
@router.get("/patient/{patient_id}")
async def patient_brief(patient_id: str,
                        ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Ό,τι ξέρει ο Σύμβουλος γι' ΑΥΤΟΝ τον άνθρωπο — για να το δεις ενώ είναι μπροστά σου."""
    return await _repo(ctx).patient_brief(patient_id)


# ── Τι ανακτήθηκε / τι χάθηκε ────────────────────────────────────────────────────────────────
@router.get("/value")
async def value(days: int = Query(90, ge=7, le=365),
                ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Ο απολογισμός αξίας: τι ανακτήθηκε πραγματικά, επαληθευμένο στα δεδομένα."""
    return await _repo(ctx).value(days)


@router.get("/leakage")
async def leakage(months: int = Query(6, ge=2, le=24),
                  ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Το «κρυφό κόστος»: πόσα χάνει το φαρμακείο ανά μήνα, σε τζίρο και σε κέρδος."""
    return await _repo(ctx).leakage(months)


# ── Η εβδομάδα & ο στόχος ────────────────────────────────────────────────────────────────────
@router.get("/week")
async def week(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).week()


class GoalIn(BaseModel):
    signal: str | None = None     # None = καθάρισε τον στόχο
    target: int = 0               # «το πολύ N την ημέρα»


# Ο στόχος του μήνα είναι απόφαση διοίκησης του φαρμακείου, όχι ενέργεια πάγκου.
@router.put("/goal")
async def set_goal(body: GoalIn,
                   ctx: TenantContext = Depends(require("settings:write", module=_MODULE))):
    return await _repo(ctx).set_goal(body.signal, body.target)


# ── Ομάδα ────────────────────────────────────────────────────────────────────────────────────
@router.get("/team")
async def team(days: int = Query(30, ge=7, le=120),
               ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).team(days)


# ── Ρυθμίσεις ────────────────────────────────────────────────────────────────────────────────
class SettingsIn(BaseModel):
    email_enabled: bool | None = None
    email_hour: int | None = None
    email_to: str | None = None
    max_items: int | None = None
    escalate_owner: bool | None = None
    signals: dict | None = None


@router.get("/settings")
async def get_settings(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).settings()


@router.put("/settings")
async def put_settings(body: SettingsIn,
                       ctx: TenantContext = Depends(require("settings:write", module=_MODULE))):
    return await _repo(ctx).save_settings(body.model_dump(exclude_none=True))


@router.get("/history")
async def history(days: int = Query(30, ge=7, le=120),
                  ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Η γραμμή αυτοβελτίωσης — πόσα ξέφευγαν πριν, πόσα ξεφεύγουν τώρα."""
    return {"items": await _repo(ctx).history(days)}
