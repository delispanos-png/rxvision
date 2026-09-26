"""Εξουσιοδοτήσεις φροντίδας — πλευρά ΦΑΡΜΑΚΟΠΟΙΟΥ.

ΓΙΑΤΙ ΞΕΧΩΡΙΣΤΟΣ ROUTER: η εξουσιοδότηση ΔΕΝ εξαρτάται από τις Οικογένειες. Η βασική της χρήση
είναι ακριβώς ο ηλικιωμένος **χωρίς παιδιά** που εμπιστεύεται κάποιον. Αν την κλείδωνα πίσω από
το πρόσθετο «Οικογένειες», αυτή η περίπτωση δεν θα καλυπτόταν ποτέ.

Ελέγχεται με το πρόσθετο ΠΥΛΗ ΠΕΛΑΤΩΝ, γιατί χωρίς πύλη δεν έχει νόημα: η εξουσιοδότηση
υπάρχει για να μπορεί κάποιος να ΔΕΙ την καρτέλα από την πύλη.

Η γονική μέριμνα ΔΕΝ περνά από εδώ — είναι αυτόματη, από τον ρόλο «Γονέας» στην οικογένεια και
την ηλικία του παιδιού. Δες `services/portal_access.py`.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.services import portal_access

router = APIRouter()
_MODULE = "patient_portal"
_PERM = "patients:read"


class GrantIn(BaseModel):
    grantor_patient_id: str          # ΠΟΙΟΣ δίνει πρόσβαση στην καρτέλα του
    grantee_patient_id: str          # ΠΟΙΟΝ εξουσιοδοτεί
    note: str = ""


@router.get("")
async def list_all(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Όλες οι ενεργές εξουσιοδοτήσεις — η λίστα που ανοίγει πρώτη."""
    return {"items": await portal_access.list_all(ctx.tenant_id, demo=ctx.demo)}


@router.get("/for-patient/{patient_id}")
async def for_patient(patient_id: str,
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Και οι δύο κατευθύνσεις: ποιους βλέπει — και ποιος βλέπει αυτόν."""
    return await portal_access.list_for_patient(ctx.tenant_id, patient_id, demo=ctx.demo)


@router.get("/viewable/{patient_id}")
async def viewable(patient_id: str,
                   ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Τι ΑΚΡΙΒΩΣ θα δει αυτός ο άνθρωπος αν μπει στην πύλη — γονική μέριμνα + εξουσιοδοτήσεις.

    Υπάρχει για να μπορεί ο φαρμακοποιός να απαντήσει στο «γιατί βλέπω/δεν βλέπω τον Χ;» χωρίς
    να μαντεύει.
    """
    return {"items": await portal_access.viewable_in_tenant(ctx.tenant_id, patient_id,
                                                            demo=ctx.demo)}


@router.post("/grant")
async def grant(body: GrantIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Καταγραφή εξουσιοδότησης. Ο εξουσιοδοτών πρέπει να είναι ΕΝΗΛΙΚΟΣ και ΕΝ ΖΩΗ."""
    from app.services.portal_access import _pseudo_of
    gr = await _pseudo_of(ctx.tenant_id, body.grantor_patient_id)
    ge = await _pseudo_of(ctx.tenant_id, body.grantee_patient_id)
    if not gr or not ge:
        return {"ok": False, "error": "no_patient"}
    return await portal_access.grant(ctx.tenant_id, grantor_pseudo=gr, grantee_pseudo=ge,
                                     by=ctx.user_id, note=body.note)


@router.delete("/{auth_id}")
async def revoke(auth_id: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await portal_access.revoke(ctx.tenant_id, auth_id, by=ctx.user_id)


@router.get("/patients")
async def search_patients(q: str = Query(..., min_length=2),
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Δική της αναζήτηση — το `/patients/search` απαιτεί άλλο πρόσθετο."""
    from app.repositories.patients import PatientExecutionsRepository
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return {"items": await repo.search(q)}
