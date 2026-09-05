"""Communications router — per-tenant email/SMS config + patient campaigns (newsletter
/ reminders). The pharmacy sets up its OWN sender; sends go only to consented patients."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from app.core.db import shared_db
from app.core.deps import TenantContext, require
from app.services import comms, message_wallet

router = APIRouter()
_MODULE = "patient_analytics"


@router.get("/settings")
async def get_settings(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Central model: no per-pharmacy SMTP/SMS config anymore — just the prepaid credit wallet status."""
    return {"central": True, **await message_wallet.usage_summary(ctx.tenant_id)}


@router.get("/wallet")
async def wallet(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    from app.services.billing_service import card_on_file
    w = await shared_db()["message_wallets"].find_one({"_id": ctx.tenant_id}) or {}
    return {**await message_wallet.usage_summary(ctx.tenant_id),
            "ledger": await message_wallet.ledger(ctx.tenant_id, limit=50),
            "auto_recharge": w.get("auto_recharge") or {"enabled": False},
            "card_on_file": await card_on_file(ctx.tenant_id)}


class AutoRechargeIn(BaseModel):
    enabled: bool = False
    threshold_cents: int = 200
    package_id: str | None = None


@router.put("/auto-recharge")
async def set_auto_recharge(body: AutoRechargeIn,
                            ctx: TenantContext = Depends(require("billing:manage"))):
    """Αυτόματη αναπλήρωση credits με κάρτα-on-file όταν το υπόλοιπο πέσει κάτω από όριο."""
    await message_wallet.set_auto_recharge(ctx.tenant_id, body.enabled,
                                           body.threshold_cents, body.package_id)
    return {"ok": True}


@router.get("/sender")
async def get_sender(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Όνομα αποστολέα (Sender ID) του φαρμακείου + κατάσταση έγκρισης. Default = RxVision."""
    from app.services import comms
    return await comms.tenant_sender_config(ctx.tenant_id)


class SenderIn(BaseModel):
    channel: str = "sms"   # sms | viber
    sender: str = ""       # κενό = επαναφορά στο RxVision


@router.put("/sender")
async def set_sender(body: SenderIn, ctx: TenantContext = Depends(require("billing:manage"))):
    """Αίτημα ονόματος αποστολέα από το φαρμακείο → pending μέχρι έγκριση από τον admin (αφού δηλωθεί
    στην Apifon). Μέχρι να εγκριθεί, τα μηνύματα φεύγουν από RxVision."""
    from app.services import comms
    return await comms.request_tenant_sender(ctx.tenant_id, body.channel, body.sender)


@router.get("/credit-packages")
async def credit_packages(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return {"items": await message_wallet.packages()}


class TopupIn(BaseModel):
    package_id: str


@router.post("/topup")
async def topup(body: TopupIn, ctx: TenantContext = Depends(require("billing:manage"))):
    """Αγορά πακέτου credits μηνυμάτων μέσω του ΕΝΕΡΓΟΥ παρόχου. Το webhook πιστώνει το wallet όταν
    ολοκληρωθεί η πληρωμή. Viva → {ok, provider:"viva", checkout_url} (redirect, κάρτα/IRIS)·
    Revolut → {ok, token, mode} (widget)."""
    from app.services import revolut_service, viva_service, billing_service
    pkg = await message_wallet.get_package(body.package_id)
    if not pkg:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown_package")
    t = await shared_db()["tenants"].find_one(
        {"_id": ctx.tenant_id}, {"name": 1, "company": 1, "billing_profile": 1}) or {}
    comp, bill = t.get("company") or {}, t.get("billing_profile") or {}
    email = bill.get("email") or comp.get("email") or bill.get("billing_email") or "billing@rxvision.gr"
    name = comp.get("name") or bill.get("name") or t.get("name") or ctx.tenant_id
    desc = f"RxVision — μηνύματα {pkg.get('name', '')}"
    if await billing_service.active_provider() == "viva":
        if not await viva_service.is_configured():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "viva_not_configured")
        res = await viva_service.create_checkout_order(
            amount=int(pkg["price_cents"]), ref=f"topup:{ctx.tenant_id}", description=desc,
            email=email, full_name=name)
        if not res.get("ok"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "viva_error"))
        await message_wallet.record_pending_topup(ctx.tenant_id, pkg, res["order_code"])
        return {"ok": True, "provider": "viva", "checkout_url": res["checkout_url"],
                "credits_cents": int(pkg["credits_cents"])}
    if not await revolut_service.is_configured():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no_payment_provider")
    res = await revolut_service.create_topup_order(
        amount=int(pkg["price_cents"]), currency="EUR", email=email, name=name,
        tenant_id=ctx.tenant_id, description=desc)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "revolut_error"))
    await message_wallet.record_pending_topup(ctx.tenant_id, pkg, res["order_id"])
    mode = (await revolut_service.config()).get("mode", "sandbox")
    return {"ok": True, "provider": "revolut", "token": res["token"], "order_id": res["order_id"],
            "mode": mode, "credits_cents": int(pkg["credits_cents"])}


async def _test_send(channel: str, to: str, tenant_id: str):
    try:
        # Δοκιμαστική αποστολή = επαλήθευση ρύθμισης → ΔΕΝ χρεώνεται το wallet (charge=False), ώστε το
        # φαρμακείο να μπορεί να δοκιμάσει ΠΡΙΝ αγοράσει credits.
        if channel == "email":
            await comms.send_email(tenant_id, to, "RxVision — δοκιμαστικό email",
                                   "<p>Το κεντρικό email της πλατφόρμας λειτουργεί για το φαρμακείο σου. ✅</p>",
                                   kind="test", charge=False)
        elif channel == "viber":
            await comms.send_viber(tenant_id, to, "RxVision: δοκιμαστικό Viber από το φαρμακείο σου.",
                                   kind="test", charge=False)
        else:
            await comms.send_sms(tenant_id, to, "RxVision: δοκιμαστικό SMS από το φαρμακείο σου.",
                                 kind="test", charge=False)
    except message_wallet.InsufficientCredits:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "Ανεπαρκές υπόλοιπο μηνυμάτων.")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return {"ok": True}


@router.post("/test-email")
async def test_email(to: str = Query(...), ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    return await _test_send("email", to, ctx.tenant_id)


@router.post("/test-sms")
async def test_sms(to: str = Query(...), ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    return await _test_send("sms", to, ctx.tenant_id)


@router.post("/test-viber")
async def test_viber(to: str = Query(...), ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    return await _test_send("viber", to, ctx.tenant_id)


async def _segment_patient_ids(tenant_id: str, segment: str, value: str | None):
    """Set of patient _ids matching a smart segment, or None = no restriction. See comms service."""
    return await comms.segment_patient_ids(tenant_id, segment, value)


async def _audience(tenant_id: str, channel: str, segment: str = "all", value: str | None = None) -> list[dict]:
    return await comms.campaign_audience(tenant_id, channel, segment, value)


@router.get("/audience")
async def audience(channel: Literal["email", "sms", "viber", "push"] = "email",
                   segment: str = "all", value: str | None = None,
                   ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    rows = (await comms.push_audience(ctx.tenant_id, segment, value) if channel == "push"
            else await _audience(ctx.tenant_id, channel, segment, value))
    return {"channel": channel, "segment": segment, "count": len(rows)}


class CouponIn(BaseModel):
    enabled: bool = False
    discount_type: str = "pct"           # "pct" (%) ή "fixed" (cents)
    discount_value: int = 0
    valid_days: int = 30
    max_redemptions: int = 0             # 0 = χωρίς όριο


class CampaignIn(BaseModel):
    channel: Literal["email", "sms", "viber", "push"]
    subject: str | None = None
    message: str
    segment: str = "all"
    value: str | None = None
    coupon: CouponIn | None = None       # προαιρετικό κουπόνι — {coupon} στο κείμενο γίνεται ο κωδικός


@router.post("/send", status_code=202)
async def send_campaign(body: CampaignIn, ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from bson import ObjectId
    cid = ObjectId()
    coupon_code = None
    if body.coupon and body.coupon.enabled and body.coupon.discount_value > 0:
        from app.services import marketing
        cp = await marketing.create_coupon(
            ctx.tenant_id, campaign_id=str(cid), discount_type=body.coupon.discount_type,
            discount_value=body.coupon.discount_value, valid_days=body.coupon.valid_days,
            max_redemptions=body.coupon.max_redemptions)
        coupon_code = cp["code"]
    return await comms.run_campaign(
        ctx.tenant_id, channel=body.channel, message=body.message, subject=body.subject,
        segment=body.segment, value=body.value, campaign_id=str(cid), coupon_code=coupon_code,
        by=ctx.email if hasattr(ctx, "email") else None)


@router.get("/history")
async def history(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    cur = shared_db()["comms_campaigns"].find({"tenant_id": ctx.tenant_id}).sort("created_at", -1).limit(30)
    out = []
    async for d in cur:
        d["id"] = str(d.pop("_id"))
        out.append(d)
    return {"items": out}


@router.get("/messages")
async def messages(status_f: str | None = Query(None, alias="status"),
                   channel: str | None = None, limit: int = Query(150, ge=1, le=500),
                   ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Ιστορικό ΑΝΑ μήνυμα: παραλήπτης, κανάλι, κόστος, κατάσταση (sent/delivered/undelivered), ώρα."""
    db = shared_db()
    q: dict = {"tenant_id": ctx.tenant_id}
    if status_f:
        q["status"] = status_f
    if channel:
        q["channel"] = channel
    out = []
    async for d in db["sent_messages"].find(q).sort("created_at", -1).limit(limit):
        out.append({"id": str(d["_id"]), "channel": d.get("channel"), "recipient": d.get("recipient"),
                    "status": d.get("status"), "cost_cents": int(d.get("cost_cents", 0) or 0),
                    "kind": d.get("kind"), "subject": d.get("subject"), "refunded": bool(d.get("refunded")),
                    "created_at": d.get("created_at"), "delivered_at": d.get("delivered_at")})
    # σύνοψη ανά κατάσταση (τελευταίες 30 ημέρες)
    since = datetime.now(tz=timezone.utc) - timedelta(days=30)
    agg = {r["_id"]: r["n"] async for r in db["sent_messages"].aggregate([
        {"$match": {"tenant_id": ctx.tenant_id, "created_at": {"$gte": since}}},
        {"$group": {"_id": "$status", "n": {"$sum": 1}}}])}
    return {"items": out, "summary_30d": agg}


@router.get("/charges")
async def charges(days: int = Query(30, ge=1, le=365), channel: str | None = None,
                  limit: int = Query(300, ge=1, le=1000), format: str = Query("json"),
                  ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """Λίστα ΧΡΕΩΣΕΩΝ ανά αποστολή (για έλεγχο των δικών μας χρεώσεων): ημ/νία, κανάλι, παραλήπτης,
    χρέωση (cents), κατάσταση, αν έγινε επιστροφή. + ΣΥΝΟΛΑ ανά κανάλι & γενικό (καθαρό, χωρίς refunds).
    format=csv → κατέβασμα CSV (με BOM για ελληνικά στο Excel)."""
    db = shared_db()
    since = datetime.now(tz=timezone.utc) - timedelta(days=days)
    q: dict = {"tenant_id": ctx.tenant_id, "created_at": {"$gte": since}, "cost_cents": {"$gt": 0}}
    if channel:
        q["channel"] = channel
    csv_cap = 5000 if format == "csv" else limit
    items = []
    async for d in db["sent_messages"].find(q).sort("created_at", -1).limit(csv_cap):
        items.append({"id": str(d["_id"]), "channel": d.get("channel"), "recipient": d.get("recipient"),
                      "status": d.get("status"), "cost_cents": int(d.get("cost_cents", 0) or 0),
                      "refunded": bool(d.get("refunded")), "kind": d.get("kind"),
                      "created_at": d.get("created_at")})
    if format == "csv":
        import csv as _csv
        import io as _io
        from fastapi.responses import Response
        buf = _io.StringIO()
        buf.write("﻿")   # BOM → σωστά ελληνικά στο Excel
        w = _csv.writer(buf, delimiter=";")
        w.writerow(["Ημερομηνία", "Κανάλι", "Παραλήπτης", "Κατάσταση", "Χρέωση (€)", "Επιστροφή", "Είδος"])
        for it in items:
            w.writerow([str(it["created_at"])[:19], it["channel"] or "", it["recipient"] or "",
                        it["status"] or "", f'{it["cost_cents"] / 100:.3f}'.replace(".", ","),
                        "ναι" if it["refunded"] else "όχι", it.get("kind") or ""])
        return Response(content=buf.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="charges_{days}d.csv"'})
    # ΣΥΝΟΛΑ σε ΟΛΗ την περίοδο (όχι μόνο στο limit) — καθαρή χρέωση = εκτός refunded
    by_channel: dict = {}
    total = count = 0
    async for r in db["sent_messages"].aggregate([
            {"$match": {**q, "refunded": {"$ne": True}}},
            {"$group": {"_id": "$channel", "sum": {"$sum": "$cost_cents"}, "n": {"$sum": 1}}}]):
        by_channel[r["_id"]] = int(r["sum"] or 0)
        total += int(r["sum"] or 0); count += int(r["n"] or 0)
    refunded_cents = 0
    async for r in db["sent_messages"].aggregate([
            {"$match": {**q, "refunded": True}},
            {"$group": {"_id": None, "sum": {"$sum": "$cost_cents"}}}]):
        refunded_cents = int(r["sum"] or 0)
    return {"items": items, "days": days, "total_cents": total, "count": count,
            "by_channel": by_channel, "refunded_cents": refunded_cents}


# ── Apifon delivery-receipt (DLR) webhook — ΔΗΜΟΣΙΟ (η Apifon το καλεί) ──────────────────────────
@router.post("/apifon-dlr", include_in_schema=False)
async def apifon_dlr(request: Request):
    """Delivery receipts της Apifon → ενημέρωση κατάστασης ανά μήνυμα + ΕΠΙΣΤΡΟΦΗ χρημάτων για μη
    παραδοθέντα. ⚠️ Η ΑΚΡΙΒΗΣ μορφή/υπογραφή DLR επιβεβαιώνεται με την Apifon (βλ. request list)."""
    # AUTH GUARD: το endpoint είναι δημόσιο και κινεί ΕΠΙΣΤΡΟΦΕΣ wallet — πλαστό DLR = δωρεάν credit.
    # Μέχρι να επιβεβαιωθεί η υπογραφή HMAC της Apifon, απαιτούμε κοινό μυστικό (token) που ρυθμίζεται
    # στο callback URL της Apifon (?token=... ή header X-Apifon-Token). Αν έχει οριστεί secret και ΔΕΝ
    # ταιριάζει → 403. Αν ΔΕΝ έχει οριστεί ακόμη → επεξεργαζόμαστε αλλά με προειδοποίηση (μη σπάσουμε το
    # τρέχον flow· ο ιδιοκτήτης πρέπει να ορίσει comms.apifon_dlr_secret + να ενημερώσει το callback URL).
    import secrets as _secrets
    from app.services.platform_secrets import decrypt_doc
    _cfg = decrypt_doc("comms", await shared_db()["platform_settings"].find_one({"_id": "comms"})) or {}
    _want = str(_cfg.get("apifon_dlr_secret") or "").strip()
    if _want:
        _got = (request.query_params.get("token") or request.headers.get("x-apifon-token")
                or request.headers.get("x-dlr-token") or "")
        if not _secrets.compare_digest(_got, _want):
            from fastapi import HTTPException
            raise HTTPException(status_code=403, detail="forbidden")
    else:
        print("⚠️ apifon_dlr: unauthenticated (comms.apifon_dlr_secret δεν έχει οριστεί) — set it + update callback URL")
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        try:
            payload = dict(await request.form())
        except Exception:  # noqa: BLE001
            return {"ok": False}
    events = payload if isinstance(payload, list) else (
        payload.get("results") or payload.get("statuses") or payload.get("delivery_receipts") or [payload])
    db = shared_db()
    updated = 0
    for ev in (events if isinstance(events, list) else [events]):
        if not isinstance(ev, dict):
            continue
        mid = str(ev.get("message_id") or ev.get("id") or ev.get("request_id") or "")
        st = str(ev.get("status") or ev.get("delivery_status") or ev.get("status_code") or "").upper()
        if not mid:
            continue
        delivered = st in ("DELIVERED", "DELIVRD", "READ", "SEEN")
        failed = st in ("UNDELIVERED", "UNDELIVERABLE", "FAILED", "EXPIRED", "REJECTED", "ERROR")
        newstatus = "delivered" if delivered else "failed" if failed else None
        if not newstatus:
            continue
        doc = await db["sent_messages"].find_one({"provider_message_id": mid})
        if not doc or doc.get("status") == newstatus:
            continue
        now = datetime.now(tz=timezone.utc)
        upd: dict = {"status": newstatus, "updated_at": now}
        if delivered:
            upd["delivered_at"] = now
        await db["sent_messages"].update_one({"_id": doc["_id"]}, {"$set": upd})
        updated += 1
        # ΕΠΙΣΤΡΟΦΗ για μη παραδοθέν (μία φορά)
        if failed and doc.get("cost_cents") and not doc.get("refunded"):
            try:
                await message_wallet.refund(doc["tenant_id"], doc["channel"], int(doc["cost_cents"]),
                                            ref=doc.get("recipient", ""))
                await db["sent_messages"].update_one({"_id": doc["_id"]}, {"$set": {"refunded": True}})
            except Exception:  # noqa: BLE001
                pass
    return {"ok": True, "updated": updated}
