"""Προωθητικές ενέργειες: `admin_router` (στήσιμο από το adminpanel) και `router` (ο κωδικός
σύστασης του φαρμακείου μέσα στην εφαρμογή). Κανόνες: services/promotions.py."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field

from app.core.deps import PlatformContext, TenantContext, get_current_context, get_platform_admin
from app.services import promotions as svc

router = APIRouter()
admin_router = APIRouter()

APP_REGISTER_URL = "https://app.rxvision.gr/register"


class EffectIn(BaseModel):
    type: Literal["discount_pct", "discount_amount", "free_module", "addon_discount"]
    value: int | None = Field(None, ge=0, le=10_000_000)
    months: int | None = Field(None, ge=0, le=36)
    referral_only: bool = False
    on: Literal["package", "total"] = "package"
    module: str | None = Field(None, max_length=60)
    days: int | None = Field(None, ge=0, le=1095)
    to: Literal["buyer", "referrer", "both"] = "buyer"


class LockIn(BaseModel):
    kind: Literal["none", "years", "until", "months"] = "none"   # months: μόνο ειδική προσφορά (τίθεται από τον server)
    years: int | None = Field(None, ge=0, le=10)
    months: int | None = Field(None, ge=0, le=36)
    until_on: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class PromotionIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    public_text: str = Field("", max_length=240)
    active: bool = False
    starts_on: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    ends_on: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    packages: list[str] = Field(default_factory=list, max_length=20)
    cycles: list[Literal["monthly", "yearly"]] = Field(default_factory=list)
    customer: Literal["new", "returning", "any"] = "any"
    code: str | None = Field(None, max_length=24)
    requires_referral: bool = False
    exclusive: bool = False
    max_redemptions: int | None = Field(None, ge=1, le=100000)
    effects: list[EffectIn] = Field(min_length=1, max_length=10)
    lock: LockIn = Field(default_factory=LockIn)
    show_on_site: bool = False
    audience: Literal["all", "afm_list"] = "all"
    offer_months: int | None = Field(None, ge=0, le=36)
    payer: Literal["pharmacy", "sponsor", "split"] = "pharmacy"
    sponsor_id: str | None = Field(None, max_length=40)
    sponsor_pct: int | None = Field(None, ge=0, le=100)


class SponsorIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    afm: str = Field(min_length=8, max_length=12)
    doy: str = Field("", max_length=80)
    address: str = Field("", max_length=160)
    city: str = Field("", max_length=80)
    postal_code: str = Field("", max_length=10)
    email: str = Field("", max_length=160)
    phone: str = Field("", max_length=40)
    contact: str = Field("", max_length=120)
    country: Literal["GR", "CY"] = "GR"
    active: bool = True
    notes: str = Field("", max_length=1000)


class AfmsIn(BaseModel):
    afms: str = Field(min_length=1, max_length=200_000)   # επικόλληση: ΑΦΜ (+ email) ανά γραμμή, ή με κόμμα


class InviteIn(BaseModel):
    resend: bool = False                                   # ξανά και σε όσους έχουν ήδη λάβει
    afms: list[str] | None = Field(None, max_length=5000)  # μόνο αυτά (π.χ. ένα ΑΦΜ)


class PreviewIn(BaseModel):
    package_code: str = Field(max_length=40)
    billing_cycle: Literal["monthly", "yearly"] = "monthly"
    returning: bool = False
    with_referral: bool = False
    promo_code: str | None = Field(None, max_length=24)
    on_date: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    listed_afm: bool = False          # «ΑΦΜ της λίστας»: δείχνει και τις ειδικές προσφορές


def _err(exc: svc.PromotionError) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"error": str(exc)})


@admin_router.get("/promotions")
async def list_promotions(_: PlatformContext = Depends(get_platform_admin)):
    from app.core.db import shared_db
    db = shared_db()
    return jsonable_encoder({
        "items": await svc.list_all(),
        "packages": [{"id": p["_id"], "name": p.get("name"), "price_monthly": p.get("price_monthly"),
                      "price_yearly": p.get("price_yearly")}
                     async for p in db["packages"].find({"trial_days": {"$in": [0, None]}}, {"name": 1, "price_monthly": 1, "price_yearly": 1})],
        "modules": [{"id": a["_id"], "name": a.get("name")} async for a in db["addons"].find({}, {"name": 1})],
        "sponsors": [{"id": s["_id"], "name": s.get("name")}
                     async for s in db["sponsors"].find({"active": {"$ne": False}}, {"name": 1}).sort("name", 1)],
    })


@admin_router.post("/promotions", status_code=201)
async def create_promotion(body: PromotionIn, ctx: PlatformContext = Depends(get_platform_admin)):
    try:
        return jsonable_encoder(await svc.save(body.model_dump(), by=ctx.email))
    except svc.PromotionError as exc:
        raise _err(exc)


@admin_router.put("/promotions/{pid}")
async def update_promotion(pid: str, body: PromotionIn, ctx: PlatformContext = Depends(get_platform_admin)):
    try:
        return jsonable_encoder(await svc.save(body.model_dump(), by=ctx.email, pid=pid))
    except svc.PromotionError as exc:
        raise _err(exc)


@admin_router.delete("/promotions/{pid}")
async def delete_promotion(pid: str, _: PlatformContext = Depends(get_platform_admin)):
    return await svc.delete(pid)


@admin_router.get("/promotions/{pid}/redemptions")
async def promotion_redemptions(pid: str, _: PlatformContext = Depends(get_platform_admin)):
    return {"items": jsonable_encoder(await svc.redemptions(pid))}


@admin_router.get("/promotions/{pid}/afms")
async def special_afms(pid: str, _: PlatformContext = Depends(get_platform_admin)):
    """Η λίστα ΑΦΜ μιας ειδικής προσφοράς: ποιος την πήρε και ποιος όχι ακόμη."""
    return {"items": jsonable_encoder(await svc.list_special_afms(pid))}


@admin_router.post("/promotions/{pid}/afms")
async def add_special_afms(pid: str, body: AfmsIn, ctx: PlatformContext = Depends(get_platform_admin)):
    try:
        return await svc.add_special_afms(pid, body.afms, by=ctx.email)
    except svc.PromotionError as exc:
        raise _err(exc)


@admin_router.post("/promotions/{pid}/invite")
async def invite_special_afms(pid: str, body: InviteIn, _: PlatformContext = Depends(get_platform_admin)):
    """Email πρόσκλησης στα ΑΦΜ της λίστας που δεν έχουν πάρει ακόμη την προσφορά."""
    try:
        return await svc.send_invitations(pid, resend=body.resend, only=body.afms)
    except svc.PromotionError as exc:
        raise _err(exc)


@admin_router.delete("/promotions/{pid}/afms/{afm}")
async def remove_special_afm(pid: str, afm: str, _: PlatformContext = Depends(get_platform_admin)):
    try:
        return await svc.remove_special_afm(pid, afm)
    except svc.PromotionError as exc:
        raise _err(exc)


# ── Χορηγοί (Φάση 3) ─────────────────────────────────────────────────────────────────────
def _sp_err(exc) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"error": str(exc)})


@admin_router.get("/sponsors")
async def list_sponsors(_: PlatformContext = Depends(get_platform_admin)):
    from app.services import sponsors
    return {"items": jsonable_encoder(await sponsors.list_all())}


@admin_router.post("/sponsors", status_code=201)
async def create_sponsor(body: SponsorIn, ctx: PlatformContext = Depends(get_platform_admin)):
    from app.services import sponsors
    try:
        return jsonable_encoder(await sponsors.save(body.model_dump(), by=ctx.email))
    except sponsors.SponsorError as exc:
        raise _sp_err(exc)


@admin_router.put("/sponsors/{sid}")
async def update_sponsor(sid: str, body: SponsorIn, ctx: PlatformContext = Depends(get_platform_admin)):
    from app.services import sponsors
    try:
        return jsonable_encoder(await sponsors.save(body.model_dump(), by=ctx.email, sid=sid))
    except sponsors.SponsorError as exc:
        raise _sp_err(exc)


@admin_router.delete("/sponsors/{sid}")
async def delete_sponsor(sid: str, _: PlatformContext = Depends(get_platform_admin)):
    from app.services import sponsors
    return await sponsors.delete(sid)


@admin_router.get("/sponsors/{sid}/charges")
async def sponsor_charges(sid: str, _: PlatformContext = Depends(get_platform_admin)):
    """Ενεργοποιήσεις που χρεώθηκαν στον χορηγό, με το παραστατικό και αν εξοφλήθηκε."""
    from app.services import sponsors
    return {"items": jsonable_encoder(await sponsors.charges(sid))}


@admin_router.get("/sponsors/{sid}/report")
async def sponsor_report(sid: str, _: PlatformContext = Depends(get_platform_admin)):
    """Αναφορά CSV για να σταλεί στον χορηγό: μόνο τα ΑΦΜ της δικής του λίστας (ποτέ χρήση)."""
    from app.services import sponsors
    sp = await sponsors.get(sid)
    if not sp:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"error": "not_found"})
    body = sponsors.report_csv(await sponsors.charges(sid), sp)
    return Response(body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="sponsor-{sid}.csv"'})


@admin_router.post("/promotions/preview")
async def preview(body: PreviewIn, _: PlatformContext = Depends(get_platform_admin)):
    """«Τι θα πάρει» ένας πελάτης σε μια ημερομηνία — για να ελεγχθεί ενέργεια πριν ξεκινήσει.
    Περιλαμβάνει και τις ανενεργές, σημειωμένες, ώστε να δοκιμάζεται πριν ανοίξει."""
    from app.core.db import shared_db
    from app.services.invoice_service import gross_from_price
    pkg = await shared_db()["packages"].find_one({"_id": body.package_code})
    if not pkg:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"error": "unknown_package"})
    net = int(pkg.get("price_yearly" if body.billing_cycle == "yearly" else "price_monthly") or 0)
    when = (svc.window(body.on_date, body.on_date)[0] + timedelta(hours=12)) if body.on_date \
        else datetime.now(tz=timezone.utc)
    promos = [{**p, "active": True, "_was_active": p.get("active")} for p in await svc.list_all()]
    ctx = {"package": body.package_code, "cycle": body.billing_cycle, "returning": body.returning,
           "promo_code": body.promo_code, "referrer": "preview" if body.with_referral else None,
           "special_ids": {p["_id"] for p in promos if p.get("audience") == "afm_list"} if body.listed_afm else set()}
    res = svc.evaluate(promos, ctx, package_net=net, total_net=net, now=when)
    inactive = {p["_id"] for p in promos if not p["_was_active"]}
    for p in res["promotions"]:
        p["inactive"] = p["id"] in inactive
    inc = bool(pkg.get("price_includes_vat"))
    return {**res, "net_before": net, "gross_before": gross_from_price(net, inc),
            "gross_after": gross_from_price(net - res["discount_net"], inc)}


@router.get("/public")
async def public(response: Response):
    """Για το δημόσιο site (rxvision.gr): οι προσφορές σε εξέλιξη με «Εμφάνιση στο site». Χωρίς
    σύνδεση· ανανεώνεται κάθε λεπτό, ώστε μια νέα ενέργεια να φαίνεται σχεδόν αμέσως."""
    response.headers["Cache-Control"] = "public, max-age=60"
    return {"offers": jsonable_encoder(await svc.public_offers())}


@router.get("/referral")
async def my_referral(ctx: TenantContext = Depends(get_current_context)):
    """Ο κωδικός σύστασης του φαρμακείου και τι κερδίζει αν συστήσει κάποιον αυτή τη στιγμή."""
    code = await svc.referral_code_for(ctx.tenant_id)
    names = await svc._module_names()
    promos = await svc.live()
    offers = svc.referral_window_hint(promos)
    promo_code = svc.referral_promo_code(promos)
    for o in offers:
        for g in o["gifts"]:
            g["module_name"] = names.get(g["module"], g["module"])
            g["text"] = svc.gift_text(g, g["module_name"])
    link = f"{APP_REGISTER_URL}?ref={code}" + (f"&code={promo_code}" if promo_code else "")
    return {"code": code, "link": link, "promo_code": promo_code, "offers": offers}
