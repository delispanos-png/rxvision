"""Prescription Analytics router."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query

from fastapi import HTTPException, status

from app.core.deps import TenantContext, require
from app.repositories.prescriptions import PrescriptionRepository

router = APIRouter()


@router.get("/detail/{external_id}")
async def execution_detail(
    external_id: str,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    detail = await repo.execution_detail(external_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "execution_not_found")
    return detail


@router.get("/idika-print/{external_id}")
async def idika_printout(
    external_id: str,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """The official ΗΔΙΚΑ prescription form (PDF) for this execution, fetched live from
    ΗΔΙΚΑ (/api/v1/prescriptions/print/{barcode}?executionNo=N) and streamed back to the UI."""
    from fastapi import Response
    from app.api.v1.routers.ingestion import _effective_hdika_creds
    from app.services.ingestion.hdika_client import HdikaClient
    bc, _, execno = str(external_id).partition(":")
    creds = await _effective_hdika_creds(ctx.tenant_id)
    if not creds.get("base_url") or not creds.get("api_key"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "ΗΔΙΚΑ δεν είναι ρυθμισμένο.")
    client = HdikaClient(creds)
    try:
        params = {"executionNo": int(execno or 1)}
        if creds.get("pharmacy_id"):
            params["pharmacyId"] = creds["pharmacy_id"]
        r = client.get_pdf(f"/api/v1/prescriptions/print/{bc}", params)
    except Exception as exc:  # noqa: BLE001 — surface a clean error to the UI
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Αποτυχία λήψης εντύπου ΗΔΙΚΑ: {exc}")
    finally:
        client.close()
    if r.status_code != 200 or "pdf" not in (r.headers.get("content-type") or ""):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Το έντυπο ΗΔΙΚΑ δεν είναι διαθέσιμο.")
    return Response(content=r.content, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{bc}.pdf"'})


@router.get("/repeats/{external_id}")
async def prescription_repeats(
    external_id: str,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """The repeat tree — all executions of this prescription's barcode + next expected."""
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.repeats(external_id)


@router.get("/idika/{barcode}")
async def idika_full_detail(
    barcode: str,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """Live, portal-equivalent detail straight from the ΗΔΙΚΑ CDA (on-demand): issue/
    deadline dates, exemption/opinion/surcharge flags, per-line lot/prices/dosage."""
    from fastapi.concurrency import run_in_threadpool
    from app.api.v1.routers.ingestion import _effective_hdika_creds
    from app.services.ingestion.hdika_client import HdikaClient

    creds = await _effective_hdika_creds(ctx.tenant_id)
    if not creds:
        raise HTTPException(status.HTTP_409_CONFLICT, "no_idika_credentials")

    bc = barcode.split(":")[0]  # external_id is "barcode:executionNo" → ΗΔΙΚΑ wants the bare barcode
    def _fetch() -> dict:
        client = HdikaClient(creds)
        try:
            return client.fetch_cda_full(bc)
        finally:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass

    data = await run_in_threadpool(_fetch)
    if not data:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "idika_fetch_failed")
    return data


@router.get("")
async def list_prescriptions(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    fund_id: str | None = None,
    doctor_id: str | None = None,
    icd10: str | None = None,
    barcode: str | None = None,
    amka: str | None = None,
    patient: str | None = None,
    status: str | None = None,            # "executed" | "partial"
    characteristic: str | None = None,    # χαρακτηριστικό συνταγής (βλ. _CHARACTERISTICS)
    sort: str = "executed_at",
    dir: int = -1,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    query: dict = {"executed_at": {"$gte": date_from, "$lt": date_to}}
    if fund_id:
        query["fund_id"] = fund_id
    if doctor_id:
        query["doctor_id"] = doctor_id
    if icd10:
        query["icd10"] = icd10
    if barcode and barcode.strip():
        # search by prescription barcode (prefix match); ignore the date window so a
        # known barcode is found regardless of the selected period.
        query.pop("executed_at", None)
        query["external_id"] = {"$regex": "^" + re.escape(barcode.strip())}
    # ΑΜΚΑ ή/και όνομα ασθενή → περιορισμός σε ασθενείς που ταιριάζουν (αγνοεί την περίοδο)
    if (amka and amka.strip()) or (patient and patient.strip()):
        refs = await repo.find_patient_refs(amka=amka, name=patient)
        query.pop("executed_at", None)
        query["patient_ref"] = {"$in": refs}   # κενό → 0 αποτελέσματα (σωστό)
    # κατάσταση εκτέλεσης
    if status == "executed":
        query["has_unexecuted_substances"] = False
    elif status == "partial":
        query["has_unexecuted_substances"] = True
    # χαρακτηριστικό συνταγής (whitelist για ασφάλεια)
    if characteristic == "repeat":
        query["repeat_total"] = {"$gt": 1}
    elif characteristic in _CHARACTERISTICS:
        query[f"details.{characteristic}"] = True
    items = await repo.list_executions(query, skip=(page - 1) * page_size, limit=page_size,
                                       sort=sort, direction=dir)
    return {"page": page, "page_size": page_size, "items": items}


# Επιτρεπτά χαρακτηριστικά συνταγής για φιλτράρισμα (πεδία στο details, βλ. hdika_cda).
_CHARACTERISTICS = {"chronic", "narcotic", "antibiotic", "special_antibiotic", "high_cost",
                    "vaccines", "n3816", "ifet", "ifet_import", "heparin", "home_delivery",
                    "negative_list", "single_dose", "intangible"}


@router.get("/by-fund")
async def by_fund(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return {"items": await repo.by_fund(date_from, date_to)}


@router.get("/aggregate")
async def aggregate(
    group_by: Literal["fund", "doctor", "icd10", "product"] = "fund",
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    dim = {"fund": "doctors", "doctor": "doctors", "icd10": "icd10", "product": "products"}
    # reuse top() shape for fund/doctor/icd10/product groupings
    return await repo.top(dim=dim.get(group_by, "doctors"), limit=100,
                          date_from=date_from, date_to=date_to)


@router.get("/unexecuted")
async def unexecuted(
    limit: int = Query(50, ge=1, le=500),
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """Concept doc §9 — ανεκτέλεστες δραστικές: μη-εκτελεσμένες γραμμές + χαμένη αξία."""
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id)
    return await repo.unexecuted_substances(date_from=date_from, date_to=date_to, limit=limit)
