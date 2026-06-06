"""Subscription / billing DTOs."""

from __future__ import annotations

from pydantic import BaseModel, Field


class CheckoutIn(BaseModel):
    plan: str = Field(..., min_length=1)  # free_trial|basic|pro|enterprise
    seats: int = Field(default=1, ge=1)
    addons: list[str] = Field(default_factory=list)


class CheckoutOut(BaseModel):
    checkout_url: str
    plan: str
    status: str
