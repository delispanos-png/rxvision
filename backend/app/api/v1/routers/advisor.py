"""Intelligent advisor router — Business & Order. One screen of prioritised insights."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query

from fastapi import HTTPException, status

from app.core.deps import TenantContext, require
from app.repositories.advisor import AdvisorRepository, nutrition_html

router = APIRouter()


@router.get("/nutrition/{patient_id}")
async def nutrition(
    patient_id: str,
    ctx: TenantContext = Depends(require("patients:read", module="patient_analytics")),
):
    plan = await AdvisorRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).nutrition_plan(patient_id)
    if not plan:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    return plan


@router.post("/nutrition/{patient_id}/email")
async def nutrition_email(
    patient_id: str,
    ctx: TenantContext = Depends(require("patients:read", module="patient_analytics")),
):
    from app.services import comms
    plan = await AdvisorRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).nutrition_plan(patient_id)
    if not plan:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    if not plan.get("email"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ο ασθενής δεν έχει email στην καρτέλα.")
    cfg = comms.get_config(ctx.tenant_id)
    try:
        await comms.send_email(cfg, plan["email"], "Διατροφικές συμβουλές από το φαρμακείο σας",
                               nutrition_html(plan, cfg.get("from_name")))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return {"ok": True, "to": plan["email"]}


@router.get("/business")
async def business(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    return await AdvisorRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).business(date_from, date_to)


@router.get("/cross-sell-patients")
async def cross_sell_patients(
    atc: str = Query(..., description="ATC prefix, e.g. C10AA"),
    ctx: TenantContext = Depends(require("patients:read", module="patient_analytics")),
):
    return {"atc": atc, "items": await AdvisorRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).cross_sell_patients(atc)}


@router.get("/recall")
async def recall(
    ctx: TenantContext = Depends(require("patients:read", module="patient_analytics")),
):
    """Recall list — patients with a missed/available repeat, ranked by € at risk."""
    return await AdvisorRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).recall()


@router.get("/recall/{patient_id}")
async def recall_detail(
    patient_id: str,
    ctx: TenantContext = Depends(require("patients:read", module="patient_analytics")),
):
    """Drill-down: οι επαναλαμβανόμενες συνταγές ενός πελάτη με τις χαμένες/διαθέσιμες επαναλήψεις."""
    return await AdvisorRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).recall_detail(patient_id)


@router.get("/orders")
async def orders(
    lead_days: int = 7,
    safety_pct: float = 15.0,
    ctx: TenantContext = Depends(require("orders:read", module="order_suggestions")),
):
    return await AdvisorRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).orders(
        lead_days=lead_days, safety_pct=safety_pct)
