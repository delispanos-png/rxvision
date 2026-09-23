"""Communications router — per-tenant email/SMS config + patient campaigns (newsletter
/ reminders). The pharmacy sets up its OWN sender; sends go only to consented patients."""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from app.core.db import shared_db
from app.core.deps import TenantContext, require
from app.services import comms, message_wallet

router = APIRouter()

# Segments που στηρίζονται σε ΔΕΔΟΜΕΝΑ ΥΓΕΙΑΣ. Επιτρέπονται μόνο για επικοινωνία φροντίδας,
# ποτέ για προώθηση — και ποτέ με κουπόνι μέσα.
_CLINICAL_SEGMENTS = {"icd", "therapy", "substance"}
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
    # Χωρίς κάρτα δεν αγοράζει ΝΕΑ credits — ό,τι έχει ήδη πληρώσει το ξοδεύει κανονικά.
    from app.services import billable_gate
    await billable_gate.require_card(ctx.tenant_id, "messaging_topup")
    """Αγορά πακέτου credits μηνυμάτων μέσω του ΕΝΕΡΓΟΥ παρόχου. Το webhook πιστώνει το wallet όταν
    ολοκληρωθεί η πληρωμή. Viva → {ok, provider:"viva", checkout_url} (redirect, κάρτα/IRIS)·
    Revolut → {ok, token, mode} (widget)."""
    from app.services import revolut_service, viva_service, billing_service
    # ΚΑΝΟΝΑΣ ιδιοκτήτη: καμία αγορά credits χωρίς αποθηκευμένη κάρτα στο σύστημα — ίδιο gate με τα
    # υπόλοιπα χρεώσιμα extras (βλ. extras_service). Fail-closed: ο έλεγχος γίνεται ΠΡΙΝ φτιαχτεί
    # παραγγελία στον πάροχο, ώστε να μην μπορεί να πληρώσει παρακάμπτοντας το UI.
    if not await billing_service.card_on_file(ctx.tenant_id):
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "card_required")
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
    purpose: str = "commercial"   # commercial | care — ο φρουρός κλινικών segments
    audience_rules: dict | None = None   # Audience Engine· αν δοθεί, τέμνεται με το segment
    audience_name: str | None = None
    scheduled_at: datetime | None = None
    channel: Literal["email", "sms", "viber", "push"]
    subject: str | None = None
    message: str
    segment: str = "all"
    value: str | None = None
    coupon: CouponIn | None = None       # προαιρετικό κουπόνι — {coupon} στο κείμενο γίνεται ο κωδικός


@router.post("/send", status_code=202)
async def send_campaign(body: CampaignIn, ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Βάζει την καμπάνια ΣΤΗΝ ΟΥΡΑ και επιστρέφει αμέσως.

    ΔΕΝ στέλνει εδώ. Παλιά έστελνε μέσα στο αίτημα (βρόχος έως 2.000 παραληπτών): χρονικά όρια,
    μισοτελειωμένες αποστολές, και refresh = διπλή χρέωση. Τώρα κάθε παραλήπτης γράφεται μία
    φορά με μοναδικό κλειδί και ο worker στέλνει σε παρτίδες με επαναλήψεις.
    """
    from app.services import campaign_engine
    from app.workers.comms import dispatch_campaign

    # ΦΡΟΥΡΟΣ ΔΕΔΟΜΕΝΩΝ ΥΓΕΙΑΣ: τμηματοποίηση με κλινικά κριτήρια επιτρέπεται ΜΟΝΟ για
    # επικοινωνία φροντίδας — και τότε απαγορεύεται το κουπόνι. Δεν αρκεί προειδοποίηση.
    purpose = (body.purpose or "commercial").strip()
    if body.segment in _CLINICAL_SEGMENTS:
        if purpose != "care":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "clinical_segment_requires_care_purpose")
        if body.coupon and body.coupon.enabled:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "care_message_cannot_carry_offer")

    coupon_code = None
    if body.coupon and body.coupon.enabled and body.coupon.discount_value > 0:
        from app.services import marketing
        pre = ObjectId()
        cp = await marketing.create_coupon(
            ctx.tenant_id, campaign_id=str(pre), discount_type=body.coupon.discount_type,
            discount_value=body.coupon.discount_value, valid_days=body.coupon.valid_days,
            max_redemptions=body.coupon.max_redemptions)
        coupon_code = cp["code"]

    # Ο φρουρός ισχύει ΚΑΙ για κανόνες του Audience Engine, όχι μόνο για τα παλιά segments.
    from app.services import audience as _aud
    if body.audience_rules and _aud.uses_clinical(body.audience_rules) and purpose != "care":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "clinical_segment_requires_care_purpose")

    try:
        res = await campaign_engine.create(
            ctx.tenant_id, channel=body.channel, message=body.message, subject=body.subject,
            segment=body.segment, value=body.value, purpose=purpose, coupon_code=coupon_code,
            audience_rules=body.audience_rules, audience_name=body.audience_name,
            scheduled_at=body.scheduled_at,
            by=getattr(ctx, "email", None) or ctx.user_id)
    except (PermissionError, ValueError) as exc:
        # Κανόνες που δεν αναγνωρίζονται → ΚΑΜΙΑ αποστολή. Ποτέ «στείλ' το σε όλους».
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    # Προγραμματισμένη → την πιάνει το sweep όταν φτάσει η ώρα. Αλλιώς φεύγει τώρα.
    if res["recipients"] and not body.scheduled_at:
        dispatch_campaign.delay(res["campaign_id"])
    return {**res, "queued": True}


# ── Audience Engine (Φάση 2) ─────────────────────────────────────────────────────────────────
@router.get("/audience/fields")
async def audience_fields(_: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Τα πεδία πάνω στα οποία χτίζεται κανόνας, με ελληνικά ονόματα και σήμανση κλινικών."""
    from app.services import audience
    return {"fields": audience.FIELDS, "operators": list(audience.OPS)}


@router.get("/audience/smart")
async def audience_smart(ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Οι έτοιμες ομάδες με ζωντανό πλήθος — οι κάρτες «σε ποιους θέλεις να μιλήσεις;»."""
    from app.services import audience
    return {"items": await audience.smart_counts(ctx.tenant_id)}


class RulesIn(BaseModel):
    rules: dict
    purpose: str = "commercial"


@router.post("/audience/preview")
async def audience_preview(body: RulesIn,
                           ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import audience
    try:
        return await audience.preview(ctx.tenant_id, body.rules, purpose=body.purpose)
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None


class AudienceIn(BaseModel):
    name: str
    rules: dict


@router.get("/audiences")
async def audiences_list(ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import audience
    return {"items": await audience.listing(ctx.tenant_id)}


@router.post("/audiences")
async def audiences_create(body: AudienceIn,
                           ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import audience
    return await audience.save(ctx.tenant_id, name=body.name, rules=body.rules,
                               by=getattr(ctx, "email", None))


@router.put("/audiences/{audience_id}")
async def audiences_update(audience_id: str, body: AudienceIn,
                           ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import audience
    return await audience.save(ctx.tenant_id, name=body.name, rules=body.rules,
                               audience_id=audience_id, by=getattr(ctx, "email", None))


@router.delete("/audiences/{audience_id}")
async def audiences_delete(audience_id: str,
                           ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import audience
    return await audience.delete(ctx.tenant_id, audience_id)


# ── Automations & ημερολόγιο (Φάση 3) ────────────────────────────────────────────────────────
class AutomationIn(BaseModel):
    name: str | None = None
    trigger: str
    param: int | None = None
    channel: str = "email"
    subject: str | None = None
    message: str
    purpose: str = "commercial"
    active: bool = False


@router.get("/automations/triggers")
async def automation_triggers(_: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import automations
    return {"triggers": automations.TRIGGERS, "daily_cap": automations.DAILY_CAP}


@router.get("/automations")
async def automations_list(ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import automations
    return {"items": await automations.listing(ctx.tenant_id)}


@router.post("/automations")
async def automations_create(body: AutomationIn,
                             ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import automations
    res = await automations.save(ctx.tenant_id, body.model_dump(), by=getattr(ctx, "email", None))
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res["error"])
    return res


@router.put("/automations/{automation_id}")
async def automations_update(automation_id: str, body: AutomationIn,
                             ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import automations
    res = await automations.save(ctx.tenant_id, body.model_dump(), automation_id=automation_id,
                                 by=getattr(ctx, "email", None))
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res["error"])
    return res


@router.delete("/automations/{automation_id}")
async def automations_delete(automation_id: str,
                             ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import automations
    return await automations.delete(ctx.tenant_id, automation_id)


@router.get("/calendar")
async def comms_calendar(days: int = Query(60, ge=7, le=180),
                         ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Πότε ενοχλείς τον κόσμο — σταλμένα, προγραμματισμένα και αυτόματα σε μία όψη."""
    from app.services import automations
    return {"items": await automations.calendar(ctx.tenant_id, days)}


# ── Analytics & AI (Φάση 4) ──────────────────────────────────────────────────────────────────
@router.get("/overview")
async def comms_overview(days: int = Query(30, ge=7, le=180),
                         ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import comm_analytics
    return await comm_analytics.overview(ctx.tenant_id, days)


@router.get("/campaigns/{campaign_id}/report")
async def campaign_report(campaign_id: str,
                          ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import comm_analytics
    res = await comm_analytics.report(ctx.tenant_id, campaign_id)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return res


class TrackingIn(BaseModel):
    enabled: bool


@router.put("/tracking")
async def set_tracking(body: TrackingIn,
                       ctx: TenantContext = Depends(require("settings:write", module=_MODULE))):
    """Μέτρηση ανοιγμάτων/κλικ — ΚΛΕΙΣΤΗ εξ ορισμού. Είναι παρακολούθηση ανθρώπου και
    ανοίγει μόνο με ρητή απόφαση του φαρμακείου."""
    from app.services import comm_analytics
    return await comm_analytics.set_tracking(ctx.tenant_id, body.enabled)


class DraftIn(BaseModel):
    brief: str
    channel: str = "email"
    audience_label: str | None = None


@router.post("/draft")
async def ai_draft(body: DraftIn, ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Προσχέδιο μηνύματος από AI. ΠΟΤΕ δεν στέλνεται μόνο του — γυρίζει στη φόρμα για έγκριση."""
    from app.services import comm_analytics
    res = await comm_analytics.draft(ctx.tenant_id, brief=body.brief, channel=body.channel,
                                     audience_label=body.audience_label or "")
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "failed"))
    return res


@router.get("/audience/breakdown")
async def audience_breakdown(channel: str, segment: str = "all", value: str | None = None,
                             audience: str | None = None, purpose: str = "commercial",
                             ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Πόσοι θα το λάβουν και ποιοι εξαιρούνται — με τον λόγο του καθενός (οθόνη έγκρισης).

    `audience` = οι ΚΑΝΟΝΕΣ της ομάδας (JSON), όπως ταξιδεύουν από τις «Ομάδες ανθρώπων».
    Χωρίς αυτό η οθόνη έγκρισης θα έδειχνε ΟΛΟ το πελατολόγιο ενώ ο φαρμακοποιός έχει διαλέξει
    μια συγκεκριμένη ομάδα — δηλαδή θα έλεγε ψέματα ακριβώς εκεί που μετράει.
    """
    only_ids = None
    if audience:
        from app.services import audience as audience_svc
        try:
            rules = json.loads(audience)
        except (TypeError, ValueError):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_audience") from None
        try:
            only_ids = await audience_svc.resolve(ctx.tenant_id, rules, purpose=purpose)
        except (PermissionError, ValueError) as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    return await comms.audience_breakdown(ctx.tenant_id, channel, segment, value, only_ids=only_ids)


@router.get("/campaigns/{campaign_id}/progress")
async def campaign_progress(campaign_id: str,
                            ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Ζωντανή πρόοδος: «340 από 1.102»."""
    from app.services import campaign_engine
    return await campaign_engine.progress(ctx.tenant_id, campaign_id)


class CampaignActionIn(BaseModel):
    action: str          # pause | resume | cancel


@router.post("/campaigns/{campaign_id}/action")
async def campaign_action(campaign_id: str, body: CampaignActionIn,
                          ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    from app.services import campaign_engine
    res = await campaign_engine.set_status(ctx.tenant_id, campaign_id, body.action)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "failed"))
    return res


class TestSendIn(BaseModel):
    channel: str
    message: str
    subject: str | None = None
    to: str                      # δικό ΣΟΥ email/κινητό


@router.post("/test-send")
async def test_send(body: TestSendIn, ctx: TenantContext = Depends(require("portal:manage", module=_MODULE))):
    """Δοκιμαστική αποστολή στον ίδιο τον φαρμακοποιό — πάντα πριν φύγει στους υπόλοιπους."""
    ph = await comms._pharmacy(ctx.tenant_id)                       # noqa: SLF001
    text = body.message.replace("{name}", "ΔΟΚΙΜΗ ΟΝΟΜΑ").replace("{first}", "ΔΟΚΙΜΗ").replace("{coupon}", "ΔΟΚΙΜΗ123")
    try:
        if body.channel == "email":
            await comms.send_email(ctx.tenant_id, body.to, f"[ΔΟΚΙΜΗ] {body.subject or 'Ενημέρωση φαρμακείου'}",
                                   comms._campaign_email_html(text, ph.get("name")), kind="test")  # noqa: SLF001
        elif body.channel == "viber":
            await comms.send_viber(ctx.tenant_id, body.to, f"[ΔΟΚΙΜΗ] {text}", kind="test")
        else:
            await comms.send_sms(ctx.tenant_id, body.to, f"[ΔΟΚΙΜΗ] {text}", kind="test")
    except Exception as e:                                          # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)[:120]) from e
    return {"ok": True}


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


# ── ΔΗΜΟΣΙΟ: διαγραφή από προωθητικά (χωρίς σύνδεση) ─────────────────────────────────────────
class UnsubIn(BaseModel):
    scope: str = "all"           # all | email | sms | viber


@router.get("/u/{token}", include_in_schema=False)
async def unsubscribe_info(token: str):
    """Τι θα δει ο άνθρωπος πριν αποφασίσει. Καμία σύνδεση, κανένα προσωπικό δεδομένο πίσω."""
    from app.services import unsubscribe
    return await unsubscribe.describe(token)


@router.post("/u/{token}", include_in_schema=False)
async def unsubscribe_apply(token: str, body: UnsubIn):
    """Ο σύνδεσμος ΠΡΕΠΕΙ να δουλεύει χωρίς λογαριασμό — αλλιώς δεν είναι πραγματική έξοδος."""
    from app.services import unsubscribe
    res = await unsubscribe.apply(token, scope=body.scope)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "failed"))
    return res


# ── ΔΗΜΟΣΙΑ: μέτρηση ανοίγματος & κλικ (μόνο αν το φαρμακείο το έχει ανοίξει) ─────────────────
@router.get("/o/{campaign_id}/{key}.gif", include_in_schema=False)
async def track_open(campaign_id: str, key: str):
    """Διαφανές pixel. Επιστρέφει ΠΑΝΤΑ εικόνα — ακόμη κι όταν η μέτρηση είναι κλειστή, ώστε
    να μη σπάει το email και να μη διαρρέει αν κάποιος μετρά ή όχι."""
    from fastapi.responses import Response
    from app.services import comm_analytics
    try:
        await comm_analytics.record_event(campaign_id, key, "opened")
    except Exception:                                      # noqa: BLE001
        pass
    gif = bytes.fromhex("47494638396101000100800000000000ffffff21f90401000000002c00000000"
                        "0100010000020144003b")
    return Response(content=gif, media_type="image/gif",
                    headers={"Cache-Control": "no-store"})


@router.get("/c/{campaign_id}/{key}", include_in_schema=False)
async def track_click(campaign_id: str, key: str, u: str):
    """Ανακατεύθυνση με καταγραφή κλικ. Ο προορισμός έρχεται από το ίδιο το μήνυμα."""
    from fastapi.responses import RedirectResponse
    from app.services import comm_analytics
    try:
        await comm_analytics.record_event(campaign_id, key, "clicked", {"url": u[:300]})
    except Exception:                                      # noqa: BLE001
        pass
    if not u.startswith(("http://", "https://")):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_url")
    return RedirectResponse(u, status_code=302)
