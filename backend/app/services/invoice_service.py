"""Αυτόματη έκδοση παραστατικών (Φάση 3).

Κύκλωμα: κάθε επιτυχής χρέωση → εγγραφή `invoices` (pending) → worker → SoftOne `issue()`
(καταχώρηση + διαβίβαση myDATA + πάροχος + **αποστολή τιμολογίου στον πελάτη από το SoftOne**) →
ACCEPT (findoc/MARK/UID) → status `issued` + κλείδωμα ΑΑΔΕ.

Αρχές:
- Η δημιουργία της εγγραφής στο σημείο χρέωσης είναι **best-effort** — ΔΕΝ κάνει ποτέ raise, ώστε
  να μη σπάει η πληρωμή αν πέσει κάτι.
- Η διαβίβαση είναι **ασύγχρονη** (worker) με retry/backoff, αποσυνδεδεμένη από την πληρωμή.
- Το RxVision ΔΕΝ στέλνει email· το SoftOne στέλνει το παραστατικό στον πελάτη.
- Η χρέωση (κάρτα) = τελικό **σύνολο** → το ΦΠΑ **αφαιρείται** (gross→net), ώστε total == χρέωση.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from pymongo import ReturnDocument

from app.core.db import shared_db
from app.services import softone_service

log = logging.getLogger(__name__)

# ΦΠΑ ανά χώρα φαρμακείου (GR 24%, CY 19%).
VAT_BY_COUNTRY = {"GR": 24.0, "CY": 19.0}
DEFAULT_VAT = 24.0
MAX_ATTEMPTS = 6           # μετά → status "failed" (χειροκίνητο retry από admin)
BATCH = 25                 # πόσα pending ανά τρέξιμο worker

KIND_LABELS = {
    "subscription": "Συνδρομή RxVision (πρώτη περίοδος)",
    "renewal": "Ανανέωση συνδρομής RxVision",
    "upgrade": "Αναβάθμιση πακέτου RxVision",
    "topup": "Αγορά credits μηνυμάτων RxVision",
    "extra": "Χρεώσιμη δυνατότητα RxVision",
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _split_gross(gross_cents: int, rate: float) -> tuple[int, int]:
    """gross (ΦΠΑ-inclusive) → (net_cents, vat_cents). Το total παραμένει ΠΑΝΤΑ == gross (η χρέωση)."""
    net = round(gross_cents / (1 + rate / 100))
    return net, gross_cents - net


def _customer_from_tenant(tenant: dict) -> dict:
    """Στοιχεία πελάτη για το παραστατικό (snapshot). Country top-level, τα υπόλοιπα από billing_profile."""
    bp = (tenant or {}).get("billing_profile") or {}
    return {
        "afm": (bp.get("afm") or "").strip(),
        "name": bp.get("name") or tenant.get("name") or "",
        "doy": bp.get("doy") or "",
        "address": bp.get("address") or "",
        "city": bp.get("city") or "",
        "zip": bp.get("postal_code") or "",
        "country": tenant.get("country") or "GR",
        "email": bp.get("billing_email") or bp.get("email") or "",
        "phone": bp.get("phone") or "",
    }


async def _resolve_email(db, tenant: dict) -> str:
    """Email παραλήπτη (για να στείλει το SoftOne): billing_email → email → owner user."""
    c = _customer_from_tenant(tenant)
    if c["email"]:
        return c["email"]
    owner = await db["users"].find_one({"tenant_id": tenant["_id"]}, sort=[("created_at", 1)])
    return (owner or {}).get("email", "") or ""


async def _next_number(db, series: str) -> int:
    """Ατομικός μετρητής ανά σειρά (αποφεύγει το race του max()+1). Ο επίσημος αριθμός έρχεται
    από το SoftOne (`aa`)· αυτός είναι εσωτερικός για ταξινόμηση/αναφορά."""
    doc = await db["counters"].find_one_and_update(
        {"_id": f"invoice_number:{series}"}, {"$inc": {"seq": 1}},
        upsert=True, return_document=ReturnDocument.AFTER)
    return int(doc.get("seq", 1))


async def create_for_payment(*, tenant_id: str, kind: str, gross_cents: int,
                             description: str | None = None, payment: dict | None = None,
                             series: str | None = None) -> dict | None:
    """Δημιουργεί εγγραφή `invoices` (pending) για μια ΕΠΙΤΥΧΗ χρέωση. Idempotent στο payment ref.
    Best-effort — δεν κάνει raise (καλείται στο hot path της πληρωμής)."""
    try:
        gross = int(gross_cents or 0)
        if gross <= 0:
            return None
        db = shared_db()
        pay = payment or {}
        txn = (pay.get("transaction_id") or "").strip()

        # idempotency: ένα παραστατικό ανά (kind, transaction) — αντέχει webhook retries
        if txn:
            existing = await db["invoices"].find_one({"source_ref": f"{kind}:{txn}"})
            if existing:
                return existing

        tenant = await db["tenants"].find_one({"_id": tenant_id})
        if not tenant:
            log.warning("invoice: tenant %s not found — skip", tenant_id)
            return None
        customer = _customer_from_tenant(tenant)
        if not customer["email"]:
            customer["email"] = await _resolve_email(db, tenant)
        rate = VAT_BY_COUNTRY.get(customer["country"], DEFAULT_VAT)
        net, vat = _split_gross(gross, rate)

        cfg = await softone_service.platform_config()
        series = series or cfg.get("series") or "Α"
        now = _now()
        number = await _next_number(db, series)
        blocked = None if customer["afm"] else "missing_afm"
        doc = {
            "tenant_id": tenant_id, "tenant_name": tenant.get("name"),
            "auto": True, "kind": kind, "doc_type": "ΤΠΥ", "series": series, "number": number,
            "issue_date": now.date().isoformat(),
            "description": description or KIND_LABELS.get(kind, "Υπηρεσία RxVision"),
            "net_amount": net, "vat_rate": rate, "vat_amount": vat, "total": gross,
            "customer": customer,
            "payment": {"method": pay.get("method"), "provider": pay.get("provider"),
                        "transaction_id": txn or None},
            "source_ref": f"{kind}:{txn}" if txn else f"{kind}:{tenant_id}:{int(now.timestamp())}",
            "status": "blocked" if blocked else "pending", "blocked_reason": blocked,
            "attempts": 0, "last_error": None, "next_attempt_at": now,
            "aade_status": "not_transmitted", "aade_mark": None, "aade_transmitted_at": None,
            "softone_findoc": None, "mydata_uid": None, "mydata_aa": None,
            "created_at": now, "updated_at": now, "issued_at": None,
        }
        res = await db["invoices"].insert_one(doc)
        doc["_id"] = res.inserted_id
        log.info("invoice queued: %s/%s €%.2f tenant=%s%s", kind, series, gross / 100, tenant_id,
                 " [BLOCKED: missing AFM]" if blocked else "")
        return doc
    except Exception:  # noqa: BLE001 — best-effort, ποτέ δεν σπάει την πληρωμή
        log.exception("invoice create_for_payment failed (kind=%s tenant=%s)", kind, tenant_id)
        return None


def _build_payload(inv: dict) -> dict:
    """Χαρτογράφηση invoice doc → JS Bridge Contract που περιμένει η SoftOne JS συνάρτηση.
    `net` σε ευρώ (float, όχι cents)· το clientID/appId τα βάζει μόνο του το `softone_service.issue()`."""
    return {
        "ref": str(inv["_id"]),
        "kind": inv.get("kind"),
        "issue_date": inv.get("issue_date"),
        "series": inv.get("series"),
        "customer": inv.get("customer") or {},
        "lines": [{
            "description": inv.get("description", ""),
            "qty": 1,
            "net": round((inv.get("net_amount", 0) or 0) / 100, 2),
            "vat_rate": inv.get("vat_rate", DEFAULT_VAT),
        }],
        "payment": inv.get("payment") or {},
    }


async def _issue_one(db, inv: dict) -> bool:
    """Στέλνει ΕΝΑ invoice στο SoftOne· ενημερώνει την εγγραφή (issued ή retry/backoff)."""
    r = await softone_service.issue(_build_payload(inv))
    now = _now()
    if r.get("ok"):
        await db["invoices"].update_one({"_id": inv["_id"]}, {"$set": {
            "status": "issued", "softone_findoc": r.get("findoc"),
            "aade_mark": r.get("mark"), "mydata_uid": r.get("uid"), "mydata_aa": r.get("aa"),
            "aade_status": "transmitted", "aade_transmitted_at": now,
            "issued_at": now, "last_error": None, "updated_at": now}})
        log.info("invoice issued: %s findoc=%s mark=%s", inv["_id"], r.get("findoc"), r.get("mark"))
        return True
    attempts = int(inv.get("attempts", 0)) + 1
    backoff_min = min(2 ** attempts, 720)           # εκθετικό, cap 12h
    status = "failed" if attempts >= MAX_ATTEMPTS else "pending"
    await db["invoices"].update_one({"_id": inv["_id"]}, {"$set": {
        "attempts": attempts, "last_error": str(r.get("error"))[:300], "status": status,
        "next_attempt_at": now + timedelta(minutes=backoff_min), "updated_at": now}})
    log.warning("invoice issue failed: %s err=%s attempt=%s→%s", inv["_id"], r.get("error"),
                attempts, status)
    return False


async def process_pending() -> dict:
    """Worker body: pending & ώριμα (next_attempt_at) invoices → SoftOne. Off μέχρι να ενεργοποιηθεί
    το auto_invoicing στο adminpanel ΚΑΙ να έχει ανέβει η JS του SoftOne (js_endpoint)."""
    db = shared_db()
    cfg = await softone_service.platform_config()
    if not softone_service.is_configured(cfg):
        return {"skipped": "softone_not_configured"}
    if not cfg.get("auto_invoicing"):
        return {"skipped": "auto_invoicing_off"}
    if not (cfg.get("js_endpoint") or "").strip():
        return {"skipped": "no_js_endpoint"}
    now = _now()
    issued = failed = 0
    cur = db["invoices"].find({"status": "pending", "auto": True,
                               "next_attempt_at": {"$lte": now}}).sort("created_at", 1).limit(BATCH)
    async for inv in cur:
        ok = await _issue_one(db, inv)
        issued += int(ok)
        failed += int(not ok)
    return {"issued": issued, "failed": failed}


async def issue_invoice_by_id(invoice_id) -> dict:
    """Χειροκίνητη έκδοση/επανάληψη ενός παραστατικού (από adminpanel)."""
    db = shared_db()
    oid = invoice_id if isinstance(invoice_id, ObjectId) else ObjectId(str(invoice_id))
    inv = await db["invoices"].find_one({"_id": oid})
    if not inv:
        return {"ok": False, "error": "not_found"}
    if inv.get("aade_status") == "transmitted":
        return {"ok": True, "already": True, "aade_mark": inv.get("aade_mark"),
                "softone_findoc": inv.get("softone_findoc")}
    if not (inv.get("customer") or {}).get("afm"):
        return {"ok": False, "error": "missing_afm"}
    ok = await _issue_one(db, inv)
    inv = await db["invoices"].find_one({"_id": oid})
    return {"ok": ok, "aade_status": inv.get("aade_status"), "aade_mark": inv.get("aade_mark"),
            "softone_findoc": inv.get("softone_findoc"),
            "error": None if ok else inv.get("last_error")}
