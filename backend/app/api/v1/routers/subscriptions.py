"""Subscriptions / billing router — current plan, usage, plan changes (upgrade/downgrade)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.core.deps import TenantContext, get_current_context, require
from app.repositories.subscriptions import SubscriptionRepository
from app.services import plan_change_service as pcs

router = APIRouter()


@router.get("")
async def get_subscription(ctx: TenantContext = Depends(get_current_context)):
    repo = SubscriptionRepository(tenant_id=ctx.tenant_id)
    sub = await repo.current()
    if sub is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no_subscription")
    return sub


@router.get("/usage")
async def usage(ctx: TenantContext = Depends(get_current_context)):
    repo = SubscriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.usage()


@router.get("/receipts")
async def receipts(ctx: TenantContext = Depends(get_current_context)):
    """Παραστατικά — everything charged through RxVision (subscriptions, upgrades, credit top-ups)."""
    from app.services import receipts as rc
    return {"items": await rc.list_for_tenant(ctx.tenant_id)}


@router.get("/payment-methods")
async def payment_methods_public(_: TenantContext = Depends(get_current_context)):
    """Enabled payment methods — the upgrade UI renders only these."""
    from app.services import payment_methods
    return {"methods": await payment_methods.public_methods()}


# ── Plan change (upgrade via card/alpha/bank · downgrade scheduled to period end) ─────────────────
class PlanChangeIn(BaseModel):
    plan: str
    method: Literal["card", "alpha", "bank"] | None = None   # required only for an upgrade


@router.get("/plan-change")
async def plan_change_status(ctx: TenantContext = Depends(get_current_context)):
    """Current pending change (if any) — for the plan page banner."""
    return await pcs.get_pending(ctx.tenant_id)


@router.post("/plan-change")
async def request_plan_change(body: PlanChangeIn,
                              ctx: TenantContext = Depends(require("billing:manage"))):
    """Request an upgrade (card → Revolut / bank → admin request) or schedule a downgrade."""
    try:
        return await pcs.request_change(ctx.tenant_id, body.plan, method=body.method,
                                        by_email=getattr(ctx, "email", None))
    except pcs.PlanChangeError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@router.delete("/plan-change")
async def cancel_plan_change(ctx: TenantContext = Depends(require("billing:manage"))):
    """Cancel a not-yet-applied change (scheduled downgrade or awaiting-payment upgrade)."""
    return await pcs.cancel_change(ctx.tenant_id)


# ── Self-service extras (αυξημένο AI όριο & extended διατήρηση — ξεκλειδώνουν με κάρτα) ────────────
@router.get("/extras")
async def get_extras(ctx: TenantContext = Depends(get_current_context)):
    """Τρέχοντα όρια + τιμές + κατάσταση κάρτας — για τη σελίδα «Χρέωση → Extras»."""
    from app.services import extras_service
    return await extras_service.get_extras(ctx.tenant_id)


class RetentionIn(BaseModel):
    months: int


@router.put("/extras/retention")
async def set_retention(body: RetentionIn, ctx: TenantContext = Depends(require("billing:manage"))):
    """Ο φαρμακοποιός ανεβάζει το παράθυρο διατήρησης (>36μ ⇒ απαιτείται κάρτα)."""
    from app.services import extras_service
    try:
        return await extras_service.set_retention(ctx.tenant_id, body.months)
    except extras_service.CardRequired:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "card_required")


# ── Self-service αριθμός χρηστών (seats) — αύξηση άμεση/prorated, μείωση στην ανανέωση ─────────────
@router.get("/seats")
async def get_seats(ctx: TenantContext = Depends(get_current_context)):
    """Τρέχοντες/ανώτατοι χρήστες + τιμή ανά χρήστη (του πακέτου) + κατάσταση κάρτας/εκκρεμής μείωση."""
    from app.services import seats_service
    return await seats_service.get_seats(ctx.tenant_id)


class SeatsIn(BaseModel):
    seats: int


@router.post("/seats/preview")
async def preview_seats(body: SeatsIn, ctx: TenantContext = Depends(get_current_context)):
    """Προεπισκόπηση: τι θα χρεωθεί ΤΩΡΑ (αναλογικά) για αύξηση σε `seats` — χωρίς εφαρμογή."""
    from app.services import seats_service
    return await seats_service.preview(ctx.tenant_id, body.seats)


@router.put("/seats")
async def set_seats(body: SeatsIn, ctx: TenantContext = Depends(require("billing:manage"))):
    """Αλλαγή αριθμού χρηστών: αύξηση = ΑΜΕΣΗ αναλογική χρέωση κάρτας· μείωση = στην ανανέωση."""
    from app.services import seats_service
    try:
        return await seats_service.change_seats(ctx.tenant_id, body.seats)
    except seats_service.CardRequired:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "card_required")
    except seats_service.SeatError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))


@router.api_route("/alpha-callback", methods=["GET", "POST"], include_in_schema=False)
async def alpha_callback(request: Request):
    """Alpha e-Commerce redirect-back: verify the digest, apply the upgrade on success, then send the
    pharmacist back to the plan page. ⚠️ Exact fields/digest confirmed with Alpha (see requirements doc)."""
    from app.services import alphabank_service as ab
    from app.core.db import shared_db
    params = dict(await request.form()) if request.method == "POST" else dict(request.query_params)
    res = await ab.verify_callback(params)
    order_id = res.get("order_id")
    if res.get("ok") and res.get("paid") and order_id:
        sub = await shared_db()["subscriptions"].find_one({"pending_change.alpha_order_id": order_id})
        if sub:
            await pcs.apply_change(sub["tenant_id"], source="alphabank")
    return RedirectResponse("https://app.rxvision.gr/settings/modules", status_code=303)
