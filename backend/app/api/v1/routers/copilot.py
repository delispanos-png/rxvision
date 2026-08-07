"""RxVision Copilot router — in-app usage assistant (Level 1: guide + deep links)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.copilot import CopilotRepository
from app.repositories.copilot_routines import CopilotRoutineRepository

router = APIRouter()


class Msg(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    messages: list[Msg]


class ActIn(BaseModel):
    action: str
    params: dict | None = None


def _repo(ctx: TenantContext) -> CopilotRepository:
    return CopilotRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


@router.get("/status")
async def status(ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    return await _repo(ctx).status()


@router.post("/chat")
async def chat(body: ChatIn, ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    return await _repo(ctx).chat(ctx.user_id, ctx.permissions, [m.model_dump() for m in body.messages])


@router.get("/action-plan")
async def action_plan(ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    """Προληπτικό «Πλάνο Ημέρας» — προτεραιοποιημένες ενέργειες με κουμπί εκτέλεσης."""
    return await _repo(ctx).action_plan(ctx.permissions)


@router.post("/act")
async def act(body: ActIn, ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    """Execute a Level-3 action the user explicitly confirmed in the UI. The action's own
    permission is re-checked inside the service (the chat only PROPOSES actions)."""
    return await _repo(ctx).run_action(ctx.user_id, ctx.permissions, body.action, body.params)


# ── Copilot Routines (Phase 1: scheduled read-only reports) ─────────────────
class RoutineIn(BaseModel):
    name: str
    schedule: dict
    action: str = "report"
    # report routine
    report_tool: str | None = None
    report_args: dict | None = None
    delivery: str = "inapp"
    email: str | None = None
    # message routine (Phase 2 — communication)
    channel: str | None = None
    subject: str | None = None
    message: str | None = None
    segment: str = "all"
    value: str | None = None
    mode: str = "draft"
    max_recipients: int = 200


class RoutinePatch(BaseModel):
    name: str | None = None
    schedule: dict | None = None
    report_tool: str | None = None
    report_args: dict | None = None
    delivery: str | None = None
    email: str | None = None
    enabled: bool | None = None


class MarkReadIn(BaseModel):
    run_id: str | None = None


def _rrepo(ctx: TenantContext) -> CopilotRoutineRepository:
    return CopilotRoutineRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


@router.get("/routines")
async def routines(ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    return {"items": await _rrepo(ctx).list()}


@router.post("/routines")
async def create_routine(body: RoutineIn,
                         ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    # Message routines send to patients → require the communications module (patient_analytics) too.
    if body.action == "message" and ctx.modules.get("patient_analytics", "locked") == "locked":
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"error": "module_locked", "module": "patient_analytics"})
    return await _rrepo(ctx).create(
        user=ctx.user_id, name=body.name, schedule=body.schedule, action=body.action,
        report_tool=body.report_tool, report_args=body.report_args,
        delivery=body.delivery, email=body.email,
        channel=body.channel, subject=body.subject, message=body.message,
        segment=body.segment, value=body.value, mode=body.mode, max_recipients=body.max_recipients)


@router.put("/routines/{routine_id}")
async def update_routine(routine_id: str, body: RoutinePatch,
                         ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    return await _rrepo(ctx).update(routine_id, body.model_dump(exclude_none=True))


@router.delete("/routines/{routine_id}")
async def delete_routine(routine_id: str,
                         ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    return await _rrepo(ctx).delete(routine_id)


@router.post("/routines/{routine_id}/run")
async def run_routine(routine_id: str,
                      ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    return await _rrepo(ctx).run_now(routine_id)


@router.get("/routines-inbox")
async def routines_inbox(ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    return await _rrepo(ctx).inbox()


@router.post("/routines-inbox/read")
async def routines_inbox_read(body: MarkReadIn,
                              ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    return await _rrepo(ctx).mark_read(body.run_id)


@router.post("/routines-inbox/{run_id}/approve")
async def approve_routine_run(run_id: str,
                              ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    """Explicitly authorise sending a queued (draft) message run to patients — then it goes out."""
    if ctx.modules.get("patient_analytics", "locked") == "locked":
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"error": "module_locked", "module": "patient_analytics"})
    return await _rrepo(ctx).approve_run(run_id)


@router.post("/routines-inbox/{run_id}/reject")
async def reject_routine_run(run_id: str,
                             ctx: TenantContext = Depends(require("patients:read", module="ai_assistant"))):
    return await _rrepo(ctx).reject_run(run_id)
