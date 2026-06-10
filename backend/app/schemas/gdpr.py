"""Request/response schemas for the GDPR data-subject-rights module."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class RectifyIn(BaseModel):
    """Art.16 — correct contact details. Only these (non-clinical) fields are writable."""
    phone: str | None = None
    mobile: str | None = None
    email: str | None = None
    address: str | None = None
    city: str | None = None
    postal_code: str | None = None
    notes: str | None = None
    preferred_channel: Literal["email", "sms"] | None = None


class ConsentIn(BaseModel):
    """Record a marketing/communications consent event (Art.6/7)."""
    channel: Literal["email", "sms", "all"]
    status: Literal["granted", "withdrawn"]
    source: str = Field("pharmacist_ui", max_length=64)
    policy_version: str | None = None


class RestrictIn(BaseModel):
    """Art.18 restriction and/or Art.21 objection to marketing."""
    restrict: bool | None = None
    object_marketing: bool | None = None


class EraseIn(BaseModel):
    """Art.17 — right to be forgotten (with legal hold). Confirmation required."""
    confirm: bool = False
    reason: str | None = Field(None, max_length=500)


class RetentionIn(BaseModel):
    """The controller (pharmacy) chooses how long RxVision keeps its data (months)."""
    retention_months: int = Field(..., ge=1, le=600)
