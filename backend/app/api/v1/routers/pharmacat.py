"""PharmaCat Clinical Assistant router — AI CDSS for the pharmacist (symptom advisor, dynamic
questions, red-flag gating, OTC guidance, drug-interaction checker, product recommendation,
case recording + audit, daily insights). NOT diagnosis, NOT a replacement for a physician."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.pharmacat import PharmaCatRepository

router = APIRouter()


class Msg(BaseModel):
    role: str  # user | assistant
    content: str


class ChatIn(BaseModel):
    messages: list[Msg]
    context: dict | None = None


class InteractionIn(BaseModel):
    drugs: list[str]
    context: dict | None = None


def _repo(ctx: TenantContext) -> PharmaCatRepository:
    return PharmaCatRepository(tenant_id=ctx.tenant_id)


@router.get("/status")
async def status(ctx: TenantContext = Depends(require("patients:read"))):
    return await _repo(ctx).status()


@router.post("/chat")
async def chat(body: ChatIn, ctx: TenantContext = Depends(require("patients:read"))):
    return await _repo(ctx).chat(ctx.user_id, [m.model_dump() for m in body.messages], body.context)


@router.post("/interactions")
async def interactions(body: InteractionIn, ctx: TenantContext = Depends(require("patients:read"))):
    return await _repo(ctx).interactions(ctx.user_id, body.drugs, body.context)


@router.get("/cases")
async def cases(limit: int = 40, ctx: TenantContext = Depends(require("patients:read"))):
    return await _repo(ctx).cases(limit)


@router.get("/insights")
async def insights(ctx: TenantContext = Depends(require("patients:read"))):
    return await _repo(ctx).insights()
