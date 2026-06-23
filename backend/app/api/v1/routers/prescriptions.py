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


async def _flu_vaccination_rows(tenant_id: str, date_from, date_to, barcode, page, page_size):
    """Flu vaccinations mapped into the prescriptions-list row shape (separate `vaccinations` coll)."""
    from app.core.db import shared_db
    from app.repositories.base import jsonsafe
    db = shared_db()
    if barcode and barcode.strip():
        q = {"tenant_id": tenant_id, "source": "INFLUENZA", "barcode": barcode.strip()}
    else:
        q = {"tenant_id": tenant_id, "source": "INFLUENZA",
             "executed_at": {"$gte": date_from, "$lt": date_to}}
    rows = []
    async for v in (db["vaccinations"].find(q).sort("executed_at", -1)
                    .skip((page - 1) * page_size).limit(page_size)):
        rows.append({
            "external_id": v.get("barcode") or v.get("external_id"),
            "executed_at": v.get("executed_at"), "source": "INFLUENZA",
            "patient_name": v.get("patient_name"), "amka": v.get("amka"),
            "fund_name": v.get("vaccine_name") or "Εμβόλιο Γρίπης",     # vaccine shown in the fund column
            "fund_general": v.get("vaccine_name") or "Εμβόλιο Γρίπης",
            "status": "cancelled" if v.get("cancelled") else "executed",
            "has_unexecuted_substances": False,
            "amount_total": v.get("total_price") or v.get("payable") or 0,
            "amount_claimed": v.get("insurance_part") or 0,
            "patient_share": v.get("patient_part") or 0,
            "icd10": [v["icd10_code"]] if v.get("icd10_code") else [],
            "icd10_named": ([f"{v['icd10_code']} — {v['icd10_title']}"] if v.get("icd10_code") and v.get("icd10_title")
                            else ([v["icd10_code"]] if v.get("icd10_code") else [])),
            "details": {"vaccine": v.get("vaccine_name"), "age": v.get("patient_age_group"),
                        "risk": v.get("high_risk_group"), "lot": v.get("lot")},
        })
    return {"page": page, "page_size": page_size, "items": jsonsafe(rows)}


@router.get("/detail/{external_id}")
async def execution_detail(
    external_id: str,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    detail = await repo.execution_detail(external_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "execution_not_found")
    return detail


@router.get("/idika-print/{external_id}")
async def idika_printout(
    external_id: str,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """The official ΗΔΥΚΑ prescription form (PDF) for this execution, fetched live from
    ΗΔΥΚΑ (/api/v1/prescriptions/print/{barcode}?executionNo=N) and streamed back to the UI."""
    from fastapi import Response
    from app.api.v1.routers.ingestion import _effective_hdika_creds
    from app.services.ingestion.hdika_client import HdikaClient
    bc, _, execno = str(external_id).partition(":")
    creds = await _effective_hdika_creds(ctx.tenant_id)
    if not creds.get("base_url") or not creds.get("api_key"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "ΗΔΥΚΑ δεν είναι ρυθμισμένο.")
    client = HdikaClient(creds)
    try:
        params = {"executionNo": int(execno or 1)}
        if creds.get("pharmacy_id"):
            params["pharmacyId"] = creds["pharmacy_id"]
        r = client.get_pdf(f"/api/v1/prescriptions/print/{bc}", params)
    except Exception as exc:  # noqa: BLE001 — surface a clean error to the UI
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Αποτυχία λήψης εντύπου ΗΔΥΚΑ: {exc}")
    finally:
        client.close()
    if r.status_code != 200 or "pdf" not in (r.headers.get("content-type") or ""):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Το έντυπο ΗΔΥΚΑ δεν είναι διαθέσιμο.")
    return Response(content=r.content, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{bc}.pdf"'})


@router.get("/repeats/{external_id}")
async def prescription_repeats(
    external_id: str,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """The repeat tree — all executions of this prescription's barcode + next expected."""
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return await repo.repeats(external_id)


@router.get("/idika/{barcode}")
async def idika_full_detail(
    barcode: str,
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """Live, portal-equivalent detail straight from the ΗΔΥΚΑ CDA (on-demand): issue/
    deadline dates, exemption/opinion/surcharge flags, per-line lot/prices/dosage."""
    from fastapi.concurrency import run_in_threadpool
    from app.api.v1.routers.ingestion import _effective_hdika_creds
    from app.services.ingestion.hdika_client import HdikaClient

    creds = await _effective_hdika_creds(ctx.tenant_id)
    if not creds:
        raise HTTPException(status.HTTP_409_CONFLICT, "no_idika_credentials")

    bc = barcode.split(":")[0]  # external_id is "barcode:executionNo" → ΗΔΥΚΑ wants the bare barcode
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
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    # Special category: flu vaccinations live in the separate `vaccinations` collection — when the
    # «Εμβολιασμοί Γρίπης» characteristic is picked, return those mapped into the same list row shape.
    if "flu_vaccination" in {x.strip() for x in (characteristic or "").split(",")}:
        return await _flu_vaccination_rows(ctx.tenant_id, date_from, date_to, barcode, page, page_size)
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
    # χαρακτηριστικά συνταγής — πολλαπλά (comma-separated), συνδυάζονται με AND
    for tok in (characteristic or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        if tok == "repeat":
            query["repeat_total"] = {"$gt": 1}
        elif tok == "simple":
            query["repeat_total"] = {"$lte": 1}
        elif tok in ("3", "4", "5", "6"):
            query["repeat_total"] = int(tok)
        elif tok == "monthly":
            query["details.interval_months"] = 1
        elif tok == "bimonthly":
            query["details.interval_months"] = 2
        elif tok == "galenic":   # not an execution flag — filter by executions with a γαληνικό item
            query["_id"] = {"$in": await repo.galenic_exec_ids(date_from, date_to)}
        elif tok == "cancelled":  # show ONLY cancelled (ακυρωμένες) — they're hidden by default
            query["status"] = "cancelled"
        elif tok in _CHARACTERISTICS:
            query[f"details.{tok}"] = True
    # ακυρωμένες συνταγές εξαιρούνται από προεπιλογή (φαίνονται μόνο με το φίλτρο «cancelled»)
    if query.get("status") != "cancelled":
        query["status"] = {"$ne": "cancelled"}
    items = await repo.list_executions(query, skip=(page - 1) * page_size, limit=page_size,
                                       sort=sort, direction=dir)
    return {"page": page, "page_size": page_size, "items": items}


# Επιτρεπτά χαρακτηριστικά συνταγής για φιλτράρισμα (πεδία στο details, βλ. hdika_cda).
_CHARACTERISTICS = {"chronic", "narcotic", "antibiotic", "special_antibiotic", "high_cost",
                    "vaccines", "desensitization", "n3816", "ifet", "ifet_import", "heparin",
                    "home_delivery", "negative_list", "single_dose", "intangible", "by_brand",
                    "ekas", "eopyy_only", "hospital_only", "eopyy_preapproval", "outside_eopyy",
                    "consumables", "supplementary_cover"}


@router.get("/by-fund")
async def by_fund(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return {"items": await repo.by_fund(date_from, date_to)}


@router.get("/characteristics")
async def characteristics(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    """Πλήθος + αξία εκτελέσεων ανά χαρακτηριστικό συνταγής (για την ανάλυση «ανά είδος»)."""
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return await repo.characteristics_breakdown(date_from, date_to)


@router.get("/aggregate")
async def aggregate(
    group_by: Literal["fund", "doctor", "icd10", "product"] = "fund",
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("prescriptions:read", module="prescription_analytics")),
):
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
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
    repo = PrescriptionRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return await repo.unexecuted_substances(date_from=date_from, date_to=date_to, limit=limit)
