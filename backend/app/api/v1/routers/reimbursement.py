"""Reimbursement Intelligence router — executive dashboard, monthly closing, claim forecast,
risk engine, expected cuts (digital ΕΟΠΥΥ auditor). Optical/OCR audit lives in a sibling module."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.reimbursement import ReimbursementRepository
from app.repositories.scans import ScanRepository

router = APIRouter()
_MODULE = "monthly_closing"

# Scan upload hardening: cap size + restrict to real image/PDF types. The bytes are later
# opened by Pillow in the OCR worker (which sets MAX_IMAGE_PIXELS to guard decompression bombs).
_MAX_SCAN = 15 * 1024 * 1024  # 15 MB
_ALLOWED_SCAN_TYPES = {
    "image/jpeg", "image/jpg", "image/png", "image/webp",
    "image/heic", "image/heif", "image/tiff", "image/bmp", "application/pdf",
}
# What we'll actually serve back as (never trust the client-stored content-type → no stored-XSS).
_SERVE_TYPE = {
    "image/jpg": "image/jpeg", "image/jpeg": "image/jpeg", "image/png": "image/png",
    "image/webp": "image/webp", "image/heic": "image/heic", "image/heif": "image/heif",
    "image/tiff": "image/tiff", "image/bmp": "image/bmp", "application/pdf": "application/pdf",
}


class StatusIn(BaseModel):
    batch_id: str
    status: str


class ManualInvoiceIn(BaseModel):
    label: str                    # π.χ. «Αναλώσιμα e-dapy»
    amount: int                   # cents
    note: str | None = None


class ManualDeleteIn(BaseModel):
    batch_id: str


class PaymentIn(BaseModel):
    batch_id: str
    paid_amount: int  # cents


class BarcodeIn(BaseModel):
    barcode: str


class PaymentIn(BaseModel):
    period: str        # YYYY-MM
    fund: str          # fund group name
    amount: int        # cents received in this installment (δόση)
    note: str | None = None


class SettleIn(BaseModel):
    period: str
    fund: str
    settled: bool = True


class RemovePaymentIn(BaseModel):
    period: str
    fund: str
    index: int


def _repo(ctx: TenantContext) -> ReimbursementRepository:
    return ReimbursementRepository(tenant_id=ctx.tenant_id)


def _cur() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m")


@router.get("/executive")
async def executive(period: str | None = Query(None, description="YYYY-MM"),
                    ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).executive(period)


@router.get("/closing")
async def closing(period: str = Query(None),
                  ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).monthly_closing(period or _cur())


@router.get("/forecast")
async def forecast(ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).forecast()


@router.get("/risk")
async def risk(period: str = Query(None),
               ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).risk(period or _cur())


@router.get("/cuts")
async def cuts(period: str = Query(None),
               ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).expected_cuts(period or _cur())


@router.get("/submission")
async def submission(period: str = Query(None),
                     ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).submission(period or _cur())


@router.post("/submission/status")
async def set_status(body: StatusIn, period: str = Query(None),
                     ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).set_status(period or _cur(), body.batch_id, body.status)


@router.post("/submission/payment")
async def set_payment(body: PaymentIn, period: str = Query(None),
                      ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).set_payment(period or _cur(), body.batch_id, body.paid_amount)


@router.post("/submission/manual")
async def add_manual_invoice(body: ManualInvoiceIn, period: str = Query(None),
                             ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).add_manual_invoice(period or _cur(), body.label, body.amount, body.note)


@router.post("/submission/manual/delete")
async def delete_manual_invoice(body: ManualDeleteIn,
                                ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).delete_manual_invoice(body.batch_id)


@router.get("/reconciliation")
async def reconciliation(period: str = Query(None),
                         ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).reconciliation(period or _cur())


# ── Open balances / receivables (cross-month: what funds still owe) ─────────
@router.get("/receivables")
async def receivables(months: int = Query(12, ge=0, le=120),  # 0 = όλο το ιστορικό
                      ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).receivables(months)


@router.post("/receivables/payment")
async def add_receivable_payment(body: PaymentIn,
                                 ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).add_payment(body.period, body.fund, body.amount, body.note)


@router.post("/receivables/settle")
async def settle_receivable(body: SettleIn,
                            ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).settle(body.period, body.fund, body.settled)


@router.post("/receivables/payment/remove")
async def remove_receivable_payment(body: RemovePaymentIn,
                                    ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).remove_payment(body.period, body.fund, body.index)


# ── Daily reconciliation (amounts + execution counts per day) ───────────────
@router.get("/daily")
async def daily(period: str = Query(None), group: str = Query("all"),
                ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).daily_reconciliation(period or _cur(), group=group)


@router.get("/prescription")
async def prescription(barcode: str = Query(...),
                       ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    # explicit open → live CDA lookup for the prescription-level γνωμάτευση (cached after first time)
    return await _repo(ctx).prescription_detail(barcode, live=True)


# ── Physical barcode check (digital vs physical) ────────────────────────────
@router.get("/physical")
async def physical(period: str = Query(None), day: str = Query(None), group: str = Query("all"),
                   ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).physical_check(period or _cur(), day, group=group)


@router.post("/physical/scan")
async def physical_scan(body: BarcodeIn, period: str = Query(None), day: str = Query(None),
                        ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).physical_scan(period or _cur(), body.barcode, day=day)


@router.post("/physical/reset")
async def physical_reset(period: str = Query(None), day: str = Query(None),
                         ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).physical_reset(period or _cur(), day=day)


@router.post("/physical/visual")
async def physical_visual(body: BarcodeIn, period: str = Query(None), undo: bool = Query(False),
                          ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).physical_visual(period or _cur(), body.barcode, undo=undo)


@router.get("/settings")
async def reimb_settings(ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).closing_prefs()


class ClosingPrefsIn(BaseModel):
    closing_mode: str | None = None
    list_open: bool | None = None


@router.post("/settings")
async def set_reimb_settings(body: ClosingPrefsIn,
                             ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await _repo(ctx).set_closing_prefs(body.closing_mode, body.list_open)


# ── Optical Audit (OCR scans) ───────────────────────────────────────────────
@router.get("/prescriptor/status")
async def prescriptor_status(ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    """Is the AI prescription reader (Prescriptor) configured & enabled for this pharmacy?
    The UI uses this to show the AI verdict panels and adjust the privacy notice. Requires the
    ai_assistant module (Pro) AND a configured Anthropic key."""
    from app.services import prescriptor_service
    st = await prescriptor_service.status()
    st["entitled"] = ctx.modules.get("ai_assistant", "locked") != "locked"
    st["enabled"] = bool(st.get("enabled") and st["entitled"])
    return st


@router.post("/scans")
async def upload_scan(file: UploadFile = File(...), doc_type: str = Form("prescription"),
                      ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    ctype = (file.content_type or "").split(";")[0].strip().lower()
    if ctype not in _ALLOWED_SCAN_TYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                            detail={"error": "unsupported_type", "content_type": ctype})
    content = await file.read(_MAX_SCAN + 1)  # read at most cap+1 → no unbounded memory
    if len(content) > _MAX_SCAN:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail={"error": "file_too_large", "max_bytes": _MAX_SCAN})
    repo = ScanRepository(tenant_id=ctx.tenant_id)
    scan_id = await repo.create(filename=file.filename or "scan.jpg", content=content,
                                content_type=ctype, doc_type=doc_type)
    from app.workers.optical import process_scan
    process_scan.delay(ctx.tenant_id, scan_id)
    return {"scan_id": scan_id, "status": "processing"}


@router.get("/scans")
async def scan_queue(ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return {"items": await ScanRepository(tenant_id=ctx.tenant_id).queue()}


class ScanReviewIn(BaseModel):
    ok: bool


@router.post("/scans/{scan_id}/review")
async def scan_review(scan_id: str, body: ScanReviewIn,
                      ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    return await ScanRepository(tenant_id=ctx.tenant_id).set_review(scan_id, body.ok)


@router.get("/scans/{scan_id}/image")
async def scan_image(scan_id: str,
                     ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    content, ctype = await ScanRepository(tenant_id=ctx.tenant_id).image(scan_id)
    if content is None:
        return Response(status_code=404)
    # Serve only a server-allowlisted type + nosniff so a mislabelled upload can't be
    # sniffed/executed as HTML/script from our origin (stored-XSS guard).
    safe = _SERVE_TYPE.get((ctype or "").lower(), "application/octet-stream")
    return Response(content=content, media_type=safe,
                    headers={"X-Content-Type-Options": "nosniff",
                             "Content-Disposition": "inline"})


@router.delete("/scans/{scan_id}")
async def delete_scan(scan_id: str,
                      ctx: TenantContext = Depends(require("closing:read", module=_MODULE))):
    ok = await ScanRepository(tenant_id=ctx.tenant_id).delete(scan_id)
    return {"ok": ok}
