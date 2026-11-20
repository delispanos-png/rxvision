"""RxVision Κύπρος — endpoints του κυπριακού φαρμακείου.

ΟΛΑ περνούν από `require_cy`: 404 για ελληνικό φαρμακείο ή όταν ο διακόπτης είναι κλειστός.
"""

from __future__ import annotations

import re
from datetime import date

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field

from app.core.db import shared_db

from app.repositories.base import jsonsafe
from app.core.deps import TenantContext
from app.repositories.cy import CyPatientRepository
from app.services.cy import analytics, chains, insights
from app.services.cy.gate import require_cy
from app.services.cy.masking import CyMaskedRoute, has_mask
from app.services.cy.importer import MAX_TOTAL_BYTES, CyImportError, import_files

router = APIRouter(route_class=CyMaskedRoute)   # παρουσίαση → απόκρυψη προσώπων σε ΚΑΘΕ απάντηση


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
    p = await CyPatientRepository(tenant_id=ctx.tenant_id).find_one({"pseudo_id": ref}) or {}
    c = p.get("contact") or {}
    card["contact"] = {"mobile": c.get("mobile"), "email": c.get("email"),
                       "marketing_consent": bool(c.get("marketing_consent")),
                       "consent_at": c.get("consent_at"), "unsubscribed": bool(c.get("unsubscribed_at")),
                       "source": c.get("source"), "updated_at": c.get("updated_at")}
    card["loyalty"] = await _loyalty_of(ctx, ref)
    # Προχορηγήσεις: το «χρωστά σκευάσματα» βρίσκει τον φαρμακοποιό εκεί που ήδη κοιτάζει
    from app.core.deps import _module_locked
    if not _module_locked(ctx, "advance_dispensing"):
        from app.services.cy import loans
        card["loans"] = [{"id": ln["id"], "created_at": ln["created_at"], "age_days": ln["age_days"],
                          "items": [i["name"] for i in ln["items"] if i.get("status") == "open"]}
                         for ln in await loans.listing(ctx.tenant_id, status="open", patient_ref=ref)]
    return card


async def _loyalty_of(ctx: TenantContext, ref: str) -> dict | None:
    """Πιστότητα του πελάτη (ίδιο πρόγραμμα με την Ελλάδα). None όταν το πρόσθετο δεν είναι ενεργό."""
    from app.repositories.loyalty import LoyaltyRepository
    from app.repositories.patient_portal import PatientAccountRepository
    from app.services.auth_service import resolve_tenant_modules, tenant_has
    if not tenant_has(await resolve_tenant_modules(ctx.tenant_id), "loyalty"):
        return None
    shell = await PatientAccountRepository().cy_shell_id(ctx.tenant_id, ref)
    if not shell:
        return {"enrolled": False}
    repo = LoyaltyRepository(tenant_id=ctx.tenant_id)
    if not await repo.is_enrolled(str(shell)):
        return {"enrolled": False}
    m = await repo.member(str(shell)) or {}
    return {"enrolled": True, "points": m.get("points", 0), "balance_cents": m.get("balance_cents", 0),
            "tier": m.get("tier"), "patient_ref": str(shell)}


class LoyaltyIn(BaseModel):
    enroll: bool = True


@router.post("/patients/{ref}/loyalty")
async def patient_loyalty(ref: str, body: LoyaltyIn, ctx: TenantContext = Depends(require_cy)):
    """Εγγραφή/διαγραφή πελάτη ΓεΣΥ στην πιστότητα από την Καρτέλα πελάτη."""
    from app.repositories.loyalty import LoyaltyRepository
    from app.repositories.patient_portal import PatientAccountRepository
    from app.services.auth_service import resolve_tenant_modules, tenant_has
    _perm(ctx, "portal:manage")
    if not tenant_has(await resolve_tenant_modules(ctx.tenant_id), "loyalty"):
        raise HTTPException(status.HTTP_409_CONFLICT, "loyalty_not_enabled")
    p = await CyPatientRepository(tenant_id=ctx.tenant_id).find_one({"pseudo_id": ref})
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    accounts = PatientAccountRepository()
    repo = LoyaltyRepository(tenant_id=ctx.tenant_id)
    if body.enroll:
        shell = await accounts.cy_shell(ctx.tenant_id, ref, p.get("full_name"))
        await repo.enroll(str(shell), method="in_store", name=p.get("full_name"))
    else:
        shell = await accounts.cy_shell_id(ctx.tenant_id, ref)
        if shell:
            await repo.unenroll(str(shell))
    return {"ok": True, "loyalty": await _loyalty_of(ctx, ref)}


class ContactIn(BaseModel):
    mobile: str | None = Field(None, max_length=30)
    email: str | None = Field(None, max_length=200)
    marketing_consent: bool | None = None


@router.put("/patients/{ref}/contact")
async def put_contact(ref: str, body: ContactIn, ctx: TenantContext = Depends(require_cy)):
    """Στοιχεία επικοινωνίας που γράφει ο φαρμακοποιός (το XML ΓεΣΥ δεν τα έχει).
    Η συγκατάθεση δίνεται ρητά, με το τικ, αφού τη ζητήσει από τον πελάτη."""
    from app.services.cy import contacts as cy_contacts
    _perm(ctx, "patients:read")
    # Οθόνη παρουσίασης: τα πεδία έρχονται ως «****» — ΠΟΤΕ δεν γράφονται πάνω στα πραγματικά.
    data = {k: v for k, v in body.model_dump(exclude_unset=True).items() if not has_mask(v)}
    try:
        c = await cy_contacts.set_contact(ctx.tenant_id, ref, data,
                                          source="pharmacist")
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return {"ok": True}


class DeceasedIn(BaseModel):
    deceased: bool


@router.put("/patients/{ref}/deceased")
async def put_deceased(ref: str, body: DeceasedIn, ctx: TenantContext = Depends(require_cy)):
    """Ο φαρμακοποιός σημειώνει ότι ο πελάτης απεβίωσε (ή το αναιρεί). Το ΓεΣΥ δεν το δίνει — το
    σύστημα ΠΟΤΕ δεν το συμπεραίνει μόνο του. Από εκεί και πέρα: εκτός μηνυμάτων, χαμένων, Συμβούλου,
    παραγγελίας και αναλύσεων (`chains.deceased_refs` — ένας ορισμός)."""
    from datetime import datetime, timezone

    from app.repositories.cy import CyPatientRepository
    _perm(ctx, "patients:read")
    repo = CyPatientRepository(tenant_id=ctx.tenant_id)
    if not await repo.find_one({"pseudo_id": ref}):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    upd = ({"$set": {"deceased": {"at": datetime.now(timezone.utc), "by": getattr(ctx, "email", None) or ctx.user_id}}}
           if body.deceased else {"$unset": {"deceased": ""}})
    await repo.update_one({"pseudo_id": ref}, upd)
    return {"ok": True, "deceased": body.deceased}


def _perm(ctx: TenantContext, perm: str) -> None:
    if perm not in ctx.permissions and "*" not in ctx.permissions:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "insufficient_permissions")


class PortalInviteIn(BaseModel):
    doc_type: str = Field("NID", pattern="^(NID|ARC)$")
    doc_number: str = Field(..., min_length=3, max_length=20)
    email: str = Field(..., min_length=5, max_length=200)
    phone: str | None = Field(None, max_length=30)


@router.post("/patients/{ref}/shell")
async def patient_shell(ref: str, ctx: TenantContext = Depends(require_cy)):
    """Η «κάρτα γέφυρας» του πελάτη ΓεΣΥ (ίδια με της πύλης), για τα κοινά κυκλώματα που κλειδώνουν
    με καρτέλα: πρόγραμμα λήψης, συνέπεια, μετρήσεις, διατροφή. Δημιουργείται μία φορά· κανένα ΑΜΚΑ."""
    from app.repositories.patient_portal import PatientAccountRepository
    p = await CyPatientRepository(tenant_id=ctx.tenant_id).find_one({"pseudo_id": ref})
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    sid = await PatientAccountRepository().cy_shell(ctx.tenant_id, ref, p.get("full_name"))
    return {"id": str(sid)}


@router.post("/patients/{ref}/portal-invite")
async def portal_invite(ref: str, body: PortalInviteIn, ctx: TenantContext = Depends(require_cy)):
    """Πρόσκληση πελάτη ΓεΣΥ στην πύλη. Ο φαρμακοποιός γράφει την ταυτότητα/ARC που βλέπει μπροστά του·
    πρέπει να ταιριάζει με αυτή του XML (σύγκριση ψευδωνύμων — η ταυτότητα δεν αποθηκεύεται)."""
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
    res = await PatientAuthService().cy_invite(
        tenant_id=ctx.tenant_id, cy_pseudo=ref, first_name=first, last_name=last,
        email=body.email, phone=body.phone, pharmacy_name=name)
    if res.get("ok"):   # ό,τι έδωσε ο πελάτης για την πύλη γίνεται και στοιχείο της καρτέλας του (χωρίς συγκατάθεση)
        from app.services.cy import contacts as cy_contacts
        from app.services.cy.contacts import norm_mobile
        data = {"email": body.email, **({"mobile": body.phone} if norm_mobile(body.phone) else {})}
        try:
            await cy_contacts.set_contact(ctx.tenant_id, ref, data, source="pharmacist")
        except ValueError:
            pass
    return res


@router.get("/not-dispensed")
async def not_dispensed(ctx: TenantContext = Depends(require_cy)):
    """Είδη που δεν δόθηκαν (QtyDisp 0): στη μέση της συνταγής ή στην τελευταία φάση."""
    return await insights.not_dispensed(ctx.tenant_id)


@router.get("/pc2")
async def pc2(days: int = 90, ctx: TenantContext = Depends(require_cy)):
    """Διαφορά τιμής (PC2) ανά σκεύασμα και ανά πελάτη."""
    return await insights.pc2(ctx.tenant_id, days=max(7, min(days, 730)))


@router.get("/claim")
async def hio_claim(month: str | None = Query(None, pattern=r"^\d{4}-\d{2}$"),
                    ctx: TenantContext = Depends(require_cy)):
    """Μηνιαία απαίτηση προς τον ΟΑΥ (για έλεγχο της πληρωμής) — χωρίς στοιχεία πελατών."""
    return await insights.hio_claim(ctx.tenant_id, month=month)


# ── Εκκαθάριση ΟΑΥ: τα αρχεία πληρωμής που λαμβάνει ο φαρμακοποιός (services/cy/settlement.py) ──

_SETTLE_PERM = "profitability:read"     # οικονομικά στοιχεία φαρμακείου — όπως ο «Σύμβουλός σου»


@router.post("/settlement/import")
async def settlement_import(files: list[UploadFile] = File(...), ctx: TenantContext = Depends(require_cy)):
    """PDF «Αμοιβή Φαρμακοποιού», PDF «Κατάσταση πληρωμής», Excel «Πληρωμένες απαιτήσεις» /
    «Εγκεκριμένο» / «Μερικώς εκτελεσμένη». Αναγνώριση από το περιεχόμενο· ξανά-ανέβασμα = αντικατάσταση."""
    from app.services.cy import settlement
    _perm(ctx, _SETTLE_PERM)
    if len(files) > 12:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "too_many_files")
    payload: list[tuple[str, bytes]] = []
    for f in files:
        data = await f.read(settlement.MAX_FILE_BYTES + 1)
        if len(data) > settlement.MAX_FILE_BYTES:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "too_large")
        payload.append((f.filename or "file", data))
    return await settlement.import_files(ctx.tenant_id, payload, by=getattr(ctx, "email", None) or ctx.user_id)


@router.get("/settlement")
async def settlement_months(ctx: TenantContext = Depends(require_cy)):
    from app.services.cy import settlement
    _perm(ctx, _SETTLE_PERM)
    return {"items": await settlement.months(ctx.tenant_id)}


@router.get("/settlement/{month}")
async def settlement_detail(month: str, ctx: TenantContext = Depends(require_cy)):
    from app.services.cy import settlement
    _perm(ctx, _SETTLE_PERM)
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_month")
    d = await settlement.detail(ctx.tenant_id, month)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return jsonsafe(d)


@router.delete("/settlement/{month}")
async def settlement_delete(month: str, ctx: TenantContext = Depends(require_cy)):
    from app.services.cy import settlement
    _perm(ctx, _SETTLE_PERM)
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_month")
    return {"ok": await settlement.delete_month(ctx.tenant_id, month)}


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


@router.get("/profitability")
async def profitability(date_from: date | None = None, date_to: date | None = None,
                        ctx: TenantContext = Depends(require_cy)):
    """Κέρδος ανά σκεύασμα: έσοδα χωρίς ΦΠΑ − χονδρική της Αποθήκης. Χωρίς χονδρική → όχι στο κέρδος.
    Ίδιο πρόσθετο ΚΑΙ ίδιο δικαίωμα με την Ελλάδα (`profitability` / `profitability:read`)."""
    _addon(ctx, "profitability")
    _perm(ctx, _SETTLE_PERM)
    return await analytics.profitability(ctx.tenant_id, date_from, date_to)


@router.get("/reorder")
async def reorder(horizon: int = 14, ctx: TenantContext = Depends(require_cy)):
    """Πρόταση παραγγελίας: ανοιχτές συνταγές του διαστήματος + ό,τι έλειψε − απόθεμα αποθήκης."""
    return await insights.reorder(ctx.tenant_id, horizon=max(3, min(horizon, 60)))


@router.get("/pharmacyone")
async def pharmacyone_status(ctx: TenantContext = Depends(require_cy)):
    """Αυτόματη λήψη από την PharmacyOne: ενεργή; πότε έτρεξε; (ΠΟΤΕ το Client Id — το ορίζει ο
    διαχειριστής RxVision από το adminpanel)."""
    from app.services.cy import pharmacyone as p1
    st = await p1.state(ctx.tenant_id)
    return jsonsafe({"configured": bool(p1.client_id(ctx.tenant_id)), "enabled": bool(st.get("enabled")),
                     "last_ok_at": st.get("last_ok_at"), "last_run_at": st.get("last_run_at"),
                     "last_result": {k: (st.get("last_result") or {}).get(k)
                                     for k in ("ok", "fetched", "imported", "updated", "error")}})


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


# ── Καμπάνιες (ίδια μηχανή αποστολής με την Ελλάδα, κυπριακό κοινό) ──────────

class CyCouponIn(BaseModel):
    discount_type: str = Field("pct", pattern="^(pct|fixed)$")
    discount_value: int = Field(..., ge=1, le=100000)   # pct: 1-100 · fixed: λεπτά
    valid_days: int = Field(30, ge=1, le=365)
    max_redemptions: int = Field(0, ge=0, le=100000)


class CyCampaignIn(BaseModel):
    channel: str = Field(..., pattern="^(sms|viber|email|push)$")
    segment: str = "all"
    purpose: str = Field("commercial", pattern="^(commercial|care)$")
    subject: str | None = Field(None, max_length=150)
    message: str = Field(..., min_length=3, max_length=1000)
    coupon: CyCouponIn | None = None     # {coupon} στο κείμενο γίνεται ο κωδικός — ΜΟΝΟ σε εμπορικό μήνυμα


@router.get("/campaigns/segments")
async def campaign_segments(ctx: TenantContext = Depends(require_cy)):
    from app.services.cy.contacts import SEGMENTS
    return {"items": [{"key": k, "label": v[0], "label_en": v[1], "clinical": v[2]} for k, v in SEGMENTS.items()]}


@router.get("/campaigns/audience")
async def campaign_audience(channel: str, segment: str = "all", ctx: TenantContext = Depends(require_cy)):
    """Πόσοι θα το λάβουν και πόσοι εξαιρούνται, και γιατί, ΠΡΙΝ την αποστολή."""
    from app.services.cy import contacts as cy_contacts
    _perm(ctx, "portal:manage")
    try:
        a = await cy_contacts.audience(ctx.tenant_id, channel, segment)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    return {k: v for k, v in a.items() if k != "recipients"} | {
        "recipients": len(a["recipients"]), "sample": [r.get("name") for r in a["recipients"][:5]]}


@router.post("/campaigns", status_code=202)
async def campaign_send(body: CyCampaignIn, ctx: TenantContext = Depends(require_cy)):
    """Βάζει την καμπάνια στην ουρά (ίδιος worker, χρέωση και ιδιοπάθεια με την Ελλάδα).
    Κοινό με δεδομένα υγείας (συνταγές, αναλώσιμα) → μόνο μήνυμα φροντίδας."""
    from app.services import campaign_engine
    from app.services.cy.contacts import SEGMENTS, clinical
    from app.workers.comms import dispatch_campaign
    _perm(ctx, "portal:manage")
    if body.segment not in SEGMENTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unknown_segment")
    if clinical(body.segment) and body.purpose != "care":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "clinical_segment_requires_care_purpose")
    if body.channel == "email" and not (body.subject or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "subject_required")
    coupon_code = None
    if body.coupon:
        # ίδιος φρουρός με την Ελλάδα: μήνυμα φροντίδας / κλινικό κοινό ΔΕΝ κουβαλά προσφορά
        if body.purpose == "care" or clinical(body.segment):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "care_message_cannot_carry_offer")
        if body.coupon.discount_type == "pct" and body.coupon.discount_value > 100:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_discount")
        from bson import ObjectId

        from app.services import marketing
        cp = await marketing.create_coupon(
            ctx.tenant_id, campaign_id=str(ObjectId()), discount_type=body.coupon.discount_type,
            discount_value=body.coupon.discount_value, valid_days=body.coupon.valid_days,
            max_redemptions=body.coupon.max_redemptions)
        coupon_code = cp["code"]
    res = await campaign_engine.create(
        ctx.tenant_id, channel=body.channel, message=body.message, subject=body.subject,
        segment=body.segment, value=None, purpose=body.purpose, coupon_code=coupon_code,
        by=getattr(ctx, "email", None) or ctx.user_id)
    res["coupon_code"] = coupon_code
    if res["recipients"]:
        dispatch_campaign.delay(res["campaign_id"])
    return {**res, "queued": True}


@router.get("/campaigns")
async def campaign_history(ctx: TenantContext = Depends(require_cy)):
    _perm(ctx, "portal:manage")
    rows = await shared_db()["comms_campaigns"].find(  # tenant-ok: tenant_id στο φίλτρο
        {"tenant_id": ctx.tenant_id}, {"message": 1, "channel": 1, "segment": 1, "status": 1, "subject": 1,
                                       "recipients": 1, "sent": 1, "failed": 1, "created_at": 1, "purpose": 1}
    ).sort("created_at", -1).limit(50).to_list(length=50)
    return {"items": [{**{k: v for k, v in r.items() if k != "_id"}, "id": str(r["_id"])} for r in rows]}


# ── Προχορηγήσεις (δανεικά) Κύπρου ──────────────────────────────────────────

def _addon(ctx: TenantContext, module: str) -> None:
    from app.core.deps import _module_locked
    if _module_locked(ctx, module):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail={"error": "module_locked", "module": module})


class LoanItemIn(BaseModel):
    gtin: str | None = Field(None, max_length=20)
    name: str | None = Field(None, max_length=200)
    qty: int = Field(1, ge=1, le=20)
    lot: str | None = Field(None, max_length=40)
    expiry: str | None = Field(None, max_length=12)


class LoanIn(BaseModel):
    patient_ref: str = Field(..., min_length=8, max_length=100)
    items: list[LoanItemIn] = Field(..., min_length=1, max_length=30)
    note: str = Field("", max_length=300)


class ScanIn(BaseModel):
    raw: str = Field(..., min_length=1, max_length=300)


class LoanItemStatusIn(BaseModel):
    cleared: bool
    dispensing_id: str | None = Field(None, max_length=80)


@router.post("/loans/scan")
async def loan_scan(body: ScanIn, ctx: TenantContext = Depends(require_cy)):
    from app.services.cy import loans
    _perm(ctx, "patients:read")
    _addon(ctx, "advance_dispensing")
    return await loans.scan(ctx.tenant_id, body.raw)


@router.post("/loans", status_code=201)
async def loan_create(body: LoanIn, ctx: TenantContext = Depends(require_cy)):
    from app.services.cy import loans
    _perm(ctx, "patients:read")
    _addon(ctx, "advance_dispensing")
    try:
        return await loans.create(ctx.tenant_id, patient_ref=body.patient_ref,
                                  items=[i.model_dump() for i in body.items], note=body.note,
                                  by=getattr(ctx, "email", None) or ctx.user_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None


@router.get("/loans")
async def loan_list(state: str = "open", patient_ref: str | None = None, ctx: TenantContext = Depends(require_cy)):
    from app.services.cy import loans
    _perm(ctx, "patients:read")
    _addon(ctx, "advance_dispensing")
    st = state if state in ("open", "closed", "cancelled", "all") else "open"
    return {"items": await loans.listing(ctx.tenant_id, status=st, patient_ref=patient_ref)}


@router.get("/loans/suggestions")
async def loan_suggestions(ctx: TenantContext = Depends(require_cy)):
    """Εκτελέσεις ΓεΣΥ που φαίνεται να καλύπτουν ανοιχτά δανεικά. ΠΡΟΤΑΣΗ: η ξεχρέωση θέλει «ναι»."""
    from app.services.cy import loans
    _perm(ctx, "patients:read")
    _addon(ctx, "advance_dispensing")
    return {"items": await loans.suggestions(ctx.tenant_id)}


@router.post("/loans/{loan_id}/items/{idx}")
async def loan_item(loan_id: str, idx: int, body: LoanItemStatusIn, ctx: TenantContext = Depends(require_cy)):
    from app.services.cy import loans
    _perm(ctx, "patients:read")
    _addon(ctx, "advance_dispensing")
    try:
        return await loans.set_item(ctx.tenant_id, loan_id, idx, cleared=body.cleared,
                                    dispensing_id=body.dispensing_id, by=getattr(ctx, "email", None) or ctx.user_id)
    except LookupError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found") from None
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None


@router.delete("/loans/{loan_id}")
async def loan_cancel(loan_id: str, ctx: TenantContext = Depends(require_cy)):
    from app.services.cy import loans
    _perm(ctx, "patients:read")
    _addon(ctx, "advance_dispensing")
    try:
        return await loans.cancel(ctx.tenant_id, loan_id, by=getattr(ctx, "email", None) or ctx.user_id)
    except LookupError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found") from None
