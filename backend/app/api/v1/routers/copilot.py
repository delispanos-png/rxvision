"""RxVision Copilot router — in-app usage assistant (Level 1: guide + deep links)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.copilot import CopilotRepository

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
    return CopilotRepository(tenant_id=ctx.tenant_id)


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
