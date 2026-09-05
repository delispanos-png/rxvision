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
from typing import Literal

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
    ("leads", "Leads (πρώην trials)"),
    ("staff", "Χρήστες (staff)"), ("billing", "Τιμολόγηση"), ("newsletter", "Newsletter"),
    ("smtp", "Ρυθμίσεις SMTP"), ("idika", "Διασύνδεση ΗΔΥΚΑ"),
    ("content", "Περιεχόμενο"), ("maintenance", "Συντήρηση"), ("health", "Επισκεψιμότητα"),
]
ADMIN_SECTION_KEYS = [k for k, _ in ADMIN_SECTIONS]
# URL segment (μετά το /admin/) → section key
_SEG_TO_SECTION = {
    "overview": "dashboard",
    "tenants": "subscribers", "packages": "subscribers", "subscriptions": "subscriptions",
    "staff": "staff", "billing": "billing", "invoices": "billing",
    "newsletter": "newsletter", "smtp": "smtp",
    "idika": "idika", "posts": "content", "maintenance": "maintenance",
    "health": "health", "sync-health": "health",
    "leads": "leads", "trials": "leads",
    # ── ευαίσθητα state-changing segments (ήταν unmapped → παρακάμπταν τον έλεγχο ενότητας) ──
    "integrations": "billing", "payments": "billing", "credit-packages": "billing",
    "eshop-fees": "billing", "data-retention": "maintenance", "network": "subscribers",
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
    if section is None:
        # FAIL-CLOSED σε άγνωστο segment: επιτρέπουμε ΜΟΝΟ ανάγνωση (GET/HEAD). Κάθε state-change
        # (POST/PUT/PATCH/DELETE) σε μη-χαρτογραφημένο segment απορρίπτεται για περιορισμένους admins
        # (αλλιώς νέα ευαίσθητα endpoints παρακάμπτουν σιωπηλά τον έλεγχο ενότητας — privilege escalation).
        if request.method in ("GET", "HEAD"):
            return ctx
        raise HTTPException(http_status.HTTP_403_FORBIDDEN,
                            {"error": "forbidden_section", "section": seg})
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
    retention_months: int | None = None   # παράθυρο διατήρησης δεδομένων (default 36· >36 = πρόσθετη υπηρεσία)
    afm: str | None = None                 # συμπλήρωση/διόρθωση ΑΦΜ (billing_profile) + auto-enrich ΑΑΔΕ
    # ── στοιχεία εταιρείας (τιμολόγηση) + επικοινωνία ──
    # Γράφονται ΚΑΙ σε company.* ΚΑΙ σε billing_profile.* ώστε κάρτα/comms/auth (company) και
    # τιμολόγια/SoftOne (billing_profile) να διαβάζουν πάντα τα ίδια. "" = καθαρισμός πεδίου.
    company_name: str | None = None        # επωνυμία τιμολόγησης (νομική)
    company_doy: str | None = None         # ΔΟΥ
    company_address: str | None = None
    company_city: str | None = None
    company_postal_code: str | None = None
    contact_email: str | None = None
    contact_phone: str | None = None


class InvoiceLineIn(BaseModel):
    description: str = ""
    item_key: str | None = None    # κλειδί κεντρικής λίστας ειδών (pkg:/credit:/addon:/ai/retention)
    mtrl: str | None = None        # SoftOne κωδικός είδους (προκύπτει από το item_key· fallback default)
    qty: float = 1.0
    unit_net: int = 0              # καθαρή τιμή μονάδας σε cents
    vat_rate: float = 24.0
    disc_kind: str = "pct"         # "pct" (ποσοστό) | "amount" (ποσό σε cents)
    disc_value: float = 0.0        # ποσοστό 0-100 αν pct· cents αν amount


class InvoiceIn(BaseModel):
    tenant_id: str
    doc_type: str = "ΤΠΥ"          # τύπος παραστατικού
    series: str = "Α"             # σειρά
    issue_date: str | None = None  # ISO· default σήμερα
    description: str = ""
    comments: str = ""             # αιτιολογία παραστατικού (π.χ. περίοδος συνδρομής) → SoftOne COMMENTS
    net_amount: int = 0            # legacy μονή αξία (cents) — αν δεν δοθούν γραμμές
    vat_rate: float = 24.0
    lines: list[InvoiceLineIn] | None = None   # πολυγραμμικό παραστατικό (header/γραμμές/σύνολα)
    discount_kind: str = "pct"     # έκπτωση συνόλου: "pct" | "amount" (cents)
    discount_value: float = 0.0


class InvoiceEditIn(BaseModel):
    doc_type: str | None = None
    series: str | None = None
    issue_date: str | None = None
    description: str | None = None
    comments: str | None = None
    net_amount: int | None = None
    vat_rate: float | None = None
    lines: list[InvoiceLineIn] | None = None
    discount_kind: str | None = None
    discount_value: float | None = None


def _line_discount(gross: int, kind: str, value: float) -> int:
    """Έκπτωση γραμμής σε cents (δεν ξεπερνά το μικτό). pct=ποσοστό, amount=cents."""
    if value <= 0 or gross <= 0:
        return 0
    d = round(gross * value / 100) if kind == "pct" else int(round(value))
    return max(0, min(d, gross))


def _compute_invoice(lines_in: list[dict], hdisc_kind: str = "pct", hdisc_value: float = 0.0) -> dict:
    """Πλήρης υπολογισμός παραστατικού με εκπτώσεις (γραμμής + συνόλου). Money = integer cents.
    Η έκπτωση συνόλου κατανέμεται αναλογικά στις γραμμές ώστε το ΦΠΑ ανά συντελεστή να είναι σωστό."""
    lines: list[dict] = []
    subtotal = 0
    for ln in lines_in:
        qty = float(ln.get("qty") or 0) or 1.0
        unit = int(ln.get("unit_net") or 0)
        rate = float(ln.get("vat_rate") or 0)
        gross = round(qty * unit)
        ldisc = _line_discount(gross, ln.get("disc_kind") or "pct", float(ln.get("disc_value") or 0))
        net = gross - ldisc
        lines.append({"description": (ln.get("description") or "").strip(), "item_key": (ln.get("item_key") or None), "mtrl": (ln.get("mtrl") or None),
                      "qty": qty, "unit_net": unit, "vat_rate": rate,
                      "disc_kind": ln.get("disc_kind") or "pct", "disc_value": float(ln.get("disc_value") or 0),
                      "gross": gross, "discount": ldisc, "net": net, "vat": round(net * rate / 100), "total": net + round(net * rate / 100)})
        subtotal += net
    # έκπτωση συνόλου (πάνω στο μερικό σύνολο μετά τις εκπτώσεις γραμμών)
    hdisc = _line_discount(subtotal, hdisc_kind, hdisc_value)
    net_total = subtotal - hdisc
    # ΦΠΑ: κατανομή της έκπτωσης συνόλου αναλογικά ανά γραμμή (σωστό ανά συντελεστή)
    vat_total = 0
    remaining = hdisc
    for i, ln in enumerate(lines):
        share = (round(ln["net"] * hdisc / subtotal) if i < len(lines) - 1 else remaining) if (subtotal and hdisc) else 0
        remaining -= share
        vat_total += round((ln["net"] - share) * ln["vat_rate"] / 100)
    return {"lines": lines, "subtotal_net": subtotal,
            "discount": {"kind": hdisc_kind, "value": hdisc_value, "amount": hdisc},
            "net_amount": net_total, "vat_amount": vat_total, "total": net_total + vat_total}


# tenant-scoped collections wiped on hard delete
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
    insecure_tls: bool = False   # accept a self-signed / hostname-mismatched cert (own mail server)


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
    from app.services import billing_service
    db = shared_db()
    subs = {s["tenant_id"]: s async for s in db["subscriptions"].find({})}
    wallets = {w["_id"]: int(w.get("balance_cents", 0) or 0) async for w in db["message_wallets"].find({})}
    user_counts: dict[str, int] = {}
    async for row in db["users"].aggregate([{"$group": {"_id": "$tenant_id", "n": {"$sum": 1}}}]):
        user_counts[row["_id"]] = row["n"]
    # concurrent active sessions (= seats consumed) seen in the last 5 minutes, per tenant.
    # Counts SESSIONS not distinct users — the same login on two PCs is two seats.
    cutoff = datetime.now(tz=timezone.utc) - timedelta(minutes=5)
    active_now: dict[str, int] = {}
    async for row in db["user_sessions"].aggregate([
        {"$match": {"last_active_at": {"$gte": cutoff}, "impersonation": {"$ne": True}}},
        {"$group": {"_id": "$tenant_id", "n": {"$sum": 1}}},
    ]):
        active_now[row["_id"]] = row["n"]

    items = []
    async for t in db["tenants"].find({}).sort("created_at", -1):
        sub = subs.get(t["_id"], {})
        pharmacies = (sub.get("limits") or {}).get("pharmacies", 1) or 1
        mrr = 0 if sub.get("complimentary") else (sub.get("price_per_pharmacy") or 0) * pharmacies
        items.append({
            "id": t["_id"],
            "name": t.get("name", t["_id"]),
            "afm": (t.get("company") or {}).get("afm") or (t.get("billing_profile") or {}).get("afm"),
            "plan": sub.get("plan", "—"),
            "status": billing_service.effective_status(sub) if sub else (t.get("status") or "—"),
            "users": user_counts.get(t["_id"], 0),
            "active_now": active_now.get(t["_id"], 0),
            "seats": sub.get("seats") or pharmacies,
            "mrr": mrr,
            "msg_balance": wallets.get(t["_id"], 0),
            "created_at": t.get("created_at"),
        })
    return {"items": jsonsafe(items)}


@router.get("/overview")
async def overview(_: PlatformContext = Depends(get_platform_admin)):
    """Platform mission-control KPIs in ONE call: business + volume + usage/modules + ops/AI/comms.
    Defensive by design — empty/absent collections and unknown fields degrade to 0, never 500."""
    db = shared_db()
    now = datetime.now(tz=timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month = today.replace(day=1)

    def _aware(t):
        return t if (isinstance(t, datetime) and t.tzinfo) else (t.replace(tzinfo=timezone.utc) if isinstance(t, datetime) else None)

    async def _count(coll: str, q: dict) -> int:
        try:
            return await db[coll].count_documents(q)
        except Exception:  # noqa: BLE001 — a missing coll/field must not break the dashboard
            return 0

    async def _est(coll: str) -> int:
        try:
            return await db[coll].estimated_document_count()
        except Exception:  # noqa: BLE001
            return 0

    # ---------- Business & revenue ----------
    tenants = [t async for t in db["tenants"].find({}, {"name": 1, "status": 1, "modules": 1, "created_at": 1, "demo": 1})]
    tnames = {t["_id"]: t.get("name", t["_id"]) for t in tenants}
    subs = {s["tenant_id"]: s async for s in db["subscriptions"].find({})}
    by_status: dict[str, int] = {}
    plan_dist: dict[str, int] = {}
    module_counts: dict[str, int] = {}
    mrr = 0
    new_month = 0
    for t in tenants:
        sub = subs.get(t["_id"], {})
        st = sub.get("status") or t.get("status") or "—"
        by_status[st] = by_status.get(st, 0) + 1
        pharm = (sub.get("limits") or {}).get("pharmacies", 1) or 1
        mrr += 0 if sub.get("complimentary") else (sub.get("price_per_pharmacy") or 0) * pharm
        plan = sub.get("plan_name") or sub.get("plan") or "—"
        plan_dist[plan] = plan_dist.get(plan, 0) + 1
        ca = _aware(t.get("created_at"))
        if ca and ca >= month:
            new_month += 1
        mods = t.get("modules") or {}
        keys = [k for k, v in mods.items() if v in ("enabled", True)] if isinstance(mods, dict) else list(mods)
        for k in keys:
            module_counts[k] = module_counts.get(k, 0) + 1
    business = {
        "tenants": len(tenants),
        "active": by_status.get("active", 0),
        "trial": by_status.get("trial", 0),
        "past_due": by_status.get("past_due", 0),
        "suspended": by_status.get("suspended", 0),
        "mrr": mrr,
        "arr": mrr * 12,
        "new_tenants_month": new_month,
        "plans": [{"plan": k, "n": v} for k, v in sorted(plan_dist.items(), key=lambda x: -x[1])],
        "invoices_month": await _count("invoices", {"issue_date": {"$gte": month}}),
        "invoices_untransmitted": await _count("invoices", {"aade_status": "not_transmitted"}),
    }

    # ---------- Volume & activity ----------
    volume = {
        "executions_total": await _est("prescription_executions"),
        "executions_month": await _count("prescription_executions", {"executed_at": {"$gte": month}}),
        "executions_today": await _count("prescription_executions", {"executed_at": {"$gte": today}}),
        "items_total": await _est("prescription_items"),
        "patients_total": await _est("patients_anonymized"),
        "vaccinations_total": await _est("vaccinations"),
        "vaccinations_month": await _count("vaccinations", {"executed_at": {"$gte": month}}),
    }

    # ---------- Usage & module adoption ----------
    cutoff5 = now - timedelta(minutes=5)
    usage = {
        "users": await _count("users", {}),
        "sessions_now": await _count("user_sessions", {"last_active_at": {"$gte": cutoff5}, "impersonation": {"$ne": True}}),
        "portal_accounts": await _count("patient_accounts", {}),
        "appointments": await _count("appointments", {}),
        "orders": await _count("orders_delivery", {}),
        "modules": [{"module": k, "n": v} for k, v in sorted(module_counts.items(), key=lambda x: -x[1])],
    }

    # ---------- Operations, AI & comms ----------
    sync = {"success": 0, "failed": 0, "partial": 0, "running": 0}
    sync_errors = 0
    try:
        async for row in db["sync_jobs"].aggregate([
            {"$match": {"started_at": {"$gte": today}}},
            {"$group": {"_id": "$status", "n": {"$sum": 1}, "err": {"$sum": {"$ifNull": ["$errors", 0]}}}},
        ]):
            sync[row["_id"] or "?"] = row["n"]
            sync_errors += int(row.get("err") or 0)
    except Exception:  # noqa: BLE001
        pass
    bs = await db["backup_status"].find_one({"_id": "last"}) or {}
    bts = _aware(bs.get("ts"))
    backup = {
        "last_at": bs.get("ts"),
        "age_h": round((now - bts).total_seconds() / 3600, 1) if bts else None,
        "ok": bs.get("ok"),
        "offsite": bool(bs.get("box_used")) or ("offsite" in str(bs.get("location", "")).lower()),
    }
    nodes_total = nodes_fresh = 0
    seen: set = set()
    try:
        async for m in db["node_metrics"].find({}, {"node": 1, "ts": 1}).sort("$natural", -1).limit(80):
            n = m.get("node")
            if not n or n in seen:
                continue
            seen.add(n)
            nodes_total += 1
            ts = _aware(m.get("ts"))
            if ts and (now - ts) < timedelta(minutes=2):
                nodes_fresh += 1
    except Exception:  # noqa: BLE001
        pass
    llm_calls = llm_cost = 0
    try:
        async for row in db["llm_daily_usage"].aggregate([
            {"$match": {"date": today.strftime("%Y-%m-%d")}},
            {"$group": {"_id": None, "calls": {"$sum": {"$ifNull": ["$calls", 0]}}, "cost": {"$sum": {"$ifNull": ["$cost_cents", 0]}}}},
        ]):
            llm_calls, llm_cost = row.get("calls", 0), row.get("cost", 0)
    except Exception:  # noqa: BLE001
        pass
    wallet_total = 0
    try:
        async for w in db["message_wallets"].find({}, {"balance_cents": 1}):
            wallet_total += int(w.get("balance_cents") or 0)
    except Exception:  # noqa: BLE001
        pass
    ops = {
        "sync_today": sync,
        "sync_errors_today": sync_errors,
        "alerts_7d": await _count("ingestion_alerts", {"at": {"$gte": now - timedelta(days=7)}}),
        "backup": backup,
        "nodes_total": nodes_total,
        "nodes_fresh": nodes_fresh,
        "llm_calls_today": llm_calls,
        "llm_cost_today": llm_cost,
        "messages_today": await _count("message_ledger", {"at": {"$gte": today}}),
        "wallet_total": wallet_total,
    }

    # ---------- Charts ----------
    since14 = today - timedelta(days=13)
    exec_trend = []
    try:
        by_day: dict[str, int] = {}
        async for row in db["prescription_executions"].aggregate([
            {"$match": {"executed_at": {"$gte": since14}}},
            {"$group": {"_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$executed_at"}}, "n": {"$sum": 1}}},
        ]):
            by_day[row["_id"]] = row["n"]
        for i in range(14):
            d = (since14 + timedelta(days=i)).strftime("%Y-%m-%d")
            exec_trend.append({"day": d, "n": by_day.get(d, 0)})
    except Exception:  # noqa: BLE001
        pass
    top_tenants = []
    try:
        async for row in db["prescription_executions"].aggregate([
            {"$group": {"_id": "$tenant_id", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}}, {"$limit": 8},
        ]):
            top_tenants.append({"tenant": tnames.get(row["_id"], row["_id"]), "n": row["n"]})
    except Exception:  # noqa: BLE001
        pass
    charts = {"exec_trend": exec_trend, "top_tenants": top_tenants}

    return jsonsafe({"business": business, "volume": volume, "usage": usage, "ops": ops, "charts": charts, "generated_at": now})


@router.get("/subscriptions")
async def subscriptions(_: PlatformContext = Depends(get_platform_admin)):
    """All tenant subscriptions with expiry/trial/renewal signals (concept: Συνδρομές).

    `days_to_expiry` < 0 = ληγμένη· 0..30 = λήγει σύντομα· trial_days_left for trials.
    """
    from app.services import billing_service
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
            "status": billing_service.effective_status(s),   # ΜΙΑ συνεκτική κατάσταση (ενεργός/ληγμένος)
            "billing_cycle": s.get("billing_cycle"),
            "seats": s.get("seats", pharmacies),
            "active_now": active_now.get(s["tenant_id"], 0),
            "mrr": 0 if s.get("complimentary") else (s.get("price_per_pharmacy") or 0) * pharmacies,
            "started_at": s.get("created_at") or created.get(s["tenant_id"]),
            "current_period_end": s.get("current_period_end"),
            "days_to_expiry": d2e,
            "trial_ends_at": s.get("trial_ends_at"),
            "trial_days_left": trial_left,
            "complimentary": bool(s.get("complimentary")),
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
        "mrr": 0 if s.get("complimentary") else (s.get("price_per_pharmacy") or 0) * pharmacies,
        # subscription-level override wins over the package default (admin can edit per-tenant)
        "extra_user_price": s.get("extra_user_price") if "extra_user_price" in s else pkg.get("extra_user_price"),
        "extra_user_price_yearly": s.get("extra_user_price_yearly") if "extra_user_price_yearly" in s else pkg.get("extra_user_price_yearly"),
        "started_at": s.get("started_at") or s.get("created_at") or t.get("created_at"),
        "current_period_end": s.get("current_period_end"),
        "trial_ends_at": s.get("trial_ends_at"),
        "complimentary": bool(s.get("complimentary")),
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
    complimentary: bool | None = None          # δωρεάν πελάτης → χωρίς χρέωση & χωρίς παραστατικά


@router.patch("/subscriptions/{tenant_id}")
async def edit_subscription(tenant_id: str, body: SubEditIn,
                            _: PlatformContext = Depends(get_platform_admin)):
    """Edit a subscription (cycle/price/dates/seats/sla/plan/status). A status change also
    flips the tenant active/suspended — so «απενεργοποίηση λόγω μη πληρωμής» blocks login."""
    db = shared_db()
    cur = await db["subscriptions"].find_one({"tenant_id": tenant_id})
    if not cur:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "subscription_not_found")
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    if upd:
        upd["updated_at"] = datetime.now(tz=timezone.utc)
        # ⭐ ΑΛΛΑΓΗ ΠΛΑΝΟΥ → συγχρόνισε ΚΑΙ τα δικαιώματα (modules_included) από το νέο πακέτο, ώστε ο
        #   πελάτης να ΜΗΝ κρατά τα δικαιώματα του παλιού (full) πλάνου. Ενοποίηση με το assign_package.
        sync_pkg = None
        if body.plan and body.plan != cur.get("plan"):
            pkg = await db["packages"].find_one({"_id": body.plan})
            if pkg:
                upd["modules_included"] = pkg.get("modules", [])
                upd.setdefault("plan_name", pkg.get("name"))
                if pkg.get("available_addons") is not None:
                    upd["available_addons"] = pkg.get("available_addons")
                sync_pkg = pkg
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": upd})
        if sync_pkg is not None:
            # τα per-tenant overrides «πέφτουν» στο νέο πλάνο — κράτα μόνο τυχόν αγορασμένα add-ons
            keep = {a: "enabled" for a in (cur.get("addons") or [])}
            await db["tenants"].update_one({"_id": tenant_id},
                                           {"$set": {"modules": keep, "updated_at": upd["updated_at"]}})
        if body.status:
            tstatus = "active" if body.status in ("active", "trial", "past_due") else "suspended"
            await db["tenants"].update_one(  # tenant-ok: platform admin, explicit _id
                {"_id": tenant_id}, {"$set": {"status": tstatus, "updated_at": upd["updated_at"]}})
    return {"ok": True, "modules_synced": bool(body.plan and body.plan != cur.get("plan"))}


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
    price_includes_vat: bool | None = None   # True = οι τιμές περιλαμβάνουν ΦΠΑ· False/None = καθαρές (+ΦΠΑ)
    extra_user_price: int | None = None         # cents — cost per extra user/seat beyond `seats`, per MONTH
    extra_user_price_yearly: int | None = None   # cents — cost per extra user/seat beyond `seats`, per YEAR
    trial_days: int | None = None
    seats: int | None = None
    included_users: int | None = None  # πόσους ταυτόχρονους χρήστες περιλαμβάνει ΔΩΡΕΑΝ η τιμή (default 1)
    ai_included: int | None = None            # δωρεάν AI ερωτήσεις που περιλαμβάνει το πακέτο
    ai_included_period: str | None = None     # "month" (σύνολο/μήνα) ή "day" (ανά ημέρα)
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
        # Propagate the plan-defining fields to EXISTING subscribers on this package, so editing a
        # package immediately changes what its tenants get (no stale modules_included snapshot).
        prop: dict = {}
        if body.modules is not None:
            prop["modules_included"] = body.modules
        if body.available_addons is not None:
            prop["available_addons"] = body.available_addons
        if prop:
            await db["subscriptions"].update_many({"plan": code}, {"$set": prop})
    return {"ok": True, "package": jsonsafe(await db["packages"].find_one({"_id": code}))}


@router.delete("/packages/{code}")
async def delete_package(code: str, _: PlatformContext = Depends(get_platform_admin)):
    await shared_db()["packages"].delete_one({"_id": code})  # tenant-ok: platform catalog
    return {"ok": True}


# ── Plan-change requests (upgrade via bank transfer → admin approval; card/downgrade shown too) ───
@router.get("/plan-changes")
async def plan_changes(_: PlatformContext = Depends(get_platform_admin)):
    """Pending plan changes across tenants (bank-transfer upgrades to approve first)."""
    from app.services import plan_change_service
    return {"items": jsonsafe(await plan_change_service.list_pending_admin())}


@router.post("/plan-changes/{tenant_id}/approve")
async def approve_plan_change(tenant_id: str, ctx: PlatformContext = Depends(get_platform_admin)):
    """Confirm a bank-transfer payment was received → apply the upgrade immediately."""
    from app.services import plan_change_service
    res = await plan_change_service.apply_change(tenant_id, source=f"admin:{ctx.email}")
    if not res.get("ok"):
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, detail=res.get("error", "apply_failed"))
    await shared_db()["audit_logs"].insert_one({
        "tenant_id": tenant_id, "action": "plan_change_approved", "by": ctx.email,
        "detail": res, "at": datetime.now(tz=timezone.utc)})
    return res


@router.post("/plan-changes/{tenant_id}/reject")
async def reject_plan_change(tenant_id: str, ctx: PlatformContext = Depends(get_platform_admin)):
    """Reject / cancel a pending plan change."""
    from app.services import plan_change_service
    await plan_change_service.cancel_change(tenant_id)
    await shared_db()["audit_logs"].insert_one({
        "tenant_id": tenant_id, "action": "plan_change_rejected", "by": ctx.email,
        "at": datetime.now(tz=timezone.utc)})
    return {"ok": True}


class BankIn(BaseModel):
    beneficiary: str | None = None
    bank_name: str | None = None
    iban: str | None = None
    swift: str | None = None
    notes: str | None = None


@router.get("/billing-bank")
async def get_billing_bank(_: PlatformContext = Depends(get_platform_admin)):
    """Bank account shown to tenants for bank-transfer plan upgrades."""
    from app.services import plan_change_service
    return plan_change_service.bank_public(await plan_change_service.bank_details())


@router.put("/billing-bank")
async def set_billing_bank(body: BankIn, _: PlatformContext = Depends(get_platform_admin)):
    from app.services import plan_change_service
    return await plan_change_service.set_bank_details(body.model_dump())


# ── Payment methods (enable/disable) — drives the tenant upgrade UI + registration wizard ────────
@router.get("/payment-methods")
async def get_payment_methods(_: PlatformContext = Depends(get_platform_admin)):
    from app.services import payment_methods, alphabank_service
    return {"methods": await payment_methods.config(),
            "alphabank_configured": await alphabank_service.is_configured()}


class PaymentMethodsIn(BaseModel):
    card_revolut: bool | None = None
    card_viva: bool | None = None
    card_alpha: bool | None = None
    bank_transfer: bool | None = None


@router.put("/payment-methods")
async def set_payment_methods(body: PaymentMethodsIn, _: PlatformContext = Depends(get_platform_admin)):
    from app.services import payment_methods
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    return {"methods": await payment_methods.set_config(updates)}


# ── Ειδοποιήσεις συνδρομής (κείμενα email + περιθώρια + επαφή πωλήσεων) ─────────────
@router.get("/subscription-notifications")
async def get_subscription_notifications(_: PlatformContext = Depends(get_platform_admin)):
    from app.services import billing_service
    return await billing_service.notification_config()


class SubNotifIn(BaseModel):
    trial_grace_days: int | None = Field(None, ge=0, le=90)
    active_grace_days: int | None = Field(None, ge=0, le=180)
    warn_days: list[int] | None = None
    expired_max_days: int | None = Field(None, ge=0, le=365)
    sales_email: str | None = None
    sales_phone: str | None = None
    warn_subject: str | None = None
    warn_body: str | None = None
    expired_subject: str | None = None
    expired_body: str | None = None


@router.put("/subscription-notifications")
async def set_subscription_notifications(body: SubNotifIn, _: PlatformContext = Depends(get_platform_admin)):
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    if "warn_days" in upd:
        upd["warn_days"] = sorted({int(x) for x in upd["warn_days"] if 0 < int(x) <= 90}, reverse=True)[:6]
    if upd:
        await shared_db()["platform_settings"].update_one(
            {"_id": "billing"}, {"$set": upd}, upsert=True)
    from app.services import billing_service
    return await billing_service.notification_config()


class SubNotifTestIn(BaseModel):
    email: str
    kind: str = "expired"  # warn | expired


@router.post("/subscription-notifications/test")
async def test_subscription_notification(body: SubNotifTestIn, _: PlatformContext = Depends(get_platform_admin)):
    from app.services import billing_service
    return await billing_service.send_test_reminder(body.email, body.kind)


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
    # Viva Wallet (Smart Checkout) — κάρτα + IRIS· εναλλακτική του Revolut για τις συνδρομές
    viva_client_id: str | None = None
    viva_client_secret: str | None = None
    viva_merchant_id: str | None = None
    viva_api_key: str | None = None
    viva_source_code: str | None = None
    viva_mode: str | None = None  # demo | live
    # SoftOne / myDATA (παραγωγή παραστατικών → διαβίβαση myDATA μέσω SoftOne)
    softone_base_url: str | None = None
    softone_app_id: str | None = None
    softone_username: str | None = None
    softone_password: str | None = None
    softone_company: str | None = None
    softone_branch: str | None = None
    softone_module: str | None = None
    softone_refid: str | None = None
    softone_series: str | None = None
    softone_salesman: str | None = None      # κωδικός Πωλητή για το παραστατικό
    softone_form: str | None = None
    softone_js_endpoint: str | None = None   # custom JS web service: "<module>/<function>"
    softone_issuer_afm: str | None = None
    softone_issuer_name: str | None = None
    # πλήρη στοιχεία εκδότη (CloudOn) για το παραστατικό
    softone_issuer_doy: str | None = None
    softone_issuer_activity: str | None = None
    softone_issuer_legal_form: str | None = None
    softone_issuer_gemi: str | None = None
    softone_issuer_address: str | None = None
    softone_issuer_postal_code: str | None = None
    softone_issuer_city: str | None = None
    softone_issuer_region: str | None = None
    softone_issuer_phone: str | None = None
    softone_issuer_email: str | None = None
    softone_auto_invoicing: bool | None = None   # master switch: αυτόματη έκδοση παραστατικών
    subscription_provider: str | None = None  # revolut | viva — ποιος χρεώνει τις συνδρομές
    # Alpha Bank (Alpha e-Commerce) card gateway — alternative to Revolut
    alphabank_merchant_id: str | None = None
    alphabank_shared_secret: str | None = None
    alphabank_mode: str | None = None  # test | live
    anthropic_api_key: str | None = None  # PharmaCat clinical assistant (Claude)
    anthropic_enabled: bool | None = None
    anthropic_model: str | None = None        # model for pharmacist queries (cheap)
    anthropic_admin_model: str | None = None  # model for admin KB corrections (strong)
    drugbank_api_key: str | None = None       # DrugBank Clinical API — drug-drug interactions
    drugbank_enabled: bool | None = None
    drugbank_region: str | None = None        # eu | us | canada
    # Central messaging (Apifon SMS + Viber) + per-channel prices (cents) for the prepaid wallet
    apifon_token: str | None = None
    apifon_secret: str | None = None
    sms_sender: str | None = None
    viber_sender: str | None = None
    price_email: int | None = None
    price_sms: int | None = None
    price_viber: int | None = None
    # Κόστος μας ανά μήνυμα (cents, δεκαδικά επιτρεπτά — π.χ. 3.4 λεπτά = €0,034) + ποσοστό κέρδους (%)
    # ανά κανάλι → τιμή πελάτη = cost*(1+margin/100). Το κόστος είναι ΜΟΝΟ για το report κέρδους· η
    # πραγματική χρέωση wallet (`prices`) μένει σε ακέραια λεπτά.
    cost_email: float | None = None
    cost_sms: float | None = None
    cost_viber: float | None = None
    margin_email: float | None = None
    margin_sms: float | None = None
    margin_viber: float | None = None
    central_low_balance: float | None = None    # όριο κεντρικού υπολοίπου Apifon → alert
    admin_alert_email: str | None = None        # που στέλνεται το alert


class AlertRecipientsIn(BaseModel):
    phones: list[str] = []


@router.get("/alert-recipients")
async def get_alert_recipients(_: PlatformContext = Depends(get_platform_admin)):
    """Λίστα κινητών που λαμβάνουν SMS ειδοποιήσεις ιδιοκτήτη (νέα εγγραφή / έναρξη-πρόβλημα ΗΔΥΚΑ)."""
    from app.services.platform_secrets import decrypt_doc
    cfg = decrypt_doc("comms", await shared_db()["platform_settings"].find_one({"_id": "comms"})) or {}
    phones = list(cfg.get("admin_alert_phones") or [])
    single = str(cfg.get("admin_alert_phone") or "").strip()
    if single and single not in phones:
        phones.append(single)
    return {"phones": phones}


@router.put("/alert-recipients")
async def set_alert_recipients(body: AlertRecipientsIn, _: PlatformContext = Depends(get_platform_admin)):
    """Αποθήκευση λίστας κινητών (μέχρι 20). Κρατούνται στο platform_settings.comms.admin_alert_phones."""
    from datetime import datetime, timezone
    phones, seen = [], set()
    for p in body.phones:
        p = str(p or "").strip()
        if p and p not in seen:
            seen.add(p)
            phones.append(p)
    phones = phones[:20]
    await shared_db()["platform_settings"].update_one(
        {"_id": "comms"},
        {"$set": {"admin_alert_phones": phones, "updated_at": datetime.now(tz=timezone.utc)},
         "$unset": {"admin_alert_phone": ""}}, upsert=True)   # migrate legacy single → list
    return {"ok": True, "phones": phones}


@router.post("/alert-recipients/test")
async def test_alert_recipients(_: PlatformContext = Depends(get_platform_admin)):
    """Δοκιμαστικό SMS σε όλα τα καταχωρημένα κινητά — για επιβεβαίωση ρύθμισης."""
    from app.services.comms import admin_alert
    await admin_alert("🔔 RxVision — δοκιμαστική ειδοποίηση. Οι ειδοποιήσεις ιδιοκτήτη λειτουργούν.")
    return {"ok": True}


@router.get("/integrations")
async def get_integrations(_: PlatformContext = Depends(get_platform_admin)):
    """ΑΑΔΕ + Revolut credential status (secrets masked) for the admin settings screen."""
    db = shared_db()
    from app.services.platform_secrets import decrypt_doc
    aade = decrypt_doc("aade", await db["platform_settings"].find_one({"_id": "aade"})) or {}
    rev = decrypt_doc("revolut", await db["platform_settings"].find_one({"_id": "revolut"})) or {}
    viva = decrypt_doc("viva", await db["platform_settings"].find_one({"_id": "viva"})) or {}
    softone = decrypt_doc("softone", await db["platform_settings"].find_one({"_id": "softone"})) or {}
    billing_cfg = await db["platform_settings"].find_one({"_id": "billing"}) or {}
    ant = decrypt_doc("anthropic", await db["platform_settings"].find_one({"_id": "anthropic"})) or {}
    dbk = decrypt_doc("drugbank", await db["platform_settings"].find_one({"_id": "drugbank"})) or {}
    comms_cfg = decrypt_doc("comms", await db["platform_settings"].find_one({"_id": "comms"})) or {}
    _pr = comms_cfg.get("prices") or {}
    _cost = comms_cfg.get("cost") or {}
    _margin = comms_cfg.get("margin") or {}
    return {
        "aade": {"username": aade.get("username"),
                 "configured": bool(aade.get("username") and aade.get("password"))},
        "revolut": {"mode": rev.get("mode", "sandbox"), "api_key_set": bool(rev.get("api_key")),
                    "webhook_secret_set": bool(rev.get("webhook_secret"))},
        "viva": {"mode": viva.get("mode", "demo"),
                 "client_id_set": bool(viva.get("client_id")),
                 "client_secret_set": bool(viva.get("client_secret")),
                 "merchant_id_set": bool(viva.get("merchant_id")),
                 "api_key_set": bool(viva.get("api_key")),
                 "source_code": viva.get("source_code") or "",
                 "checkout_ready": bool(viva.get("client_id") and viva.get("client_secret") and viva.get("source_code")),
                 "recurring_ready": bool(viva.get("merchant_id") and viva.get("api_key"))},
        "softone": {"base_url": softone.get("base_url") or "", "app_id": softone.get("app_id") or "",
                    "username": softone.get("username") or "", "password_set": bool(softone.get("password")),
                    "company": softone.get("company") or "", "branch": softone.get("branch") or "",
                    "module": softone.get("module") or "", "refid": softone.get("refid") or "",
                    "series": softone.get("series") or "", "salesman": softone.get("salesman") or "",
                    "form": softone.get("form") or "",
                    "js_endpoint": softone.get("js_endpoint") or "",
                    "issuer_afm": softone.get("issuer_afm") or "", "issuer_name": softone.get("issuer_name") or "",
                    "issuer_doy": softone.get("issuer_doy") or "", "issuer_activity": softone.get("issuer_activity") or "",
                    "issuer_legal_form": softone.get("issuer_legal_form") or "", "issuer_gemi": softone.get("issuer_gemi") or "",
                    "issuer_address": softone.get("issuer_address") or "", "issuer_postal_code": softone.get("issuer_postal_code") or "",
                    "issuer_city": softone.get("issuer_city") or "", "issuer_region": softone.get("issuer_region") or "",
                    "issuer_phone": softone.get("issuer_phone") or "", "issuer_email": softone.get("issuer_email") or "",
                    "auto_invoicing": bool(softone.get("auto_invoicing")),
                    "configured": bool(softone.get("base_url") and softone.get("username")
                                       and softone.get("password") and softone.get("app_id"))},
        "subscription_provider": billing_cfg.get("active_provider") or "revolut",
        "alphabank": {"mode": (decrypt_doc("alphabank", await db["platform_settings"].find_one({"_id": "alphabank"})) or {}).get("mode", "test"),
                      "merchant_id_set": bool((decrypt_doc("alphabank", await db["platform_settings"].find_one({"_id": "alphabank"})) or {}).get("merchant_id")),
                      "shared_secret_set": bool((decrypt_doc("alphabank", await db["platform_settings"].find_one({"_id": "alphabank"})) or {}).get("shared_secret"))},
        "anthropic": {"api_key_set": bool(ant.get("api_key")),
                      "enabled": ant.get("enabled", True),
                      "model": ant.get("model", "claude-opus-4-8"),
                      "admin_model": ant.get("admin_model", "claude-opus-4-8")},
        "drugbank": {"api_key_set": bool(dbk.get("api_key")),
                     "enabled": dbk.get("enabled", True),
                     "region": dbk.get("region") or "eu"},
        "comms": {"apifon_token_set": bool(comms_cfg.get("apifon_token")),
                  "apifon_secret_set": bool(comms_cfg.get("apifon_secret")),
                  "apifon_token_tail": (comms_cfg.get("apifon_token") or "")[-4:],
                  "apifon_secret_tail": (comms_cfg.get("apifon_secret") or "")[-4:],
                  "updated_at": comms_cfg.get("updated_at"),
                  "sms_sender": comms_cfg.get("sms_sender") or "RxVision",
                  "viber_sender": comms_cfg.get("viber_sender") or comms_cfg.get("sms_sender") or "RxVision",
                  "prices": {"email": int(_pr.get("email", 2)), "sms": int(_pr.get("sms", 6)),
                             "viber": int(_pr.get("viber", 4))},
                  "cost": {"email": float(_cost.get("email", 0)), "sms": float(_cost.get("sms", 0)),
                           "viber": float(_cost.get("viber", 0))},
                  "margin": {"email": float(_margin.get("email", 0)), "sms": float(_margin.get("sms", 0)),
                             "viber": float(_margin.get("viber", 0))},
                  "central_low_balance": float(comms_cfg.get("central_low_balance") or 0),
                  "admin_alert_email": comms_cfg.get("admin_alert_email") or "",
                  "central_balance_last": comms_cfg.get("central_balance_last"),
                  "central_low_alerted": bool(comms_cfg.get("central_low_alerted"))},
    }


@router.put("/integrations")
async def set_integrations(body: IntegrationsIn,
                           _: PlatformContext = Depends(get_platform_admin)):
    """Store ΑΑΔΕ / Revolut credentials in platform_settings (encrypted at rest, never in git/logs)."""
    db = shared_db()
    from app.services.platform_secrets import encrypt_fields
    a = {}
    if body.aade_username is not None:
        a["username"] = body.aade_username
    if body.aade_password:
        a["password"] = body.aade_password
    if a:
        await db["platform_settings"].update_one(
            {"_id": "aade"}, {"$set": encrypt_fields("aade", a)}, upsert=True)
    r = {}
    if body.revolut_api_key:
        r["api_key"] = body.revolut_api_key
    if body.revolut_mode:
        r["mode"] = body.revolut_mode
    if body.revolut_webhook_secret:
        r["webhook_secret"] = body.revolut_webhook_secret
    if r:
        await db["platform_settings"].update_one(
            {"_id": "revolut"}, {"$set": encrypt_fields("revolut", r)}, upsert=True)
    v = {}
    # trim: κρυφά κενά/tabs από copy-paste (ιδίως στο API key) σπάνε το Basic/OAuth auth της Viva
    if body.viva_client_id is not None:
        v["client_id"] = body.viva_client_id.strip()
    if body.viva_client_secret:
        v["client_secret"] = body.viva_client_secret.strip()
    if body.viva_merchant_id is not None:
        v["merchant_id"] = body.viva_merchant_id.strip()
    if body.viva_api_key:
        v["api_key"] = body.viva_api_key.strip()
    if body.viva_source_code is not None:
        v["source_code"] = body.viva_source_code.strip()
    if body.viva_mode:
        v["mode"] = body.viva_mode
    if v:
        await db["platform_settings"].update_one(
            {"_id": "viva"}, {"$set": encrypt_fields("viva", v)}, upsert=True)
    # SoftOne / myDATA
    s1 = {}
    _s1map = (("base_url", body.softone_base_url), ("app_id", body.softone_app_id),
              ("username", body.softone_username), ("company", body.softone_company),
              ("branch", body.softone_branch), ("module", body.softone_module),
              ("refid", body.softone_refid), ("series", body.softone_series),
              ("salesman", body.softone_salesman),
              ("form", body.softone_form), ("js_endpoint", body.softone_js_endpoint),
              ("issuer_afm", body.softone_issuer_afm), ("issuer_name", body.softone_issuer_name),
              ("issuer_doy", body.softone_issuer_doy), ("issuer_activity", body.softone_issuer_activity),
              ("issuer_legal_form", body.softone_issuer_legal_form), ("issuer_gemi", body.softone_issuer_gemi),
              ("issuer_address", body.softone_issuer_address), ("issuer_postal_code", body.softone_issuer_postal_code),
              ("issuer_city", body.softone_issuer_city), ("issuer_region", body.softone_issuer_region),
              ("issuer_phone", body.softone_issuer_phone), ("issuer_email", body.softone_issuer_email))
    for k, val in _s1map:
        if val is not None:
            s1[k] = val.strip()
    if body.softone_password:            # secret — μόνο αν δόθηκε (αλλιώς κρατά το υπάρχον)
        s1["password"] = body.softone_password
    if body.softone_auto_invoicing is not None:   # master switch (bool, όχι secret)
        s1["auto_invoicing"] = bool(body.softone_auto_invoicing)
    if s1:
        await db["platform_settings"].update_one(
            {"_id": "softone"}, {"$set": encrypt_fields("softone", s1)}, upsert=True)
    if body.subscription_provider in ("revolut", "viva"):
        await db["platform_settings"].update_one(
            {"_id": "billing"}, {"$set": {"active_provider": body.subscription_provider}}, upsert=True)
    if body.alphabank_merchant_id is not None or body.alphabank_shared_secret or body.alphabank_mode:
        from app.services import alphabank_service
        await alphabank_service.save_config(
            merchant_id=body.alphabank_merchant_id, shared_secret=body.alphabank_shared_secret,
            mode=body.alphabank_mode)
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
        await db["platform_settings"].update_one(
            {"_id": "anthropic"}, {"$set": encrypt_fields("anthropic", ant)}, upsert=True)
    dbk: dict = {}
    if body.drugbank_api_key:
        dbk["api_key"] = body.drugbank_api_key
    if body.drugbank_enabled is not None:
        dbk["enabled"] = body.drugbank_enabled
    if body.drugbank_region:
        dbk["region"] = body.drugbank_region
    if dbk:
        await db["platform_settings"].update_one(
            {"_id": "drugbank"}, {"$set": encrypt_fields("drugbank", dbk)}, upsert=True)
    cm: dict = {}
    if body.apifon_token:
        if "@" in body.apifon_token:   # guard: το client_id ΔΕΝ είναι email/login
            raise HTTPException(http_status.HTTP_400_BAD_REQUEST,
                                "Το Client ID είναι το OAuth2 client_id της Apifon (μεγάλο αλφαριθμητικό), όχι email/login.")
        cm["apifon_token"] = body.apifon_token
    if body.apifon_secret:
        cm["apifon_secret"] = body.apifon_secret
    if body.sms_sender is not None:
        cm["sms_sender"] = body.sms_sender
    if body.viber_sender is not None:
        cm["viber_sender"] = body.viber_sender
    price_set = {k: v for k, v in (("email", body.price_email), ("sms", body.price_sms),
                                   ("viber", body.price_viber)) if v is not None}
    if price_set:
        cm.update({f"prices.{k}": int(v) for k, v in price_set.items()})
    for ch in ("email", "sms", "viber"):          # κόστος μας + ποσοστό κέρδους ανά κανάλι (για display/re-edit)
        cst = getattr(body, f"cost_{ch}")
        mrg = getattr(body, f"margin_{ch}")
        if cst is not None:
            cm[f"cost.{ch}"] = round(float(cst), 1)   # έως 1 δεκαδικό λεπτού = 3 δεκαδικά €
        if mrg is not None:
            cm[f"margin.{ch}"] = float(mrg)
    if body.central_low_balance is not None:      # όριο κεντρικού υπολοίπου Apifon για alert
        cm["central_low_balance"] = float(body.central_low_balance)
    if body.admin_alert_email is not None:
        cm["admin_alert_email"] = body.admin_alert_email
    if cm:
        cm["updated_at"] = datetime.now(tz=timezone.utc)
        await db["platform_settings"].update_one(
            {"_id": "comms"}, {"$set": encrypt_fields("comms", cm)}, upsert=True)
    return {"ok": True}


class WalletCreditIn(BaseModel):
    amount_cents: int
    reason: str | None = "admin_grant"


@router.get("/tenants/{tenant_id}/wallet")
async def admin_wallet(tenant_id: str, _: PlatformContext = Depends(get_platform_admin)):
    from app.services import message_wallet
    return {**await message_wallet.usage_summary(tenant_id),
            "ledger": await message_wallet.ledger(tenant_id, limit=50)}


@router.post("/tenants/{tenant_id}/wallet/credit")
async def admin_wallet_credit(tenant_id: str, body: WalletCreditIn,
                              _: PlatformContext = Depends(get_platform_admin)):
    """Add message credits to a pharmacy's prepaid wallet (top-up / manual grant)."""
    from app.services import message_wallet
    return await message_wallet.credit(tenant_id, int(body.amount_cents), reason=body.reason or "admin_grant")


class CommsTestIn(BaseModel):
    channel: str = "sms"          # sms | viber | email
    to: str
    text: str | None = None


@router.post("/comms/test-send")
async def admin_comms_test(body: CommsTestIn, _: PlatformContext = Depends(get_platform_admin)):
    """Send a test message through the central provider (no wallet charge) to verify credentials."""
    from app.services import comms
    txt = body.text or "Hello from CloudOn / RxVision — δοκιμαστικό μήνυμα."
    try:
        await comms.admin_test_send(body.channel, body.to, txt)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, str(exc))
    return {"ok": True}


@router.get("/comms/apifon-balance")
async def admin_apifon_balance(_: PlatformContext = Depends(get_platform_admin)):
    """Το ΔΙΚΟ ΜΑΣ υπόλοιπο στον κεντρικό λογαριασμό Apifon (live)."""
    from app.services import comms
    try:
        return await comms.apifon_balance()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, str(exc))


@router.get("/comms/usage-by-tenant")
async def admin_usage_by_tenant(days: int = 30, _: PlatformContext = Depends(get_platform_admin)):
    """Κατανάλωση μηνυμάτων ανά φαρμακείο (τελευταίες `days` ημέρες) + τρέχον wallet."""
    from app.services import message_wallet
    return {"days": days, "prices": await message_wallet.prices(),
            "items": await message_wallet.usage_by_tenant(days=days)}


@router.get("/comms/profit")
async def admin_comms_profit(days: int = 30, _: PlatformContext = Depends(get_platform_admin)):
    """Κέρδος μηνυμάτων (ΓΙΑ ΕΜΑΣ): έσοδα (τι χρεώσαμε στα φαρμακεία) − κόστος μας (τι μας χρεώνει ο
    πάροχος) ανά κανάλι + σύνολο & margin. Το κόστος = πλήθος × κόστος/κανάλι (platform_settings.comms.cost)."""
    db = shared_db()
    from app.services.platform_secrets import decrypt_doc
    cfg = decrypt_doc("comms", await db["platform_settings"].find_one({"_id": "comms"})) or {}
    our_cost = cfg.get("cost") or {}
    since = datetime.now(tz=timezone.utc) - timedelta(days=int(days))
    rows: dict = {}
    # tenant-ok: πλατφορμικά έσοδα/κόστος μηνυμάτων ΣΕ ΟΛΟΥΣ τους πελάτες (adminpanel, padmin identity)
    async for r in db["sent_messages"].aggregate([
            {"$match": {"created_at": {"$gte": since}, "cost_cents": {"$gt": 0}, "refunded": {"$ne": True}}},
            {"$group": {"_id": "$channel", "count": {"$sum": 1}, "revenue": {"$sum": "$cost_cents"}}}]):
        ch = r["_id"]
        cnt, rev = int(r["count"] or 0), int(r["revenue"] or 0)
        unit = float(our_cost.get(ch, 0) or 0)     # κόστος/μονάδα σε λεπτά (δεκαδικά, π.χ. 3.4)
        cost = round(unit * cnt)                    # συνολικό κόστος σε ακέραια λεπτά
        rows[ch] = {"count": cnt, "revenue_cents": rev, "cost_cents": cost,
                    "profit_cents": rev - cost, "unit_cost_cents": round(unit, 1)}
    t_cnt = sum(v["count"] for v in rows.values())
    t_rev = sum(v["revenue_cents"] for v in rows.values())
    t_cost = sum(v["cost_cents"] for v in rows.values())
    return {"days": int(days), "by_channel": rows, "count": t_cnt,
            "revenue_cents": t_rev, "cost_cents": t_cost, "profit_cents": t_rev - t_cost,
            "margin_pct": round(100 * (t_rev - t_cost) / t_rev, 1) if t_rev else 0}


# ── Αξιολογήσεις churned trials + χειροκίνητα coupons ──────────────────────────────────────
@router.get("/feedback")
async def admin_feedback(_: PlatformContext = Depends(get_platform_admin)):
    from app.services import feedback_service
    return {"items": jsonsafe(await feedback_service.list_feedback())}


class CouponIn(BaseModel):
    discount_pct: int = Field(..., ge=1, le=90)
    days: int = Field(14, ge=1, le=365)


@router.post("/feedback/{token}/coupon")
async def admin_feedback_coupon(token: str, body: CouponIn,
                                _: PlatformContext = Depends(get_platform_admin)):
    """Ο admin στέλνει χειροκίνητα εκπτωτικό coupon στο φαρμακείο αυτής της αξιολόγησης."""
    from app.services import feedback_service
    fb = await shared_db()["feedback"].find_one({"_id": token})
    if not fb:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, detail={"error": "not_found"})
    return await feedback_service.issue_coupon(fb["tenant_id"], body.discount_pct, body.days,
                                               feedback_token=token)


@router.post("/integrations/softone/test")
async def admin_softone_test(_: PlatformContext = Depends(get_platform_admin)):
    """Δοκιμή σύνδεσης SoftOne (login + authenticate)."""
    from app.services import softone_service
    return await softone_service.test_connection()


class MtrlMapIn(BaseModel):
    map: dict[str, str] = {}
    default_mtrl: str | None = None


@router.get("/softone/items")
async def softone_items(_: PlatformContext = Depends(get_platform_admin)):
    """ΚΕΝΤΡΙΚΗ λίστα όλων των τιμολογήσιμων ειδών → κωδικός SoftOne (MTRL). Ένα σημείο αλήθειας:
    συνδρομές, credits μηνυμάτων, add-ons/modules, extras (AI/retention) + default fallback."""
    from app.services.platform_secrets import decrypt_doc
    db = shared_db()
    cfg = decrypt_doc("softone", await db["platform_settings"].find_one({"_id": "softone"})) or {}
    mm = cfg.get("mtrl_map") or {}
    # price = προτεινόμενη τιμή ΜΕ ΦΠΑ (gross, cents) — το billing χρεώνει gross· 0 = μεταβλητή/χωρίς σταθερή τιμή.
    items: list[dict] = []
    async for p in db["packages"].find({}).sort("price_monthly", 1):
        k = f"pkg:{p['_id']}"
        items.append({"key": k, "group": "Συνδρομές", "name": p.get("name") or p["_id"], "mtrl": mm.get(k, ""),
                      "price": int(p.get("price_monthly") or 0), "price_yearly": int(p.get("price_yearly") or 0),
                      "price_includes_vat": bool(p.get("price_includes_vat"))})
    async for c in db["credit_packages"].find({}).sort("price_cents", 1):
        k = f"credit:{c['_id']}"
        items.append({"key": k, "group": "Credits μηνυμάτων", "name": c.get("name") or c["_id"], "mtrl": mm.get(k, ""),
                      "price": int(c.get("price_cents") or 0), "price_includes_vat": bool(c.get("price_includes_vat"))})
    async for a in db["addons"].find({}):
        k = f"addon:{a['_id']}"
        items.append({"key": k, "group": "Add-ons / Modules", "name": a.get("name") or a["_id"], "mtrl": mm.get(k, ""),
                      "price": int(a.get("price_monthly") or 0), "price_yearly": int(a.get("price_yearly") or 0),
                      "price_includes_vat": bool(a.get("price_includes_vat"))})
    for k, nm in (("ai", "Επιπλέον όριο AI"), ("retention", "Επέκταση διατήρησης δεδομένων")):
        items.append({"key": k, "group": "Extras", "name": nm, "mtrl": mm.get(k, ""), "price": 0, "price_includes_vat": False})
    return {"items": items, "default_mtrl": mm.get("default", "")}


@router.put("/softone/items")
async def set_softone_items(body: MtrlMapIn, _: PlatformContext = Depends(get_platform_admin)):
    """Αποθήκευση της αντιστοίχισης ειδών → MTRL (+ default fallback)."""
    mm = {k: str(v).strip() for k, v in (body.map or {}).items() if str(v or "").strip()}
    if body.default_mtrl and body.default_mtrl.strip():
        mm["default"] = body.default_mtrl.strip()
    await shared_db()["platform_settings"].update_one(
        {"_id": "softone"}, {"$set": {"mtrl_map": mm}}, upsert=True)
    return {"ok": True, "count": len(mm)}


@router.get("/comms/senders")
async def admin_comms_senders(_: PlatformContext = Depends(get_platform_admin)):
    """Φαρμακεία που ζήτησαν δικό τους όνομα αποστολέα (Sender ID) — για έγκριση (αφού δηλωθεί Apifon)."""
    from app.services import comms
    return {"items": await comms.pending_sender_requests()}


class SenderApproveIn(BaseModel):
    tenant_id: str
    channel: str = "sms"      # sms | viber
    approved: bool = True


@router.post("/comms/senders/approve")
async def admin_approve_sender(body: SenderApproveIn, _: PlatformContext = Depends(get_platform_admin)):
    """Έγκριση/απόρριψη ονόματος αποστολέα φαρμακείου. Μόνο εγκεκριμένο → χρησιμοποιείται στα SMS/Viber."""
    from app.services import comms
    return await comms.approve_tenant_sender(body.tenant_id, body.channel, body.approved)


class SenderClearIn(BaseModel):
    tenant_id: str
    channel: str = "sms"


@router.post("/comms/senders/clear")
async def admin_clear_sender(body: SenderClearIn, _: PlatformContext = Depends(get_platform_admin)):
    """Διαγραφή custom sender φαρμακείου → επαναφορά στο κεντρικό (RxVision)."""
    from app.services import comms
    return await comms.clear_tenant_sender(body.tenant_id, body.channel)


@router.get("/credit-packages")
async def admin_credit_packages(_: PlatformContext = Depends(get_platform_admin)):
    from app.services import message_wallet
    return {"items": jsonsafe(await message_wallet.packages(active_only=False))}


class CreditPackageIn(BaseModel):
    name: str | None = None
    price_cents: int | None = None
    credits_cents: int | None = None
    active: bool | None = None


@router.put("/credit-packages/{code}")
async def update_credit_package(code: str, body: CreditPackageIn,
                                _: PlatformContext = Depends(get_platform_admin)):
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    db = shared_db()
    if upd:
        upd["updated_at"] = datetime.now(tz=timezone.utc)
        await db["credit_packages"].update_one({"_id": code}, {"$set": upd}, upsert=True)  # tenant-ok: catalog
    return {"ok": True, "package": jsonsafe(await db["credit_packages"].find_one({"_id": code}))}


@router.delete("/credit-packages/{code}")
async def delete_credit_package(code: str, _: PlatformContext = Depends(get_platform_admin)):
    await shared_db()["credit_packages"].delete_one({"_id": code})  # tenant-ok: platform catalog
    return {"ok": True}


# ── AI credit packs (Phase C — overage πέρα από το included του πακέτου) ──────────────────────────
@router.get("/ai-credit-packs")
async def admin_ai_credit_packs(_: PlatformContext = Depends(get_platform_admin)):
    from app.services import ai_credits
    return {"items": jsonsafe(await ai_credits.packs(active_only=False))}


class AiCreditPackIn(BaseModel):
    name: str | None = None
    questions: int | None = None
    price_cents: int | None = None
    active: bool | None = None


@router.put("/ai-credit-packs/{code}")
async def update_ai_credit_pack(code: str, body: AiCreditPackIn,
                                _: PlatformContext = Depends(get_platform_admin)):
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    db = shared_db()
    if upd:
        upd["updated_at"] = datetime.now(tz=timezone.utc)
        await db["ai_credit_packs"].update_one({"_id": code}, {"$set": upd}, upsert=True)  # tenant-ok: catalog
    return {"ok": True, "pack": jsonsafe(await db["ai_credit_packs"].find_one({"_id": code}))}


@router.delete("/ai-credit-packs/{code}")
async def delete_ai_credit_pack(code: str, _: PlatformContext = Depends(get_platform_admin)):
    await shared_db()["ai_credit_packs"].delete_one({"_id": code})  # tenant-ok: platform catalog
    return {"ok": True}


# ── Trial leads (πρώην δοκιμαστικοί) — βάση + προσφορές + block επανα-trial ───────────────────────
@router.get("/leads")
async def admin_leads(status: str | None = None, _: PlatformContext = Depends(get_platform_admin)):
    from app.services import trial_leads
    return {"items": jsonsafe(await trial_leads.list_leads(status)),
            "counts": await trial_leads.counts(), "config": await trial_leads.config()}


class LeadPatchIn(BaseModel):
    status: str | None = None
    trial_allowed: bool | None = None   # True = ο admin επιτρέπει trial ξανά σε αυτό το ΑΦΜ
    email: str | None = None            # χειροκίνητη συμπλήρωση/διόρθωση επικοινωνίας
    phone: str | None = None
    contact_name: str | None = None


@router.patch("/leads/{lead_id}")
async def admin_lead_patch(lead_id: str, body: LeadPatchIn,
                           _: PlatformContext = Depends(get_platform_admin)):
    from app.services import trial_leads
    out: dict = {"ok": True}
    if body.status is not None:
        out["status"] = await trial_leads.set_status(lead_id, body.status)
    if body.trial_allowed is not None:
        out["trial"] = await trial_leads.set_trial_allowed(lead_id, body.trial_allowed)
    if body.email is not None or body.phone is not None or body.contact_name is not None:
        out["contact"] = await trial_leads.update_contact(
            lead_id, email=body.email, phone=body.phone, contact_name=body.contact_name)
    return out


@router.delete("/leads/{lead_id}")
async def admin_lead_delete(lead_id: str, _: PlatformContext = Depends(get_platform_admin)):
    from app.services import trial_leads
    return await trial_leads.delete_lead(lead_id)


class LeadOfferIn(BaseModel):
    subject: str | None = None
    body: str | None = None
    lead_ids: list[str] | None = None   # None → μεμονωμένο (path)· λίστα → bulk


@router.post("/leads/{lead_id}/offer")
async def admin_lead_offer(lead_id: str, body: LeadOfferIn,
                           _: PlatformContext = Depends(get_platform_admin)):
    from app.services import trial_leads
    return await trial_leads.send_offer(lead_id, body.subject, body.body)


@router.post("/leads/offer-bulk")
async def admin_leads_offer_bulk(body: LeadOfferIn, _: PlatformContext = Depends(get_platform_admin)):
    from app.services import trial_leads
    ids = body.lead_ids or [x["_id"] for x in await trial_leads.list_leads(status="lead")]
    sent = failed = 0
    for lid in ids:
        r = await trial_leads.send_offer(lid, body.subject, body.body)
        sent += 1 if r.get("ok") else 0
        failed += 0 if r.get("ok") else 1
    return {"ok": True, "sent": sent, "failed": failed}


class LeadCfgIn(BaseModel):
    purge_days: int | None = Field(None, ge=1, le=365)
    purge_enabled: bool | None = None
    offer_subject: str | None = None
    offer_body: str | None = None


@router.put("/leads-config")
async def admin_leads_config(body: LeadCfgIn, _: PlatformContext = Depends(get_platform_admin)):
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    if upd:
        upd["updated_at"] = datetime.now(tz=timezone.utc)
        await shared_db()["platform_settings"].update_one({"_id": "trial_leads"}, {"$set": upd}, upsert=True)
    from app.services import trial_leads
    return {"ok": True, "config": await trial_leads.config()}


@router.post("/trials/purge")
async def admin_trials_purge(dry_run: bool = True, _: PlatformContext = Depends(get_platform_admin)):
    """Χειροκίνητη εκτέλεση του καθαρισμού ληγμένων trials (dry_run=True → μόνο προεπισκόπηση)."""
    from app.services import billing_service
    return await billing_service.purge_expired_trials(dry_run=dry_run)


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


@router.get("/tenants/{tenant_id}/profarm-module")
async def get_profarm_module(tenant_id: str, _: PlatformContext = Depends(get_platform_admin)):
    """Κατάσταση module Profarm (ενημέρωση ειδών) για το φαρμακείο."""
    from app.repositories.supplier_settings import SupplierSettingsRepository
    return await SupplierSettingsRepository(tenant_id=tenant_id).get_profarm()


@router.post("/tenants/{tenant_id}/profarm-module")
async def set_profarm_module(tenant_id: str, enabled: bool = True,
                             _: PlatformContext = Depends(get_platform_admin)):
    """Ενεργοποίηση/απενεργοποίηση του module Profarm για συγκεκριμένο φαρμακείο (admin-only)."""
    from app.repositories.supplier_settings import SupplierSettingsRepository
    return await SupplierSettingsRepository(tenant_id=tenant_id).set_profarm_enabled(enabled)


class CopyItemsIn(BaseModel):
    source_tenant: str
    overwrite: bool = False


@router.post("/tenants/{tenant_id}/copy-items")
async def copy_items(tenant_id: str, body: CopyItemsIn,
                     _: PlatformContext = Depends(get_platform_admin)):
    """Αντιγραφή ειδών από ΑΛΛΟ φαρμακείο (source) στο {tenant_id} ως αρχικοποίηση (φωτο κοινές)."""
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    return await PharmacyCatalogRepository(tenant_id=tenant_id).copy_from(
        body.source_tenant, overwrite=body.overwrite)


@router.delete("/tenants/{tenant_id}/items")
async def delete_all_items(tenant_id: str, _: PlatformContext = Depends(get_platform_admin)):
    """Διαγραφή ΟΛΩΝ των ειδών αποθήκης του φαρμακείου (admin-only, destructive)."""
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    return await PharmacyCatalogRepository(tenant_id=tenant_id).delete_all_items()


@router.get("/tenants/{tenant_id}")
async def tenant_detail(tenant_id: str, _: PlatformContext = Depends(get_platform_admin)):
    """Καρτέλα πελάτη: tenant + subscription + χρήστες + πρόσφατα sync jobs."""
    from app.services import billing_service
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
                   "company": t.get("company"), "billing_profile": t.get("billing_profile"),
                   "store": t.get("store"),
                   "demo": bool(t.get("demo"))},
        "modules": resolve_modules(set(sub.get("modules_included", [])), t.get("modules") or {}),
        "subscription": {
            "plan": sub.get("plan"), "plan_name": sub.get("plan_name"),
            "status": sub.get("status"),
            # ΜΙΑ συνεκτική κατάσταση πελάτη (ενεργός/ληγμένος) από τη συνδρομή — πηγή αλήθειας για το badge
            "effective_status": billing_service.effective_status(sub),
            "product_code": sub.get("product_code"),
            "features": sub.get("features", {}), "limits": sub.get("limits", {}),
            "billing_cycle": sub.get("billing_cycle"), "seats": sub.get("seats"),
            "mrr": 0 if sub.get("complimentary") else (sub.get("price_per_pharmacy") or 0) * pharmacies,
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
    # στοιχεία εταιρείας + επικοινωνία → mirror σε company.* ΚΑΙ billing_profile.* (single source of truth)
    for src, dst in (("company_name", "name"), ("company_doy", "doy"), ("company_address", "address"),
                     ("company_city", "city"), ("company_postal_code", "postal_code")):
        if src in patch:
            v = patch.pop(src)
            patch[f"company.{dst}"] = v
            patch[f"billing_profile.{dst}"] = v
    if "contact_email" in patch:            # top-level (κάρτα) + billing_email (το SoftOne στέλνει εκεί)
        v = patch["contact_email"]
        patch["company.email"] = v
        patch["billing_profile.email"] = v
        patch["billing_profile.billing_email"] = v
    if "contact_phone" in patch:
        v = patch["contact_phone"]
        patch["company.phone"] = v
        patch["billing_profile.phone"] = v
    afm = (patch.pop("afm", None) or "").strip()
    if afm:      # ΑΦΜ → billing_profile.afm + auto-enrich (επωνυμία/ΔΟΥ/διεύθυνση) από ΑΑΔΕ
        patch["billing_profile.afm"] = afm
        patch["company.afm"] = afm       # συνέπεια με τα views που διαβάζουν company.afm
        from app.services.aade_service import lookup as aade_lookup
        info = await aade_lookup(afm)
        if info.get("ok"):
            for src, dst in (("name", "name"), ("doy", "doy"), ("address", "address"),
                             ("city", "city"), ("postal_code", "postal_code")):
                if info.get(src):     # setdefault: δεν κλωτσάει ό,τι έδωσε ρητά ο admin παραπάνω
                    patch.setdefault(f"billing_profile.{dst}", info[src])
                    patch.setdefault(f"company.{dst}", info[src])
    if not patch:
        return {"id": tenant_id, "updated": False}
    if "retention_months" in patch:      # ασφαλή όρια (36–120)
        from app.services.data_retention import clamp_months
        patch["retention_months"] = clamp_months(patch["retention_months"])
    patch["updated_at"] = datetime.now(tz=timezone.utc)
    res = await db["tenants"].update_one({"_id": tenant_id}, {"$set": patch})
    if not res.matched_count:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    if "retention_months" in patch:   # κλιμακωτή επιβάρυνση διατήρησης → recurring
        from app.services import addon_service
        await addon_service._recompute_total(tenant_id)
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
    # ΒΑΣΗ 1 δωρεάν χρήστης· default 1 (όχι το max του πλάνου)· cap στο max του πλάνου («έως N»)
    seats = min(int(pkg.get("seats", 1) or 1), max(1, int(body.seats or 1)))
    upd = {
        "plan": body.package_code, "plan_name": pkg.get("name"),
        "modules_included": pkg.get("modules", []),
        "billing_cycle": cycle, "price_per_pharmacy": price, "seats": seats,
        "sla": pkg.get("sla") or sub.get("sla"),
        "available_addons": pkg.get("available_addons"),
        "updated_at": datetime.now(tz=timezone.utc),
    }
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": upd}, upsert=True)
    # Adapt the per-tenant capabilities to the package: clear leftover overrides so the tenant matches
    # the package EXACTLY — but keep entitlement for any à-la-carte add-ons it has actually purchased.
    keep = {a: "enabled" for a in (sub.get("addons") or [])}
    await db["tenants"].update_one({"_id": tenant_id},
                                   {"$set": {"modules": keep, "updated_at": datetime.now(tz=timezone.utc)}})
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
    """ΟΡΙΣΤΙΚΗ διαγραφή πελάτη + όλων των δεδομένων του (admin-initiated). Αρχειοθετεί πρώτα το ΑΦΜ
    στη βάση leads (ώστε να μη χαθεί & να μπλοκάρει επανα-trial)."""
    db = shared_db()
    if not await db["tenants"].find_one({"_id": tenant_id}):
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    from app.services import billing_service, trial_leads
    await trial_leads.archive_from_tenant(tenant_id, db=db, reason="admin_deleted")
    removed = await billing_service.delete_tenant_fully(tenant_id)
    return {"id": tenant_id, "deleted": True, "removed": removed}


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
        m = 0 if s.get("complimentary") else (s.get("price_per_pharmacy") or 0) * pharmacies
        billed = st in ("active", "past_due") and not s.get("complimentary")
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
        "comments": inv.get("comments", ""),
        "net_amount": inv.get("net_amount", 0), "vat_rate": inv.get("vat_rate", 0),
        "vat_amount": inv.get("vat_amount", 0), "total": inv.get("total", 0),
        "aade_status": inv.get("aade_status", "not_transmitted"),
        "aade_mark": inv.get("aade_mark"), "aade_transmitted_at": inv.get("aade_transmitted_at"),
        # myDATA/e-invoicing απόδειξη μετά τον μετασχηματισμό (s1ecos): υπογραφή, QR URL, τελικός αριθμός.
        "aade_sign": inv.get("aade_sign"), "aade_qr": inv.get("aade_qr"),
        "mydata_uid": inv.get("mydata_uid"), "transformed": bool(inv.get("transformed")),
        "transformed_number": inv.get("transformed_number"), "transformed_findoc": inv.get("transformed_findoc"),
        # Κατάσταση πληρωμής: paid = υπάρχει επιτυχής χρέωση (transaction)· settled = χειροκίνητος
        # χαρακτηρισμός «εξοφλημένο»· αλλιώς unpaid.
        "payment_status": ("paid" if (inv.get("payment") or {}).get("transaction_id")
                           else ("settled" if inv.get("settled") else "unpaid")),
        "payment_method": (inv.get("payment") or {}).get("method"),
        "payment_provider": (inv.get("payment") or {}).get("provider"),
        "settled_at": inv.get("settled_at"),
        "created_at": inv.get("created_at"),
        # Φάση 3 — αυτόματο κύκλωμα
        "auto": bool(inv.get("auto")), "kind": inv.get("kind"),
        "status": inv.get("status"), "blocked_reason": inv.get("blocked_reason"),
        "softone_findoc": inv.get("softone_findoc"), "mydata_aa": inv.get("mydata_aa"),
        "attempts": inv.get("attempts", 0), "last_error": inv.get("last_error"),
        "customer_afm": (inv.get("customer") or {}).get("afm"),
        "customer": inv.get("customer") or None,
        "lines": inv.get("lines") or None, "mtrl": inv.get("mtrl"),
        "subtotal_net": inv.get("subtotal_net"), "discount": inv.get("discount") or None,
    }


def _aade_locked(inv: dict) -> bool:
    # Κλείδωμα ΜΟΝΟ όταν υπάρχει πραγματικό ΑΑΔΕ MARK (οριστικό στο myDATA). Όσο το MARK είναι κενό —
    # ακόμη κι αν έχει περάσει προσωρινό doc στο SoftOne (findoc χωρίς MARK)— επιτρέπονται
    # διόρθωση / διαγραφή / επαναποστολή.
    return bool(inv.get("aade_mark"))


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
    tenant = await db["tenants"].find_one({"_id": body.tenant_id})
    if not tenant:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "tenant_not_found")
    last = await db["invoices"].find_one({"series": body.series}, sort=[("number", -1)])
    number = (last.get("number", 0) if last else 0) + 1
    now = datetime.now(tz=timezone.utc)
    # Πολυγραμμικό: αν δοθούν γραμμές, τα σύνολα προκύπτουν από αυτές (με εκπτώσεις)· αλλιώς legacy.
    disc = None
    if body.lines:
        c = _compute_invoice([ln.model_dump() for ln in body.lines], body.discount_kind, body.discount_value)
        lines, net, vat, total = c["lines"], c["net_amount"], c["vat_amount"], c["total"]
        subtotal_net, disc = c["subtotal_net"], c["discount"]
        vat_rate = body.lines[0].vat_rate if len({ln.vat_rate for ln in body.lines}) == 1 else 0.0
        description = body.description or (lines[0]["description"] if lines else "")
    else:
        lines = subtotal_net = None
        net, vat_rate = body.net_amount, body.vat_rate
        vat, total = _invoice_totals(net, vat_rate)
        description = body.description
    # Snapshot στοιχείων πελάτη (λήπτη) — ώστε η διαβίβαση SoftOne να έχει ΑΦΜ/επωνυμία.
    from app.services.invoice_service import _customer_from_tenant
    customer = _customer_from_tenant(tenant)
    blocked = None if customer.get("afm") else "missing_afm"
    doc = {"tenant_id": body.tenant_id, "tenant_name": tenant.get("name"),
           "doc_type": body.doc_type, "series": body.series,
           "number": number, "issue_date": body.issue_date or now.date().isoformat(),
           "description": description, "comments": body.comments or "", "net_amount": net,
           "vat_rate": vat_rate, "vat_amount": vat, "total": total,
           "lines": lines, "subtotal_net": subtotal_net, "discount": disc, "customer": customer,
           "status": "blocked" if blocked else "pending", "blocked_reason": blocked,
           "attempts": 0, "last_error": None, "next_attempt_at": now,
           "aade_status": "not_transmitted", "aade_mark": None, "aade_transmitted_at": None,
           "softone_findoc": None, "mydata_uid": None, "mydata_aa": None,
           "created_at": now, "updated_at": now}
    res = await db["invoices"].insert_one(doc)
    doc["_id"] = res.inserted_id
    # Άμεση διαβίβαση στο SoftOne (αν είναι ρυθμισμένο & έχει ανέβει η JS)· αλλιώς μένει pending
    # για το batch (κάθε 5') ή το κουμπί «Αποστολή SoftOne».
    if not blocked:
        try:
            from app.services import softone_service
            scfg = await softone_service.platform_config()
            if softone_service.is_configured(scfg) and (scfg.get("js_endpoint") or "").strip():
                from app.workers.billing import transmit_invoice
                transmit_invoice.delay(str(doc["_id"]))
        except Exception:   # noqa: BLE001 — best-effort· η δημιουργία δεν σπάει
            pass
    return jsonsafe(_invoice_public(doc, tenant.get("name")))


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
    if body.lines is not None:      # πολυγραμμικό: ξαναϋπολογισμός γραμμών, εκπτώσεων & συνόλων
        hk = body.discount_kind if body.discount_kind is not None else (inv.get("discount") or {}).get("kind", "pct")
        hv = body.discount_value if body.discount_value is not None else (inv.get("discount") or {}).get("value", 0.0)
        c = _compute_invoice([ln.model_dump() for ln in body.lines], hk, hv)
        rate = body.lines[0].vat_rate if body.lines and len({ln.vat_rate for ln in body.lines}) == 1 else 0.0
        patch.update({"lines": c["lines"], "subtotal_net": c["subtotal_net"], "discount": c["discount"],
                      "net_amount": c["net_amount"], "vat_amount": c["vat_amount"], "total": c["total"], "vat_rate": rate})
        patch.pop("discount_kind", None); patch.pop("discount_value", None)
    elif "net_amount" in patch or "vat_rate" in patch:
        net = patch.get("net_amount", inv.get("net_amount", 0))
        rate = patch.get("vat_rate", inv.get("vat_rate", 0))
        patch["vat_amount"], patch["total"] = _invoice_totals(net, rate)
    if patch:
        now = datetime.now(tz=timezone.utc)
        # Η διόρθωση ακυρώνει την προηγούμενη (προσωρινή, ΧΩΡΙΣ MARK) διαβίβαση SoftOne → το παραστατικό
        # ξαναγίνεται «εκκρεμές» ώστε να επανεκδοθεί καθαρά (νέο SoftOne doc) στην επόμενη αποστολή.
        if inv.get("softone_findoc") or inv.get("aade_status") == "transmitted":
            patch.update({"softone_findoc": None, "aade_status": "not_transmitted",
                          "aade_transmitted_at": None, "mydata_uid": None, "mydata_aa": None,
                          "status": "blocked" if inv.get("status") == "blocked" else "pending",
                          "attempts": 0, "last_error": None, "next_attempt_at": now})
        patch["updated_at"] = now
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
    """Πραγματική έκδοση/διαβίβαση μέσω SoftOne → myDATA. Μετά το κλείδωμα: όχι edit/delete."""
    from app.services import invoice_service
    inv = await shared_db()["invoices"].find_one({"_id": _oid(invoice_id)})
    if not inv:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    if _aade_locked(inv):
        return {"id": invoice_id, "aade_status": "transmitted", "aade_mark": inv.get("aade_mark"),
                "softone_findoc": inv.get("softone_findoc")}
    r = await invoice_service.issue_invoice_by_id(inv["_id"])
    if not r.get("ok"):
        raise HTTPException(http_status.HTTP_502_BAD_GATEWAY,
                            {"error": r.get("error") or "softone_failed"})
    return {"id": invoice_id, "aade_status": "transmitted", "aade_mark": r.get("aade_mark"),
            "softone_findoc": r.get("softone_findoc")}


class SettleIn(BaseModel):
    settled: bool = True


@router.post("/invoices/{invoice_id}/settle")
async def settle_invoice(invoice_id: str, body: SettleIn,
                         _: PlatformContext = Depends(get_platform_admin)):
    """Χειροκίνητος χαρακτηρισμός παραστατικού ως «εξοφλημένο» (ή αναίρεση). Για παραστατικά χωρίς
    αυτόματη πληρωμή (π.χ. τραπεζική κατάθεση). Τα auto (με transaction) είναι ήδη «Πληρωμένα»."""
    db = shared_db()
    inv = await db["invoices"].find_one({"_id": _oid(invoice_id)})
    if not inv:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "not_found")
    now = datetime.now(tz=timezone.utc)
    await db["invoices"].update_one({"_id": inv["_id"]}, {"$set": {
        "settled": bool(body.settled), "settled_at": now if body.settled else None, "updated_at": now}})
    return {"id": invoice_id, "settled": bool(body.settled)}


# ── εκκρεμείς εγγραφές (πλήρωσαν αλλά δεν ολοκλήρωσαν) ──────────
@router.get("/pending-registrations")
async def pending_registrations(_: PlatformContext = Depends(get_platform_admin)):
    """Δίχτυ ασφαλείας: εγγραφές που πλήρωσαν αλλά δεν όρισαν κωδικό (ή εκκρεμεί πληρωμή)."""
    from app.services.onboarding_service import OnboardingService
    rows = await OnboardingService().list_incomplete()
    items = [{"id": r["_id"], "pharmacy_name": r.get("pharmacy_name"), "owner_email": r.get("owner_email"),
              "owner_name": r.get("owner_name"), "status": r.get("status"),
              "amount_cents": r.get("amount_cents", 0), "package_code": r.get("package_code"),
              "payment_method": r.get("payment_method"), "created_at": r.get("created_at"),
              "paid_at": r.get("paid_at"), "afm": (r.get("company") or {}).get("afm")} for r in rows]
    return {"items": jsonsafe(items)}


@router.post("/pending-registrations/{pending_id}/resend")
async def resend_pending_completion(pending_id: str, _: PlatformContext = Depends(get_platform_admin)):
    """Ξαναστέλνει το link ολοκλήρωσης σε PAID εκκρεμή εγγραφή."""
    from app.services.onboarding_service import OnboardingService
    ok = await OnboardingService().resend_completion(pending_id)
    if not ok:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST, detail={"error": "not_resendable"})
    return {"ok": True}


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
    # Vault health + ingestion freshness — αναδεικνύει τη ΣΙΩΠΗΛΗ αποτυχία (ληγμένο token → syncs
    # «success» με 0 εγγραφές· incident 2026-07-08). Χωρίς αυτό, η σελίδα δείχνει 99% uptime ενώ
    # στην πραγματικότητα δεν έρχονται δεδομένα.
    from app.services.vault_service import vault
    vault_ok = vault.healthy()
    newest_data = max((j["started_at"] for j in jobs
                       if (j.get("stats") or {}).get("fetched", 0) > 0 and j.get("started_at")),
                      default=None)
    stale_h = round((now - newest_data).total_seconds() / 3600, 1) if newest_data else None
    alert = (not vault_ok) or (stale_h is not None and stale_h > 6) or (newest_data is None)
    # ── GDPR: cross-tenant διαρροές — αυτόματες μεταφορές (30ημ) + τυχόν ΕΚΚΡΕΜΕΙΣ (από τη σάρωση) ──
    xt_transfers = []
    async for a in db["ingestion_alerts"].find(
            {"kind": "cross_tenant_transferred", "at": {"$gte": since}}).sort("at", -1).limit(50):
        xt_transfers.append({"external_id": a.get("external_id"),
                             "from": names.get(a.get("from_tenant"), a.get("from_tenant")),
                             "to": names.get(a.get("to_tenant"), a.get("to_tenant")),
                             "patient_removed": bool(a.get("patient_removed")), "at": a.get("at")})
    xt_count = await db["ingestion_alerts"].count_documents(
        {"kind": "cross_tenant_transferred", "at": {"$gte": since}})
    pending_leaks = 0
    last_scan = None
    async for sc in db["ingestion_alerts"].find({"kind": "cross_tenant_leak_scan"}):
        pending_leaks += int(sc.get("leaks") or 0)
        u = sc.get("updated_at")
        if u and (last_scan is None or u > last_scan):
            last_scan = u
    return {
        "summary": {"syncs_30d": runs, "failed_30d": failed, "active_tenants": active,
                    "success_rate": round((runs - failed) / runs * 100, 2) if runs else 100.0},
        "services": jsonsafe(services), "recent_failures": jsonsafe(recent),
        "vault": {"healthy": vault_ok},
        "ingest": {"last_data_at": jsonsafe(newest_data), "stale_hours": stale_h},
        "alert": alert,
        "cross_tenant": {"transfers_30d": xt_count, "recent_transfers": jsonsafe(xt_transfers),
                         "pending_leaks": pending_leaks, "last_scan_at": jsonsafe(last_scan)},
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


# ── portal mode (GLOBAL) — δίκτυο (όλα τα φαρμακεία) vs μεμονωμένο (μόνο το φαρμακείο εγγραφής) ──
class PortalModeIn(BaseModel):
    mode: Literal["network", "single"]


@router.get("/portal-mode")
async def get_portal_mode(_: PlatformContext = Depends(get_platform_admin)):
    doc = await shared_db()["platform_settings"].find_one({"_id": "portal"})
    m = (doc or {}).get("mode", "network")
    return {"mode": m if m in ("network", "single") else "network"}


@router.put("/portal-mode")
async def set_portal_mode(body: PortalModeIn, _: PlatformContext = Depends(get_platform_admin)):
    await shared_db()["platform_settings"].update_one(
        {"_id": "portal"},
        {"$set": {"mode": body.mode, "updated_at": datetime.now(tz=timezone.utc)}}, upsert=True)
    return {"mode": body.mode}


# ── Διατήρηση δεδομένων (rolling window ανά φαρμακείο) ──────────────────────────────
@router.get("/data-retention")
async def data_retention_preview(_: PlatformContext = Depends(get_platform_admin)):
    """Προεπισκόπηση: τι ΘΑ διαγραφόταν τώρα (ανά φαρμακείο) + εκτίμηση χώρου/φαρμακείο. Καμία διαγραφή."""
    from app.services.data_retention import (
        purge_old, storage_by_tenant, tenant_retention_months, retention_surcharge_monthly,
        retention_price_per_year, DEFAULT_RETENTION_MONTHS, MAX_RETENTION_MONTHS)
    db = shared_db()
    res = await purge_old(dry_run=True)
    storage = await storage_by_tenant(db)
    price = await retention_price_per_year(db)
    for s in storage:
        s["retention_months"] = await tenant_retention_months(db, s["tenant_id"])
        s["surcharge_cents"] = await retention_surcharge_monthly(db, s["tenant_id"])
    return {**res, "storage": storage, "price_per_year_cents": price,
            "default_months": DEFAULT_RETENTION_MONTHS, "max_months": MAX_RETENTION_MONTHS}


class RetentionPriceIn(BaseModel):
    price_per_year_cents: int = Field(..., ge=0, le=100000)


@router.put("/data-retention/pricing")
async def set_retention_pricing(body: RetentionPriceIn, _: PlatformContext = Depends(get_platform_admin)):
    """Μηνιαία τιμή ανά ΕΠΙΠΛΕΟΝ έτος retention (πάνω από 36μ). Ξαναϋπολογίζει όλες τις συνδρομές."""
    db = shared_db()
    await db["platform_settings"].update_one(
        {"_id": "retention"}, {"$set": {"price_per_year_cents": body.price_per_year_cents,
                                        "updated_at": datetime.now(tz=timezone.utc)}}, upsert=True)
    # όσα φαρμακεία έχουν >36μ → ενημέρωσε τη χρέωσή τους με τη νέα τιμή
    from app.services import addon_service
    async for t in db["tenants"].find({"retention_months": {"$gt": 36}}, {"_id": 1}):
        await addon_service._recompute_total(t["_id"])
    return {"ok": True, "price_per_year_cents": body.price_per_year_cents}


class AreaOverrideIn(BaseModel):
    raw_or_key: str
    canonical: str


@router.get("/area-aliases")
async def area_aliases(q: str | None = None, _: PlatformContext = Depends(get_platform_admin)):
    """Χάρτης κανονικοποίησης περιοχών (raw key → canonical δήμος) — επισκόπηση & χειροκίνητη διόρθωση."""
    from app.repositories.base import jsonsafe
    db = shared_db()
    query: dict = {}
    if q:
        import re as _re
        rx = _re.escape(q.strip())
        query = {"$or": [{"_id": {"$regex": rx, "$options": "i"}},
                         {"canonical": {"$regex": rx, "$options": "i"}}]}
    rows = [jsonsafe(d) async for d in db["area_aliases"].find(query).sort("_id", 1).limit(1000)]
    return {"items": rows, "total": await db["area_aliases"].count_documents(query)}


@router.post("/area-aliases/override")
async def area_alias_override(body: AreaOverrideIn, _: PlatformContext = Depends(get_platform_admin)):
    """Χειροκίνητη υπερίσχυση αντιστοίχισης περιοχής (κλειδώνεται· το AI δεν την ξαναγγίζει)."""
    from app.services import area_canonical
    return await area_canonical.set_override(body.raw_or_key, body.canonical)


@router.get("/ai-limits")
async def ai_limits(_: PlatformContext = Depends(get_platform_admin)):
    """Όρια AI ΣΤΗ ΓΛΩΣΣΑ ΤΩΝ ΠΑΚΕΤΩΝ: ανά φαρμακείο → πακέτο, δικαιούμενα (included/period) & κατανάλωση
    τρέχουσας περιόδου. Το επιπλέον αγοράζεται ως AI credits (Phase C) — καμία μπλοκ-επιβάρυνση."""
    from app.services import ai_quota, ai_cost, billing_service
    db = shared_db()
    rows = []
    async for t in db["tenants"].find({}, {"_id": 1, "name": 1}):
        tid = t["_id"]
        st = await ai_quota.status_for(db, tid)
        bd = await ai_quota.usage_breakdown_today(db, tid)
        sub = await db["subscriptions"].find_one({"tenant_id": tid}, {"plan": 1, "plan_name": 1})
        rows.append({
            "tenant_id": str(tid), "name": t.get("name"),
            "plan": (sub or {}).get("plan"), "plan_name": (sub or {}).get("plan_name"),
            "included": st["included"], "period": st["period"],
            "used": st["used"], "remaining": st["remaining"], "credits": st.get("credits", 0),
            "ai_used_today": bd["total"],
            "ai_used_ai": bd["ai"],        # πραγματικές AI κλήσεις (μόνο για εμάς)
            "ai_used_local": bd["local"],  # σερβιρίστηκαν από την τοπική βάση (μόνο για εμάς)
            "card_on_file": await billing_service.card_on_file(tid),
        })
    rows.sort(key=lambda r: (-(r["used"] or 0), (r["name"] or "").lower()))
    return {"tenants": rows, "default": await ai_quota.base_daily_free(db),
            "cost": await ai_cost.pricing_suggestion(db)}


class AiPriceIn(BaseModel):
    base_daily_free: int | None = Field(None, ge=0, le=20000)         # καθολικό fallback (πακέτα χωρίς included)
    margin_pct: int | None = Field(None, ge=0, le=1000)               # cost-plus περιθώριο (τιμολόγηση credits)
    models: dict[str, dict[str, int]] | None = None                   # per-model τιμές (cents/1M tokens)


@router.put("/ai-pricing")
async def set_ai_pricing(body: AiPriceIn, _: PlatformContext = Depends(get_platform_admin)):
    """Ρυθμίζει: (α) καθολικό δωρεάν fallback (platform_settings.ai_quota.base_daily_free)· (β) cost-plus
    περιθώριο + τιμές μοντέλων (platform_settings.ai_pricing). Το AI ΔΕΝ επιβαρύνει τη συνδρομή."""
    db = shared_db()
    now = datetime.now(tz=timezone.utc)
    if body.base_daily_free is not None:
        await db["platform_settings"].update_one(
            {"_id": "ai_quota"}, {"$set": {"base_daily_free": body.base_daily_free, "updated_at": now}}, upsert=True)
    pricing_upd: dict = {}
    if body.margin_pct is not None:
        pricing_upd["margin_pct"] = body.margin_pct
    if body.models is not None:
        pricing_upd["models"] = {m: {k: max(0, int(v)) for k, v in p.items() if k in ("in", "out", "cin")}
                                 for m, p in body.models.items()}
    if pricing_upd:
        await db["platform_settings"].update_one(
            {"_id": "ai_pricing"}, {"$set": {**pricing_upd, "updated_at": now}}, upsert=True)
    return {"ok": True}


@router.post("/data-retention/purge")
async def data_retention_purge(_: PlatformContext = Depends(get_platform_admin)):
    """Χειροκίνητη ΟΡΙΣΤΙΚΗ διαγραφή δεδομένων εκτός παραθύρου (ανά φαρμακείο). Μη αναστρέψιμο."""
    from app.services.data_retention import purge_old
    return await purge_old()


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
    from app.services.platform_secrets import encrypt_fields
    await db["platform_settings"].update_one(
        {"_id": "idika"}, {"$set": encrypt_fields("idika", doc)}, upsert=True)
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


# ── Προμήθειες συναλλαγής e-shop ─────────────────────────────────────────────
class EshopFeeCfgIn(BaseModel):
    enabled: bool | None = None
    default_cents: int | None = None
    min_order_cents: int | None = None
    cap_pct: int | None = None
    min_charge_cents: int | None = None
    charge_weekday: int | None = None


class EshopFeeTenantIn(BaseModel):
    fee_cents: int | None = None   # <0 ⇒ καθαρισμός override (χρήση default)
    exempt: bool | None = None


@router.get("/eshop-fees/config")
async def eshop_fees_config(_: PlatformContext = Depends(get_platform_admin)):
    from app.services import eshop_fees
    return await eshop_fees.get_config()


@router.put("/eshop-fees/config")
async def eshop_fees_set_config(body: EshopFeeCfgIn, _: PlatformContext = Depends(get_platform_admin)):
    from app.services import eshop_fees
    return await eshop_fees.set_config(body.model_dump(exclude_none=True))


@router.get("/eshop-fees/overview")
async def eshop_fees_overview(_: PlatformContext = Depends(get_platform_admin)):
    from app.services import eshop_fees
    return {"items": await eshop_fees.admin_overview()}


@router.put("/eshop-fees/tenant/{tenant_id}")
async def eshop_fees_set_tenant(tenant_id: str, body: EshopFeeTenantIn,
                                _: PlatformContext = Depends(get_platform_admin)):
    from app.services import eshop_fees
    await eshop_fees.set_tenant(tenant_id, fee_cents=body.fee_cents, exempt=body.exempt)
    return {"ok": True}


@router.post("/eshop-fees/tenant/{tenant_id}/charge")
async def eshop_fees_charge_now(tenant_id: str, _: PlatformContext = Depends(get_platform_admin)):
    from app.services import eshop_fees
    return await eshop_fees.charge_tenant(tenant_id, force=True)






@router.get("/sync-health")
async def sync_health(_: PlatformContext = Depends(get_platform_admin)):
    """Latest ingestion sync per (tenant, source) + Vault health + silent-failure detection.

    Silent failure (incident 2026-07-08): ληγμένο Vault token → syncs «success» με 0 εγγραφές.
    Εδώ το αναδεικνύουμε: Vault status + last_fetched + πότε ήρθαν τελευταία δεδομένα ανά tenant."""
    from app.services.vault_service import vault
    db = shared_db()
    now = datetime.now(tz=timezone.utc)
    names = {t["_id"]: t.get("name", t["_id"]) async for t in db["tenants"].find({})}
    pipeline = [
        {"$sort": {"started_at": -1}},
        {"$group": {
            "_id": {"tenant": "$tenant_id", "source": "$source"},
            "last_run": {"$first": "$started_at"},
            "status": {"$first": "$status"},
            "last_fetched": {"$first": {"$ifNull": ["$stats.fetched", 0]}},
            "last_inserted": {"$first": {"$ifNull": ["$stats.inserted", 0]}},
            # πιο πρόσφατο job που ΕΦΕΡΕ δεδομένα (fetched>0)
            "last_data_at": {"$max": {"$cond": [{"$gt": [{"$ifNull": ["$stats.fetched", 0]}, 0]},
                                                "$started_at", None]}},
            "errors": {"$sum": {"$cond": [{"$eq": ["$status", "failed"]}, 1, 0]}},
        }},
        {"$sort": {"last_run": -1}},
    ]
    items = []
    newest_data = None
    async for row in db["sync_jobs"].aggregate(pipeline):
        key = row["_id"]
        lda = row.get("last_data_at")
        if lda and (newest_data is None or lda > newest_data):
            newest_data = lda
        data_age_h = round((now - lda).total_seconds() / 3600, 1) if lda else None
        # «σιωπηλή αποτυχία»: πετυχαίνει αλλά δεν φέρνει δεδομένα εδώ και >6h
        silent = bool(row.get("status") == "success" and (data_age_h is None or data_age_h > 6))
        items.append({
            "id": f'{key["tenant"]}:{key["source"]}',
            "tenant": names.get(key["tenant"], key["tenant"]),
            "source": key["source"],
            "last_run": row["last_run"],
            "status": row["status"],
            "last_fetched": row.get("last_fetched", 0),
            "last_inserted": row.get("last_inserted", 0),
            "last_data_at": lda,
            "data_age_hours": data_age_h,
            "silent_failure": silent,
            "errors": row["errors"],
        })
    vault_ok = vault.healthy()
    overall_stale_h = round((now - newest_data).total_seconds() / 3600, 1) if newest_data else None
    return jsonsafe({
        "items": items,
        "vault": {"healthy": vault_ok},
        "ingest": {"last_data_at": newest_data, "stale_hours": overall_stale_h},
        # κόκκινος συναγερμός στο adminpanel αν το Vault έπεσε ή δεν ήρθαν δεδομένα εδώ και >6h
        "alert": (not vault_ok) or (overall_stale_h is not None and overall_stale_h > 6) or (newest_data is None),
        "checked_at": now,
    })


@router.get("/sessions")
async def list_sessions(_: PlatformContext = Depends(get_platform_admin)):
    """Ποιοι είναι ΣΥΝΔΕΔΕΜΕΝΟΙ τώρα: session ανά συσκευή με username, IP, tenant, τελευταία δραστηριότητα."""
    db = shared_db()
    names = {t["_id"]: t.get("name", t["_id"]) async for t in db["tenants"].find({}, {"name": 1})}
    items = []
    async for s in db["user_sessions"].find({}).sort("last_active_at", -1).limit(500):
        u = None
        try:
            u = await db["users"].find_one({"_id": _oid(s.get("user_id"))}, {"email": 1, "full_name": 1})
        except Exception:  # noqa: BLE001
            u = None
        items.append({
            "sid": s["_id"],
            "tenant": names.get(s.get("tenant_id"), s.get("tenant_id")),
            "tenant_id": s.get("tenant_id"),
            "username": (u or {}).get("email") or s.get("user_id"),
            "full_name": (u or {}).get("full_name"),
            "ip": s.get("ip") or "—",
            "ua": s.get("ua") or "",
            "impersonation": bool(s.get("impersonation")),
            "last_active_at": s.get("last_active_at"),
            "created_at": s.get("created_at"),
        })
    return {"items": jsonsafe(items)}


@router.post("/sessions/{sid}/revoke")
async def revoke_session(sid: str, _: PlatformContext = Depends(get_platform_admin)):
    """Force-logout ΜΙΑΣ session: μπλοκάρει άμεσα το access token (Redis flag) + κόβει το refresh
    (bump refresh_token_version) → η συσκευή αποσυνδέεται και δεν ξανασυνδέεται με το παλιό token."""
    from app.services import session_service as sessions
    db = shared_db()
    s = await db["user_sessions"].find_one({"_id": sid})
    if not s:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "session_not_found")
    await sessions.mark_revoked(sid)                     # Redis flag (άμεσο) + delete session doc
    try:                                                  # και ανάκληση refresh token της συσκευής
        await db["users"].update_one({"_id": _oid(s.get("user_id"))},
                                     {"$inc": {"refresh_token_version": 1}})
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "sid": sid}


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


# ── Amount audit vs ΗΔΥΚΑ printout (ground-truth reconciliation) ───────────────────────────────
class AmountAuditRunIn(BaseModel):
    tenant_id: str | None = None          # None → όλα τα ενεργά GR tenants
    batches: int = Field(1, ge=1, le=20)  # πόσες παρτίδες να πυροδοτηθούν ανά tenant


@router.get("/amount-audit/status")
async def amount_audit_status(_: PlatformContext = Depends(get_platform_admin)):
    """Ανά tenant: εκτελέσεις ΗΔΥΚΑ, πόσες ελέγχθηκαν vs το έντυπο, πόσες απομένουν, πόσες διορθώθηκαν."""
    db = shared_db()
    names = {str(t["_id"]): (t.get("company", {}).get("name") or t.get("name") or str(t["_id"]))
             async for t in db["tenants"].find({}, {"company.name": 1, "name": 1})}
    out: list[dict] = []
    async for row in db["prescription_executions"].aggregate([
        {"$match": {"source": "HDIKA"}},
        {"$group": {"_id": "$tenant_id",
                    "total": {"$sum": 1},
                    "audited": {"$sum": {"$cond": [{"$ifNull": ["$amount_audited_at", False]}, 1, 0]}}}},
    ]):
        tid = row["_id"]
        corrected = await db["amount_audit_log"].count_documents({"tenant_id": tid})
        out.append({"tenant_id": tid, "name": names.get(tid, tid),
                    "total": row["total"], "audited": row["audited"],
                    "remaining": row["total"] - row["audited"], "corrected": corrected})
    out.sort(key=lambda r: r["remaining"], reverse=True)
    return {"tenants": out, "total_corrected": sum(r["corrected"] for r in out)}


@router.get("/amount-audit/log")
async def amount_audit_log(tenant_id: str | None = None, limit: int = 100,
                           _: PlatformContext = Depends(get_platform_admin)):
    """Οι πιο πρόσφατες διορθώσεις (old→new ποσά) — για διαφάνεια/έλεγχο."""
    db = shared_db()
    q = {"tenant_id": tenant_id} if tenant_id else {}
    rows = [jsonsafe(r) async for r in db["amount_audit_log"].find(q).sort("ts", -1).limit(min(limit, 500))]
    return {"log": rows}


@router.post("/amount-audit/run")
async def amount_audit_run(body: AmountAuditRunIn, _: PlatformContext = Depends(get_platform_admin)):
    """Πυροδοτεί το audit ποσών (backfill queue). Χωρίς tenant_id → όλα τα ενεργά GR tenants."""
    from app.core.config import settings as _s
    from app.workers.ingestion import amount_audit_task
    db = shared_db()
    if body.tenant_id:
        tids = [body.tenant_id]
    else:
        tids = [str(t["_id"]) async for t in db["tenants"].find(
            {"country": "GR", "status": {"$in": ["active", "trial"]},
             "credentials_ref.hdika": {"$ne": None},
             "ingestion_config.hdika.sync_enabled": {"$ne": False}}, {"_id": 1})]
    for tid in tids:
        for _b in range(body.batches):
            amount_audit_task.apply_async(args=[tid, _s.AMOUNT_AUDIT_BATCH], queue="backfill")
    return {"ok": True, "tenants": len(tids), "batches_each": body.batches}


# ── Δίκτυο φαρμακείων: σε ποια φαρμακεία μπορεί να συνδεθεί ΕΝΑΣ χρήστης ────────────────────
# Π.χ. ιδιοκτήτης 5 φαρμακείων (ίδιο ή διαφορετικό ΑΦΜ) → ένα login, επιλογέας πάνω-πάνω.
# ΑΣΦΑΛΕΙΑ: γράφεται ΜΟΝΟ από εδώ (πλατφόρμα). Αν το άλλαζε ο διαχειριστής του φαρμακείου,
# θα έδινε στον εαυτό του πρόσβαση σε ξένο φαρμακείο.
@router.get("/network/users")
async def network_users(q: str = "", owners_only: bool = True,
                        _: PlatformContext = Depends(get_platform_admin)):
    """owners_only (default): μόνο χρήστες με ρόλο ιδιοκτήτη — η πρόσβαση σε πολλά φαρμακεία
    αφορά ιδιοκτήτες. Ένας υπάλληλος του Α δεν πρέπει να «βρεθεί» εύκολα με πρόσβαση στο Β."""
    db = shared_db()
    query: dict = {"status": "active"}
    if q.strip():
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        query["$or"] = [{"email": rx}, {"full_name": rx}]
    tmap = {t["_id"]: t async for t in db["tenants"].find({})}
    names = {k: ((v.get("company") or {}).get("name") or v.get("name") or k) for k, v in tmap.items()}
    owner_ids = {r["_id"] async for r in db["roles"].find({"key": "owner"}, {"_id": 1})}
    out = []
    # Το φιλτράρισμα γίνεται σε Python (όχι $in στο query): τα role_ids άλλοτε είναι ObjectId και
    # άλλοτε string (όσα φτιάχτηκαν από το API) — ένα $in με ObjectIds θα έχανε τα δεύτερα.
    async for u in db["users"].find(query).limit(300):
        extra = [str(x) for x in (u.get("tenant_ids") or [])]
        home = tmap.get(u.get("tenant_id")) or {}
        afm = str(((home.get("company") or {}).get("afm") or "")).strip()
        is_owner = any(_oid(r) in owner_ids for r in (u.get("role_ids") or []))
        # Κράτα και μη-ιδιοκτήτες που ΗΔΗ έχουν πρόσβαση — αλλιώς «εξαφανίζονται» και δεν αφαιρείται.
        if owners_only and not is_owner and not extra:
            continue
        if len(out) >= 50:
            break
        # ΑΥΤΟΜΑΤΗ πρόσβαση: ίδιο (έγκυρο) ΑΦΜ + ρόλος ιδιοκτήτη → δεν χρειάζεται χειροκίνητη δήλωση
        auto = []
        if is_owner and re.fullmatch(r"\d{9}", afm):
            auto = [k for k, v in tmap.items()
                    if str(((v.get("company") or {}).get("afm") or "")).strip() == afm
                    and k != u.get("tenant_id")]
        out.append({
            "id": str(u["_id"]), "email": u.get("email"), "name": u.get("full_name", ""),
            "tenant_id": u.get("tenant_id"), "tenant_name": names.get(u.get("tenant_id"), ""),
            "afm": afm, "is_owner": is_owner,
            "tenant_ids": extra,
            "extra_names": [names.get(t, t) for t in extra],
            "auto_names": [names.get(t, t) for t in auto],   # από ίδιο ΑΦΜ — αυτόματα
        })
    return {"items": out}


class NetworkAccessIn(BaseModel):
    tenant_ids: list[str] = Field(default_factory=list, max_length=50)


@router.put("/network/users/{user_id}")
async def set_network_access(user_id: str, body: NetworkAccessIn,
                             _: PlatformContext = Depends(get_platform_admin)):
    db = shared_db()
    user = await db["users"].find_one({"_id": _oid(user_id)})
    if not user:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "user_not_found")
    valid = {t["_id"] async for t in db["tenants"].find({}, {"_id": 1})}
    # Το κύριο φαρμακείο δεν χρειάζεται να επαναληφθεί εδώ (μπαίνει πάντα από το allowed_tenants).
    clean = [t for t in dict.fromkeys(body.tenant_ids) if t in valid and t != user.get("tenant_id")]
    await db["users"].update_one({"_id": user["_id"]}, {"$set": {"tenant_ids": clean}})
    return {"ok": True, "user_id": user_id, "tenant_ids": clean}
