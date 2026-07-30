"""Δημόσια φόρμα αξιολόγησης (churned trials) — GET context + POST απαντήσεις, με token."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.core.ratelimit import rate_limit
from app.services import feedback_service

router = APIRouter()


@router.get("/{token}",
            dependencies=[Depends(rate_limit("feedback_get", limit=30, window_seconds=600))])
async def get_form(token: str):
    f = await feedback_service.get_form(token)
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"error": "not_found"})
    return f


class FeedbackIn(BaseModel):
    strong_points: str | None = Field(None, max_length=2000)
    weak_points: str | None = Field(None, max_length=2000)
    would_choose: str | None = Field(None, max_length=2000)
    pricing_view: str | None = Field(None, max_length=2000)
    churn_reason: str | None = Field(None, max_length=2000)
    most_useful: str | None = Field(None, max_length=2000)
    missing: str | None = Field(None, max_length=2000)
    nps: int | None = Field(None, ge=0, le=10)
    competitor: str | None = Field(None, max_length=500)
    contact_ok: bool | None = None
    contact_phone: str | None = Field(None, max_length=40)


@router.post("/{token}",
             dependencies=[Depends(rate_limit("feedback_post", limit=10, window_seconds=600))])
async def submit(token: str, body: FeedbackIn):
    ok = await feedback_service.submit(token, body.model_dump(exclude_none=True))
    if not ok:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": "already_submitted_or_invalid"})
    return {"ok": True}
