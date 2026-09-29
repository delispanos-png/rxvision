"""Κερδοφορία — ένα repository, ένας ορισμός κέρδους για όλα τα πάνελ."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Query

from app.core.deps import TenantContext, require
from app.repositories.profitability import ProfitabilityRepository

router = APIRouter()

_MODULE = "profitability"


def _repo(ctx: TenantContext) -> ProfitabilityRepository:
    return ProfitabilityRepository(tenant_id=ctx.tenant_id)


@router.get("/summary")
async def summary(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("profitability:read", module=_MODULE)),
):
    return await _repo(ctx).range_summary(date_from=date_from, date_to=date_to)


@router.get("/attention")
async def attention(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("profitability:read", module=_MODULE)),
):
    """Χάρτης προσοχής: ενότητες που πιέζουν / βοηθούν / είναι αδιάφορες, σε 4 διαστάσεις,
    με σύγκριση με την ίδια περίοδο πέρσι (52 εβδομάδες πίσω)."""
    return await _repo(ctx).attention(date_from=date_from, date_to=date_to)


@router.get("/by")
async def by_dimension(
    # `type` = κανονικό / ναρκωτικό / γαληνικό. Το παλιό όνομα `category` μπερδευόταν με τη
    # ΘΕΡΑΠΕΥΤΙΚΗ κατηγορία του διπλανού πάνελ — ίδια λέξη, άλλο πράγμα. Κρατιέται ως συνώνυμο.
    dim: Literal["fund", "doctor", "icd10", "product", "type", "category"] = "fund",
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("profitability:read", module=_MODULE)),
):
    d = "type" if dim == "category" else dim
    rows = await _repo(ctx).by_dimension(date_from=date_from, date_to=date_to, dim=d)
    return {"dim": d, "rows": rows}


@router.get("/by-category")
async def by_category(
    date_from: datetime = Query(...),
    date_to: datetime = Query(...),
    ctx: TenantContext = Depends(require("profitability:read", module=_MODULE)),
):
    """Κέρδος ανά θεραπευτική κατηγορία (ATC), για την περίοδο."""
    return {"rows": await _repo(ctx).by_medicine_category(date_from=date_from, date_to=date_to)}


@router.get("/low-margin")
async def low_margin(
    threshold_pct: float = 10.0,
    limit: int = 50,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    ctx: TenantContext = Depends(require("profitability:read", module=_MODULE)),
):
    """Χωρίς περίοδο → τελευταίες 90 ημέρες."""
    return {"threshold_pct": threshold_pct,
            "items": await _repo(ctx).low_margin(threshold_pct=threshold_pct, limit=min(limit, 200),
                                                 date_from=date_from, date_to=date_to)}


@router.get("/aging")
async def aging(
    ctx: TenantContext = Depends(require("profitability:read", module=_MODULE)),
):
    """ΑΝΟΙΧΤΑ υπόλοιπα ταμείων ανά ηλικία — όσα δεν έχουν σημειωθεί ως εισπραγμένα."""
    return await _repo(ctx).open_receivables(now=datetime.now(tz=timezone.utc))
