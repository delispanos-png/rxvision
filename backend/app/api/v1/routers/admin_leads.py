"""Leads & Conversions — platform-level API.

Ξεχωριστός router από τον `admin.py` (3.700+ γραμμές) επίτηδες. Κάθε διαδρομή περνά από
`enforce_section` → ενότητα `leads`: staff χωρίς αυτό το δικαίωμα παίρνει 403.

ΚΑΜΙΑ διαδρομή δεν αγγίζει δεδομένα ασθενών. Το Lead Engine αφορά τη σχέση με το φαρμακείο.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.v1.routers.admin import enforce_section, jsonsafe
from app.core.db import shared_db
from app.core.deps import PlatformContext
from app.services.leads import actions, board, config as cfg, projection, segments
from pydantic import BaseModel

router = APIRouter(prefix="/admin/leads", tags=["admin-leads"])


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _who(ctx: PlatformContext) -> str:
    return ctx.email


# ── οθόνη ───────────────────────────────────────────────────────────────────────────────────
@router.get("/overview")
async def overview(_: PlatformContext = Depends(enforce_section)):
    """«Σήμερα» + μετρήσεις + καρτέλες + έτοιμα τμήματα, με ζωντανά νούμερα."""
    return jsonsafe(await board.overview())


@router.get("")
async def listing(tab: str = "attention", q: str | None = None,
                  segment: str | None = None, assigned_to: str | None = None,
                  limit: int = 200, _: PlatformContext = Depends(enforce_section)):
    try:
        return jsonsafe(await board.listing(tab=tab, q=q, segment_id=segment,
                                            assigned_to=assigned_to, limit=min(500, limit)))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None


@router.get("/config")
async def get_config(_: PlatformContext = Depends(enforce_section)):
    return await cfg.get()


class ConfigIn(BaseModel):
    trial_ending_days: int | None = None
    inactive_days: int | None = None
    needs_contact_days: int | None = None
    returned_after_days: int | None = None
    signup_abandoned_hours: int | None = None
    expired_buckets: list[int] | None = None
    weights: dict | None = None


@router.put("/config")
async def put_config(body: ConfigIn, ctx: PlatformContext = Depends(enforce_section)):
    return await cfg.save(body.model_dump(exclude_none=True), by=_who(ctx))


@router.post("/refresh")
async def refresh(ctx: PlatformContext = Depends(enforce_section)):
    """Χειροκίνητο ξαναχτίσιμο της προβολής — δεν στέλνει τίποτα, μόνο διαβάζει & ενημερώνει."""
    return await projection.project()


# ── τμήματα ─────────────────────────────────────────────────────────────────────────────────
@router.get("/segments/fields")
async def segment_fields(_: PlatformContext = Depends(enforce_section)):
    return {"fields": segments.FIELDS, "operators": list(segments.OPS),
            "stages": projection.STAGE_LABEL, "statuses": actions.STATUSES,
            "tags": segments.BUILTIN and actions.TAG_LABEL}


@router.get("/segments")
async def segment_list(_: PlatformContext = Depends(enforce_section)):
    return {"builtin": await segments.builtin_counts(), "saved": await segments.listing()}


class RulesIn(BaseModel):
    rules: dict


@router.post("/segments/preview")
async def segment_preview(body: RulesIn, _: PlatformContext = Depends(enforce_section)):
    try:
        return {"count": await segments.count(body.rules)}
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None


class SegmentIn(BaseModel):
    name: str
    rules: dict


@router.post("/segments")
async def segment_save(body: SegmentIn, ctx: PlatformContext = Depends(enforce_section)):
    try:
        res = await segments.save(name=body.name, rules=body.rules, by=_who(ctx))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "failed"))
    return res


@router.delete("/segments/{segment_id}")
async def segment_delete(segment_id: str, _: PlatformContext = Depends(enforce_section)):
    return await segments.delete(segment_id)


# ── εργασίες (τροφοδοτούν το «Σήμερα») ──────────────────────────────────────────────────────
@router.get("/tasks")
async def task_list(overdue: bool = False, _: PlatformContext = Depends(enforce_section)):
    rows = await actions.open_tasks(overdue_only=overdue)
    db = shared_db()
    for r in rows:                       # το όνομα του φαρμακείου, για να μη λέει σκέτο ΑΦΜ
        lead = await db[projection.COLL].find_one({"_id": r["lead_key"]},
                                                  {"pharmacy_name": 1, "phone": 1})
        r["pharmacy_name"] = (lead or {}).get("pharmacy_name") or r["lead_key"]
        r["phone"] = (lead or {}).get("phone")
    return jsonsafe({"items": rows})


# ── ένα lead ────────────────────────────────────────────────────────────────────────────────
@router.get("/{lead_key:path}/detail")
async def detail(lead_key: str, _: PlatformContext = Depends(enforce_section)):
    res = await board.detail(lead_key)
    if not res:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return jsonsafe(res)


class StatusIn(BaseModel):
    status: str
    reason: str | None = None


@router.post("/{lead_key:path}/status")
async def set_status(lead_key: str, body: StatusIn,
                     ctx: PlatformContext = Depends(enforce_section)):
    res = await actions.set_status(lead_key, body.status, by=_who(ctx), reason=body.reason)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "failed"))
    return res


class NoteIn(BaseModel):
    body: str
    kind: str = "note"


@router.post("/{lead_key:path}/notes")
async def add_note(lead_key: str, body: NoteIn,
                   ctx: PlatformContext = Depends(enforce_section)):
    res = await actions.add_note(lead_key, body.body, kind=body.kind, by=_who(ctx))
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "failed"))
    return res


class TaskIn(BaseModel):
    action: str = "call"
    title: str | None = None
    due_at: datetime
    priority: str = "normal"
    assigned_to: str | None = None


@router.post("/{lead_key:path}/tasks")
async def add_task(lead_key: str, body: TaskIn,
                   ctx: PlatformContext = Depends(enforce_section)):
    res = await actions.add_task(lead_key, action=body.action, title=body.title,
                                 due_at=body.due_at, priority=body.priority,
                                 assigned_to=body.assigned_to, by=_who(ctx))
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "failed"))
    return res


class TaskDoneIn(BaseModel):
    note: str | None = None
    cancel: bool = False


@router.post("/tasks/{task_id}/done")
async def task_done(task_id: str, body: TaskDoneIn,
                    ctx: PlatformContext = Depends(enforce_section)):
    res = await actions.complete_task(task_id, by=_who(ctx), note=body.note, cancel=body.cancel)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, res.get("error", "failed"))
    return res


class TagsIn(BaseModel):
    tags: list[str]


@router.post("/{lead_key:path}/tags")
async def set_tags(lead_key: str, body: TagsIn,
                   ctx: PlatformContext = Depends(enforce_section)):
    res = await actions.set_tags(lead_key, body.tags, by=_who(ctx))
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, res.get("error", "failed"))
    return res


class AssignIn(BaseModel):
    admin_id: str | None = None


@router.post("/{lead_key:path}/assign")
async def assign(lead_key: str, body: AssignIn,
                 ctx: PlatformContext = Depends(enforce_section)):
    res = await actions.assign(lead_key, body.admin_id, by=_who(ctx))
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "failed"))
    return res


class GrantTrialIn(BaseModel):
    days: int = 15
    reason: str


@router.post("/{lead_key:path}/grant-trial")
async def grant_trial(lead_key: str, body: GrantTrialIn,
                      ctx: PlatformContext = Depends(enforce_section)):
    """Κατ' εξαίρεση νέα δοκιμαστική περίοδος. Ζητά ΠΑΝΤΑ λόγο και μετριέται."""
    from app.services.leads import trials
    res = await trials.grant(lead_key, days=body.days, by=_who(ctx), reason=body.reason)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "failed"))
    return jsonsafe(res)


@router.get("/{lead_key:path}/trials")
async def trial_history(lead_key: str, _: PlatformContext = Depends(enforce_section)):
    from app.services.leads import trials
    return jsonsafe({"items": await trials.history(lead_key)})


class TrialAllowedIn(BaseModel):
    allowed: bool


@router.post("/{lead_key:path}/trial-allowed")
async def set_trial_allowed(lead_key: str, body: TrialAllowedIn,
                            ctx: PlatformContext = Depends(enforce_section)):
    """Ξεμπλοκάρει (ή ξανα-μπλοκάρει) ΑΦΜ ώστε να μπορεί να πάρει ΞΑΝΑ δωρεάν δοκιμαστική.

    Μεταφέρθηκε αυτούσιο από τον παλιό router — είναι το ένα πράγμα που ο ιδιοκτήτης όντως
    χρησιμοποιεί σε αυτή τη σελίδα και δεν έπρεπε να χαθεί.
    """
    from app.services import trial_leads
    res = await trial_leads.set_trial_allowed(lead_key, body.allowed)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return res


@router.delete("/{lead_key:path}")
async def delete_lead(lead_key: str, _: PlatformContext = Depends(enforce_section)):
    """Οριστική διαγραφή lead + χρονολογίου (αίτημα διαγραφής)."""
    from app.services.leads import timeline as tl
    db = shared_db()
    res = await db[projection.COLL].delete_one({"_id": lead_key})
    await tl.purge_for(lead_key)
    for c in ("lead_notes", "lead_tasks", "lead_status_history"):
        await db[c].delete_many({"lead_key": lead_key})
    return {"ok": bool(res.deleted_count)}


class ContactIn(BaseModel):
    email: str | None = None
    phone: str | None = None
    contact_name: str | None = None


@router.patch("/{lead_key:path}/contact")
async def update_contact(lead_key: str, body: ContactIn,
                         ctx: PlatformContext = Depends(enforce_section)):
    res = await actions.update_contact(lead_key, email=body.email, phone=body.phone,
                                       contact_name=body.contact_name, by=_who(ctx))
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return res
