"""Πολιτική πρόσβασης — beacon αυτοματισμού από τον browser.

Η σελίδα στέλνει `POST /access/beacon` όταν `navigator.webdriver === true` (browser που οδηγείται από
script: Playwright/Selenium/agent). Ο server ΚΛΕΙΔΩΝΕΙ τον λογαριασμό 24 ώρες, ακυρώνει όλες τις συνεδρίες
και ειδοποιεί τους διαχειριστές. Admin & «σύνδεση ως πελάτης» (imp) → μόνο καταγραφή (QA/υποστήριξη).
Βλ. services/access_policy.py · docs/security-access-policy.md
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.core.ratelimit import client_ip
from app.services import access_policy as ap

router = APIRouter()


class BeaconIn(BaseModel):
    signal: str = Field(..., max_length=40)


@router.post("/beacon")
async def beacon(body: BeaconIn, request: Request):
    who = ap.identify_claims(request.headers.get("authorization"))
    if not who:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token_required")
    kind, uid, tid, claims = who
    ua, ip = request.headers.get("user-agent") or "", client_ip(request)
    if body.signal != "webdriver":
        return {"ok": True}
    if kind == "admin" or claims.get("imp"):
        await ap.record("automation_flagged", kind=kind, uid=uid, tid=tid, ua=ua, ip=ip,
                        path="beacon", extra={"exempt": "admin" if kind == "admin" else "impersonation"},
                        throttle_key=f"{kind}:{uid}:webdriver")
        return {"ok": True, "locked": False}
    from app.core.db import shared_db
    await ap.record("automation_flagged", kind=kind, uid=uid, tid=tid, ua=ua, ip=ip, path="beacon")
    res = await ap.lock_account(shared_db(), kind=kind, uid=uid, tid=tid,
                                reason="navigator.webdriver = true (browser οδηγούμενος από script/agent)",
                                ua=ua, ip=ip)
    return {"ok": True, "locked": bool(res.get("locked"))}
