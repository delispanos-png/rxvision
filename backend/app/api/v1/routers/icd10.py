"""ICD-10 analytics router — count / value / profit per diagnosis."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query

from app.core.deps import TenantContext, require
from app.repositories.icd10 import Icd10Repository

router = APIRouter()

_MODULE = "icd10_analytics"


@router.get("/aggregate")
async def aggregate(
    metric: Literal["count", "value", "profit"] = "count",
    limit: int = 50,
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("icd10:read", module=_MODULE)),
):
    repo = Icd10Repository(tenant_id=ctx.tenant_id)
    rows = await repo.aggregate_metric(metric=metric, date_from=date_from,
                                       date_to=date_to, limit=limit)
    return {"metric": metric, "items": rows}


@router.get("/hierarchy")
async def hierarchy(
    level: int = Query(3, ge=1, le=5, description="ICD-10 rollup depth (1=chapter..5=full)"),
    metric: Literal["count", "value", "profit"] = "count",
    limit: int = 50,
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("icd10:read", module=_MODULE)),
):
    """Concept doc §4 — diagnoses rolled up to a chosen hierarchy level (1-5)."""
    repo = Icd10Repository(tenant_id=ctx.tenant_id)
    rows = await repo.aggregate_hierarchy(level=level, metric=metric,
                                          date_from=date_from, date_to=date_to, limit=limit)
    return {"level": level, "metric": metric, "items": rows}


@router.get("/detail")
async def detail(
    code: str = Query(..., min_length=2, max_length=10),
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("icd10:read", module=_MODULE)),
):
    """Ό,τι ξέρουμε για ΜΙΑ πάθηση: επίσημη περιγραφή, κεφάλαιο, μεγέθη, τάση vs προηγούμενη
    ίση περίοδο, και τα φάρμακα που όντως δόθηκαν γι' αυτήν σ' αυτό το φαρμακείο."""
    repo = Icd10Repository(tenant_id=ctx.tenant_id)
    return await repo.detail(code=code.upper(), date_from=date_from, date_to=date_to)


@router.get("/note")
async def read_note(
    code: str = Query(..., min_length=2, max_length=10),
    ctx: TenantContext = Depends(require("icd10:read", module=_MODULE)),
):
    """Η AI επεξήγηση ΑΝ υπάρχει ήδη — ποτέ δεν παράγει, ποτέ δεν χρεώνει όριο."""
    from app.services import icd10_notes
    hit = await icd10_notes.cached(code.upper())
    if not hit:
        return {"ok": False, "error": "not_generated"}
    return {"ok": True, "cached": True,
            **{k: hit.get(k) for k in ("what", "pharmacy", "watch", "talk", "at")}}


@router.post("/note")
async def make_note(
    code: str = Query(..., min_length=2, max_length=10),
    ctx: TenantContext = Depends(require("icd10:read", module=_MODULE)),
):
    """Παράγει την επεξήγηση (αν λείπει). Καίει όριο AI ΜΟΝΟ όταν όντως παραχθεί.

    ΔΕΝ απαιτεί το πρόσθετο AI: ο φρουρός είναι ΟΙΚΟΝΟΜΙΚΟΣ, όχι modular — το `ai_quota`
    κρίνει με βάση τον προϋπολογισμό του πακέτου. Έτσι, μόλις ΕΝΑ φαρμακείο παραγάγει την
    επεξήγηση ενός κωδικού, τη διαβάζουν ΟΛΑ δωρεάν από την καθολική μνήμη."""
    from app.core.db import shared_db
    from app.services import icd10_notes
    code = code.upper()
    # tenant-ok: ο κατάλογος ICD-10 είναι διεθνής, κοινός για όλα τα φαρμακεία
    cat = await shared_db()["icd10_codes"].find_one({"_id": code}) or {}
    desc = cat.get("description")
    return await icd10_notes.generate(
        code=code, title=cat.get("title_el") or "",
        description=desc if desc and desc != cat.get("title_el") else None,
        tenant_id=ctx.tenant_id)
