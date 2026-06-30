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


@router.get("/packages",
            dependencies=[Depends(rate_limit("onboarding_packages", limit=60, window_seconds=600))])
async def public_packages():
    """Active subscription packages + active SLA tiers for the public /register wizard. Only
    `active` items are exposed, so deactivated packages are never offered to new customers."""
    from app.core.db import shared_db
    from app.repositories.base import jsonsafe
    db = shared_db()
    flt = {"$or": [{"active": {"$ne": False}}, {"active": {"$exists": False}}]}
    pkgs = [p async for p in db["packages"].find(flt).sort("price_monthly", 1)]
    sla = [s async for s in db["sla_tiers"].find(flt).sort("response_hours", 1)]
    from app.services import addon_service
    addons = await addon_service.catalog(active_only=True)   # à-la-carte add-ons for the pricing page
    return {"packages": jsonsafe(pkgs), "sla": jsonsafe(sla), "addons": jsonsafe(addons)}


@router.get("/aade/{afm}",
            dependencies=[Depends(rate_limit("onboarding_aade", limit=15, window_seconds=600))])
async def aade_lookup(afm: str):
    """Public ΑΑΔΕ VAT lookup for the signup wizard — AFM → company details auto-fill."""
    from app.services.aade_service import lookup
    return await lookup(afm)
