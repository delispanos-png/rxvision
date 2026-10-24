"""Δημόσιος σύνδεσμος «νέος κωδικός ΗΔΥΚΑ» (από SMS/email) — ΧΩΡΙΣ σύνδεση στο RxVision.

Όλη η λογική ασφάλειας ζει στο `services/hdika_password_link.py` (token μίας χρήσης, 48ω, ≤3
προσπάθειες, δοκιμή στην ΗΔΥΚΑ πριν την αποθήκευση). Εδώ μόνο όριο αιτημάτων ανά IP.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core.ratelimit import rate_limit
from app.services import hdika_password_link as link

router = APIRouter()


class CheckIn(BaseModel):
    token: str = Field(..., min_length=20, max_length=100)


class SubmitIn(CheckIn):
    password: str = Field(..., min_length=1, max_length=200)


@router.post("/check", dependencies=[Depends(rate_limit("hdika_link_check", limit=30, window_seconds=600))])
async def check(body: CheckIn):
    return await link.check(body.token)


@router.post("/submit", dependencies=[Depends(rate_limit("hdika_link_submit", limit=10, window_seconds=600))])
async def submit(body: SubmitIn):
    return await link.submit(body.token, body.password)
