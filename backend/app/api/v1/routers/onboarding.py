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
    sla: Literal["basic", "professional"] | None = None


@router.post("/register", status_code=201)
async def register(body: RegisterIn):
    try:
        return await OnboardingService().register(
            pharmacy_name=body.pharmacy_name, country=body.country,
            email=body.email, password=body.password, full_name=body.full_name,
            company=body.company.model_dump() if body.company else None,
            package_code=body.package_code, billing_cycle=body.billing_cycle, sla=body.sla)
    except OnboardingError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": str(exc)})


@router.get("/aade/{afm}",
            dependencies=[Depends(rate_limit("aade_lookup", limit=10, window_seconds=3600))])
async def aade_lookup(afm: str):
    """Public ΑΑΔΕ VAT lookup for the signup wizard — AFM → company details auto-fill."""
    from app.services.aade_service import lookup
    return await lookup(afm)
