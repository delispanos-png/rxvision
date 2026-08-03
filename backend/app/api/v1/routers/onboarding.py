"""Onboarding router — public pharmacy registration."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from app.core.ratelimit import rate_limit
from app.services.onboarding_service import OnboardingError, OnboardingService

router = APIRouter()


class CompanyIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=200)        # επωνυμία
    title: str | None = Field(None, max_length=200)             # διακριτικός τίτλος
    afm: str | None = Field(None, max_length=20)
    doy: str | None = Field(None, max_length=120)
    email: EmailStr | None = None                               # contact email
    billing_email: EmailStr | None = None
    phone: str | None = Field(None, max_length=40)
    website: str | None = Field(None, max_length=200)
    address: str | None = Field(None, max_length=200)
    postal_code: str | None = Field(None, max_length=12)
    city: str | None = Field(None, max_length=120)
    region: str | None = Field(None, max_length=120)


class RegisterIn(BaseModel):
    pharmacy_name: str = Field(..., min_length=2, max_length=120)
    country: Literal["GR", "CY"] = "GR"
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)
    full_name: str = Field(..., min_length=2, max_length=120)
    # wizard extensions (all optional → legacy register still works)
    company: CompanyIn | None = None
    package_code: str | None = Field(None, max_length=40)
    billing_cycle: Literal["monthly", "yearly"] | None = None
    sla: str | None = Field(None, max_length=40)
    seats: int | None = Field(None, ge=1, le=999)        # ταυτόχρονοι χρήστες
    payment_method: Literal["card", "bank"] | None = None
    addons: list[str] | None = None                      # à-la-carte add-on ids chosen at signup


@router.post("/register", status_code=201,
             dependencies=[Depends(rate_limit("onboarding_register", limit=5, window_seconds=600))])
async def register(body: RegisterIn):
    try:
        return await OnboardingService().register(
            pharmacy_name=body.pharmacy_name, country=body.country,
            email=body.email, password=body.password, full_name=body.full_name,
            company=body.company.model_dump() if body.company else None,
            package_code=body.package_code, billing_cycle=body.billing_cycle, sla=body.sla,
            seats=body.seats, payment_method=body.payment_method, addons=body.addons)
    except OnboardingError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": str(exc)})


# ── Φάση 1: πληρωμή-πρώτα (pending → Viva → materialize) ────────────────────────────────
class IntentIn(BaseModel):
    pharmacy_name: str = Field(..., min_length=2, max_length=120)
    country: Literal["GR", "CY"] = "GR"
    owner_email: EmailStr
    owner_name: str = Field(..., min_length=2, max_length=120)
    company: CompanyIn | None = None
    package_code: str | None = Field(None, max_length=40)
    billing_cycle: Literal["monthly", "yearly"] | None = None
    sla: str | None = Field(None, max_length=40)
    seats: int | None = Field(None, ge=1, le=999)
    payment_method: Literal["card", "bank"] = "card"
    addons: list[str] | None = None


class CompleteIn(BaseModel):
    pending_id: str = Field(..., min_length=8, max_length=64)
    password: str = Field(..., min_length=8, max_length=128)
    full_name: str | None = Field(None, max_length=120)


@router.get("/check-afm/{afm}",
            dependencies=[Depends(rate_limit("onboarding_afm", limit=60, window_seconds=600))])
async def check_afm(afm: str):
    """Υπάρχει ήδη συνδρομή για αυτό το ΑΦΜ; → μπλοκ διπλής εγγραφής (boolean, χωρίς διαρροή στοιχείων)."""
    return {"exists": await OnboardingService().afm_exists(afm)}


@router.post("/register-intent", status_code=201,
             dependencies=[Depends(rate_limit("onboarding_intent", limit=10, window_seconds=600))])
async def register_intent(body: IntentIn):
    """Δημιουργεί προσωρινή εγγραφή (ΧΩΡΙΣ λογαριασμό) & ξεκινά την πληρωμή. Κάρτα → Viva checkout_url."""
    svc = OnboardingService()
    try:
        pending = await svc.create_pending(
            pharmacy_name=body.pharmacy_name, country=body.country,
            owner_email=body.owner_email, owner_name=body.owner_name,
            company=body.company.model_dump() if body.company else {},
            package_code=body.package_code, billing_cycle=body.billing_cycle,
            sla=body.sla, seats=body.seats, addons=body.addons,
            payment_method=body.payment_method)
    except OnboardingError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": str(exc)})
    pid = pending["pending_id"]
    if pending.get("is_trial"):     # δωρεάν trial → καμία πληρωμή, κατευθείαν στο βήμα κωδικού
        return {"pending_id": pid, "status": "paid", "trial": True, "amount_cents": 0}
    if body.payment_method == "card":
        from app.core.db import shared_db
        from app.services import viva_service
        order = await viva_service.create_checkout_order(
            amount=pending["amount_cents"], ref=f"signup:{pid}",
            description=f"RxVision {body.billing_cycle or 'monthly'} — {body.pharmacy_name}",
            email=body.owner_email, full_name=body.owner_name, allow_recurring=True)
        if not order.get("ok"):
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail={"error": order.get("error", "viva_error")})
        await shared_db()["pending_registrations"].update_one(
            {"_id": pid}, {"$set": {"viva_order_code": order.get("order_code")}})
        return {"pending_id": pid, "checkout_url": order["checkout_url"], "amount_cents": pending["amount_cents"]}
    # bank → αναμονή έγκρισης admin (Φάση 2)
    return {"pending_id": pid, "status": "awaiting_bank_approval", "amount_cents": pending["amount_cents"]}


@router.get("/register-status/{pending_id}",
            dependencies=[Depends(rate_limit("onboarding_status", limit=120, window_seconds=600))])
async def register_status(pending_id: str):
    """Poll κατάστασης προσωρινής εγγραφής μετά την επιστροφή από Viva."""
    p = await OnboardingService().get_pending(pending_id)
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"error": "not_found"})
    return {"status": p.get("status"), "payment_method": p.get("payment_method"),
            "is_trial": bool(p.get("is_trial")),
            "owner_email": p.get("owner_email"), "owner_name": p.get("owner_name")}


@router.post("/register-complete", status_code=201,
             dependencies=[Depends(rate_limit("onboarding_complete", limit=10, window_seconds=600))])
async def register_complete(body: CompleteIn):
    """Ολοκλήρωση: ο πελάτης βάζει κωδικό ΜΟΝΟ αφού επιβεβαιωθεί η πληρωμή → δημιουργείται ο λογαριασμός."""
    try:
        return await OnboardingService().materialize(
            pending_id=body.pending_id, password=body.password, full_name=body.full_name)
    except OnboardingError as exc:
        code = (status.HTTP_409_CONFLICT if str(exc) in ("payment_not_confirmed", "already_completed",
                                                         "email_already_registered")
                else status.HTTP_400_BAD_REQUEST)
        raise HTTPException(code, detail={"error": str(exc)})


@router.get("/packages",
            dependencies=[Depends(rate_limit("onboarding_packages", limit=60, window_seconds=600))])
async def public_packages():
    """Active subscription packages + active SLA tiers for the public /register wizard & Lovable
    pricing page. Only `active` items are exposed. Στέλνει ΜΟΝΟ τους διαθέσιμους κύκλους χρέωσης
    (billing_cycles): αν ένα πακέτο είναι μόνο ετήσιο → μόνο η ετήσια τιμή (όχι μηνιαία), ώστε η
    σελίδα να δείχνει μόνο ό,τι χρειάζεται."""
    from app.core.db import shared_db
    from app.repositories.base import jsonsafe
    db = shared_db()
    flt = {"$or": [{"active": {"$ne": False}}, {"active": {"$exists": False}}]}

    def _public_pkg(p: dict) -> dict:
        cycles = [c for c in (p.get("billing_cycles") or ["monthly", "yearly"]) if c in ("monthly", "yearly")] or ["monthly", "yearly"]
        out = {
            "_id": p["_id"], "name": p.get("name"), "description": p.get("description"),
            "seats": p.get("seats"), "trial_days": p.get("trial_days"), "sla": p.get("sla"),
            "modules": p.get("modules", []), "features": p.get("features", []),
            "available_addons": p.get("available_addons", []),
            "billing_cycles": cycles, "price_includes_vat": bool(p.get("price_includes_vat")),
        }
        # μόνο οι τιμές των προσφερόμενων κύκλων (+ τιμή επιπλέον χρήστη αντίστοιχα)
        if "monthly" in cycles:
            out["price_monthly"] = int(p.get("price_monthly") or 0)
            out["extra_user_price"] = int(p.get("extra_user_price") or 0)
        if "yearly" in cycles:
            out["price_yearly"] = int(p.get("price_yearly") or 0)
            out["extra_user_price_yearly"] = int(p.get("extra_user_price_yearly") or 0)
        return out

    pkgs = [_public_pkg(p) async for p in db["packages"].find(flt).sort("price_monthly", 1)]
    sla = [s async for s in db["sla_tiers"].find(flt).sort("response_hours", 1)]
    from app.services import addon_service
    addons = await addon_service.catalog(active_only=True)   # à-la-carte add-ons for the pricing page
    from app.services import payment_methods
    methods = await payment_methods.public_methods()
    return {"packages": jsonsafe(pkgs), "sla": jsonsafe(sla), "addons": jsonsafe(addons),
            "payment_methods": methods}


@router.get("/payment-methods",
            dependencies=[Depends(rate_limit("onboarding_pm", limit=60, window_seconds=600))])
async def public_payment_methods():
    """Enabled payment methods — the public registration wizard adapts to these."""
    from app.services import payment_methods
    return {"methods": await payment_methods.public_methods()}


@router.get("/aade/{afm}",
            dependencies=[Depends(rate_limit("onboarding_aade", limit=15, window_seconds=600))])
async def aade_lookup(afm: str):
    """Public ΑΑΔΕ VAT lookup for the signup wizard — AFM → company details auto-fill."""
    from app.services.aade_service import lookup
    return await lookup(afm)
