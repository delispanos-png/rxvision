"""Ομάδες ασφαλισμένων — Φάση 1: ΟΙΚΟΓΕΝΕΙΕΣ.

Η ίδια συλλογή θα εξυπηρετήσει και τις ΔΟΜΕΣ ΦΡΟΝΤΙΔΑΣ (Φάση 2) με `kind="care"`: κύκλος
ετοιμασίας + καθολικό χρεώσεων/εισπράξεων. Γι' αυτό το `kind` είναι παράμετρος από την πρώτη
μέρα και το πρόσθετο ελέγχεται ανά είδος — δες `docs/patient-groups-design.md`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.patient_groups import FAMILY, PatientGroupRepository

router = APIRouter()
_MODULE = "family_groups"
_PERM = "patients:read"
# ΕΝΑ δικαίωμα για όλο το πρόσθετο, όπως στις Προχορηγήσεις. ΔΕΝ φτιάχνουμε «patients:write»:
# τα δικαιώματα είναι deny-by-default, οπότε ένα καινούργιο που δεν έχει σπαρθεί στους ρόλους
# θα έδινε 403 σε ΟΛΟΥΣ — και το 403 εμφανίζεται ως «με πετάει έξω», που δεν διαγιγνώσκεται εύκολα.
_WRITE = _PERM


def _repo(ctx: TenantContext) -> PatientGroupRepository:
    return PatientGroupRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


def _period(months: int) -> tuple[datetime, datetime]:
    now = datetime.now(tz=timezone.utc).replace(tzinfo=None)
    return now - timedelta(days=30 * max(1, months)), now + timedelta(days=1)


class GroupIn(BaseModel):
    name: str


class MemberIn(BaseModel):
    # Ένα από τα δύο: ΑΜΚΑ (για άτομο που μπορεί να ΜΗΝ έχει ακόμη δεδομένα) ή έτοιμο
    # ψευδώνυμο από την αναζήτηση. Το ΑΜΚΑ δεν αποθηκεύεται ποτέ — γίνεται ψευδώνυμο και χάνεται.
    amka: str | None = None
    pseudo_id: str | None = None
    patient_id: str | None = None      # από την αναζήτηση — δεν ταξιδεύει ΑΜΚΑ
    label: str | None = None
    role: str | None = None


class MemberPatch(BaseModel):
    label: str | None = None
    role: str | None = None


@router.get("")
async def list_groups(q: str | None = Query(None),
                      include_inactive: bool = Query(False),
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await _repo(ctx).list_groups(kind=FAMILY, q=q,
                                                  include_inactive=include_inactive)}


@router.get("/patients")
async def search_patients(q: str = Query(..., min_length=2),
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Αναζήτηση για προσθήκη μέλους.

    ΓΙΑΤΙ ΕΔΩ ΚΑΙ ΟΧΙ ΤΟ `/patients/search`: εκείνο απαιτεί το πρόσθετο «Ασφαλισμένοι». Όποιος
    αγόρασε ΜΟΝΟ τις Οικογένειες θα έπαιρνε 403 και το πεδίο δεν θα έβρισκε ποτέ κανέναν — το
    ίδιο λάθος είχε γίνει στις Προχορηγήσεις.
    """
    from app.repositories.patients import PatientExecutionsRepository
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return {"items": await repo.search(q)}


@router.post("")
async def create_group(body: GroupIn,
                       ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    return await _repo(ctx).create(kind=FAMILY, name=body.name, by=ctx.user_id)


@router.get("/{gid}")
async def group_detail(gid: str, months: int = Query(12, ge=1, le=60),
                       ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    df, dt = _period(months)
    d = await _repo(ctx).detail(gid, date_from=df, date_to=dt)
    return d or {"error": "not_found"}


@router.patch("/{gid}")
async def rename_group(gid: str, body: GroupIn,
                       ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    return await _repo(ctx).rename(gid, body.name)


@router.delete("/{gid}")
async def delete_group(gid: str,
                       ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    return await _repo(ctx).delete(gid)


@router.post("/{gid}/members")
async def add_member(gid: str, body: MemberIn,
                     ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    return await _repo(ctx).add_member(gid, amka=body.amka, pseudo_id=body.pseudo_id,
                                       patient_id=body.patient_id,
                                       label=body.label, role=body.role)


@router.patch("/{gid}/members/{pseudo_id}")
async def update_member(gid: str, pseudo_id: str, body: MemberPatch,
                        ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    return await _repo(ctx).update_member(gid, pseudo_id, label=body.label, role=body.role)


@router.delete("/{gid}/members/{pseudo_id}")
async def remove_member(gid: str, pseudo_id: str,
                        ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    return await _repo(ctx).remove_member(gid, pseudo_id)


@router.get("/for-patient/{patient_id}")
async def for_patient(patient_id: str,
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Σε ποιες ομάδες ανήκει — το καταναλώνει η Εικόνα Πελάτη."""
    return {"items": await _repo(ctx).groups_for_patient(patient_id)}
