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


class ReportIn(BaseModel):
    sig: str
    reason: str | None = None


def _repo(ctx: TenantContext) -> PharmaCatRepository:
    return PharmaCatRepository(tenant_id=ctx.tenant_id)


@router.get("/status")
async def status(ctx: TenantContext = Depends(require("patients:read", module=["ai_assistant", "pharmacat"]))):
    return await _repo(ctx).status()


@router.post("/chat")
async def chat(body: ChatIn, ctx: TenantContext = Depends(require("patients:read", module=["ai_assistant", "pharmacat"]))):
    return await _repo(ctx).chat(ctx.user_id, [m.model_dump() for m in body.messages], body.context)


@router.post("/interactions")
async def interactions(body: InteractionIn, ctx: TenantContext = Depends(require("patients:read", module=["ai_assistant", "pharmacat"]))):
    return await _repo(ctx).interactions(ctx.user_id, body.drugs, body.context)


@router.post("/interactions/execution/{external_id}")
async def interactions_execution(external_id: str, ctx: TenantContext = Depends(require("patients:read", module="drug_interactions"))):
    """Έλεγχος αλληλεπιδράσεων για τα φάρμακα ΜΙΑΣ συνταγής (add-on «drug_interactions»)."""
    return await _repo(ctx).interactions_for_execution(ctx.user_id, external_id)


class PatientInteractionIn(BaseModel):
    amka: str | None = None
    patient_id: str | None = None


@router.post("/interactions/patient")
async def interactions_patient(body: PatientInteractionIn, ctx: TenantContext = Depends(require("patients:read", module="drug_interactions"))):
    """Έλεγχος αλληλεπιδράσεων σε ΟΛΗ την ενεργή αγωγή του ασθενή (add-on «drug_interactions»)."""
    return await _repo(ctx).interactions_for_patient(ctx.user_id, patient_id=body.patient_id, amka=body.amka)


@router.post("/report")
async def report_wrong(body: ReportIn, ctx: TenantContext = Depends(require("patients:read", module=["ai_assistant", "pharmacat"]))):
    """Flag a cached answer as wrong → shows up in the admin KB curation panel."""
    return await _repo(ctx).report_wrong(ctx.user_id, body.sig, body.reason)


@router.get("/reports")
async def my_reports(ctx: TenantContext = Depends(require("patients:read", module=["ai_assistant", "pharmacat"]))):
    """The pharmacist's own reports (+ unseen-resolved count for the «διορθώθηκε» banner)."""
    return await _repo(ctx).my_reports(ctx.user_id)


@router.post("/reports/seen")
async def reports_seen(ctx: TenantContext = Depends(require("patients:read", module=["ai_assistant", "pharmacat"]))):
    return await _repo(ctx).mark_reports_seen(ctx.user_id)


@router.get("/medicine")
async def medicine(eof: str, ctx: TenantContext = Depends(require("patients:read", module=["ai_assistant", "pharmacat"]))):
    return await _repo(ctx).medicine(eof)


@router.get("/cases")
async def cases(limit: int = 40, ctx: TenantContext = Depends(require("patients:read", module=["ai_assistant", "pharmacat"]))):
    return await _repo(ctx).cases(limit)


@router.get("/insights")
async def insights(ctx: TenantContext = Depends(require("patients:read", module=["ai_assistant", "pharmacat"]))):
    return await _repo(ctx).insights()
