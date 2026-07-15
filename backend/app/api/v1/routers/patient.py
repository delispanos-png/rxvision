"""Patient portal API (3rd identity). Every data endpoint is scoped to the patient's OWN record
in their ACTIVE pharmacy (tenant + patient_ref come from the patient token — never from the client)."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, EmailStr, Field

from app.core.db import shared_db
from app.core.deps import PatientContext, get_patient_context
from app.core.ratelimit import (
    account_locked, clear_login_failures, rate_limit, record_login_failure,
)
from app.repositories.advisor import AdvisorRepository
from app.repositories.patient_portal import (
    AppointmentRepository, AvailabilityRepository, PatientAccountRepository,
    PatientRxRepository, PharmacyServiceRepository, RxRequestRepository,
)
from app.services.hdika_lookup import lookup_prescription
from app.services.patient_auth_service import PatientAuthService, PatientError

router = APIRouter()


async def portal_mode() -> str:
    """Καθολικός τρόπος λειτουργίας της πύλης (platform_settings._id='portal'):
      • 'network' (default) — ο πελάτης βλέπει ΟΛΑ τα φαρμακεία του δικτύου (κατάλογος/εναλλαγή/cross).
      • 'single'  — ο πελάτης «κλειδώνεται» στο φαρμακείο που τον ενέγραψε (καμία cross-pharmacy λειτουργία)."""
    doc = await shared_db()["platform_settings"].find_one({"_id": "portal"})
    m = (doc or {}).get("mode", "network")
    return m if m in ("network", "single") else "network"


# ── schemas ──────────────────────────────────────────────────
class RegisterIn(BaseModel):
    first_name: str = Field(..., min_length=1, max_length=80)
    last_name: str = Field(..., min_length=1, max_length=80)
    email: EmailStr
    phone: str = Field("", max_length=40)
    amka: str = Field(..., min_length=6, max_length=20)
    password: str = Field(..., min_length=8, max_length=128)
    pharmacy: str | None = Field(None, max_length=40)   # «αγαπημένο» tenant from a counter QR


class RegisterVerifyIn(BaseModel):
    challenge_id: str = Field(..., min_length=8, max_length=64)
    code: str = Field(..., min_length=4, max_length=8)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class SelectIn(BaseModel):
    tenant_id: str


class AvailabilityIn(BaseModel):
    tenant_id: str | None = None                          # target pharmacy (defaults to active)
    medicine_barcode: str | None = Field(None, max_length=40)
    medicine_name: str | None = Field(None, max_length=200)
    query: str = Field("", max_length=300)                # optional free text


class AppointmentIn(BaseModel):
    tenant_id: str | None = None                          # target pharmacy (defaults to active)
    service_id: str | None = None
    service_name: str = Field(..., min_length=2, max_length=120)
    kind: str = Field("service", pattern="^(service|pickup)$")  # pickup = "θα περάσω να την παραλάβω"
    requested_at: datetime
    note: str | None = Field(None, max_length=300)


# ── auth ─────────────────────────────────────────────────────
@router.post("/auth/register",
             dependencies=[Depends(rate_limit("patient_register", limit=5, window_seconds=600))])
async def register(body: RegisterIn):
    """Step 1: send an ownership-proof OTP to a contact the pharmacy holds on file for this ΑΜΚΑ.
    Returns {otp_required, challenge_id, channels}. No account is created until the code is verified."""
    try:
        return await PatientAuthService().start_registration(
            first_name=body.first_name, last_name=body.last_name, email=body.email,
            phone=body.phone, amka=body.amka, password=body.password, pharmacy=body.pharmacy)
    except PatientError as exc:
        err = str(exc)
        # approval_required → the pharmacy must create the account (no on-file contact to verify against)
        code = status.HTTP_409_CONFLICT if err in ("email_exists", "amka_exists", "approval_required") \
            else status.HTTP_400_BAD_REQUEST
        raise HTTPException(code, detail={"error": err})


@router.post("/auth/register/verify", status_code=201,
             dependencies=[Depends(rate_limit("patient_register_verify", limit=10, window_seconds=600))])
async def register_verify(body: RegisterVerifyIn):
    """Step 2: confirm the OTP → create the account + auto-link the patient's pharmacies + mint tokens."""
    try:
        return await PatientAuthService().verify_registration(body.challenge_id, body.code)
    except PatientError as exc:
        err = str(exc)
        code = status.HTTP_409_CONFLICT if err == "amka_exists" else status.HTTP_400_BAD_REQUEST
        raise HTTPException(code, detail={"error": err})


@router.post("/auth/login",
             dependencies=[Depends(rate_limit("patient_login", limit=10, window_seconds=300))])
async def login(body: LoginIn):
    locked = await account_locked(f"patient:{body.email}")
    if locked:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            detail={"error": "account_locked", "retry_after": locked},
                            headers={"Retry-After": str(locked)})
    res = await PatientAuthService().login(body.email, body.password)
    if res is None:
        await record_login_failure(f"patient:{body.email}")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")
    await clear_login_failures(f"patient:{body.email}")
    return res


@router.post("/auth/refresh")
async def refresh(body: RefreshIn):
    res = await PatientAuthService().refresh(body.refresh_token)
    if res is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_refresh")
    return res


@router.post("/auth/logout")
async def logout(ctx: PatientContext = Depends(get_patient_context)):
    """Revoke this patient's refresh tokens (all devices) so a stolen token can't mint new sessions."""
    await PatientAuthService().logout(ctx.account_id)
    return {"ok": True}


@router.post("/auth/select-pharmacy")
async def select_pharmacy(body: SelectIn, ctx: PatientContext = Depends(get_patient_context)):
    if await portal_mode() == "single" and body.tenant_id != ctx.tenant_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "single_pharmacy_mode")   # καμία εναλλαγή/self-onboarding
    token = await PatientAuthService().select_pharmacy(ctx.account_id, body.tenant_id)
    if token is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "not_linked_to_pharmacy")
    return {"access_token": token, "active_tenant": body.tenant_id}


# ── profile + own data ───────────────────────────────────────
@router.get("/me")
async def me(ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.patient_portal import PatientAccountRepository
    from app.services.auth_service import resolve_tenant_modules, tenant_has
    from app.repositories.loyalty import LoyaltyRepository
    repo = PatientAccountRepository()
    acc = await repo.get(ctx.account_id)
    if not acc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "account_not_found")
    # Δυνατότητες του ΕΝΕΡΓΟΥ φαρμακείου → η πύλη κρύβει καρτέλες που δεν προσφέρει (Κατάστημα/Επιβράβευση).
    mods = await resolve_tenant_modules(ctx.tenant_id)
    try:
        loy_on = bool((await LoyaltyRepository(tenant_id=ctx.tenant_id).config()).get("enabled"))
    except Exception:  # noqa: BLE001
        loy_on = False
    mode = await portal_mode()
    links = await repo.links(ctx.account_id)
    if mode == "single":   # κλείδωμα στο ενεργό (φαρμακείο εγγραφής) — κρύβεται εναλλαγή/κατάλογος
        links = [l for l in links if l.get("tenant_id") == ctx.tenant_id]
    return {
        "profile": {"first_name": acc.get("first_name"), "last_name": acc.get("last_name"),
                    "email": acc.get("email"), "phone": acc.get("phone")},
        "active_tenant": ctx.tenant_id,
        "favorite_tenant": acc.get("favorite_tenant_id"),
        "pharmacies": links,
        "portal_mode": mode,
        "caps": {"shop": tenant_has(mods, "order_delivery"), "loyalty": loy_on},
    }


@router.get("/prescriptions")
async def my_prescriptions(ctx: PatientContext = Depends(get_patient_context)):
    # 200 ώστε η αναζήτηση (αρ. συνταγής / ημ. διάστημα) στην πύλη να καλύπτει αρκετό ιστορικό·
    # η προβολή δείχνει by default μόνο τις 5 πιο πρόσφατες.
    # ΟΛΑ τα φαρμακεία του πελάτη — κάθε εκτέλεση με ετικέτα «πού έγινε» (η συνταγή είναι δική του).
    return {"items": await PatientAccountRepository().all_prescriptions(ctx.account_id, limit=200)}


@router.get("/repeats")
async def my_repeats(ctx: PatientContext = Depends(get_patient_context)):
    repo = PatientRxRepository(tenant_id=ctx.tenant_id)
    return {"items": await repo.my_repeats(ctx.patient_ref)}


@router.get("/summary")
async def my_summary(ctx: PatientContext = Depends(get_patient_context)):
    """KPI snapshot for the portal home (counts, paid, fund-covered, repeats)."""
    return await PatientRxRepository(tenant_id=ctx.tenant_id).summary(ctx.patient_ref)


@router.get("/meds/schedule")
async def meds_schedule(ctx: PatientContext = Depends(get_patient_context)):
    """Εβδομαδιαίο πρόγραμμα λήψης: ενεργές αγωγές με τη δοσολογία του γιατρού + ημ/νία εξάντλησης,
    και calendar grid για όσες έχει ενεργοποιήσει ο ασθενής."""
    return await PatientRxRepository(tenant_id=ctx.tenant_id).medication_schedule(ctx.patient_ref)


class ReminderIn(BaseModel):
    med_key: str
    enabled: bool
    time: str | None = None      # ώρα (πρώτης) λήψης (HH:MM)
    meal: str | None = None      # before | after | none — σε σχέση με το γεύμα
    interval_hours: int | None = None   # «κάθε X ώρες» (0/None = συγκεκριμένη ώρα)


@router.post("/meds/reminder")
async def meds_reminder(body: ReminderIn, ctx: PatientContext = Depends(get_patient_context)):
    """Ενεργοποίηση/απενεργοποίηση ενημερώσεων + (προαιρετικά) ώρα λήψης & σχέση με το γεύμα."""
    return await PatientRxRepository(tenant_id=ctx.tenant_id).set_reminder(
        ctx.patient_ref, body.med_key, body.enabled, body.time, body.meal, body.interval_hours)


class IntakeIn(BaseModel):
    med_key: str
    slot: str | None = None   # πρωί/μεσημέρι/βράδυ/νύχτα — per-δόση (None = γενικά για τη μέρα)


@router.post("/meds/taken")
async def meds_taken(body: IntakeIn, ctx: PatientContext = Depends(get_patient_context)):
    """«✓ Το πήρα» ΑΝΑ ΔΟΣΗ → σερί συνέπειας (+ πόντοι ΜΟΝΟ αν το φαρμακείο το έχει ενεργοποιήσει)."""
    return await PatientRxRepository(tenant_id=ctx.tenant_id).log_intake(ctx.patient_ref, body.med_key, body.slot)


@router.post("/meds/untaken")
async def meds_untaken(body: IntakeIn, ctx: PatientContext = Depends(get_patient_context)):
    """Αναίρεση «✓ Το πήρα» για τη συγκεκριμένη δόση (med_key+slot) σήμερα."""
    return await PatientRxRepository(tenant_id=ctx.tenant_id).delete_intake(ctx.patient_ref, body.med_key, body.slot)


class ReserveIn(BaseModel):
    med_name: str


@router.post("/meds/reserve")
async def meds_reserve(body: ReserveIn, ctx: PatientContext = Depends(get_patient_context)):
    """Κράτηση επανάληψης (click-&-collect) → πέφτει στο worklist του φαρμακείου."""
    from app.repositories.patient_portal import PatientAccountRepository
    acc = await PatientAccountRepository().get(ctx.account_id)
    name = f"{(acc or {}).get('first_name', '')} {(acc or {}).get('last_name', '')}".strip()
    return await PatientRxRepository(tenant_id=ctx.tenant_id).reserve_refill(
        account_id=ctx.account_id, patient_ref=ctx.patient_ref, med_name=body.med_name, patient_name=name)


class SlotTimesIn(BaseModel):
    morning: str | None = None
    noon: str | None = None
    evening: str | None = None
    night: str | None = None


@router.post("/meds/times")
async def meds_times(body: SlotTimesIn, ctx: PatientContext = Depends(get_patient_context)):
    """Προσωποποιημένες ώρες λήψης (πρωί/μεσημέρι/βράδυ/νύχτα)."""
    return await PatientRxRepository(tenant_id=ctx.tenant_id).set_slot_times(ctx.patient_ref, body.model_dump())


# ── Κατάστημα φαρμακείου (OTC + παραφάρμακα) — παραγγελία στο δικό σου φαρμακείο ──────────────
@router.get("/shop")
async def shop(q: str = "", category: str | None = None, type: str | None = None,
               tag: str | None = None, sort: str = "featured",
               ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    # in_stock_only=False → δείχνουμε ΚΑΙ τα «κατόπιν παραγγελίας» (χωρίς απόθεμα)· ο πελάτης τα
    # παραγγέλνει ως αίτημα και ο φαρμακοποιός εγκρίνει/απορρίπτει + δηλώνει ημερομηνία.
    return await PharmacyCatalogRepository(tenant_id=ctx.tenant_id).list(
        q=q, category=category, ptype=type, tag=tag, sort=sort, in_stock_only=False, page_size=60)


class ShopFavIn(BaseModel):
    barcode: str


@router.post("/shop/favorite")
async def shop_favorite(body: ShopFavIn, ctx: PatientContext = Depends(get_patient_context)):
    """Αγαπημένο προϊόν (toggle) — ειδοποιήσεις για πτώση τιμής / επιστροφή σε απόθεμα."""
    from app.repositories.patient_portal import PatientAccountRepository
    fav = await PatientAccountRepository().toggle_shop_favorite(ctx.account_id, ctx.tenant_id, body.barcode.strip())
    return {"favorite": fav}


@router.get("/shop/favorites")
async def shop_favorites(ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.patient_portal import PatientAccountRepository
    repo = PatientAccountRepository()
    return {"items": await repo.shop_favorites(ctx.account_id, ctx.tenant_id),
            "barcodes": await repo.shop_favorite_barcodes(ctx.account_id, ctx.tenant_id)}


@router.get("/shop/meta")
async def shop_meta(ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    from app.repositories.orders_delivery import OrdersDeliveryRepository
    from app.repositories.shop_campaigns import ShopCampaignRepository
    from app.repositories.loyalty import LoyaltyRepository
    cat = PharmacyCatalogRepository(tenant_id=ctx.tenant_id)
    settings = await OrdersDeliveryRepository(tenant_id=ctx.tenant_id).settings()
    camps = await ShopCampaignRepository(tenant_id=ctx.tenant_id).active_now()
    # Πόντοι: υπόλοιπο + ελάχιστη εξαργύρωση (το καλάθι δείχνει «διαθέσιμα X €»).
    loyalty = {"enabled": False, "balance_cents": 0, "min_redeem_cents": 0}
    try:
        lrepo = LoyaltyRepository(tenant_id=ctx.tenant_id)
        lcfg = await lrepo.config()
        if lcfg.get("enabled"):
            m = await lrepo.member(ctx.patient_ref) if ctx.patient_ref else None
            loyalty = {"enabled": True, "balance_cents": int((m or {}).get("balance_cents") or 0),
                       "min_redeem_cents": int(lcfg.get("min_redeem_cents") or 0),
                       "member": bool(m)}
    except Exception:  # noqa: BLE001
        pass
    from app.repositories.shop_promos import ShopBundleRepository
    bundles = await ShopBundleRepository(tenant_id=ctx.tenant_id).active_now()
    return {"categories": await cat.categories(), "tags": await cat.tags(), "settings": settings,
            "campaigns": [{"name": c.get("name"), "discount_pct": c.get("discount_pct"),
                           "categories": c.get("categories") or [], "tags": c.get("tags") or []}
                          for c in camps],
            "bundles": [{"name": b.get("name"), "kind": b.get("kind"), "barcode": b.get("barcode"),
                         "buy_qty": b.get("buy_qty"), "free_qty": b.get("free_qty"),
                         "lines": b.get("lines") or [], "discount_pct": b.get("discount_pct")}
                        for b in bundles],
            "loyalty": loyalty}


class CouponCheckIn(BaseModel):
    code: str = Field(..., max_length=32)
    eligible_cents: int = Field(0, ge=0)


@router.post("/shop/coupon/check")
async def check_coupon(body: CouponCheckIn, ctx: PatientContext = Depends(get_patient_context)):
    """Προέλεγχος κουπονιού για το καλάθι. Η ΤΕΛΙΚΗ ισχύς κρίνεται ξανά κατά την παραγγελία."""
    from app.repositories.shop_promos import ShopCouponRepository
    from app.services.shop_pricing import coupon_discount
    v = await ShopCouponRepository(tenant_id=ctx.tenant_id).validate(body.code, body.eligible_cents)
    if not v.get("ok"):
        return v
    c = v["coupon"]
    return {"ok": True, "code": c["code"], "kind": c["kind"], "value": c["value"],
            "discount_cents": coupon_discount(c, body.eligible_cents)}


class AddressIn(BaseModel):
    street: str | None = None
    area: str | None = None
    postal: str | None = None
    phone: str | None = None
    notes: str | None = None


class OrderLineIn(BaseModel):
    barcode: str
    qty: int = 1


class CourierAuthIn(BaseModel):
    """Στοιχεία εξουσιοδοτούμενου — ΜΟΝΟ για αποστολή με μεταφορέα (η παραλαβή από το
    κατάστημα δεν χρειάζεται εξουσιοδότηση)."""
    name: str = Field(..., min_length=3, max_length=120)        # ονοματεπώνυμο
    id_number: str = Field(..., min_length=4, max_length=40)    # αρ. ταυτότητας ή διαβατηρίου


class CartSyncIn(BaseModel):
    lines: list[OrderLineIn] = []


@router.post("/shop/cart")
async def sync_cart(body: CartSyncIn, ctx: PatientContext = Depends(get_patient_context)):
    """Αντίγραφο του ενεργού καλαθιού (barcode+qty) → επιτρέπει υπενθύμιση «ξεχασμένου καλαθιού»."""
    from app.repositories.orders_delivery import OrdersDeliveryRepository
    return await OrdersDeliveryRepository(tenant_id=ctx.tenant_id).save_cart(
        ctx.account_id, [ln.model_dump() for ln in body.lines])


class OrderIn(BaseModel):
    lines: list[OrderLineIn]
    mode: str = "delivery"                  # delivery | pickup
    address: AddressIn | None = None
    courier_authorized: bool = False
    courier_auth: CourierAuthIn | None = None
    loyalty_redeem_cents: int = Field(0, ge=0)   # εξαργύρωση πόντων (μόνο σε μη-συνταγογραφούμενα)
    coupon_code: str | None = Field(None, max_length=32)
    gdpr_consent: bool = False
    repeat_days: int = 0                     # 0 = εφάπαξ· >0 = συνδρομή κάθε N ημέρες


@router.post("/shop/order")
async def place_order(body: OrderIn, ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.patient_portal import PatientAccountRepository
    from app.repositories.orders_delivery import OrdersDeliveryRepository
    acc = await PatientAccountRepository().get(ctx.account_id)
    name = f"{(acc or {}).get('first_name', '')} {(acc or {}).get('last_name', '')}".strip()
    phone = (body.address.phone if body.address else None) or (acc or {}).get("phone") or ""
    repo = OrdersDeliveryRepository(tenant_id=ctx.tenant_id)
    addr = body.address.model_dump() if body.address else None
    st = await repo.settings()
    sub_disc = st.get("subscription_discount_pct", 0) if body.repeat_days > 0 else 0
    cauth = body.courier_auth.model_dump() if body.courier_auth else None
    res = await repo.create_order(
        account_id=ctx.account_id, patient_ref=ctx.patient_ref, patient_name=name, patient_phone=phone,
        lines=[ln.model_dump() for ln in body.lines], mode=body.mode, address=addr,
        courier_authorized=body.courier_authorized, courier_auth=cauth,
        loyalty_redeem_cents=body.loyalty_redeem_cents, coupon_code=body.coupon_code,
        gdpr_consent=body.gdpr_consent, sub_discount_pct=sub_disc)
    if res.get("ok") and body.repeat_days > 0 and st.get("subscription_enabled", True):
        sub = await repo.create_subscription(
            account_id=ctx.account_id, patient_ref=ctx.patient_ref, patient_name=name, patient_phone=phone,
            lines=[ln.model_dump() for ln in body.lines], mode=body.mode, address=addr,
            courier_authorized=body.courier_authorized, courier_auth=cauth,
            interval_days=body.repeat_days)
        res["subscription_id"] = sub.get("subscription_id")
    return res


@router.get("/shop/orders")
async def my_orders(ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.orders_delivery import OrdersDeliveryRepository
    return {"items": await OrdersDeliveryRepository(tenant_id=ctx.tenant_id).my_orders(ctx.account_id)}


@router.get("/shop/subscriptions")
async def my_subscriptions(ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.orders_delivery import OrdersDeliveryRepository
    return {"items": await OrdersDeliveryRepository(tenant_id=ctx.tenant_id).my_subscriptions(ctx.account_id)}


@router.post("/shop/subscriptions/{sub_id}/cancel")
async def cancel_subscription(sub_id: str, ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.orders_delivery import OrdersDeliveryRepository
    return await OrdersDeliveryRepository(tenant_id=ctx.tenant_id).cancel_subscription(sub_id, ctx.account_id)


@router.get("/pharmacy-hours")
async def pharmacy_hours(ctx: PatientContext = Depends(get_patient_context)):
    """Ζωντανή κατάσταση (ανοιχτό/κλειστό/εφημερία) + εβδομαδιαίο ωράριο του ενεργού φαρμακείου."""
    from app.repositories.pharmacy_availability import PharmacyAvailabilityRepository
    repo = PharmacyAvailabilityRepository(tenant_id=ctx.tenant_id)
    return {"status": await repo.status(), "schedule": await repo.get_schedule()}


@router.get("/renewals")
async def my_renewals(ctx: PatientContext = Depends(get_patient_context)):
    """Διαθέσιμες ανανεώσεις: χρόνιες επαναλαμβανόμενες συνταγές που μπορούν να εκτελεστούν τώρα
    στο ενεργό φαρμακείο (ώστε ο ασθενής να μην ξεχάσει την επανάληψη)."""
    det = await AdvisorRepository(tenant_id=ctx.tenant_id).recall_detail(str(ctx.patient_ref))
    items = []
    for c in det.get("chains", []):
        if c.get("available"):
            since = next((w["due"] for w in c.get("windows", []) if w.get("status") == "available"), None)
            items.append({"key": c.get("key"), "medicine": c.get("medicine"),
                          "doctor": c.get("doctor"), "available": c["available"],
                          "since": since, "intent": c.get("intent")})
    return {"items": items}


class RenewalRespondIn(BaseModel):
    key: str
    decision: str                  # "take" (θα το πάρω) | "skip" (δεν θα το πάρω)
    visit_date: str | None = None  # ISO ημερομηνία επίσκεψης (αν θα το πάρει)
    reason: str | None = None      # λόγος (αν δεν θα το πάρει)


@router.post("/renewals/respond")
async def respond_renewal(body: RenewalRespondIn, ctx: PatientContext = Depends(get_patient_context)):
    """Ο ασθενής δηλώνει αν θα παραλάβει την ανανέωση (+ημ/νία επίσκεψης) ή όχι (+λόγο) — ώστε
    ο φαρμακοποιός να προγραμματίσει παραγγελία/διαθεσιμότητα/παράδοση."""
    from bson import ObjectId
    from bson.errors import InvalidId
    if body.decision not in ("take", "skip"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_decision")
    try:
        pref = ObjectId(ctx.patient_ref)
    except (InvalidId, TypeError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_patient")
    await shared_db()["renewal_intents"].update_one(
        {"tenant_id": ctx.tenant_id, "patient_ref": pref, "key": body.key},
        {"$set": {"decision": body.decision,
                  "visit_date": (body.visit_date or None) if body.decision == "take" else None,
                  "reason": (body.reason or None) if body.decision == "skip" else None,
                  "account_id": ctx.account_id, "updated_at": datetime.now(tz=timezone.utc)}},
        upsert=True)
    return {"ok": True}


@router.get("/prescriptions/{barcode}")
async def prescription_detail(barcode: str, tenant_id: str | None = None,
                              ctx: PatientContext = Depends(get_patient_context)):
    """Λεπτομέρειες ΜΙΑΣ εκτέλεσης. Με `tenant_id` ανοίγει εκτέλεση άλλου φαρμακείου του πελάτη —
    ΜΟΝΟ αν είναι όντως linked εκεί (αλλιώς 403) και μόνο τη ΔΙΚΗ ΤΟΥ καρτέλα (patient_ref του link)."""
    tid, pref = ctx.tenant_id, ctx.patient_ref
    if tenant_id and tenant_id != ctx.tenant_id:
        link = await PatientAccountRepository().link_for(ctx.account_id, tenant_id)
        if not link:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "not_linked_to_pharmacy")
        tid, pref = tenant_id, str(link["patient_ref"])
    d = await PatientRxRepository(tenant_id=tid).my_prescription_detail(pref, barcode)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return d


# ── μεταφορά σε άλλο φαρμακείο — ο ΠΕΛΑΤΗΣ εγκρίνει (το αίτημα το κάνει το νέο φαρμακείο) ──
@router.get("/transfers")
async def my_transfers(ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.patient_transfer import PatientTransferRepository
    return {"items": await PatientTransferRepository().pending_for_account(ctx.account_id)}


class TransferDecideIn(BaseModel):
    transfer_id: str = Field(..., max_length=40)
    accept: bool


@router.post("/transfers/decide")
async def decide_transfer(body: TransferDecideIn, ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.patient_transfer import PatientTransferRepository
    res = await PatientTransferRepository().decide(body.transfer_id, ctx.account_id, body.accept)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, res.get("error", "failed"))
    return res


@router.get("/notifications")
async def notifications(ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PatientAccountRepository().notifications(ctx.account_id)}


class NotifDismissIn(BaseModel):
    id: str = Field(..., max_length=120)


@router.post("/notifications/dismiss")
async def dismiss_notification(body: NotifDismissIn, ctx: PatientContext = Depends(get_patient_context)):
    """«Το είδα» — να μην ξαναεμφανιστεί αυτή η ειδοποίηση."""
    return {"ok": await PatientAccountRepository().dismiss_notification(ctx.account_id, body.id)}


class PickupIntentIn(BaseModel):
    id: str = Field(..., max_length=120)     # notif id (av-<reqid>)
    coming: bool = True                       # θα περάσω να το πάρω;
    date: str | None = None                   # ISO ημερομηνία (YYYY-MM-DD), προαιρετικά


@router.post("/notifications/pickup")
async def notification_pickup(body: PickupIntentIn, ctx: PatientContext = Depends(get_patient_context)):
    """Απάντηση διαθεσιμότητας: ο ασθενής δηλώνει αν θα περάσει να το πάρει (+πότε)."""
    ok = await PatientAccountRepository().set_pickup_intent(
        ctx.account_id, body.id, coming=body.coming, date=body.date)
    if not ok:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_notif")
    return {"ok": True}


# ── web push (VAPID) — phone notifications even when the app is closed ──
class PushKeys(BaseModel):
    p256dh: str = Field(..., max_length=200)
    auth: str = Field(..., max_length=100)


class PushSubIn(BaseModel):
    endpoint: str = Field(..., max_length=1000)
    keys: PushKeys


class PushUnsubIn(BaseModel):
    endpoint: str = Field(..., max_length=1000)


@router.get("/push/key")
async def push_key(ctx: PatientContext = Depends(get_patient_context)):
    from app.core.config import settings
    from app.services import push_service
    return {"public_key": settings.VAPID_PUBLIC_KEY, "enabled": push_service.enabled()}


@router.post("/push/subscribe", status_code=201)
async def push_subscribe(body: PushSubIn, ctx: PatientContext = Depends(get_patient_context)):
    from app.services import push_service
    return {"ok": await push_service.save_subscription(ctx.account_id, body.model_dump())}


@router.post("/push/unsubscribe")
async def push_unsubscribe(body: PushUnsubIn, ctx: PatientContext = Depends(get_patient_context)):
    from app.services import push_service
    await push_service.remove_subscription(body.endpoint, account_id=ctx.account_id)
    return {"ok": True}


# ── pharmacy directory (nearby) + medicine catalogue ─────────
@router.get("/pharmacies/nearby")
async def nearby(lat: float, lon: float, ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PatientAccountRepository().nearby_pharmacies(lat, lon)}


@router.get("/pharmacies/directory")
async def pharmacies_directory(ctx: PatientContext = Depends(get_patient_context)):
    """Κατάλογος ΟΛΩΝ των φαρμακείων του δικτύου (με ενεργή πύλη) + κατάσταση + «δικό μου»/«αγαπημένο»."""
    repo = PatientAccountRepository()
    linked = {l["tenant_id"] for l in await repo.links(ctx.account_id)}
    acc = await repo.get(ctx.account_id)
    fav = (acc or {}).get("favorite_tenant_id")
    items = await repo.directory(linked_ids=linked, favorite_id=fav)
    if await portal_mode() == "single":   # single: μόνο το φαρμακείο εγγραφής (κλειδώνει PharmacyPicker)
        items = [p for p in items if p.get("tenant_id") == ctx.tenant_id]
    return {"items": items, "favorite": fav, "active_tenant": ctx.tenant_id}


class FavoriteIn(BaseModel):
    tenant_id: str = Field(..., max_length=80)


@router.post("/pharmacies/favorite")
async def set_favorite_pharmacy(body: FavoriteIn, ctx: PatientContext = Depends(get_patient_context)):
    """Δήλωση/αναίρεση «αγαπημένου» φαρμακείου (toggle) — γίνεται προεπιλεγμένο active στο login."""
    return {"favorite": await PatientAccountRepository().set_favorite(ctx.account_id, body.tenant_id)}


@router.get("/medicines/search")
async def medicines_search(q: str, ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PatientAccountRepository().search_medicines(q)}


@router.get("/medicines/by-barcode")
async def medicine_by_barcode(code: str, ctx: PatientContext = Depends(get_patient_context)):
    m = await PatientAccountRepository().medicine_by_barcode(code)
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "medicine_not_found")
    return m


async def _target(ctx: PatientContext, body_tenant: str | None):
    """Resolve (target_tenant, patient_ref|None, name, phone) for a request to a CHOSEN pharmacy
    (may be a nearby one where the patient has no history → patient_ref is None, contact is used)."""
    repo = PatientAccountRepository()
    target = body_tenant or ctx.tenant_id
    if body_tenant and body_tenant != ctx.tenant_id and not await repo.pharmacy_has_portal(target):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "pharmacy_unavailable")
    acc = await repo.get(ctx.account_id) or {}
    link = await repo.link_for(ctx.account_id, target)
    pref = str(link["patient_ref"]) if link and link.get("patient_ref") else None
    name = f"{acc.get('first_name', '')} {acc.get('last_name', '')}".strip()
    return target, pref, name, acc.get("phone", "")


# ── services / availability / appointments (active OR chosen pharmacy) ──
@router.get("/services")
async def services(tenant_id: str | None = None, ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PharmacyServiceRepository(tenant_id=tenant_id or ctx.tenant_id).list_active()}


@router.post("/availability", status_code=201)
async def ask_availability(body: AvailabilityIn, ctx: PatientContext = Depends(get_patient_context)):
    qtext = body.medicine_name or body.query
    if not qtext or len(qtext.strip()) < 2:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "medicine_or_query_required")
    target, pref, name, phone = await _target(ctx, body.tenant_id)
    rid = await AvailabilityRepository(tenant_id=target).create(
        account_id=ctx.account_id, query=qtext, patient_ref=pref, patient_name=name,
        patient_phone=phone, medicine_barcode=body.medicine_barcode, medicine_name=body.medicine_name)
    return {"id": rid, "status": "open"}


@router.get("/availability")
async def my_availability(ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PatientAccountRepository().my_availability(ctx.account_id)}


@router.post("/appointments", status_code=201)
async def book_appointment(body: AppointmentIn, ctx: PatientContext = Depends(get_patient_context)):
    target, pref, name, phone = await _target(ctx, body.tenant_id)
    aid = await AppointmentRepository(tenant_id=target).create(
        account_id=ctx.account_id, service_id=body.service_id, service_name=body.service_name,
        requested_at=body.requested_at, note=body.note, patient_ref=pref,
        patient_name=name, patient_phone=phone, kind=body.kind)
    return {"id": aid, "status": "requested"}


@router.get("/appointments")
async def my_appointments(ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await PatientAccountRepository().my_appointments(ctx.account_id)}


# ── «Ανάθεση συνταγής» — by barcode OR a photo of the doctor's Rx ───────────
class RxRequestIn(BaseModel):
    barcode: str
    note: str | None = None
    tenant_id: str | None = None


@router.post("/rx-request", status_code=201)
async def rx_request_barcode(body: RxRequestIn, ctx: PatientContext = Depends(get_patient_context)):
    bc = (body.barcode or "").strip()
    if len(bc) < 4:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "barcode_required")
    target, pref, name, phone = await _target(ctx, body.tenant_id)
    # live ΗΔΥΚΑ check via the pharmacy's own connection — verify + enrich the barcode
    cda = await lookup_prescription(target, bc)
    rid = await RxRequestRepository(tenant_id=target).create(
        account_id=ctx.account_id, patient_ref=pref, patient_name=name, patient_phone=phone,
        kind="barcode", barcode=bc, note=body.note, cda=cda)
    return {"id": rid, "status": "new", "cda": cda}


_MAX_RX_PHOTO = 12 * 1024 * 1024
_RX_PHOTO_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"}


@router.post("/rx-request/photo", status_code=201)
async def rx_request_photo(file: UploadFile = File(...), note: str | None = Form(None),
                           tenant_id: str | None = Form(None),
                           ctx: PatientContext = Depends(get_patient_context)):
    if (file.content_type or "") not in _RX_PHOTO_TYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "bad_type")
    content = await file.read(_MAX_RX_PHOTO + 1)   # bounded read → no unbounded memory
    if len(content) > _MAX_RX_PHOTO:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "too_large")
    target, pref, name, phone = await _target(ctx, tenant_id)
    rid = await RxRequestRepository(tenant_id=target).create(
        account_id=ctx.account_id, patient_ref=pref, patient_name=name, patient_phone=phone,
        kind="photo", note=note, image=content, content_type=file.content_type)
    return {"id": rid, "status": "new"}


@router.get("/rx-requests")
async def my_rx_requests(ctx: PatientContext = Depends(get_patient_context)):
    return {"items": await RxRequestRepository(tenant_id=ctx.tenant_id).mine(ctx.account_id)}


# ── οι μετρήσεις μου (πίεση/ζάχαρο/βάρος + ύψος) ────────────────────────────
@router.get("/health")
async def my_health(ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.contacts import PatientContactRepository
    repo = PatientContactRepository(tenant_id=ctx.tenant_id)
    contact = await repo.get(ctx.patient_ref) or {}
    meas = await repo.measurements(ctx.patient_ref)
    return {"height_cm": contact.get("height_cm"), **meas}


# ── loyalty wallet (πορτοφόλι επιβράβευσης) ────────────────────────────────
@router.get("/loyalty")
async def my_loyalty(ctx: PatientContext = Depends(get_patient_context)):
    from app.repositories.loyalty import LoyaltyRepository
    repo = LoyaltyRepository(tenant_id=ctx.tenant_id)
    cfg = await repo.config()
    if not cfg.get("enabled"):
        return {"enabled": False}
    if not await repo.is_enrolled(ctx.patient_ref):
        return {"enabled": True, "enrolled": False, "terms": cfg.get("terms")}
    member = await repo.member(ctx.patient_ref)
    rewards = await repo.rewards(only_active=True)
    return {"enabled": True, "enrolled": True, "member": member, "rewards": rewards, "terms": cfg.get("terms")}


@router.post("/loyalty/join", status_code=201)
async def join_loyalty(ctx: PatientContext = Depends(get_patient_context)):
    """Patient accepts the terms electronically and joins the programme."""
    from app.repositories.loyalty import LoyaltyRepository
    repo = LoyaltyRepository(tenant_id=ctx.tenant_id)
    cfg = await repo.config()
    if not cfg.get("enabled"):
        raise HTTPException(status.HTTP_409_CONFLICT, "loyalty_off")
    return await repo.enroll(ctx.patient_ref, method="electronic")
