"""Per-pharmacy product catalog (OTC + parapharmacy) — the basis of the order/delivery circuit.
Gated by the `order_delivery` module; the pharmacist manages it manually or via XML import."""

from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel, Field

from app.core.deps import TenantContext, require
from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
from app.repositories.shop_campaigns import ShopCampaignRepository
from app.repositories.shop_promos import ShopBundleRepository, ShopCouponRepository

_MAX_XML = 25 * 1024 * 1024  # 25 MB cap on the uploaded catalog XML (no unbounded in-memory read)
_XML_CTYPES = {"application/xml", "text/xml", "application/octet-stream", ""}
_MAX_IMG = 8 * 1024 * 1024   # 8 MB cap on a product photo upload

router = APIRouter()
_MODULE = "order_delivery"      # opt-in module — ενεργοποιείται ανά φαρμακείο
_PERM = "portal:manage"


def _repo(ctx: TenantContext) -> PharmacyCatalogRepository:
    return PharmacyCatalogRepository(tenant_id=ctx.tenant_id)


@router.get("")
async def list_products(q: str = "", category: str | None = None, type: str | None = None,
                        tag: str | None = None, sort: str = "featured", in_stock: bool = False,
                        page: int = 1, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).list(q=q, category=category, ptype=type, tag=tag, sort=sort,
                                 in_stock_only=in_stock, page=page)


@router.get("/categories")
async def categories(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"categories": await _repo(ctx).categories(), "tags": await _repo(ctx).tags()}


@router.get("/taxonomy")
async def taxonomy(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ενιαία ταξινομία (3 κλάσεις + κατηγορίες) — κοινή για όλα τα φαρμακεία."""
    from app.services.catalog_taxonomy import TAXONOMY
    return TAXONOMY


@router.get("/registry")
async def registry(q: str = "", category: str | None = None, page: int = 1,
                   ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Μητρώο φαρμάκων ΗΔΥΚΑ (search/πλοήγηση ανά κατηγορία) — για ενεργοποίηση «προς πώληση»."""
    return await _repo(ctx).registry(q=q, category=category, page=page)


class ActivateIn(BaseModel):
    barcodes: list[str] | None = None
    category: str | None = None
    type: str = "rx_medicine"
    stock_qty: int = Field(0, ge=0)


@router.post("/activate")
async def activate(body: ActivateIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _repo(ctx).activate(barcodes=body.barcodes, category=body.category,
                                     ptype=body.type, stock_qty=body.stock_qty)


@router.post("/image")
async def upload_image(file: UploadFile = File(...),
                       ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ανέβασμα φωτογραφίας προϊόντος → resize + αποθήκευση στη shared DB. Επιστρέφει image_id."""
    if not (file.content_type or "").lower().startswith("image/"):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail={"error": "not_an_image"})
    raw = await file.read(_MAX_IMG + 1)
    if len(raw) > _MAX_IMG:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail={"error": "file_too_large"})
    image_id = await _repo(ctx).save_image(raw, file.content_type or "")
    if not image_id:
        return {"ok": False, "error": "bad_image"}
    return {"ok": True, "image_id": image_id, "url": f"/catalog/image/{image_id}"}


@router.get("/image/{image_id}")
async def get_image(image_id: str):
    """ΔΗΜΟΣΙΟ (χωρίς auth) — τα <img> των πελατών/φαρμακείου δεν στέλνουν token· opaque id, μη-PII."""
    res = await PharmacyCatalogRepository.get_image(image_id)
    if not res:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    data, ctype = res
    return Response(content=data, media_type=ctype,
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


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
    wholesale_cents: int = Field(0, ge=0)   # χονδρική — για την κερδοφορία
    type: str = "parapharmacy"          # rx_medicine | otc_medicine | parapharmacy
    category: str | None = None
    tags: list[str] = Field(default_factory=list)
    featured: bool = False
    image_id: str | None = None
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
    ctype = (file.content_type or "").split(";")[0].strip().lower()
    if ctype not in _XML_CTYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                            detail={"error": "unsupported_type", "content_type": ctype})
    content = await file.read(_MAX_XML + 1)   # read at most cap+1 → bounded memory
    if len(content) > _MAX_XML:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail={"error": "file_too_large", "max_bytes": _MAX_XML})
    return await _repo(ctx).import_xml(content, row_tag=row_tag, mapping=m, default_type=default_type)


# ── Εκπτωτικές καμπάνιες (έκπτωση σε ΟΜΑΔΑ ειδών: κατηγορίες ή/και ετικέτες) ──────────────
# ΚΑΝΟΝΑΣ: τα συνταγογραφούμενα ΔΕΝ παίρνουν ΠΟΤΕ έκπτωση καμπάνιας — επιβάλλεται
# server-side στη μηχανή τιμολόγησης (orders_delivery.create_order → campaign_pct_for).
class CampaignIn(BaseModel):
    id: str | None = None
    name: str = Field(..., min_length=1, max_length=120)
    discount_pct: int = Field(..., ge=1, le=90)
    categories: list[str] = []
    tags: list[str] = []
    active: bool = True
    starts_at: datetime | None = None
    ends_at: datetime | None = None


def _crepo(ctx: TenantContext) -> ShopCampaignRepository:
    return ShopCampaignRepository(tenant_id=ctx.tenant_id)


@router.get("/campaigns")
async def list_campaigns(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await _crepo(ctx).list()}


@router.post("/campaigns")
async def save_campaign(body: CampaignIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    data = body.model_dump()
    data["_id"] = data.pop("id", None)
    return await _crepo(ctx).upsert(data)


@router.delete("/campaigns/{campaign_id}")
async def delete_campaign(campaign_id: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _crepo(ctx).delete(campaign_id)


# ── Κουπόνια έκπτωσης ────────────────────────────────────────────────────────────────────
# Ισχύουν ΜΟΝΟ πάνω στην αξία των μη-συνταγογραφούμενων ειδών (server-side).
class CouponIn(BaseModel):
    id: str | None = None
    code: str = Field(..., min_length=3, max_length=32)
    kind: str = Field("pct", pattern="^(pct|amount)$")
    value: int = Field(..., ge=1)
    min_order_cents: int = Field(0, ge=0)
    max_uses: int = Field(0, ge=0)          # 0 = απεριόριστο
    expires_at: datetime | None = None
    active: bool = True


@router.get("/coupons")
async def list_coupons(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await ShopCouponRepository(tenant_id=ctx.tenant_id).list()}


@router.post("/coupons")
async def save_coupon(body: CouponIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    data = body.model_dump()
    data["_id"] = data.pop("id", None)
    return await ShopCouponRepository(tenant_id=ctx.tenant_id).upsert(data)


@router.delete("/coupons/{coupon_id}")
async def delete_coupon(coupon_id: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await ShopCouponRepository(tenant_id=ctx.tenant_id).delete(coupon_id)


# ── Πακέτα (bundles): «2+1» ή combo ──────────────────────────────────────────────────────
class BundleLineIn(BaseModel):
    barcode: str
    qty: int = Field(1, ge=1)


class BundleIn(BaseModel):
    id: str | None = None
    name: str = Field(..., min_length=1, max_length=120)
    kind: str = Field("combo", pattern="^(combo|nplusm)$")
    active: bool = True
    # nplusm
    barcode: str | None = None
    buy_qty: int = Field(2, ge=1)
    free_qty: int = Field(1, ge=1)
    # combo
    lines: list[BundleLineIn] = []
    discount_pct: int = Field(10, ge=1, le=90)


@router.get("/bundles")
async def list_bundles(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await ShopBundleRepository(tenant_id=ctx.tenant_id).list()}


@router.post("/bundles")
async def save_bundle(body: BundleIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    data = body.model_dump()
    data["_id"] = data.pop("id", None)
    return await ShopBundleRepository(tenant_id=ctx.tenant_id).upsert(data)


@router.delete("/bundles/{bundle_id}")
async def delete_bundle(bundle_id: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await ShopBundleRepository(tenant_id=ctx.tenant_id).delete(bundle_id)
