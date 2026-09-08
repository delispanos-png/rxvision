"""Intelligent advisor router — Business & Order. One screen of prioritised insights."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query

from fastapi import HTTPException, status
from pydantic import BaseModel

from app.core.db import shared_db

from app.core.deps import TenantContext, require
from app.repositories.advisor import AdvisorRepository, nutrition_html

router = APIRouter()


@router.get("/nutrition/{patient_id}")
async def nutrition(
    patient_id: str,
    ctx: TenantContext = Depends(require("patients:read", module=["nutrition", "ai_assistant"])),
):
    plan = await AdvisorRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).nutrition_plan(patient_id)
    if not plan:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    return plan


class NutritionAssignIn(BaseModel):
    note: str | None = None       # προαιρετικό σημείωμα φαρμακοποιού προς τον ασθενή


@router.post("/nutrition/{patient_id}/assign")
async def nutrition_assign(
    patient_id: str, body: NutritionAssignIn | None = None,
    ctx: TenantContext = Depends(require("patients:read", module=["nutrition", "ai_assistant"])),
):
    """Αναθέτει την πρόταση διατροφής ΣΤΗΝ ΠΥΛΗ του ασθενή (αντί/επιπλέον του email).

    ΓΙΑΤΙ: το email χάνεται στα εισερχόμενα· στην πύλη ο ασθενής το ξαναβρίσκει όποτε θέλει.
    Κρατάμε ΜΙΑ ενεργή πρόταση ανά ασθενή (η νέα αντικαθιστά την προηγούμενη) — ο ασθενής δεν
    πρέπει να βλέπει αντικρουόμενες οδηγίες από διαφορετικές ημερομηνίες.
    """
    plan = await AdvisorRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).nutrition_plan(patient_id)
    if not plan:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    if not (plan.get("sections") or []):
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": "no_sections"})
    db = shared_db()
    now = datetime.now(tz=timezone.utc)
    await db["patient_nutrition_plans"].update_one(   # tenant-ok: ρητό φίλτρο tenant_id
        {"tenant_id": ctx.tenant_id, "patient_ref": patient_id},
        {"$set": {"sections": plan.get("sections") or [], "note": (body.note if body else None),
                  "assigned_at": now, "assigned_by": getattr(ctx, "user_id", None)},
         "$setOnInsert": {"created_at": now}},
        upsert=True)
    # ειδοποίηση στην πύλη (best-effort — η ανάθεση δεν πρέπει να αποτύχει αν το push είναι κάτω)
    try:
        from app.repositories.patient_portal import PatientAccountRepository
        from app.services import push_service
        # ίδιο μοτίβο με τον worker υπενθυμίσεων: patient_ref → ΑΜΚΑ → λογαριασμός πύλης
        from bson import ObjectId
        pa = await db["patients_anonymized"].find_one(
            {"_id": ObjectId(patient_id), "tenant_id": ctx.tenant_id}, {"amka": 1})
        acc = (await PatientAccountRepository().get_by_amka((pa or {}).get("amka"))
               if (pa or {}).get("amka") else None)
        if acc:
            await push_service.send_to_account(
                str(acc["_id"]), title="🥗 Νέα πρόταση διατροφής",
                body="Ο φαρμακοποιός σου ετοίμασε διατροφικές οδηγίες για την αγωγή σου.",
                url="/portal")
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "sections": len(plan.get("sections") or [])}


@router.post("/nutrition/{patient_id}/email")
async def nutrition_email(
    patient_id: str,
    ctx: TenantContext = Depends(require("patients:read", module=["nutrition", "ai_assistant"])),
):
    from app.services import comms, message_wallet
    plan = await AdvisorRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).nutrition_plan(patient_id)
    if not plan:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    if not plan.get("email"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ο ασθενής δεν έχει email στην καρτέλα.")
    try:
        await comms.send_email(ctx.tenant_id, plan["email"], "Διατροφικές συμβουλές από το φαρμακείο σας",
                               nutrition_html(plan, None))
    except message_wallet.InsufficientCredits:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "Ανεπαρκές υπόλοιπο μηνυμάτων.")
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
