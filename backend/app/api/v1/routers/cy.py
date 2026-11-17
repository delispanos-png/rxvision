"""RxVision Κύπρος — endpoints του κυπριακού φαρμακείου.

ΟΛΑ περνούν από `require_cy`: 404 για ελληνικό φαρμακείο ή όταν ο διακόπτης είναι κλειστός.
"""

from __future__ import annotations

import re
from datetime import date

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from app.core.db import shared_db

from app.core.deps import TenantContext
from app.services.cy import analytics, chains, insights
from app.services.cy.gate import require_cy
from app.services.cy.importer import MAX_TOTAL_BYTES, CyImportError, import_files

router = APIRouter()


@router.get("/overview")
async def overview(ctx: TenantContext = Depends(require_cy)):
    return await chains.overview(ctx.tenant_id)


@router.get("/open-prescriptions")
async def open_prescriptions(status: str | None = None, ctx: TenantContext = Depends(require_cy)):
    """Ανοιχτές συνταγές & αναμενόμενες επισκέψεις (status: soon | upcoming | late | lost)."""
    if status and status not in chains.STATUS_ORDER:
        raise HTTPException(status_code=400, detail="bad_status")
    return await chains.open_prescriptions(ctx.tenant_id, status=status)


@router.get("/lost-customers")
async def lost_customers(ctx: TenantContext = Depends(require_cy)):
    """Πελάτες που χάθηκαν (δεν ξαναήρθαν) ή «διαρρέουν» (έρχονται, αλλά μια συνταγή εκτελείται αλλού)."""
    return await chains.lost_customers(ctx.tenant_id)


@router.get("/patients/{ref}")
async def patient_card(ref: str, ctx: TenantContext = Depends(require_cy)):
    """Καρτέλα πελάτη: ανοιχτές/χαμένες συνταγές, ιστορικό, γιατροί, απαλλαγή, διαβήτης."""
    card = await insights.patient_card(ctx.tenant_id, ref)
    if card is None:
        raise HTTPException(status_code=404, detail="not_found")
    from app.repositories.patient_portal import PatientAccountRepository
    acc = await PatientAccountRepository().cy_account_for(ctx.tenant_id, ref)
    card["portal"] = {"invited": bool(acc),
                      "email": ((acc or {}).get("email") or "")[:2] + "…" if acc else None}
    return card


class PortalInviteIn(BaseModel):
    doc_type: str = Field("NID", pattern="^(NID|ARC)$")
    doc_number: str = Field(..., min_length=3, max_length=20)
    email: str = Field(..., min_length=5, max_length=200)
    phone: str | None = Field(None, max_length=30)


@router.post("/patients/{ref}/portal-invite")
async def portal_invite(ref: str, body: PortalInviteIn, ctx: TenantContext = Depends(require_cy)):
    """Πρόσκληση πελάτη ΓεΣΥ στην πύλη. Ο φαρμακοποιός γράφει την ταυτότητα/ARC που βλέπει μπροστά του·
    πρέπει να ταιριάζει με αυτή του XML (σύγκριση ψευδωνύμων — η ταυτότητα δεν αποθηκεύεται)."""
    from app.repositories.cy import CyPatientRepository
    from app.services.auth_service import resolve_tenant_modules, tenant_has
    from app.services.cy.parser import patient_key
    from app.services.patient_auth_service import PatientAuthService
    from app.services.vault_service import vault
    from app.utils.anonymization import pseudonymize
    if "portal:manage" not in ctx.permissions and "*" not in ctx.permissions:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "insufficient_permissions")
    if not tenant_has(await resolve_tenant_modules(ctx.tenant_id), "patient_portal"):
        raise HTTPException(status.HTTP_409_CONFLICT, "portal_not_enabled")
    p = await CyPatientRepository(tenant_id=ctx.tenant_id).find_one({"pseudo_id": ref})
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    if not p.get("id_ref"):
        return {"ok": False, "error": "no_id_on_file"}
    given = pseudonymize(patient_key("", body.doc_type, re.sub(r"\s", "", body.doc_number)),
                         tenant_pepper=vault.tenant_pepper(ctx.tenant_id))
    if given != p["id_ref"]:
        return {"ok": False, "error": "id_mismatch"}
    parts = (p.get("full_name") or "").split(" ", 1)
    first, last = (parts[0], parts[1]) if len(parts) == 2 else (p.get("full_name") or "", "")
    t = await shared_db()["tenants"].find_one({"_id": ctx.tenant_id}, {"name": 1, "company": 1}) or {}
    name = (t.get("company") or {}).get("name") or t.get("name")
    return await PatientAuthService().cy_invite(
        tenant_id=ctx.tenant_id, cy_pseudo=ref, first_name=first, last_name=last,
        email=body.email, phone=body.phone, pharmacy_name=name)


@router.get("/not-dispensed")
async def not_dispensed(ctx: TenantContext = Depends(require_cy)):
    """Είδη που δεν δόθηκαν (QtyDisp 0): στη μέση της συνταγής ή στην τελευταία φάση."""
    return await insights.not_dispensed(ctx.tenant_id)


@router.get("/pc2")
async def pc2(days: int = 90, ctx: TenantContext = Depends(require_cy)):
    """Διαφορά τιμής (PC2) ανά σκεύασμα και ανά πελάτη."""
    return await insights.pc2(ctx.tenant_id, days=max(7, min(days, 730)))


@router.get("/doctors")
async def doctors(days: int = 365, date_from: date | None = None, date_to: date | None = None,
                  ctx: TenantContext = Depends(require_cy)):
    """Γιατροί που συνταγογραφούν στους πελάτες του φαρμακείου (αξία, πελάτες, συχνότερα είδη)."""
    return await insights.doctors(ctx.tenant_id, days=max(30, min(days, 1095)),
                                  date_from=date_from, date_to=date_to)


@router.get("/doctors/{doctor_id}")
async def doctor_card(doctor_id: str, ctx: TenantContext = Depends(require_cy)):
    """Καρτέλα γιατρού: τάση 12 μηνών, πελάτες, συχνότερα σκευάσματα, ανοιχτές/χαμένες συνταγές."""
    d = await analytics.doctor(ctx.tenant_id, doctor_id[:40])
    if d is None:
        raise HTTPException(status_code=404, detail="not_found")
    return d


# ── Dashboard (ίδιες κάρτες/γραφήματα με το ελληνικό) ───────────────────────

@router.get("/dashboard/summary")
async def dash_summary(date_from: date, date_to: date, ctx: TenantContext = Depends(require_cy)):
    return await analytics.summary(ctx.tenant_id, date_from, date_to)


@router.get("/dashboard/timeseries")
async def dash_timeseries(date_from: date, date_to: date, metric: str = "value", grain: str = "day",
                          ctx: TenantContext = Depends(require_cy)):
    if metric not in analytics.METRICS or grain not in ("day", "month"):
        raise HTTPException(status_code=400, detail="bad_metric")
    if (date_to - date_from).days > 1100:
        raise HTTPException(status_code=400, detail="range_too_long")
    return await analytics.timeseries(ctx.tenant_id, date_from, date_to, metric=metric, grain=grain)


@router.get("/dashboard/heatmap")
async def dash_heatmap(date_from: date, date_to: date, ctx: TenantContext = Depends(require_cy)):
    return await analytics.heatmap(ctx.tenant_id, date_from, date_to)


@router.get("/dashboard/top")
async def dash_top(date_from: date, date_to: date, dim: str = "doctors", limit: int = 6,
                   ctx: TenantContext = Depends(require_cy)):
    if dim not in ("doctors", "products"):
        raise HTTPException(status_code=400, detail="bad_dim")
    return await analytics.top(ctx.tenant_id, date_from, date_to, dim=dim, limit=max(1, min(limit, 50)))


@router.get("/staff")
async def staff(days: int = 90, ctx: TenantContext = Depends(require_cy)):
    """Εκτελέσεις ανά χρήστη της πύλης ΓεΣΥ."""
    return await insights.staff(ctx.tenant_id, days=max(7, min(days, 730)))


@router.get("/consumables")
async def consumables(ctx: TenantContext = Depends(require_cy)):
    """Αναλώσιμα ανά είδος + πελάτες (διαβητικοί από ταινίες/σκαρφιστήρες) με την κατάσταση τους."""
    return await insights.consumables(ctx.tenant_id)


@router.get("/recall")
async def recall(lot: str, gtin: str | None = None, ctx: TenantContext = Depends(require_cy)):
    """Ανάκληση παρτίδας: ποιοι πελάτες πήραν την παρτίδα (EMVS: παρτίδα + προαιρετικά GTIN)."""
    return await insights.recall(ctx.tenant_id, lot=lot[:40], gtin=(gtin or None) and gtin[:20])


@router.get("/dispensings")
async def dispensings(date_from: date | None = None, date_to: date | None = None, q: str | None = None,
                      doctor_id: str | None = None, kind: str | None = None, patient_ref: str | None = None,
                      sort: str = "dispensed_at", dir: int = -1, page: int = 1, page_size: int = 50,
                      ctx: TenantContext = Depends(require_cy)):
    """Λίστα εκτελέσεων (όπως οι «Συνταγές»): φίλτρα περιόδου, αναζήτηση, γιατρός, τύπος."""
    return await analytics.dispensings(
        ctx.tenant_id, date_from=date_from, date_to=date_to, q=(q or "")[:80] or None,
        doctor_id=doctor_id, kind=kind, patient_ref=patient_ref, sort=sort, direction=dir,
        page=page, page_size=page_size)


@router.get("/dispensings/{dispensing_id}")
async def dispensing_detail(dispensing_id: str, ctx: TenantContext = Depends(require_cy)):
    d = await analytics.dispensing(ctx.tenant_id, dispensing_id[:80])
    if d is None:
        raise HTTPException(status_code=404, detail="not_found")
    return d


@router.get("/patients")
async def patients_list(date_from: date | None = None, date_to: date | None = None, q: str | None = None,
                        sort: str = "value", limit: int = 300, ctx: TenantContext = Depends(require_cy)):
    """Λίστα πελατών (όπως οι «Ασφαλισμένοι»): εκτελέσεις, αξία, τελευταία επίσκεψη, κατάσταση."""
    return await analytics.patients(ctx.tenant_id, date_from=date_from, date_to=date_to,
                                    q=(q or "")[:80] or None, sort=sort, limit=limit)


@router.post("/import")
async def import_xml(files: list[UploadFile] = File(...), ctx: TenantContext = Depends(require_cy)):
    """Ανέβασμα XML εκτελέσεων ΓεΣΥ (ένα ή πολλά, ή ZIP). Τα διπλά αγνοούνται."""
    payload: list[tuple[str, bytes]] = []
    total = 0
    for f in files:
        data = await f.read(MAX_TOTAL_BYTES + 1)
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "too_large")
        payload.append((f.filename or "file.xml", data))
    try:
        return await import_files(ctx.tenant_id, payload)
    except CyImportError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
