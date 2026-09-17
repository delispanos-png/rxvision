"""Ανακοινώσεις — πλευρά πελάτη.

Δύο endpoints μόνο: «τι πρέπει να δω τώρα» και «να τι απάντησα». Καμία ειδική άδεια: αν μπορείς
να μπεις στην εφαρμογή, μπορείς να δεις την ανακοίνωση — αλλιώς θα την έβλεπε μόνο ο ιδιοκτήτης
του φαρμακείου, που συχνά δεν είναι αυτός που κάθεται στον υπολογιστή.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.db import shared_db
from app.core.deps import TenantContext, get_current_context
from app.services import announcements as svc

router = APIRouter()


@router.get("/next")
async def next_announcement(ctx: TenantContext = Depends(get_current_context)):
    """Η μία ανακοίνωση που πρέπει να δει τώρα αυτός ο χρήστης — ή `{item: null}`."""
    return {"item": await svc.next_for(ctx.tenant_id, ctx.user_id)}


class ActionIn(BaseModel):
    action: str                  # shown|dismissed|never|trial|demo|callback|info
    note: str | None = None      # προαιρετικό μήνυμα του πελάτη
    # «Να με καλέσει κάποιος» — η μικρή φόρμα επικοινωνίας
    callback_name: str | None = None
    callback_phone: str | None = None
    callback_when: str | None = None


@router.post("/{ann_id}/action")
async def act(ann_id: str, body: ActionIn, ctx: TenantContext = Depends(get_current_context)):
    from bson import ObjectId
    uid = ObjectId(ctx.user_id) if ObjectId.is_valid(ctx.user_id) else ctx.user_id
    user = await shared_db()["users"].find_one({"_id": uid, "tenant_id": ctx.tenant_id},
                                               {"full_name": 1, "email": 1}) or {}
    user["_form"] = {"callback_name": body.callback_name, "callback_phone": body.callback_phone,
                     "callback_when": body.callback_when}
    return await svc.record(ann_id, ctx.tenant_id, ctx.user_id, body.action,
                            note=body.note, user=user)
