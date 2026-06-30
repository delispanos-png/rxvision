"""Back-office (platform) admin — cross-tenant tenants list + sync health.

These endpoints intentionally read ACROSS tenants (platform view), so they use the
shared DB directly rather than a tenant-scoped repository. Gated on a CloudOn
platform-admin token (`padmin`) — NEVER a tenant `owner` role.
"""

from __future__ import annotations

import re
import secrets
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status as http_status
from pydantic import BaseModel, EmailStr, Field

from app.core.db import shared_db
from app.core.deps import PlatformContext, get_platform_admin
from app.core.security import hash_password
from app.repositories.base import jsonsafe
from app.services import email_template, mailer
from app.services.auth_service import AuthService, resolve_modules
from app.services.provisioning import ProvisioningError, TenantProvisioningService
from app.services.vault_service import vault
from app.services.wholesale import DEFAULT_BANDS, load_bands, recompute, sanitize_bands


def _oid(value):
    try:
        return ObjectId(value)
    except Exception:  # noqa: BLE001
        return value


# ── per-section access control for CloudOn staff ───────────
# Canonical sidebar sections (key → ελληνική ετικέτα for the UI).
ADMIN_SECTIONS = [
    ("dashboard", "Πίνακας"), ("subscribers", "Συνδρομητές"), ("subscriptions", "Συνδρομές"),
    ("staff", "Χρήστες (staff)"), ("billing", "Τιμολόγηση"), ("newsletter", "Newsletter"),
    ("smtp", "Ρυθμίσεις SMTP"), ("idika", "Διασύνδεση ΗΔΥΚΑ"),
    ("content", "Περιεχόμενο"), ("maintenance", "Συντήρηση"), ("health", "Επισκεψιμότητα"),
]
ADMIN_SECTION_KEYS = [k for k, _ in ADMIN_SECTIONS]
# URL segment (μετά το /admin/) → section key
_SEG_TO_SECTION = {
    "tenants": "subscribers", "packages": "subscribers", "subscriptions": "subscriptions",
    "staff": "staff", "billing": "billing", "invoices": "billing",
    "newsletter": "newsletter", "smtp": "smtp",
    "idika": "idika", "posts": "content", "maintenance": "maintenance",
    "health": "health", "sync-health": "health",
}
# read-only endpoints που χρειάζεται και ο «dashboard»-only χρήστης
_DASHBOARD_GET = {"tenants", "packages", "sync-health"}


async def enforce_section(request: Request,
                          ctx: PlatformContext = Depends(get_platform_admin)) -> PlatformContext:
    """Router-wide gate: super_admin → όλα· αλλιώς ο χρήστης πρέπει να έχει το section.
    Legacy admins χωρίς πεδίο permissions θεωρούνται πλήρους πρόσβασης."""
    admin = await shared_db()["platform_admins"].find_one({"_id": _oid(ctx.admin_id)})
    if not admin:
        raise HTTPException(http_status.HTTP_403_FORBIDDEN, "forbidden")
    perms = admin.get("permissions")
    if admin.get("super_admin") or perms is None:        # super ή legacy → full
        return ctx
    m = re.search(r"/admin/([^/?]+)", request.url.path)
    seg = m.group(1) if m else ""
    section = _SEG_TO_SECTION.get(seg)
    if section is None:                                   # unmapped misc → allow
        return ctx
    allowed = {section}
    if request.method == "GET" and seg in _DASHBOARD_GET:
        allowed.add("dashboard")
    if any(a in perms for a in allowed):
        return ctx
    raise HTTPException(http_status.HTTP_403_FORBIDDEN,
                        {"error": "forbidden_section", "section": section})


router = APIRouter(dependencies=[Depends(enforce_section)])


class OpenTenantIn(BaseModel):
    name: str
    owner_email: EmailStr
    package_code: str
    owner_name: str | None = None
    owner_password: str | None = None  # if omitted, a temp password is generated & returned
    billing_cycle: str | None = None   # monthly | yearly
    sla: str | None = None
    company: dict | None = None        # ΑΑΔΕ company profile (afm/doy/address/city/…)
    modules: list[str] | None = None   # capabilities to grant (overrides the package's base set)
    seats: int | None = None           # ταυτόχρονοι χρήστες (≥ package included seats)
    payment_method: str | None = None  # card | bank


class StatusIn(BaseModel):
    status: str  # "active" | "suspended"


class TenantEditIn(BaseModel):
    name: str | None = None
    demo: bool | None = None        # «πελάτης παρουσίασης» → απόκρυψη PII (ισχύει στο επόμενο login)


class InvoiceIn(BaseModel):
    tenant_id: str
    doc_type: str = "ΤΠΥ"          # τύπος παραστατικού
    series: str = "Α"             # σειρά
    issue_date: str | None = None  # ISO· default σήμερα
    description: str = ""
    net_amount: int = 0            # καθαρή αξία σε cents
    vat_rate: float = 24.0


class InvoiceEditIn(BaseModel):
    doc_type: str | None = None
    series: str | None = None
    issue_date: str | None = None
    description: str | None = None
    net_amount: int | None = None
    vat_rate: float | None = None


# tenant-scoped collections wiped on hard delete
_TENANT_COLLECTIONS = ["subscriptions", "users", "roles", "audit_logs", "doctors",
                       "future_prescriptions", "patients_anonymized", "pharmacyone_sales",
                       "prescription_executions", "prescription_items", "products",
                       "sellers", "sync_jobs", "icd10_codes", "insurance_funds"]


class StaffIn(BaseModel):
    email: EmailStr
    full_name: str
    password: str | None = None  # if omitted, a temp password is generated & returned
    super_admin: bool = False
    permissions: list[str] = []  # section keys (αγνοείται αν super_admin)


class ResetPwIn(BaseModel):
    # None → server generates a random temp password; else set this exact one.
    password: str | None = Field(None, min_length=8)


class StaffEditIn(BaseModel):
    full_name: str | None = None
    email: EmailStr | None = None
    super_admin: bool | None = None
    permissions: list[str] | None = None


def _clean_perms(perms: list[str] | None) -> list[str]:
    return [p for p in (perms or []) if p in ADMIN_SECTION_KEYS]


class SmtpIn(BaseModel):
    host: str
    port: int = 587
    username: str | None = None
    password: str | None = None  # blank keeps the stored one
    from_email: EmailStr
    from_name: str = "RxVision"
    use_tls: bool = True


class TestEmailIn(BaseModel):
    to: EmailStr | None = None


class NewsletterIn(BaseModel):
    subject: str
    body_html: str
    preheader: str = ""               # inbox preview text (boosts open rate)
    segment: str = "all"  # all | active | trial | past_due


class NewsletterPreviewIn(BaseModel):
    subject: str = ""
    body_html: str = ""
    preheader: str = ""


class NewsletterTestIn(BaseModel):
    to: EmailStr
    subject: str
    body_html: str
    preheader: str = ""


_SEGMENTS = {"all", "active", "trial", "past_due"}
_POST_TYPES = {"article", "news", "wiki"}


class PostIn(BaseModel):
    type: str  # article | news | wiki
    title: str
    body: str = ""
    status: str = "draft"  # draft | published


class PostUpdateIn(BaseModel):
    title: str | None = None
    body: str | None = None
    status: str | None = None


class MaintenanceIn(BaseModel):
    enabled: bool
    message: str = ""


# ── platform-level ΗΔΥΚΑ integrator config (CloudOn, shared by all tenants) ──
_IDIKA_DEFAULTS = {
    "test": "https://testeps.e-prescription.gr/pharmapiv2",
    "production": "https://eps.e-prescription.gr/pharmacistapi",
}


class IdikaEnvIn(BaseModel):
    base_url: str | None = None
    api_key: str | None = None              # TEST sandbox key (secret); prod key is per-pharmacy
    integrator_username: str | None = None  # TEST sandbox account (Basic auth); prod is per-pharmacy
    integrator_password: str | None = None  # secret → masked on GET, kept on empty (merge)
    pharmacy_id: str | None = None          # TEST sandbox pharmacy id (e.g. 11316)


class IdikaIn(BaseModel):
    active_environment: str = "test"  # test | production
    doctor_ip: str | None = None
    test: IdikaEnvIn = IdikaEnvIn()
    production: IdikaEnvIn = IdikaEnvIn()




async def _newsletter_recipients(db, segment: str) -> list[dict]:
    """Owner recipients of tenants in the segment, with merge-tag fields
    {email, name, pharmacy, tenant_id} for personalization."""
    owner_role_ids = [r["_id"] async for r in db["roles"].find({"key": "owner"})]
    if segment == "all":
        tenant_ids = None
    else:
        tenant_ids = [s["tenant_id"] async for s in
                      db["subscriptions"].find({"status": segment})]
    names = {t["_id"]: t.get("name", "") async for t in db["tenants"].find({})}
    q: dict = {"role_ids": {"$in": owner_role_ids}, "status": "active"}
    if tenant_ids is not None:
        q["tenant_id"] = {"$in": tenant_ids}
    seen, out = set(), []
    async for u in db["users"].find(q):
        e = u.get("email")
        if e and e not in seen:
            seen.add(e)
            out.append({"email": e, "name": u.get("full_name", ""),
                        "pharmacy": names.get(u.get("tenant_id"), ""),
                        "tenant_id": u.get("tenant_id")})
    return out


def _days_until(when, now: datetime) -> int | None:
    if not when:
        return None
    if isinstance(when, str):                       # handles ISO strings
        try:
            when = datetime.fromisoformat(when.replace("Z", "+00:00"))
        except ValueError:
            return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return (when - now).days


@router.get("/tenants")
async def tenants(_: PlatformContext = Depends(get_platform_admin)):
    """All tenants + plan/status/users/MRR for the back-office customer table."""
    db = shared_db()
    subs = {s["tenant_id"]: s async for s in db["subscriptions"].find({})}
    user_counts: dict[str, int] = {}
    async for row in db["users"].aggregate([{"$group": {"_id": "$tenant_id", "n": {"$sum": 1}}}]):
        user_counts[row["_id"]] = row["n"]
    # concurrent active users = distinct users seen in the last 5 minutes, per tenant
    cutoff = datetime.now(tz=timezone.utc) - timedelta(minutes=5)
    active_now: dict[str, int] = {}
    async for row in db["users"].aggregate([
        {"$match": {"last_active_at": {"$gte": cutoff}}},
        {"$group": {"_id": "$tenant_id", "n": {"$sum": 1}}},
    ]):
        active_now[row["_id"]] = row["n"]

    items = []
    async for t in db["tenants"].find({}).sort("created_at", -1):
        sub = subs.get(t["_id"], {})
        pharmacies = (sub.get("limits") or {}).get("pharmacies", 1) or 1
        mrr = (sub.get("price_per_pharmacy") or 0) * pharmacies
        items.append({
            "id": t["_id"],
            "name": t.get("name", t["_id"]),
            "plan": sub.get("plan", "—"),
            "status": sub.get("status", t.get("status", "—")),
            "users": user_counts.get(t["_id"], 0),
            "active_now": active_now.get(t["_id"], 0),
            "seats": sub.get("seats") or pharmacies,
            "mrr": mrr,
            "created_at": t.get("created_at"),
        })
    return {"items": jsonsafe(items)}


@router.get("/subscriptions")
async def subscriptions(_: PlatformContext = Depends(get_platform_admin)):
    """All tenant subscriptions with expiry/trial/renewal signals (concept: Συνδρομές).

    `days_to_expiry` < 0 = ληγμένη· 0..30 = λήγει σύντομα· trial_days_left for trials.
    """
    db = shared_db()
    now = datetime.now(tz=timezone.utc)
    names = {t["_id"]: t.get("name", t["_id"]) async for t in db["tenants"].find({})}
    created = {t["_id"]: t.get("created_at") async for t in db["tenants"].find({}, {"created_at": 1})}
    active_now: dict[str, int] = {}
    async for row in db["users"].aggregate([
        {"$match": {"last_active_at": {"$gte": now - timedelta(minutes=5)}}},
        {"$group": {"_id": "$tenant_id", "n": {"$sum": 1}}},
    ]):
        active_now[row["_id"]] = row["n"]

    items = []
    async for s in db["subscriptions"].find({}):
        # skip orphan subscriptions (tenant deleted) so this view stays consistent
        # with «Συνδρομητές» (which lists tenants). Keeps counts in sync.
        if s["tenant_id"] not in names:
            continue
        pharmacies = (s.get("limits") or {}).get("pharmacies", 1) or 1
        d2e = _days_until(s.get("current_period_end"), now)
        trial_left = _days_until(s.get("trial_ends_at"), now)
        items.append({
            "tenant_id": s["tenant_id"],
            "tenant": names.get(s["tenant_id"], s["tenant_id"]),
            "plan": s.get("plan", "—"),
            "status": s.get("status", "—"),
            "billing_cycle": s.get("billing_cycle"),
            "seats": s.get("seats", pharmacies),
            "active_now": active_now.get(s["tenant_id"], 0),
            "mrr": (s.get("price_per_pharmacy") or 0) * pharmacies,
            "started_at": s.get("created_at") or created.get(s["tenant_id"]),
            "current_period_end": s.get("current_period_end"),
            "days_to_expiry": d2e,
            "trial_ends_at": s.get("trial_ends_at"),
            "trial_days_left": trial_left,
        })
    items.sort(key=lambda x: (x["days_to_expiry"] is None, x["days_to_expiry"] or 0))

    summary = {
        "total": len(items),
        "expiring_30d": sum(1 for x in items
                            if x["days_to_expiry"] is not None and 0 <= x["days_to_expiry"] <= 30),
        "expired": sum(1 for x in items
                       if x["days_to_expiry"] is not None and x["days_to_expiry"] < 0),
        "trials_ending_14d": sum(1 for x in items
                                 if x["status"] == "trial" and x["trial_days_left"] is not None
                                 and 0 <= x["trial_days_left"] <= 14),
        "past_due": sum(1 for x in items if x["status"] == "past_due"),
        "mrr": sum(x["mrr"] for x in items if x["status"] in ("active", "past_due")),
    }
    return {"items": jsonsafe(items), "summary": summary}


@router.get("/subscriptions/{tenant_id}")
async def subscription_detail(tenant_id: str, _: PlatformContext = Depends(get_platform_admin)):
    """Full subscription card: plan/cycle/dates/costs + concurrent users + issued invoices."""
    db = shared_db()
    s = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    t = await db["tenants"].find_one({"_id": tenant_id}) or {}
    pkg_code = str(s.get("plan") or "").split("-")[-1]
    pkg = await db["packages"].find_one({"_id": pkg_code}) or {}
    now = datetime.now(tz=timezone.utc)
    active_now = await db["users"].count_documents({
        "tenant_id": tenant_id, "last_active_at": {"$gte": now - timedelta(minutes=5)}})
    users = await db["users"].count_documents({"tenant_id": tenant_id})
    pharmacies = (s.get("limits") or {}).get("pharmacies", 1) or 1
    invoices = [_invoice_public(i, t.get("name"))
                async for i in db["invoices"].find({"tenant_id": tenant_id}).sort("created_at", -1)]
    return jsonsafe({
        "tenant_id": tenant_id, "tenant": t.get("name", tenant_id),
        "plan": s.get("plan"), "plan_name": s.get("plan_name") or pkg.get("name"),
        "status": s.get("status"), "billing_cycle": s.get("billing_cycle") or "monthly",
        "sla": s.get("sla"), "seats": s.get("seats", pharmacies),
        "users": users, "active_now": active_now,
        "price_per_pharmacy": s.get("price_per_pharmacy"),
        "mrr": (s.get("price_per_pharmacy") or 0) * pharmacies,
        # subscription-level override wins over the package default (admin can edit per-tenant)
        "extra_user_price": s.get("extra_user_price") if "extra_user_price" in s else pkg.get("extra_user_price"),
        "extra_user_price_yearly": s.get("extra_user_price_yearly") if "extra_user_price_yearly" in s else pkg.get("extra_user_price_yearly"),
        "started_at": s.get("started_at") or s.get("created_at") or t.get("created_at"),
        "current_period_end": s.get("current_period_end"),
        "trial_ends_at": s.get("trial_ends_at"),
        "invoices": invoices,
    })


class SubEditIn(BaseModel):
    billing_cycle: str | None = None
    price_per_pharmacy: int | None = None      # cents
    current_period_end: datetime | None = None
    trial_ends_at: datetime | None = None
    started_at: datetime | None = None         # έναρξη συνδρομής
    seats: int | None = None
    sla: str | None = None
    plan: str | None = None
    plan_name: str | None = None               # εμφανιζόμενο όνομα πλάνου
    extra_user_price: int | None = None        # cents/μήνα — override του πακέτου
    extra_user_price_yearly: int | None = None # cents/έτος — override του πακέτου
    status: str | None = None                  # active|suspended|cancelled|past_due|trial


@router.patch("/subscriptions/{tenant_id}")
async def edit_subscription(tenant_id: str, body: SubEditIn,
                            _: PlatformContext = Depends(get_platform_admin)):
    """Edit a subscription (cycle/price/dates/seats/sla/plan/status). A status change also
    flips the tenant active/suspended — so «απενεργοποίηση λόγω μη πληρωμής» blocks login."""
    db = shared_db()
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    if not await db["subscriptions"].find_one({"tenant_id": tenant_id}):
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "subscription_not_found")
    if upd:
        upd["updated_at"] = datetime.now(tz=timezone.utc)
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": upd})
        if body.status:
            tstatus = "active" if body.status in ("active", "trial", "past_due") else "suspended"
            await db["tenants"].update_one(  # tenant-ok: platform admin, explicit _id
                {"_id": tenant_id}, {"$set": {"status": tstatus, "updated_at": upd["updated_at"]}})
    return {"ok": True}


@router.get("/aade/{afm}")
async def admin_aade(afm: str, _: PlatformContext = Depends(get_platform_admin)):
    """ΑΑΔΕ company lookup for the admin «open tenant» wizard (auto-fill from ΑΦΜ)."""
    from app.services.aade_service import lookup
    return await lookup(afm)


@router.get("/packages")
async def packages(_: PlatformContext = Depends(get_platform_admin)):
    """Available subscription packages (code → modules/price/trial) for opening tenants."""
    db = shared_db()
    items = [p async for p in db["packages"].find({}).sort("price_monthly", 1)]
    return {"items": jsonsafe(items)}


class PackageIn(BaseModel):
    name: str | None = None
    description: str | None = None
    price_monthly: int | None = None  # cents
    price_yearly: int | None = None   # cents
    extra_user_price: int | None = None         # cents — cost per extra user/seat beyond `seats`, per MONTH
    extra_user_price_yearly: int | None = None   # cents — cost per extra user/seat beyond `seats`, per YEAR
    trial_days: int | None = None
    seats: int | None = None
    sla: str | None = None
    modules: list[str] | None = None  # the capabilities this package grants
    features: list[str] | None = None  # marketing bullet list shown on the pricing card
    available_addons: list[str] | None = None  # which à-la-carte add-ons are offered ON this package
    billing_cycles: list[str] | None = None  # offered cycles: ["monthly"], ["yearly"], or both
    active: bool | None = None


@router.put("/packages/{code}")
async def update_package(code: str, body: PackageIn,
                         _: PlatformContext = Depends(get_platform_admin)):
    """Create/edit a subscription package (name/pricing/trial/seats/SLA + the modules it grants)."""
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    db = shared_db()
    if upd:
        upd["updated_at"] = datetime.now(tz=timezone.utc)
        await db["packages"].update_one(  # tenant-ok: platform-level catalog, explicit _id
            {"_id": code}, {"$set": upd}, upsert=True)
    return {"ok": True, "package": jsonsafe(await db["packages"].find_one({"_id": code}))}


@router.delete("/packages/{code}")
async def delete_package(code: str, _: PlatformContext = Depends(get_platform_admin)):
    await shared_db()["packages"].delete_one({"_id": code})  # tenant-ok: platform catalog
    return {"ok": True}


# ── Add-ons catalog (à-la-carte modules sold on top of any plan) ──────────────
@router.get("/addons")
async def admin_addons(_: PlatformContext = Depends(get_platform_admin)):
    """Full add-on catalog (active + inactive). _id == the module key the add-on unlocks."""
    from app.services import addon_service
    return {"items": jsonsafe(await addon_service.catalog(active_only=False))}


class AddonIn(BaseModel):
    name: str | None = None
    description: str | None = None
    icon: str | None = None
    category: str | None = None            # "ai" | "consumer"
    price_monthly: int | None = None       # cents
    price_yearly: int | None = None        # cents
    features: list[str] | None = None
    active: bool | None = None


@router.put("/addons/{code}")
async def update_addon(code: str, body: AddonIn,
                       _: PlatformContext = Depends(get_platform_admin)):
    """Create/edit an add-on. `code` is the module key it unlocks (e.g. ai_assistant, loyalty)."""
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    db = shared_db()
    if upd:
        upd["updated_at"] = datetime.now(tz=timezone.utc)
        await db["addons"].update_one({"_id": code}, {"$set": upd}, upsert=True)  # tenant-ok: catalog
    return {"ok": True, "addon": jsonsafe(await db["addons"].find_one({"_id": code}))}


@router.delete("/addons/{code}")
async def delete_addon(code: str, _: PlatformContext = Depends(get_platform_admin)):
    await shared_db()["addons"].delete_one({"_id": code})  # tenant-ok: platform catalog
    return {"ok": True}


@router.get("/tenants/{tenant_id}/addons")
async def tenant_addons(tenant_id: str, _: PlatformContext = Depends(get_platform_admin)):
    """Add-on catalog annotated for ONE tenant (included/active/granted/available)."""
    from app.services import addon_service
    return jsonsafe(await addon_service.for_tenant(tenant_id))


@router.post("/tenants/{tenant_id}/addons/{addon_id}/{op}")
async def tenant_addon_op(tenant_id: str, addon_id: str, op: str,
                          _: PlatformContext = Depends(get_platform_admin)):
    """Platform-admin (de)activation of an add-on for a tenant — keeps entitlement + billing in sync
    (same path as tenant self-service). op = activate | deactivate."""
    from app.services import addon_service
    if op not in ("activate", "deactivate"):
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "bad_op")
    fn = addon_service.activate if op == "activate" else addon_service.deactivate
    res = await fn(tenant_id, addon_id)
    if not res.get("ok"):
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, detail=res)
    return res


# ── SLA / support tiers (admin-managed) ──────────────────────
_DEFAULT_SLA = [
    {"_id": "basic", "name": "Basic", "description": "Email support, απόκριση 24ω",
     "response_hours": 24, "channels": "email", "price_monthly": 0, "price_yearly": 0},
    {"_id": "professional", "name": "Professional", "description": "Τηλ. + email, απόκριση 4ω",
     "response_hours": 4, "channels": "phone,email", "price_monthly": 0, "price_yearly": 0},
]


@router.get("/sla")
async def sla_tiers(_: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    if await db["sla_tiers"].count_documents({}) == 0:
        await db["sla_tiers"].insert_many([dict(s) for s in _DEFAULT_SLA])  # seed once
    items = [s async for s in db["sla_tiers"].find({}).sort("response_hours", 1)]
    return {"items": jsonsafe(items)}


class SlaIn(BaseModel):
    name: str | None = None
    description: str | None = None
    response_hours: int | None = None
    channels: str | None = None
    price_monthly: int | None = None   # cents — add-on cost of this support tier, per month
    price_yearly: int | None = None    # cents — add-on cost of this support tier, per year
    active: bool | None = None


@router.put("/sla/{code}")
async def update_sla(code: str, body: SlaIn, _: PlatformContext = Depends(get_platform_admin)):
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    db = shared_db()
    if upd:
        await db["sla_tiers"].update_one({"_id": code}, {"$set": upd}, upsert=True)  # tenant-ok: catalog
    return {"ok": True, "sla": jsonsafe(await db["sla_tiers"].find_one({"_id": code}))}


@router.delete("/sla/{code}")
async def delete_sla(code: str, _: PlatformContext = Depends(get_platform_admin)):
    await shared_db()["sla_tiers"].delete_one({"_id": code})  # tenant-ok: catalog
    return {"ok": True}


class IntegrationsIn(BaseModel):
    aade_username: str | None = None
    aade_password: str | None = None
    revolut_api_key: str | None = None
    revolut_mode: str | None = None  # sandbox | live
    revolut_webhook_secret: str | None = None
    anthropic_api_key: str | None = None  # PharmaCat clinical assistant (Claude)
    anthropic_enabled: bool | None = None
    anthropic_model: str | None = None        # model for pharmacist queries (cheap)
    anthropic_admin_model: str | None = None  # model for admin KB corrections (strong)


@router.get("/integrations")
async def get_integrations(_: PlatformContext = Depends(get_platform_admin)):
    """ΑΑΔΕ + Revolut credential status (secrets masked) for the admin settings screen."""
    db = shared_db()
    aade = await db["platform_settings"].find_one({"_id": "aade"}) or {}
    rev = await db["platform_settings"].find_one({"_id": "revolut"}) or {}
    ant = await db["platform_settings"].find_one({"_id": "anthropic"}) or {}
    return {
        "aade": {"username": aade.get("username"),
                 "configured": bool(aade.get("username") and aade.get("password"))},
        "revolut": {"mode": rev.get("mode", "sandbox"), "api_key_set": bool(rev.get("api_key")),
                    "webhook_secret_set": bool(rev.get("webhook_secret"))},
        "anthropic": {"api_key_set": bool(ant.get("api_key")),
                      "enabled": ant.get("enabled", True),
                      "model": ant.get("model", "claude-opus-4-8"),
                      "admin_model": ant.get("admin_model", "claude-opus-4-8")},
    }


@router.put("/integrations")
async def set_integrations(body: IntegrationsIn,
                           _: PlatformContext = Depends(get_platform_admin)):
    """Store ΑΑΔΕ / Revolut credentials in platform_settings (never in git/logs)."""
    db = shared_db()
    a = {}
    if body.aade_username is not None:
        a["username"] = body.aade_username
    if body.aade_password:
        a["password"] = body.aade_password
    if a:
        await db["platform_settings"].update_one({"_id": "aade"}, {"$set": a}, upsert=True)
    r = {}
    if body.revolut_api_key:
        r["api_key"] = body.revolut_api_key
    if body.revolut_mode:
        r["mode"] = body.revolut_mode
    if body.revolut_webhook_secret:
        r["webhook_secret"] = body.revolut_webhook_secret
    if r:
        await db["platform_settings"].update_one({"_id": "revolut"}, {"$set": r}, upsert=True)
    ant: dict = {}
    if body.anthropic_api_key:
        ant["api_key"] = body.anthropic_api_key
    if body.anthropic_enabled is not None:
        ant["enabled"] = body.anthropic_enabled
    if body.anthropic_model:
        ant["model"] = body.anthropic_model
    if body.anthropic_admin_model:
        ant["admin_model"] = body.anthropic_admin_model
    if ant:
        await db["platform_settings"].update_one({"_id": "anthropic"}, {"$set": ant}, upsert=True)
    return {"ok": True}


@router.post("/tenants")
async def open_tenant(body: OpenTenantIn, _: PlatformContext = Depends(get_platform_admin)):
    """«Άνοιγμα» tenant από πακέτο — admin entry point ."""
    try:
        result = await TenantProvisioningService().open_tenant(
            name=body.name, owner_email=body.owner_email, package_code=body.package_code,
            owner_name=body.owner_name, owner_password=body.owner_password, source="admin",
            billing_cycle=body.billing_cycle, sla=body.sla, company=body.company,
            modules=body.modules, seats=body.seats, payment_method=body.payment_method)
    except ProvisioningError as e:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, str(e))
    return result


@router.patch("/tenants/{tenant_id}/status")
async def set_tenant_status(tenant_id: str, body: StatusIn,
                            _: PlatformContext = Depends(get_platform_admin)):
    try:
        return await TenantProvisioningService().set_status(tenant_id=tenant_id, status=body.status)
    except ProvisioningError as e:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, str(e))


@router.get("/tenants/{tenant_id}")
async def tenant_detail(tenant_id: str, _: PlatformContext = Depends(get_platform_admin)):
    """Καρτέλα πελάτη: tenant + subscription + χρήστες + πρόσφατα sync jobs."""
    db = shared_db()
    t = await db["tenants"].find_one({"_id": tenant_id})
    if not t:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    users = await TenantProvisioningService().list_users(tenant_code=tenant_id)
    active_now = await db["users"].count_documents({
        "tenant_id": tenant_id,
        "last_active_at": {"$gte": datetime.now(tz=timezone.utc) - timedelta(minutes=5)}})
    jobs = [j async for j in db["sync_jobs"].find({"tenant_id": tenant_id})
            .sort("started_at", -1).limit(5)]
    pharmacies = (sub.get("limits") or {}).get("pharmacies", 1) or 1
    return jsonsafe({
        "tenant": {"id": t["_id"], "name": t.get("name"), "status": t.get("status"),
                   "country": t.get("country"), "opened_via": t.get("opened_via"),
                   "external_ref": t.get("external_ref"), "created_at": t.get("created_at"),
                   "contact_email": t.get("contact_email"), "contact_phone": t.get("contact_phone"),
                   "company": t.get("company"), "store": t.get("store"),
                   "demo": bool(t.get("demo"))},
        "modules": resolve_modules(set(sub.get("modules_included", [])), t.get("modules") or {}),
        "subscription": {
            "plan": sub.get("plan"), "plan_name": sub.get("plan_name"),
            "status": sub.get("status"), "product_code": sub.get("product_code"),
            "features": sub.get("features", {}), "limits": sub.get("limits", {}),
            "billing_cycle": sub.get("billing_cycle"), "seats": sub.get("seats"),
            "mrr": (sub.get("price_per_pharmacy") or 0) * pharmacies,
            "trial_ends_at": sub.get("trial_ends_at"),
            "current_period_end": sub.get("current_period_end"),
            "source": sub.get("source")},
        "users": users,
        "active_now": active_now,
        "sync": [{"source": j.get("source"), "status": j.get("status"),
                  "started_at": j.get("started_at"), "stats": j.get("stats")} for j in jobs],
    })


@router.patch("/tenants/{tenant_id}")
async def edit_tenant(tenant_id: str, body: TenantEditIn,
                      _: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        return {"id": tenant_id, "updated": False}
    patch["updated_at"] = datetime.now(tz=timezone.utc)
    res = await db["tenants"].update_one({"_id": tenant_id}, {"$set": patch})
    if not res.matched_count:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    return {"id": tenant_id, "updated": True}


class ModulesIn(BaseModel):
    modules: dict[str, str]   # {module_key: "enabled" | "trial" | "locked"}


@router.put("/tenants/{tenant_id}/modules")
async def set_tenant_modules(tenant_id: str, body: ModulesIn,
                             _: PlatformContext = Depends(get_platform_admin)):
    """Enable/lock individual capabilities (pharmacat, patient_portal, …) for ONE pharmacy.
    Stored as a per-tenant override; takes effect on the tenant's next login/token refresh."""
    db = shared_db()
    allowed = {"enabled", "trial", "locked"}
    sets = {f"modules.{k}": v for k, v in body.modules.items() if v in allowed}
    if sets:
        res = await db["tenants"].update_one(  # tenant-ok: platform admin, explicit _id
            {"_id": tenant_id}, {"$set": {**sets, "updated_at": datetime.now(tz=timezone.utc)}})
        if not res.matched_count:
            raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    t = await db["tenants"].find_one({"_id": tenant_id}, {"modules": 1})
    return {"modules": (t or {}).get("modules") or {}}


class AssignPackageIn(BaseModel):
    package_code: str
    billing_cycle: str | None = None   # κρατά τον τρέχοντα αν δεν δοθεί
    seats: int | None = None


@router.post("/tenants/{tenant_id}/package")
async def assign_package(tenant_id: str, body: AssignPackageIn,
                         _: PlatformContext = Depends(get_platform_admin)):
    """Assign a tenant to a package → it INHERITS the package's capabilities (modules_included),
    price, seats, cycle & SLA. Per-tenant module overrides remain as exceptions on top."""
    db = shared_db()
    pkg = await db["packages"].find_one({"_id": body.package_code})
    if not pkg:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "package_not_found")
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    cycle = body.billing_cycle or sub.get("billing_cycle") or "monthly"
    yearly = cycle == "yearly"
    price = int(pkg.get("price_yearly" if yearly else "price_monthly", 0) or 0)
    seats = max(1, int(body.seats or pkg.get("seats", 1) or 1))
    upd = {
        "plan": body.package_code, "plan_name": pkg.get("name"),
        "modules_included": pkg.get("modules", []),
        "billing_cycle": cycle, "price_per_pharmacy": price, "seats": seats,
        "sla": pkg.get("sla") or sub.get("sla"),
        "available_addons": pkg.get("available_addons"),
        "updated_at": datetime.now(tz=timezone.utc),
    }
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": upd}, upsert=True)
    return {"ok": True, "plan": body.package_code, "modules_included": pkg.get("modules", [])}


@router.post("/tenants/{tenant_id}/cancel")
async def cancel_subscription(tenant_id: str, _: PlatformContext = Depends(get_platform_admin)):
    """Ακύρωση συνδρομής: subscription→cancelled, tenant→suspended (μπλοκάρει login)."""
    db = shared_db()
    now = datetime.now(tz=timezone.utc)
    res = await db["subscriptions"].update_one({"tenant_id": tenant_id},
                                               {"$set": {"status": "cancelled", "updated_at": now}})
    await db["tenants"].update_one({"_id": tenant_id},
                                   {"$set": {"status": "suspended", "updated_at": now}})
    if not res.matched_count and not await db["tenants"].find_one({"_id": tenant_id}):
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    return {"id": tenant_id, "status": "cancelled"}


async def _pick_impersonation_user(tenant_id: str) -> dict | None:
    """Owner user αν υπάρχει, αλλιώς ο πρώτος ενεργός χρήστης του tenant."""
    db = shared_db()
    owner_role = await db["roles"].find_one({"tenant_id": tenant_id, "key": "owner"})
    if owner_role:
        u = await db["users"].find_one({"tenant_id": tenant_id, "status": "active",
                                        "role_ids": owner_role["_id"]})
        if u:
            return u
    return await db["users"].find_one({"tenant_id": tenant_id, "status": "active"})


@router.get("/tenants/{tenant_id}/credentials")
async def tenant_credentials(tenant_id: str, _: PlatformContext = Depends(get_platform_admin)):
    """Credentials πελάτη: λογαριασμοί σύνδεσης (email/ρόλος) + ΗΔΥΚΑ σύνδεση (χωρίς
    να αποκαλύπτονται μυστικά — μόνο username/αναγνωριστικά + flags)."""
    db = shared_db()
    if not await db["tenants"].find_one({"_id": tenant_id}):
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    users = await TenantProvisioningService().list_users(tenant_code=tenant_id)
    c = vault.get_secret(f"tenants/{tenant_id}/hdika") or {}
    hdika = {"configured": bool(c),
             "username": c.get("username"), "pharmacy_id": c.get("pharmacy_id"),
             "pharmacy_name": c.get("pharmacy_name"), "environment": c.get("environment"),
             "base_url": c.get("base_url"), "has_password": bool(c.get("password")),
             "has_api_key": bool(c.get("api_key"))}
    return jsonsafe({"users": users, "hdika": hdika})


@router.post("/tenants/{tenant_id}/impersonate")
async def impersonate_tenant(tenant_id: str, ctx: PlatformContext = Depends(get_platform_admin)):
    """Έκδοση tenant token για «Σύνδεση ως πελάτης» — χωρίς password, χωρίς δέσμευση
    άδειας (χρησιμοποιεί την υπάρχουσα ταυτότητα του χρήστη). Καταγράφεται στο audit."""
    user = await _pick_impersonation_user(tenant_id)
    if not user:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "no_active_user")
    tokens = await AuthService().issue_for_user(user)
    await shared_db()["audit_logs"].insert_one({
        "tenant_id": tenant_id, "action": "admin_impersonate", "by": ctx.email,
        "as_user": user["email"], "at": datetime.now(tz=timezone.utc)})
    return {**tokens, "as_email": user["email"], "app_url": "https://app.rxvision.gr"}


class SendCredsIn(BaseModel):
    email: EmailStr


@router.post("/tenants/{tenant_id}/users/send-credentials")
async def send_tenant_credentials(tenant_id: str, body: SendCredsIn,
                                  ctx: PlatformContext = Depends(get_platform_admin)):
    """(Re)issue a login for a tenant user: generate a NEW temporary password, set it,
    email it to the customer, and return it ONCE so the admin can relay it by phone.
    The existing password is hashed and cannot be shown — this replaces it."""
    db = shared_db()
    u = await db["users"].find_one({"tenant_id": tenant_id, "email": body.email})
    if not u:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "user_not_found")
    temp = "Rx-" + secrets.token_urlsafe(8)        # readable temporary password
    await db["users"].update_one({"_id": u["_id"]}, {
        "$set": {"password_hash": hash_password(temp),
                 "updated_at": datetime.now(tz=timezone.utc)},
        "$inc": {"refresh_token_version": 1}})       # invalidate old sessions
    html = (f"<p>Γεια σας {u.get('full_name','')},</p>"
            f"<p>Τα στοιχεία σύνδεσής σας στο RxVision:</p>"
            f"<p><b>Διεύθυνση:</b> https://app.rxvision.gr<br/>"
            f"<b>Email:</b> {body.email}<br/>"
            f"<b>Προσωρινός κωδικός:</b> {temp}</p>"
            f"<p>Συνιστούμε να τον αλλάξετε μετά τη σύνδεση (Λογαριασμός → Αλλαγή κωδικού).</p>")
    try:
        await mailer.send_email(body.email, "RxVision — Στοιχεία σύνδεσης", html)
        emailed = True
    except Exception:  # noqa: BLE001 — SMTP may be unconfigured; admin still gets the password
        emailed = False
    await db["audit_logs"].insert_one({
        "tenant_id": tenant_id, "action": "admin_send_credentials", "by": ctx.email,
        "to": body.email, "emailed": emailed, "at": datetime.now(tz=timezone.utc)})
    return {"email": body.email, "temp_password": temp, "emailed": emailed,
            "login_url": "https://app.rxvision.gr"}


@router.delete("/tenants/{tenant_id}")
async def delete_tenant(tenant_id: str, _: PlatformContext = Depends(get_platform_admin)):
    """ΟΡΙΣΤΙΚΗ διαγραφή πελάτη + όλων των δεδομένων του (admin-initiated)."""
    db = shared_db()
    if not await db["tenants"].find_one({"_id": tenant_id}):
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    deleted = {}
    for c in _TENANT_COLLECTIONS:
        r = await db[c].delete_many({"tenant_id": tenant_id})
        if r.deleted_count:
            deleted[c] = r.deleted_count
    await db["tenants"].delete_one({"_id": tenant_id})
    return {"id": tenant_id, "deleted": True, "removed": deleted}


# ── platform staff (CloudOn admins) ────────────────────────
def _staff_public(a: dict) -> dict:
    # legacy admins (χωρίς πεδίο permissions) = full access → super
    is_super = bool(a.get("super_admin")) or a.get("permissions") is None
    return {"id": str(a["_id"]), "email": a["email"], "full_name": a.get("full_name", ""),
            "status": a.get("status", "active"), "created_at": a.get("created_at"),
            "super_admin": is_super, "permissions": a.get("permissions") or []}


@router.get("/sections")
async def list_sections(_: PlatformContext = Depends(get_platform_admin)):
    return {"sections": [{"key": k, "label": label} for k, label in ADMIN_SECTIONS]}


@router.get("/staff")
async def list_staff(_: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    items = [_staff_public(a) async for a in db["platform_admins"].find({}).sort("created_at", 1)]
    return {"items": jsonsafe(items)}


@router.post("/staff")
async def create_staff(body: StaffIn, _: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    if await db["platform_admins"].find_one({"email": body.email}):
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "email_in_use")
    temp = body.password or secrets.token_urlsafe(9)
    now = datetime.now(tz=timezone.utc)
    res = await db["platform_admins"].insert_one({
        "email": body.email, "full_name": body.full_name,
        "password_hash": hash_password(temp), "status": "active",
        "super_admin": body.super_admin,
        "permissions": [] if body.super_admin else _clean_perms(body.permissions),
        "refresh_token_version": 0, "created_at": now, "updated_at": now})
    return {"id": str(res.inserted_id), "email": body.email,
            "temp_password": None if body.password else temp}


@router.patch("/staff/{admin_id}")
async def edit_staff(admin_id: str, body: StaffEditIn,
                     _: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    admin = await db["platform_admins"].find_one({"_id": _oid(admin_id)})
    if not admin:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    patch: dict = {}
    if body.full_name is not None:
        patch["full_name"] = body.full_name
    if body.email and body.email != admin["email"]:
        if await db["platform_admins"].find_one({"email": body.email}):
            raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "email_in_use")
        patch["email"] = body.email
    if body.super_admin is not None:
        patch["super_admin"] = body.super_admin
        if body.super_admin:
            patch["permissions"] = []
    if body.permissions is not None and not patch.get("super_admin"):
        patch["permissions"] = _clean_perms(body.permissions)
        patch.setdefault("super_admin", False)
    if not patch:
        return {"id": admin_id, "updated": False}
    patch["updated_at"] = datetime.now(tz=timezone.utc)
    await db["platform_admins"].update_one({"_id": admin["_id"]}, {"$set": patch})
    return {"id": admin_id, "updated": True}


@router.post("/staff/{admin_id}/reset-password")
async def reset_staff_password(admin_id: str, body: ResetPwIn,
                               _: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    admin = await db["platform_admins"].find_one({"_id": _oid(admin_id)})
    if not admin:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    temp = body.password or secrets.token_urlsafe(9)
    await db["platform_admins"].update_one(
        {"_id": admin["_id"]},
        {"$set": {"password_hash": hash_password(temp),
                  "updated_at": datetime.now(tz=timezone.utc)},
         "$inc": {"refresh_token_version": 1}})  # revoke existing sessions
    return {"id": admin_id, "temp_password": None if body.password else temp}


@router.post("/staff/{admin_id}/send-credentials")
async def send_staff_credentials(admin_id: str, ctx: PlatformContext = Depends(get_platform_admin)):
    """Issue a NEW temporary password for a staff member and email it to them.
    Returns the password too, so it can be relayed manually if email fails."""
    db = shared_db()
    admin = await db["platform_admins"].find_one({"_id": _oid(admin_id)})
    if not admin:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    temp = "Rx-" + secrets.token_urlsafe(8)
    await db["platform_admins"].update_one(
        {"_id": admin["_id"]},
        {"$set": {"password_hash": hash_password(temp),
                  "updated_at": datetime.now(tz=timezone.utc)},
         "$inc": {"refresh_token_version": 1}})  # revoke existing sessions
    html = (f"<p>Γεια σας {admin.get('full_name','')},</p>"
            f"<p>Τα στοιχεία πρόσβασής σας στην κονσόλα διαχείρισης RxVision:</p>"
            f"<p><b>Διεύθυνση:</b> https://adminpanel.rxvision.gr<br/>"
            f"<b>Email:</b> {admin['email']}<br/>"
            f"<b>Προσωρινός κωδικός:</b> {temp}</p>"
            f"<p>Συνιστούμε να τον αλλάξετε μετά τη σύνδεση.</p>")
    try:
        await mailer.send_email(admin["email"], "RxVision — Στοιχεία πρόσβασης (Console)", html)
        emailed = True
    except Exception:  # noqa: BLE001 — SMTP may fail; admin still gets the password back
        emailed = False
    await db["audit_logs"].insert_one({
        "tenant_id": None, "action": "admin_send_staff_credentials", "by": ctx.email,
        "to": admin["email"], "emailed": emailed, "at": datetime.now(tz=timezone.utc)})
    return {"id": admin_id, "email": admin["email"], "temp_password": temp, "emailed": emailed}


@router.patch("/staff/{admin_id}/status")
async def set_staff_status(admin_id: str, body: StatusIn,
                           ctx: PlatformContext = Depends(get_platform_admin)):
    if body.status not in {"active", "suspended"}:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "bad_status")
    db = shared_db()
    if body.status == "suspended":
        if admin_id == ctx.admin_id:
            raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "cannot_suspend_self")
        active = await db["platform_admins"].count_documents({"status": "active"})
        if active <= 1:
            raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "last_active_admin")
    await db["platform_admins"].update_one(
        {"_id": _oid(admin_id)},
        {"$set": {"status": body.status, "updated_at": datetime.now(tz=timezone.utc)},
         "$inc": {"refresh_token_version": 1}})
    return {"id": admin_id, "status": body.status}


@router.delete("/staff/{admin_id}")
async def delete_staff(admin_id: str, ctx: PlatformContext = Depends(get_platform_admin)):
    if admin_id == ctx.admin_id:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "cannot_delete_self")
    db = shared_db()
    active = await db["platform_admins"].count_documents({"status": "active"})
    if active <= 1:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "last_active_admin")
    await db["platform_admins"].delete_one({"_id": _oid(admin_id)})
    return {"id": admin_id, "deleted": True}


@router.get("/billing")
async def billing(_: PlatformContext = Depends(get_platform_admin)):
    """Platform revenue overview (Οικονομικά): MRR/ARR, ανά πλάνο, MRR σε κίνδυνο.

    Invoicing is managed separately; here we surface what RxVision knows from
    subscriptions (read-only revenue picture)."""
    db = shared_db()
    now = datetime.now(tz=timezone.utc)
    names = {t["_id"]: t.get("name", t["_id"]) async for t in db["tenants"].find({})}

    by_plan: dict[str, dict] = {}
    rows = []
    mrr = at_risk = 0
    counts = {"active": 0, "trial": 0, "past_due": 0, "suspended": 0}
    async for s in db["subscriptions"].find({}):
        if s["tenant_id"] not in names:
            continue  # skip orphan subscriptions (tenant deleted)
        st = s.get("status", "—")
        counts[st] = counts.get(st, 0) + 1
        pharmacies = (s.get("limits") or {}).get("pharmacies", 1) or 1
        m = (s.get("price_per_pharmacy") or 0) * pharmacies
        billed = st in ("active", "past_due")
        if billed:
            mrr += m
            d2e = _days_until(s.get("current_period_end"), now)
            if st == "past_due" or (d2e is not None and 0 <= d2e <= 30):
                at_risk += m
        plan = s.get("plan", "—")
        p = by_plan.setdefault(plan, {"plan": plan, "tenants": 0, "mrr": 0})
        p["tenants"] += 1
        p["mrr"] += m if billed else 0
        rows.append({"tenant": names.get(s["tenant_id"], s["tenant_id"]),
                     "plan": plan, "status": st, "mrr": m})

    rows.sort(key=lambda x: x["mrr"], reverse=True)
    return {
        "summary": {"mrr": mrr, "arr": mrr * 12, "at_risk_mrr": at_risk,
                    "active": counts.get("active", 0), "trial": counts.get("trial", 0),
                    "past_due": counts.get("past_due", 0)},
        "by_plan": jsonsafe(sorted(by_plan.values(), key=lambda x: x["mrr"], reverse=True)),
        "tenants": jsonsafe(rows),
    }


# ── παραστατικά (invoices) με κλείδωμα ΑΑΔΕ ────────────────
def _invoice_totals(net: int, vat_rate: float) -> tuple[int, int]:
    vat = round(net * (vat_rate or 0) / 100)
    return vat, net + vat


def _invoice_public(inv: dict, tenant_name: str | None = None) -> dict:
    return {
        "id": str(inv["_id"]), "tenant_id": inv.get("tenant_id"),
        "tenant_name": tenant_name or inv.get("tenant_name"),
        "doc_type": inv.get("doc_type"), "series": inv.get("series"),
        "number": inv.get("number"), "full_number": f"{inv.get('series')}-{inv.get('number')}",
        "issue_date": inv.get("issue_date"), "description": inv.get("description", ""),
        "net_amount": inv.get("net_amount", 0), "vat_rate": inv.get("vat_rate", 0),
        "vat_amount": inv.get("vat_amount", 0), "total": inv.get("total", 0),
        "aade_status": inv.get("aade_status", "not_transmitted"),
        "aade_mark": inv.get("aade_mark"), "aade_transmitted_at": inv.get("aade_transmitted_at"),
        "created_at": inv.get("created_at"),
    }


def _aade_locked(inv: dict) -> bool:
    return inv.get("aade_status") == "transmitted"


@router.get("/invoices")
async def list_invoices(tenant_id: str | None = None, aade: str | None = None,
                        _: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    q: dict = {}
    if tenant_id:
        q["tenant_id"] = tenant_id
    if aade in ("transmitted", "not_transmitted"):
        q["aade_status"] = aade
    names = {t["_id"]: t.get("name", t["_id"]) async for t in db["tenants"].find({})}
    items = [_invoice_public(i, names.get(i.get("tenant_id")))
             async for i in db["invoices"].find(q).sort("created_at", -1)]
    return {"items": jsonsafe(items)}


@router.post("/invoices")
async def create_invoice(body: InvoiceIn, _: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    if not await db["tenants"].find_one({"_id": body.tenant_id}):
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "tenant_not_found")
    last = await db["invoices"].find_one({"series": body.series}, sort=[("number", -1)])
    number = (last.get("number", 0) if last else 0) + 1
    vat, total = _invoice_totals(body.net_amount, body.vat_rate)
    now = datetime.now(tz=timezone.utc)
    doc = {"tenant_id": body.tenant_id, "doc_type": body.doc_type, "series": body.series,
           "number": number, "issue_date": body.issue_date or now.date().isoformat(),
           "description": body.description, "net_amount": body.net_amount,
           "vat_rate": body.vat_rate, "vat_amount": vat, "total": total,
           "aade_status": "not_transmitted", "aade_mark": None, "aade_transmitted_at": None,
           "created_at": now, "updated_at": now}
    res = await db["invoices"].insert_one(doc)
    doc["_id"] = res.inserted_id
    return jsonsafe(_invoice_public(doc))


@router.get("/invoices/{invoice_id}")
async def get_invoice(invoice_id: str, _: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    inv = await db["invoices"].find_one({"_id": _oid(invoice_id)})
    if not inv:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    t = await db["tenants"].find_one({"_id": inv.get("tenant_id")})
    return jsonsafe(_invoice_public(inv, (t or {}).get("name")))


@router.patch("/invoices/{invoice_id}")
async def edit_invoice(invoice_id: str, body: InvoiceEditIn,
                       _: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    inv = await db["invoices"].find_one({"_id": _oid(invoice_id)})
    if not inv:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    if _aade_locked(inv):
        raise HTTPException(http_status.HTTP_409_CONFLICT,
                            {"error": "aade_transmitted", "message": "Διαβιβασμένο στην ΑΑΔΕ — δεν τροποποιείται."})
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if "net_amount" in patch or "vat_rate" in patch:
        net = patch.get("net_amount", inv.get("net_amount", 0))
        rate = patch.get("vat_rate", inv.get("vat_rate", 0))
        patch["vat_amount"], patch["total"] = _invoice_totals(net, rate)
    if patch:
        patch["updated_at"] = datetime.now(tz=timezone.utc)
        await db["invoices"].update_one({"_id": inv["_id"]}, {"$set": patch})
    return {"id": invoice_id, "updated": bool(patch)}


@router.delete("/invoices/{invoice_id}")
async def delete_invoice(invoice_id: str, _: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    inv = await db["invoices"].find_one({"_id": _oid(invoice_id)})
    if not inv:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    if _aade_locked(inv):
        raise HTTPException(http_status.HTTP_409_CONFLICT,
                            {"error": "aade_transmitted", "message": "Διαβιβασμένο στην ΑΑΔΕ — δεν διαγράφεται."})
    await db["invoices"].delete_one({"_id": inv["_id"]})
    return {"id": invoice_id, "deleted": True}


@router.post("/invoices/{invoice_id}/transmit")
async def transmit_invoice(invoice_id: str, _: PlatformContext = Depends(get_platform_admin)):
    """Διαβίβαση στην ΑΑΔΕ (myDATA). Μετά το κλείδωμα δεν επιτρέπεται edit/delete.
    Placeholder MARK — η πραγματική σύνδεση myDATA θα μπει εδώ."""
    db = shared_db()
    inv = await db["invoices"].find_one({"_id": _oid(invoice_id)})
    if not inv:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    if _aade_locked(inv):
        return {"id": invoice_id, "aade_status": "transmitted", "aade_mark": inv.get("aade_mark")}
    now = datetime.now(tz=timezone.utc)
    mark = f"4000{int(now.timestamp())}"  # placeholder MARK μέχρι τη σύνδεση myDATA
    await db["invoices"].update_one({"_id": inv["_id"]}, {"$set": {
        "aade_status": "transmitted", "aade_mark": mark, "aade_transmitted_at": now,
        "updated_at": now}})
    return {"id": invoice_id, "aade_status": "transmitted", "aade_mark": mark}


# ── SMTP settings + newsletter ─────────────────────────────
@router.get("/smtp")
async def get_smtp(_: PlatformContext = Depends(get_platform_admin)):
    cfg = await mailer.get_smtp(masked=True)
    return cfg or {"configured": False}


@router.put("/smtp")
async def put_smtp(body: SmtpIn, _: PlatformContext = Depends(get_platform_admin)):
    await mailer.save_smtp(body.model_dump())
    return {"saved": True}


@router.post("/smtp/test")
async def test_smtp(body: TestEmailIn, ctx: PlatformContext = Depends(get_platform_admin)):
    to = (body.to or ctx.email)
    try:
        await mailer.send_email(to, "RxVision — δοκιμαστικό email",
                                "<p>Το SMTP του RxVision admin λειτουργεί ✓</p>")
    except Exception as e:  # noqa: BLE001 — surface the real SMTP error to the operator
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST,
                            detail={"error": "smtp_error", "message": str(e)[:300]})
    return {"ok": True, "to": to}


@router.get("/newsletter/recipients")
async def newsletter_recipients(segment: str = "all",
                                _: PlatformContext = Depends(get_platform_admin)):
    if segment not in _SEGMENTS:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "bad_segment")
    emails = await _newsletter_recipients(shared_db(), segment)
    return {"segment": segment, "count": len(emails)}


def _unsub_url(email: str) -> str:
    from urllib.parse import quote
    return f"https://app.rxvision.gr/unsubscribe?email={quote(email or '')}"


def _render_for(rcpt: dict, subject: str, body_html: str, preheader: str) -> str:
    """Per-recipient: apply merge tags then wrap in the email-safe template."""
    unsub = _unsub_url(rcpt.get("email", ""))
    content = email_template.apply_merge_tags(
        body_html, name=rcpt.get("name", ""), pharmacy=rcpt.get("pharmacy", ""),
        email=rcpt.get("email", ""), unsubscribe_url=unsub)
    return email_template.render_newsletter(
        content, subject=subject, preheader=preheader, unsubscribe_url=unsub)


@router.post("/newsletter/preview")
async def preview_newsletter(body: NewsletterPreviewIn,
                             _: PlatformContext = Depends(get_platform_admin)):
    """Return the wrapped email HTML (sample merge data) for the live preview iframe."""
    sample = {"email": "owner@example.gr", "name": "Γιάννης Παπαδόπουλος",
              "pharmacy": "Φαρμακείο Παπαδόπουλος"}
    return {"html": _render_for(sample, body.subject, body.body_html, body.preheader)}


@router.post("/newsletter/test")
async def test_newsletter(body: NewsletterTestIn, ctx: PlatformContext = Depends(get_platform_admin)):
    """Send a single test email (with sample merge data) to verify rendering/SMTP."""
    sample = {"email": body.to, "name": "Δοκιμή", "pharmacy": "Φαρμακείο Δοκιμή"}
    html = _render_for(sample, body.subject, body.body_html, body.preheader)
    try:
        await mailer.send_email(body.to, f"[TEST] {body.subject}", html)
    except RuntimeError as e:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, str(e))  # smtp_not_configured
    return {"ok": True, "to": body.to}


@router.post("/newsletter")
async def send_newsletter(body: NewsletterIn, ctx: PlatformContext = Depends(get_platform_admin)):
    if body.segment not in _SEGMENTS:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "bad_segment")
    db = shared_db()
    recipients = await _newsletter_recipients(db, body.segment)
    messages = [{"to": r["email"], "subject": body.subject,
                 "html": _render_for(r, body.subject, body.body_html, body.preheader)}
                for r in recipients]
    try:
        result = await mailer.send_messages(messages)
        status_str = "sent"
    except RuntimeError as e:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, str(e))  # smtp_not_configured
    doc = {
        "subject": body.subject, "preheader": body.preheader, "segment": body.segment,
        "recipients": len(recipients), "sent": result["sent"], "failed": result["failed"],
        "status": status_str, "sent_by": ctx.email, "sent_at": datetime.now(tz=timezone.utc),
    }
    res = await db["newsletters"].insert_one(doc)
    return {"id": str(res.inserted_id), **{k: doc[k] for k in
            ("recipients", "sent", "failed", "status")}}


@router.get("/newsletter")
async def newsletter_history(_: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    items = []
    async for n in db["newsletters"].find({}).sort("sent_at", -1).limit(50):
        items.append({"id": str(n["_id"]), "subject": n.get("subject"),
                      "segment": n.get("segment"), "recipients": n.get("recipients", 0),
                      "sent": n.get("sent", 0), "failed": n.get("failed", 0),
                      "status": n.get("status"), "sent_by": n.get("sent_by"),
                      "sent_at": n.get("sent_at")})
    return {"items": jsonsafe(items)}


@router.get("/health")
async def platform_health(_: PlatformContext = Depends(get_platform_admin)):
    """Platform status console (Επισκεψιμότητα): sync uptime/errors ανά υπηρεσία,
    30ήμερο timeline, πρόσφατες αποτυχίες — στυλ status page."""
    db = shared_db()
    now = datetime.now(tz=timezone.utc)
    since = now - timedelta(days=30)
    names = {t["_id"]: t.get("name", t["_id"]) async for t in db["tenants"].find({})}
    jobs = [j async for j in db["sync_jobs"].find({"started_at": {"$gte": since}})]

    days = [(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(29, -1, -1)]
    per = defaultdict(lambda: defaultdict(lambda: {"ok": 0, "fail": 0}))
    tot = defaultdict(lambda: {"runs": 0, "failed": 0})
    for j in jobs:
        src = j.get("source", "?")
        d = j["started_at"].strftime("%Y-%m-%d") if j.get("started_at") else None
        ok = j.get("status") != "failed"
        per[src][d]["ok" if ok else "fail"] += 1
        tot[src]["runs"] += 1
        tot[src]["failed"] += 0 if ok else 1

    services = []
    for src, t in sorted(tot.items()):
        daily = []
        for d in days:
            c = per[src].get(d)
            n = (c["ok"] + c["fail"]) if c else 0
            daily.append({"date": d, "ratio": round(c["ok"] / n, 3) if n else None})
        uptime = round((t["runs"] - t["failed"]) / t["runs"] * 100, 2) if t["runs"] else 100.0
        status = "operational" if uptime >= 99 else "degraded" if uptime >= 95 else "partial_outage"
        services.append({"source": src, "runs": t["runs"], "failed": t["failed"],
                         "uptime_pct": uptime, "status": status, "daily": daily})

    runs = sum(t["runs"] for t in tot.values())
    failed = sum(t["failed"] for t in tot.values())
    recent = [{"tenant": names.get(j.get("tenant_id"), j.get("tenant_id")),
               "source": j.get("source"), "error": j.get("error"), "at": j.get("started_at")}
              for j in sorted((x for x in jobs if x.get("status") == "failed"),
                              key=lambda x: x.get("started_at") or since, reverse=True)[:10]]
    active = await db["subscriptions"].count_documents({"status": "active"})
    return {
        "summary": {"syncs_30d": runs, "failed_30d": failed, "active_tenants": active,
                    "success_rate": round((runs - failed) / runs * 100, 2) if runs else 100.0},
        "services": jsonsafe(services), "recent_failures": jsonsafe(recent),
    }


# ── content (Άρθρα/Νέα/Wiki) ────────────────────────────────
def _post_public(p: dict) -> dict:
    return {"id": str(p["_id"]), "type": p.get("type"), "title": p.get("title"),
            "body": p.get("body", ""), "status": p.get("status", "draft"),
            "updated_at": p.get("updated_at"), "created_at": p.get("created_at")}


@router.get("/posts")
async def list_posts(type: str | None = None,
                     _: PlatformContext = Depends(get_platform_admin)):
    q = {"type": type} if type in _POST_TYPES else {}
    db = shared_db()
    items = [_post_public(p) async for p in db["posts"].find(q).sort("updated_at", -1)]
    return {"items": jsonsafe(items)}


@router.post("/posts")
async def create_post(body: PostIn, ctx: PlatformContext = Depends(get_platform_admin)):
    if body.type not in _POST_TYPES:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "bad_type")
    now = datetime.now(tz=timezone.utc)
    res = await shared_db()["posts"].insert_one({
        "type": body.type, "title": body.title, "body": body.body,
        "status": body.status if body.status in ("draft", "published") else "draft",
        "author": ctx.email, "created_at": now, "updated_at": now})
    return {"id": str(res.inserted_id)}


@router.patch("/posts/{post_id}")
async def update_post(post_id: str, body: PostUpdateIn,
                      _: PlatformContext = Depends(get_platform_admin)):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        return {"id": post_id, "updated": False}
    patch["updated_at"] = datetime.now(tz=timezone.utc)
    await shared_db()["posts"].update_one({"_id": _oid(post_id)}, {"$set": patch})
    return {"id": post_id, "updated": True}


@router.delete("/posts/{post_id}")
async def delete_post(post_id: str, _: PlatformContext = Depends(get_platform_admin)):
    await shared_db()["posts"].delete_one({"_id": _oid(post_id)})
    return {"id": post_id, "deleted": True}


# ── maintenance mode ────────────────────────────────────────
@router.get("/maintenance")
async def get_maintenance(_: PlatformContext = Depends(get_platform_admin)):
    doc = await shared_db()["platform_settings"].find_one({"_id": "maintenance"})
    return {"enabled": (doc or {}).get("enabled", False),
            "message": (doc or {}).get("message", "")}


@router.put("/maintenance")
async def set_maintenance(body: MaintenanceIn, _: PlatformContext = Depends(get_platform_admin)):
    await shared_db()["platform_settings"].update_one(
        {"_id": "maintenance"},
        {"$set": {"enabled": body.enabled, "message": body.message,
                  "updated_at": datetime.now(tz=timezone.utc)}}, upsert=True)
    return {"enabled": body.enabled, "message": body.message}


# ── notifications (GLOBAL — όλοι οι tenants με την ίδια συνθήκη) ──────────────
# auto_cancel_minutes → αιτήματα πελατών (διαθεσιμότητα/ραντεβού/ανάθεση συνταγής).
# order_auto_cancel_minutes → ΞΕΧΩΡΙΣΤΟ όριο για παραγγελίες παραφαρμάκων/OTC.
_NOTIF_DEFAULTS = {"sound_repeat_seconds": 30, "escalate_popup_minutes": 3,
                   "auto_cancel_minutes": 5, "auto_cancel_enabled": True,
                   "order_auto_cancel_minutes": 30, "order_auto_cancel_enabled": True}


class NotificationsIn(BaseModel):
    sound_repeat_seconds: int = Field(30, ge=5, le=600)
    escalate_popup_minutes: int = Field(3, ge=1, le=60)
    auto_cancel_minutes: int = Field(5, ge=1, le=1440)
    auto_cancel_enabled: bool = True
    order_auto_cancel_minutes: int = Field(30, ge=1, le=1440)   # παραφάρμακα/OTC — ξεχωριστό όριο
    order_auto_cancel_enabled: bool = True


@router.get("/notifications")
async def get_notifications(_: PlatformContext = Depends(get_platform_admin)):
    """Καθολικές ρυθμίσεις ειδοποιήσεων φαρμακείου — ισχύουν για ΟΛΟΥΣ τους tenants."""
    doc = await shared_db()["platform_settings"].find_one({"_id": "notifications"}) or {}
    return {**_NOTIF_DEFAULTS, **{k: doc[k] for k in _NOTIF_DEFAULTS if k in doc}}


@router.put("/notifications")
async def set_notifications(body: NotificationsIn, _: PlatformContext = Depends(get_platform_admin)):
    await shared_db()["platform_settings"].update_one(
        {"_id": "notifications"},
        {"$set": {**body.model_dump(), "updated_at": datetime.now(tz=timezone.utc)}}, upsert=True)
    return body.model_dump()


@router.get("/idika")
async def get_idika(_: PlatformContext = Depends(get_platform_admin)):
    """Platform-level ΗΔΥΚΑ integrator config (CloudOn): application keys + endpoints,
    κοινά για όλα τα φαρμακεία. Secrets masked — never returned."""
    doc = await shared_db()["platform_settings"].find_one({"_id": "idika"}) or {}

    def env(name):
        e = doc.get(name) or {}
        return {"base_url": e.get("base_url") or _IDIKA_DEFAULTS[name],
                "has_api_key": bool(e.get("api_key")),
                "integrator_username": e.get("integrator_username") or "",
                "has_integrator_password": bool(e.get("integrator_password")),
                "pharmacy_id": e.get("pharmacy_id") or ""}

    return {"active_environment": doc.get("active_environment", "test"),
            "doctor_ip": doc.get("doctor_ip"),
            "test": env("test"), "production": env("production")}


@router.put("/idika")
async def put_idika(body: IdikaIn, _: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    existing = await db["platform_settings"].find_one({"_id": "idika"}) or {}
    doc = {"_id": "idika", "active_environment": body.active_environment,
           "doctor_ip": body.doctor_ip, "updated_at": datetime.now(tz=timezone.utc)}
    for name, inp in (("test", body.test), ("production", body.production)):
        prev = existing.get(name) or {}
        api_key = inp.api_key if inp.api_key else prev.get("api_key", "")  # keep secret on empty
        password = inp.integrator_password if inp.integrator_password else prev.get("integrator_password", "")
        username = inp.integrator_username if inp.integrator_username is not None else prev.get("integrator_username", "")
        pharmacy_id = inp.pharmacy_id if inp.pharmacy_id is not None else prev.get("pharmacy_id", "")
        doc[name] = {"base_url": inp.base_url or _IDIKA_DEFAULTS[name], "api_key": api_key,
                     "integrator_username": username, "integrator_password": password,
                     "pharmacy_id": pharmacy_id}
    await db["platform_settings"].update_one({"_id": "idika"}, {"$set": doc}, upsert=True)
    return {"saved": True}


# ── Διατίμηση (κλιμακωτό μεικτό κέρδος φαρμακείου) — platform-global, ισχύει σε ΟΛΟΥΣ τους πελάτες ──
class MarkupIn(BaseModel):
    bands: list[list[float]]   # [[upper_euro, pct], …] — π.χ. [[50, 30], [100, 20], …]


async def _recompute_all_markup(bands: list[list[float]]) -> None:
    await recompute(shared_db(), bands)


@router.get("/markup")
async def get_markup(_: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    doc = await db["platform_settings"].find_one({"_id": "markup"}) or {}
    bands = sanitize_bands(doc.get("bands"))
    return {"bands": bands or [list(b) for b in DEFAULT_BANDS],
            "is_default": not bool(bands),
            "default_bands": [list(b) for b in DEFAULT_BANDS],
            "updated_at": jsonsafe(doc.get("updated_at"))}


@router.put("/markup")
async def put_markup(body: MarkupIn, background: BackgroundTasks,
                     ctx: PlatformContext = Depends(get_platform_admin)):
    bands = sanitize_bands(body.bands)
    if not bands:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "invalid_bands")
    await shared_db()["platform_settings"].update_one(
        {"_id": "markup"},
        {"$set": {"bands": bands, "updated_at": datetime.now(tz=timezone.utc), "updated_by": ctx.email}},
        upsert=True)
    # Εφαρμογή στα ιστορικά δεδομένα ΟΛΩΝ των πελατών (background) — τα νέα sync το παίρνουν αυτόματα.
    background.add_task(_recompute_all_markup, bands)
    return {"saved": True, "bands": bands, "recompute": "started"}


@router.post("/markup/recompute")
async def recompute_markup(background: BackgroundTasks,
                           _: PlatformContext = Depends(get_platform_admin)):
    bands = await load_bands(shared_db())
    background.add_task(_recompute_all_markup, bands)
    return {"recompute": "started"}






@router.get("/sync-health")
async def sync_health(_: PlatformContext = Depends(get_platform_admin)):
    """Latest ingestion sync per (tenant, source) with status + recent error count."""
    db = shared_db()
    names = {t["_id"]: t.get("name", t["_id"]) async for t in db["tenants"].find({})}
    pipeline = [
        {"$sort": {"started_at": -1}},
        {"$group": {
            "_id": {"tenant": "$tenant_id", "source": "$source"},
            "last_run": {"$first": "$started_at"},
            "status": {"$first": "$status"},
            "errors": {"$sum": {"$cond": [{"$eq": ["$status", "failed"]}, 1, 0]}},
        }},
        {"$sort": {"last_run": -1}},
    ]
    items = []
    async for row in db["sync_jobs"].aggregate(pipeline):
        key = row["_id"]
        items.append({
            "id": f'{key["tenant"]}:{key["source"]}',
            "tenant": names.get(key["tenant"], key["tenant"]),
            "source": key["source"],
            "last_run": row["last_run"],
            "status": row["status"],
            "errors": row["errors"],
        })
    return {"items": jsonsafe(items)}


@router.get("/audit-logs")
async def audit_logs_list(
    _: PlatformContext = Depends(get_platform_admin),
    tenant_id: str | None = None,
    actor_user_id: str | None = None,
    action: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    page: int = 1,
    page_size: int = 50,
):
    """Read-only cross-tenant audit-log viewer with filters (date / tenant / user / action).
    Platform-admin only; never mutates."""
    db = shared_db()
    q: dict = {}
    if tenant_id:
        q["tenant_id"] = tenant_id
    if actor_user_id:
        q["actor_user_id"] = actor_user_id
    if action:
        q["action"] = {"$regex": re.escape(action), "$options": "i"}
    at: dict = {}
    if date_from:
        at["$gte"] = date_from
    if date_to:
        at["$lte"] = date_to
    if at:
        q["at"] = at
    page = max(1, page)
    page_size = max(1, min(page_size, 200))
    total = await db["audit_logs"].count_documents(q)
    rows = await (db["audit_logs"].find(q).sort("at", -1)
                  .skip((page - 1) * page_size).limit(page_size).to_list(length=page_size))
    return {"page": page, "page_size": page_size, "total": total, "items": jsonsafe(rows)}


# ── PharmaCat shared knowledge base (cached clinical answers) — admin curation ──────────────
# The CDSS caches every answer platform-wide by query signature and re-serves it for free. A
# wrong/miscategorised answer would otherwise be frozen, so admins can search/fix/delete entries.
class KbEditIn(BaseModel):
    reply: str | None = None
    substances: list[str] | None = None       # commercial-substance names (drive product chips)
    otc_categories: list[str] | None = None
    query: str | None = None                  # the question text (lets admins fill unknown ones)


class KbRegenIn(BaseModel):
    question: str | None = None               # supply the question when the entry has none stored


_GR_FOLD = {"α": "αά", "ά": "αά", "ε": "εέ", "έ": "εέ", "η": "ηή", "ή": "ηή",
            "ι": "ιίϊΐ", "ί": "ιίϊΐ", "ϊ": "ιίϊΐ", "ο": "οό", "ό": "οό",
            "υ": "υύϋΰ", "ύ": "υύϋΰ", "ϋ": "υύϋΰ", "ω": "ωώ", "ώ": "ωώ"}


def _accent_insensitive_regex(term: str) -> str:
    """Greek search that ignores tonos — 'καουρα' matches 'καούρα' and vice-versa."""
    out = []
    for ch in term:
        cls = _GR_FOLD.get(ch.lower())
        out.append(f"[{cls}]" if cls else re.escape(ch))
    return "".join(out)


@router.get("/pharmacat-kb")
async def pharmacat_kb_list(q: str | None = None, flagged: bool = False,
                            page: int = 1, page_size: int = 30,
                            _: PlatformContext = Depends(get_platform_admin)):
    """Search the shared PharmaCat knowledge base. `flagged=true` → only entries a pharmacist
    reported as wrong (with the reasons), so they can be found & corrected quickly."""
    db = shared_db()
    filt: dict = {}
    if flagged:
        filt["flag_open"] = True
    if q and q.strip():
        rx = {"$regex": _accent_insensitive_regex(q.strip()), "$options": "i"}
        filt["$or"] = [{"query": rx}, {"result.reply": rx}, {"result.substances.name": rx}]
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    coll = db["pharmacat_knowledge"]
    total = await coll.count_documents(filt)
    flagged_total = await coll.count_documents({"flag_open": True})
    # flagged entries first, then most-recent
    rows = await (coll.find(filt).sort([("flag_open", -1), ("last_flag_at", -1), ("last_at", -1)])
                  .skip((page - 1) * page_size).limit(page_size).to_list(length=page_size))
    sigs = [r.get("sig") for r in rows if r.get("flag_open")]
    reports_by_sig: dict = {}
    if sigs:
        async for rep in db["pharmacat_reports"].find({"sig": {"$in": sigs}, "status": "open"}):
            reports_by_sig.setdefault(rep["sig"], []).append(
                {"reason": rep.get("reason"), "at": rep.get("created_at")})
    items = []
    for r in rows:
        res = r.get("result") or {}
        items.append({
            "sig": r.get("sig"),
            "query": r.get("query"),
            "reply": (res.get("reply") or "")[:800],
            "substances": [s.get("name") for s in (res.get("substances") or []) if s.get("name")],
            "otc_categories": res.get("otc_categories") or [],
            "stage": res.get("stage"),
            "hits": r.get("hits", 0),
            "flag_open": bool(r.get("flag_open")),
            "flag_count": r.get("flag_count", 0),
            "reports": reports_by_sig.get(r.get("sig"), []),
            "edited_at": r.get("edited_at"),
            "last_at": r.get("last_at"), "created_at": r.get("created_at"),
        })
    return {"page": page, "page_size": page_size, "total": total,
            "flagged_total": flagged_total, "items": jsonsafe(items)}


async def _resolve_reports(db, sig: str) -> None:
    """Correction happened → mark this entry's open reports resolved (notifies the pharmacists)
    and clear the KB flag."""
    now = datetime.now(tz=timezone.utc)
    await db["pharmacat_reports"].update_many(
        {"sig": sig, "status": "open"}, {"$set": {"status": "resolved", "resolved_at": now}})
    await db["pharmacat_knowledge"].update_one(
        {"sig": sig}, {"$set": {"flag_open": False, "flag_count": 0}})


@router.post("/pharmacat-kb/{sig}/resolve")
async def pharmacat_kb_resolve(sig: str, _: PlatformContext = Depends(get_platform_admin)):
    """Dismiss the flags on an entry (mark reports resolved) WITHOUT editing — for false reports."""
    await _resolve_reports(shared_db(), sig)
    return {"ok": True}


@router.delete("/pharmacat-kb/{sig}")
async def pharmacat_kb_delete(sig: str, _: PlatformContext = Depends(get_platform_admin)):
    """Delete a cached answer → the next time that question is asked the AI is re-queried fresh."""
    res = await shared_db()["pharmacat_knowledge"].delete_one({"sig": sig})
    return {"deleted": res.deleted_count}


@router.put("/pharmacat-kb/{sig}")
async def pharmacat_kb_edit(sig: str, body: KbEditIn,
                            _: PlatformContext = Depends(get_platform_admin)):
    """Override a cached answer in place (authoritative correction kept for all pharmacies)."""
    db = shared_db()
    cur = await db["pharmacat_knowledge"].find_one({"sig": sig})
    if not cur:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    result = dict(cur.get("result") or {})
    if body.reply is not None:
        result["reply"] = body.reply
    if body.substances is not None:
        result["substances"] = [{"name": n.strip()} for n in body.substances if n.strip()]
    if body.otc_categories is not None:
        result["otc_categories"] = [c.strip() for c in body.otc_categories if c.strip()]
    sets: dict = {"result": result, "edited_at": datetime.now(tz=timezone.utc)}
    if body.query is not None and body.query.strip():
        sets["query"] = body.query.strip()[:500]
    await db["pharmacat_knowledge"].update_one({"sig": sig}, {"$set": sets})
    await _resolve_reports(db, sig)        # correction done → notify reporters
    return {"ok": True}


@router.post("/pharmacat-kb/{sig}/regenerate")
async def pharmacat_kb_regenerate(sig: str, body: KbRegenIn | None = None,
                                  _: PlatformContext = Depends(get_platform_admin)):
    """Re-ask the AI for this question NOW (bypassing cache + daily limit) and overwrite the stored
    answer with the fresh one. If the entry has no stored question, the admin can supply it."""
    from app.services import pharmacat_service
    db = shared_db()
    cur = await db["pharmacat_knowledge"].find_one({"sig": sig})
    if not cur:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    query = (cur.get("query") or "").strip()
    supplied = bool(body and body.question and body.question.strip())
    if not query and supplied:
        query = body.question.strip()
    if not query:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, "no_query")  # δεν ξέρουμε την ερώτηση
    st = await pharmacat_service.status()           # corrections use the stronger admin model
    res = await pharmacat_service.ask([{"role": "user", "content": query}], None,
                                      model=st.get("admin_model"))
    if not res.get("ok"):
        raise HTTPException(http_status.HTTP_502_BAD_GATEWAY,
                            {"error": res.get("error") or "ai_failed"})
    store = {k: v for k, v in res.items() if k != "ok"}
    now = datetime.now(tz=timezone.utc)
    sets = {"result": store, "last_at": now, "regenerated_at": now}
    if supplied:
        sets["query"] = query[:500]   # remember it so the button stays enabled next time
    await db["pharmacat_knowledge"].update_one({"sig": sig}, {"$set": sets})
    await _resolve_reports(db, sig)        # correction done → notify reporters
    return {"ok": True, "reply": (res.get("reply") or "")[:800]}
