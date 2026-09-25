"""Δομές Φροντίδας — κύκλος ετοιμασίας & λογαριασμός.

ΞΕΧΩΡΙΣΤΟ ΠΡΟΣΘΕΤΟ από τις Οικογένειες, παρότι μοιράζονται τη συλλογή `patient_groups`. Κάθε
πληρωμένο πρόσθετο πρέπει να δουλεύει ΜΟΝΟ του: όποιος αγόρασε τις Δομές και όχι τις Οικογένειες
δεν πρέπει να πάρει 403 πουθενά.

«Δομή» ΔΕΝ σημαίνει κτίριο. Το `care_type` καλύπτει ΜΦΗ/γηροκομείο, ξενώνα ΑμεΑ, δομή ψυχικής
υγείας, θεραπευτική κοινότητα, παιδικό ίδρυμα, κατ' οίκον φροντίδα, ακόμη και ιδιώτη φροντιστή.
Η μηχανή είναι ίδια — δες `docs/patient-groups-design.md` §5γ.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.care_accounts import CareAccountRepository
from app.repositories.patient_groups import CARE, PatientGroupRepository

router = APIRouter()
_MODULE = "care_homes"
_PERM = "patients:read"          # ΕΝΑ δικαίωμα· νέο θα έδινε 403 σε όλους (deny-by-default)

CARE_TYPES = ["ΜΦΗ / Γηροκομείο", "Ξενώνας ΑμεΑ", "Δομή ψυχικής υγείας",
              "Θεραπευτική κοινότητα", "Δομή φιλοξενίας", "Παιδικό ίδρυμα",
              "Κατ' οίκον φροντίδα", "Ιδιώτης φροντιστής", "Άλλο"]


def _groups(ctx: TenantContext) -> PatientGroupRepository:
    return PatientGroupRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


def _acc(ctx: TenantContext) -> CareAccountRepository:
    return CareAccountRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


class GroupIn(BaseModel):
    name: str


class CareSettings(BaseModel):
    care_type: str | None = None
    cycle_days: int | None = None
    billing: dict | None = None
    charges_from: str | None = None      # YYYY-MM-DD — από πότε μετράνε οι χρεώσεις


class MemberIn(BaseModel):
    amka: str | None = None
    patient_id: str | None = None
    label: str | None = None
    role: str | None = None


class EntryIn(BaseModel):
    kind: str = "receipt"                # receipt | manual | adjustment
    amount_cents: int
    at: str | None = None                # YYYY-MM-DD
    note: str = ""


def _date(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s)[:10])
    except ValueError:
        return None


# ── δομές ─────────────────────────────────────────────────────────────────────────────
@router.get("")
async def list_structures(q: str | None = Query(None),
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await _groups(ctx).list_groups(kind=CARE, q=q), "care_types": CARE_TYPES}


@router.get("/portfolio")
async def portfolio(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Όλες οι δομές με το ανοιχτό υπόλοιπό τους — η οθόνη που ανοίγει πρώτη."""
    return await _acc(ctx).portfolio()


@router.get("/patients")
async def search_patients(q: str = Query(..., min_length=2),
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Δική της αναζήτηση: το `/patients/search` απαιτεί άλλο πρόσθετο."""
    from app.repositories.patients import PatientExecutionsRepository
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return {"items": await repo.search(q)}


@router.post("")
async def create_structure(body: GroupIn,
                           ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _groups(ctx).create(kind=CARE, name=body.name, by=ctx.user_id)


@router.get("/{gid}")
async def structure_detail(gid: str, months: int = Query(12, ge=1, le=60),
                           ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    now = datetime.now(tz=timezone.utc).replace(tzinfo=None)
    d = await _groups(ctx).detail(gid, date_from=now - timedelta(days=30 * months),
                                  date_to=now + timedelta(days=1))
    if not d:
        return {"error": "not_found"}
    d["balance"] = await _acc(ctx).balance(gid)
    return d


@router.patch("/{gid}")
async def rename_structure(gid: str, body: GroupIn,
                           ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _groups(ctx).rename(gid, body.name)


@router.patch("/{gid}/settings")
async def care_settings(gid: str, body: CareSettings,
                        ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    cycle = {"days": body.cycle_days} if body.cycle_days else None
    return await _groups(ctx).update_care(gid, care_type=body.care_type, cycle=cycle,
                                          billing=body.billing,
                                          charges_from=_date(body.charges_from))


@router.delete("/{gid}")
async def delete_structure(gid: str,
                           ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _groups(ctx).delete(gid)


# ── τρόφιμοι ──────────────────────────────────────────────────────────────────────────
@router.post("/{gid}/members")
async def add_member(gid: str, body: MemberIn,
                     ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _groups(ctx).add_member(gid, amka=body.amka, patient_id=body.patient_id,
                                         label=body.label, role=body.role)


@router.delete("/{gid}/members/{pseudo_id}")
async def remove_member(gid: str, pseudo_id: str,
                        ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _groups(ctx).remove_member(gid, pseudo_id)


# ── λογαριασμός ───────────────────────────────────────────────────────────────────────
@router.get("/{gid}/statement")
async def statement(gid: str, month: str | None = Query(None),
                    ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Εκκαθαριστικό μήνα: υπόλοιπο από προηγούμενο → χρεώσεις → εισπράξεις → νέο υπόλοιπο."""
    d = await _acc(ctx).statement(gid, month or "")
    return d or {"error": "not_found"}


@router.post("/{gid}/entries")
async def add_entry(gid: str, body: EntryIn,
                    ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Είσπραξη ή χειροκίνητη χρέωση. Τις ΣΥΜΜΕΤΟΧΕΣ δεν τις καταχωρεί κανείς — παράγονται."""
    return await _acc(ctx).add_entry(gid, kind=body.kind, amount_cents=body.amount_cents,
                                     at=_date(body.at), note=body.note, by=ctx.user_id)


@router.delete("/{gid}/entries/{eid}")
async def delete_entry(gid: str, eid: str,
                       ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _acc(ctx).delete_entry(gid, eid)


# ── κύκλος ετοιμασίας ─────────────────────────────────────────────────────────────────
@router.get("/{gid}/cycle")
async def cycle(gid: str, days: int = Query(30, ge=1, le=120),
                ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Τι ανοίγει, τι να παραγγείλεις, τι εκκρεμεί — για τον επόμενο κύκλο."""
    d = await _acc(ctx).cycle(gid, days=days)
    return d or {"error": "not_found"}
