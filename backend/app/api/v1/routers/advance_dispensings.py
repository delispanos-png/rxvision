"""Προχορηγήσεις σκευασμάτων («δανεικά») — Α & Β φάση.

Α φάση: καταγραφή δανεικού, λίστες, χειροκίνητη ξεχρέωση.
Β φάση: προτάσεις ταύτισης με εκτελεσμένη συνταγή — ο φαρμακοποιός απαντά ναι/όχι.
Γ φάση (μελλοντική): ΗΔΥΚΑ + HMVO. Το πεδίο `hmvo_uploaded` υπάρχει ήδη ανά είδος ώστε η λίστα
των αργοπορημένων να το δείχνει από σήμερα, χειροκίνητα.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.advance_dispensings import AdvanceDispensingRepository

router = APIRouter()
_MODULE = "advance_dispensing"
_PERM = "patients:read"


def _repo(ctx: TenantContext) -> AdvanceDispensingRepository:
    return AdvanceDispensingRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


class ItemIn(BaseModel):
    name: str | None = None
    eof_code: str | None = None
    gtin: str | None = None          # από το 2D barcode του κουτιού
    batch: str | None = None         # παρτίδα του 2D
    strip: str | None = None         # ταινία γνησιότητας / σειριακό
    lot: str | None = None           # για σκευάσματα χωρίς QR
    expiry: str | None = None
    qty: int = 1
    hmvo_uploaded: bool = False


class LoanIn(BaseModel):
    patient_name: str
    patient_ref: str | None = None
    amka: str | None = None
    items: list[ItemIn] = []
    note: str = ""


@router.get("")
async def list_loans(status_f: str = Query("open", alias="status"),
                     q: str | None = Query(None),
                     limit: int = Query(100, ge=1, le=500),
                     ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Τα δανεικά του φαρμακείου. `status`: open | cleared | written_off | all."""
    query: dict = {} if status_f == "all" else {"status": status_f}
    if q and q.strip():
        import re as _re
        query["patient_name"] = {"$regex": _re.escape(q.strip()), "$options": "i"}
    items = await _repo(ctx).find(query, sort=[("created_at", -1)], limit=limit)
    for it in items:
        it["_id"] = str(it["_id"])
    return {"items": items}


@router.get("/overdue")
async def overdue(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Τι αργεί: QR πάνω από 10 ημέρες (πρέπει να ανέβουν στον HMVO) και όλα πάνω από 30."""
    res = await _repo(ctx).overdue()
    for k in ("qr_over_10d", "over_30d"):
        for it in res[k]:
            it["_id"] = str(it["_id"])
    return res


@router.get("/matches")
async def matches(days: int = Query(45, ge=1, le=365),
                  ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """ΠΡΟΤΑΣΕΙΣ ξεχρέωσης — όχι αυτόματη πράξη.

    Το `strip` ΔΕΝ είναι μοναδικό (μετρημένο: 15% επαναλαμβάνονται), οπότε μια αυτόματη
    ξεχρέωση θα έσβηνε χρέος που υπάρχει. Ο φαρμακοποιός βλέπει ΓΙΑΤΙ ταιριάζει και αποφασίζει.
    """
    return {"items": await _repo(ctx).matches(days=days)}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_loan(body: LoanIn,
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    try:
        return await _repo(ctx).create(
            patient_name=body.patient_name, patient_ref=body.patient_ref, amka=body.amka,
            items=[i.model_dump() for i in body.items], note=body.note, by=ctx.user_id)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"error": str(e)}) from e


class StatusIn(BaseModel):
    status: str                      # cleared | written_off | open
    reason: str = ""
    execution_id: str | None = None


@router.post("/{loan_id}/status")
async def set_status(loan_id: str, body: StatusIn,
                     ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ξεχρέωση, διαγραφή χρέους, ή επαναφορά αν πατήθηκε κατά λάθος."""
    if body.status not in ("cleared", "written_off", "open"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"error": "bad_status"})
    if body.status == "written_off" and not body.reason.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"error": "reason_required",
                                    "message": "Γράψε γιατί διαγράφεται το χρέος."})
    n = await _repo(ctx).set_status(loan_id, body.status, by=ctx.user_id, reason=body.reason)
    if not n:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"error": "not_found"})
    return {"ok": True, "status": body.status}
