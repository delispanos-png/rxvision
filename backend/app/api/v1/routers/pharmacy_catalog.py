"""Per-pharmacy product catalog (OTC + parapharmacy) — the basis of the order/delivery circuit.
Gated by the `order_delivery` module; the pharmacist manages it manually or via XML import."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from pydantic import BaseModel, Field

from app.core.deps import TenantContext, require
from app.repositories.pharmacy_catalog import PharmacyCatalogRepository

router = APIRouter()
_MODULE = "order_delivery"      # opt-in module — ενεργοποιείται ανά φαρμακείο
_PERM = "portal:manage"


def _repo(ctx: TenantContext) -> PharmacyCatalogRepository:
    return PharmacyCatalogRepository(tenant_id=ctx.tenant_id)


@router.get("")
async def list_products(q: str = "", category: str | None = None, type: str | None = None,
                        in_stock: bool = False, page: int = 1,
                        ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).list(q=q, category=category, ptype=type, in_stock_only=in_stock, page=page)


@router.get("/categories")
async def categories(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"categories": await _repo(ctx).categories()}


@router.get("/prefill")
async def prefill(barcode: str = Query(...),
                  ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).prefill(barcode)


class ProductIn(BaseModel):
    barcode: str
    name: str
    description_short: str | None = None
    description_long: str | None = None
    photo_url: str | None = None
    price_cents: int = Field(0, ge=0)
    type: str = "parapharmacy"          # otc_medicine | parapharmacy
    category: str | None = None
    discount_pct: int = Field(0, ge=0, le=90)
    stock_qty: int = Field(0, ge=0)
    active: bool = True


@router.post("")
async def upsert_product(body: ProductIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).upsert(body.model_dump())


@router.delete("/{barcode}")
async def delete_product(barcode: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).delete(barcode)


@router.post("/import-xml")
async def import_xml(file: UploadFile = File(...), row_tag: str = Form(...),
                     mapping: str = Form(...), default_type: str = Form("parapharmacy"),
                     ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Upload the commercial program's XML + a field mapping (JSON) → upsert products by barcode."""
    try:
        m = json.loads(mapping)
    except json.JSONDecodeError:
        return {"ok": False, "error": "bad_mapping_json"}
    content = await file.read()
    return await _repo(ctx).import_xml(content, row_tag=row_tag, mapping=m, default_type=default_type)
