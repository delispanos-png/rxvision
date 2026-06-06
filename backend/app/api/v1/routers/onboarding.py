"""Onboarding router — public pharmacy registration."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from app.services.onboarding_service import OnboardingError, OnboardingService

router = APIRouter()


class RegisterIn(BaseModel):
    pharmacy_name: str = Field(..., min_length=2, max_length=120)
    country: Literal["GR", "CY"]
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)
    full_name: str = Field(..., min_length=2, max_length=120)


@router.post("/register", status_code=201)
async def register(body: RegisterIn):
    try:
        return await OnboardingService().register(
            pharmacy_name=body.pharmacy_name, country=body.country,
            email=body.email, password=body.password, full_name=body.full_name)
    except OnboardingError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": str(exc)})
