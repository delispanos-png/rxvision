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


def _repo(ctx: TenantContext) -> CopilotRepository:
    return CopilotRepository(tenant_id=ctx.tenant_id)


@router.get("/status")
async def status(ctx: TenantContext = Depends(require("patients:read"))):
    return await _repo(ctx).status()


@router.post("/chat")
async def chat(body: ChatIn, ctx: TenantContext = Depends(require("patients:read"))):
    return await _repo(ctx).chat(ctx.user_id, [m.model_dump() for m in body.messages])
