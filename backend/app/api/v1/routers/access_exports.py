"""Πολιτική πρόσβασης — ΦΑΣΗ 2: εξαγωγές (Excel/CSV/PDF).

Κάθε εξαγωγή του UI (lib/csv.ts · lib/export.ts) ζητά πρώτα άδεια εδώ: όριο ανά ημέρα (σε επιβολή),
όριο γραμμών, κείμενο υδατογραφήματος, καταγραφή (ποιος, ποια οθόνη, ποια φίλτρα, πόσες γραμμές). Μετά τη
δημιουργία του αρχείου στέλνει το SHA-256 του → η εγγραφή «δένει» με το συγκεκριμένο αρχείο.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.core.ratelimit import client_ip
from app.services import access_limits as al
from app.services import access_policy as ap

router = APIRouter()


class ExportIn(BaseModel):
    format: str = Field(..., max_length=10)
    screen: str = Field("", max_length=200)
    filters: str = Field("", max_length=500)
    rows: int = Field(0, ge=0, le=10_000_000)


class ExportDoneIn(BaseModel):
    sha256: str = Field(..., min_length=64, max_length=64)
    rows: int = Field(0, ge=0, le=10_000_000)


async def _label(db, kind: str, uid: str) -> str | None:
    from bson import ObjectId
    if kind == "tenant" and ObjectId.is_valid(uid):
        u = await db["users"].find_one({"_id": ObjectId(uid)}, {"email": 1, "full_name": 1})  # tenant-ok
        return (u or {}).get("full_name") or (u or {}).get("email")
    if kind == "admin" and ObjectId.is_valid(uid):
        a = await db["platform_admins"].find_one({"_id": ObjectId(uid)}, {"email": 1})  # tenant-ok
        return (a or {}).get("email")
    return None


@router.post("/export")
async def export_authorize(body: ExportIn, request: Request):
    who = ap.identify_claims(request.headers.get("authorization"))
    if not who:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token_required")
    kind, uid, tid, claims = who
    from app.core.db import shared_db
    db = shared_db()
    res = await al.export_authorize(
        db, kind=kind, uid=uid, tid=tid, exempt=bool(claims.get("imp")), fmt=body.format,
        screen=body.screen, rows=body.rows, filters=body.filters, ip=client_ip(request),
        ua=request.headers.get("user-agent") or "", user_label=await _label(db, kind, uid))
    if not res["allowed"]:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail={
            "error": "export_limit", "limit": res["limit"],
            "message": f"Συμπληρώθηκε το όριο εξαγωγών της ημέρας ({res['limit']}). "
                       "Για μεγαλύτερη εξαγωγή επικοινωνήστε με την υποστήριξη του RxVision."})
    return res


@router.post("/export/{export_id}/done")
async def export_done(export_id: str, body: ExportDoneIn, request: Request):
    who = ap.identify_claims(request.headers.get("authorization"))
    if not who:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token_required")
    from app.core.db import shared_db
    ok = await al.export_done(shared_db(), export_id, uid=who[1], sha256=body.sha256.lower(), rows=body.rows)
    return {"ok": ok}
