"""RxVision Connect — δίκτυα συνεργασίας φαρμακείων.

Κάθε endpoint δουλεύει ΓΙΑ ΤΟΝ ΣΥΝΔΕΔΕΜΕΝΟ tenant· το αποθετήριο δεν δέχεται ποτέ «για ποιον»
— η ταυτότητα έρχεται από το token, όχι από το σώμα του αιτήματος. Έτσι δεν υπάρχει διαδρομή
όπου ο πελάτης δηλώνει ποιανού τα δεδομένα θέλει.

ΔΙΚΑΙΩΜΑ: `portal:manage`, το ίδιο με τη συνομιλία φαρμακείων. ΓΙΑΤΙ ΟΧΙ ΝΕΟ `connect:manage`:
τα δικαιώματα των ρόλων ζουν στη ΒΑΣΗ κάθε φαρμακείου και δεν ενημερώνονται αναδρομικά — ένα
νέο κλειδί θα άφηνε όλους πλην του ιδιοκτήτη έξω από ένα πληρωμένο κύκλωμα, ακριβώς όπως
συνέβη με τη δοκιμή δυνατότητας (14 στα 15 φαρμακεία).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.connect import ConnectPolicyRepository, ConnectRepository

router = APIRouter()
_MODULE = "connect"
_PERM = "portal:manage"


def _repo(ctx: TenantContext) -> ConnectRepository:
    return ConnectRepository(tenant_id=ctx.tenant_id)


def _policy(ctx: TenantContext) -> ConnectPolicyRepository:
    return ConnectPolicyRepository(tenant_id=ctx.tenant_id)


# ── σχήματα ──────────────────────────────────────────────────────────────────────────────────
class GroupIn(BaseModel):
    name: str = ""


class InviteIn(BaseModel):
    group_id: str
    afm: str


class RespondIn(BaseModel):
    accept: bool


class RequestIn(BaseModel):
    barcode: str = ""
    name: str = ""
    qty: int = 1
    group_ids: list[str] = []
    urgency: str = "normal"
    notes: str = ""
    hours: int = 48


class OfferIn(BaseModel):
    qty: int = 1


class DeliverIn(BaseModel):
    doc_ref: str = ""
    batch: str = ""
    expiry: str = ""


class ReturnIn(BaseModel):
    qty: int = 1
    note: str = ""


class SettleIn(BaseModel):
    qty: int = 0
    amount_cents: int = 0
    note: str = ""


class DisputeIn(BaseModel):
    reason: str = "other"
    note: str = ""


class PolicyIn(BaseModel):
    global_pct: int | None = None
    safety_qty: int | None = None
    reservation_minutes: int | None = None
    auto_offer: bool | None = None
    require_doc_ref: bool | None = None
    per_group: dict[str, int] | None = None


# ── πίνακας & δίκτυα ─────────────────────────────────────────────────────────────────────────
@router.get("/dashboard")
async def dashboard(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).dashboard()


@router.get("/groups")
async def groups(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    repo = _repo(ctx)
    return {"groups": await repo.groups(), "invites": await repo.my_invites()}


@router.post("/groups")
async def create_group(body: GroupIn,
                       ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).create_group(body.name)


@router.delete("/groups/{group_id}")
async def delete_group(group_id: str,
                       ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).delete_group(group_id)


@router.post("/groups/{group_id}/leave")
async def leave_group(group_id: str,
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).leave(group_id)


@router.post("/invites")
async def invite(body: InviteIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).invite(body.group_id, body.afm)


@router.post("/invites/{invite_id}")
async def respond_invite(invite_id: str, body: RespondIn,
                         ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).respond(invite_id, body.accept)


# ── αιτήματα & προσφορές ─────────────────────────────────────────────────────────────────────
@router.get("/requests")
async def my_requests(limit: int = Query(60, ge=1, le=200),
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).my_requests(limit=limit)


@router.post("/requests")
async def create_request(body: RequestIn,
                         ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).create_request(
        barcode=body.barcode, name=body.name, qty=body.qty, group_ids=body.group_ids,
        urgency=body.urgency, notes=body.notes, hours=body.hours)


@router.delete("/requests/{request_id}")
async def cancel_request(request_id: str,
                         ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).cancel_request(request_id)


@router.get("/inbox")
async def inbox(limit: int = Query(60, ge=1, le=200),
                ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).inbox(limit=limit)


@router.post("/requests/{request_id}/offer")
async def make_offer(request_id: str, body: OfferIn,
                     ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).make_offer(request_id, body.qty)


@router.post("/requests/{request_id}/decline")
async def decline(request_id: str,
                  ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).decline_request(request_id)


@router.post("/offers/{offer_id}/withdraw")
async def withdraw(offer_id: str,
                   ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).withdraw_offer(offer_id)


@router.post("/offers/{offer_id}/accept")
async def accept_offer(offer_id: str,
                       ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).accept_offer(offer_id)


@router.post("/offers/{offer_id}/reject")
async def reject_offer(offer_id: str,
                       ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).reject_offer(offer_id)


# ── κινήσεις, υπόλοιπα, επιστροφές ───────────────────────────────────────────────────────────
@router.get("/movements")
async def movements(status: str | None = None, limit: int = Query(80, ge=1, le=200),
                    ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).movements(status=status, limit=limit)


@router.post("/movements/{movement_id}/deliver")
async def deliver(movement_id: str, body: DeliverIn,
                  ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).complete_movement(movement_id, doc_ref=body.doc_ref,
                                              batch=body.batch, expiry=body.expiry)


@router.post("/movements/{movement_id}/cancel")
async def cancel_movement(movement_id: str,
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).cancel_movement(movement_id)


@router.get("/balances")
async def balances(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).balances()


@router.post("/movements/{movement_id}/return")
async def request_return(movement_id: str, body: ReturnIn,
                         ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).request_return(movement_id, body.qty, body.note)


@router.post("/returns/{return_id}/respond")
async def respond_return(return_id: str, body: RespondIn,
                         ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).respond_return(return_id, body.accept)


@router.post("/returns/{return_id}/complete")
async def complete_return(return_id: str,
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).complete_return(return_id)


@router.post("/movements/{movement_id}/settle")
async def settle(movement_id: str, body: SettleIn,
                 ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).settle(movement_id, amount_cents=body.amount_cents,
                                   qty=body.qty, note=body.note)


@router.post("/movements/{movement_id}/dispute")
async def dispute(movement_id: str, body: DisputeIn,
                  ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).open_dispute(movement_id, body.reason, body.note)


@router.post("/disputes/{dispute_id}/resolve")
async def resolve_dispute(dispute_id: str, body: DisputeIn,
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).resolve_dispute(dispute_id, body.note)


# ── πολιτική διαθεσιμότητας ──────────────────────────────────────────────────────────────────
@router.get("/policy")
async def get_policy(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _policy(ctx).get()


@router.put("/policy")
async def save_policy(body: PolicyIn,
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _policy(ctx).save(body.model_dump(exclude_none=True))
