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


def gross_from_price(price_cents: int, includes_vat: bool, country: str | None = "GR") -> int:
    """Ποσό ΜΕ ΦΠΑ που ΧΡΕΩΝΕΤΑΙ. Αν οι τιμές είναι καθαρές (includes_vat=False) → προσθέτει ΦΠΑ
    χώρας· αν ήδη περιλαμβάνουν ΦΠΑ → επιστρέφει ως έχει. Ενιαία πηγή αλήθειας για κάθε χρέωση."""
    price = int(price_cents or 0)
    if includes_vat or price <= 0:
        return price
    rate = VAT_BY_COUNTRY.get(country or "GR", DEFAULT_VAT)
    return round(price * (1 + rate / 100))


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
                             series: str | None = None, item_key: str | None = None) -> dict | None:
    """Δημιουργεί εγγραφή `invoices` (pending) για μια ΕΠΙΤΥΧΗ χρέωση. Idempotent στο payment ref.
    Best-effort — δεν κάνει raise (καλείται στο hot path της πληρωμής)."""
    try:
        gross = int(gross_cents or 0)
        if gross <= 0:
            return None
        db = shared_db()
        pay = payment or {}
        txn = (pay.get("transaction_id") or "").strip()

        # Δωρεάν πελάτης (χαρακτηρισμένος στη συνδρομή) → ΚΑΝΕΝΑ παραστατικό.
        sub = await db["subscriptions"].find_one({"tenant_id": tenant_id},
              {"complimentary": 1, "plan": 1, "started_at": 1, "current_period_end": 1, "billing_cycle": 1})
        if sub and sub.get("complimentary"):
            log.info("invoice skipped — complimentary tenant: %s (%s)", tenant_id, kind)
            return None

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
        # SoftOne MTRL (είδος) από την κεντρική αντιστοίχιση· subscription/renewal/upgrade → pkg:<plan>·
        # αλλιώς το item_key του caller (credit:/addon:/ai/retention)· fallback → default (αλλιώς η JS
        # χρησιμοποιεί το δικό της CFG.SERVICE_MTRL) → το παραστατικό δεν σπάει ποτέ.
        mm = cfg.get("mtrl_map") or {}
        ik = item_key
        if not ik and kind in ("subscription", "renewal", "upgrade") and sub and sub.get("plan"):
            ik = f"pkg:{sub['plan']}"
        mtrl = mm.get(ik or "") or mm.get("default") or None
        now = _now()
        number = await _next_number(db, series)
        blocked = None if customer["afm"] else "missing_afm"
        # ΑΙΤΙΟΛΟΓΙΑ = περίοδος συνδρομής (για subscription/renewal/upgrade) → SoftOne COMMENTS
        comments = ""
        if kind in ("subscription", "renewal", "upgrade") and sub:
            _f = lambda d: d.strftime("%d/%m/%Y") if hasattr(d, "strftime") else ""  # noqa: E731
            st, en = sub.get("started_at"), sub.get("current_period_end")
            if en:
                comments = "Πώληση από το site του RxVision - Περίοδος: " + (f"{_f(st)} έως " if st else "έως ") + _f(en)
        doc = {
            "tenant_id": tenant_id, "tenant_name": tenant.get("name"),
            "auto": True, "kind": kind, "doc_type": "ΤΠΥ", "series": series, "number": number,
            "issue_date": now.date().isoformat(),
            "description": description or KIND_LABELS.get(kind, "Υπηρεσία RxVision"),
            "comments": comments,
            "net_amount": net, "vat_rate": rate, "vat_amount": vat, "total": gross,
            "mtrl": mtrl, "item_key": ik,
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
    `net` σε ευρώ (float, όχι cents)· το clientID/appId τα βάζει μόνο του το `softone_service.issue()`.
    Πολυγραμμικό: αν το παραστατικό έχει `lines`, τις στέλνει όλες· αλλιώς μονή γραμμή (legacy)."""
    c = lambda x: round((x or 0) / 100, 2)  # noqa: E731 — cents → euros (2 δεκαδικά)
    lines = inv.get("lines") or []
    if lines:
        # έκπτωση συνόλου κατανεμημένη αναλογικά στις γραμμές (ώστε το άθροισμα καθαρών = τελικό net)
        hdisc = int((inv.get("discount") or {}).get("amount") or 0)
        subtotal = int(inv.get("subtotal_net") or sum(int(ln.get("net") or 0) for ln in lines)) or 0
        out_lines = []
        remaining = hdisc
        n = len(lines)
        for i, ln in enumerate(lines):
            line_net = int(ln.get("net") or 0)                 # καθαρή γραμμής μετά την έκπτωση γραμμής
            share = (round(line_net * hdisc / subtotal) if i < n - 1 else remaining) if (subtotal and hdisc) else 0
            remaining -= share
            final_net = line_net - share                       # καθαρή μετά ΚΑΙ την έκπτωση συνόλου
            qty = float(ln.get("qty") or 1) or 1
            gross = int(ln.get("gross") or line_net)
            out_lines.append({
                "description": ln.get("description", ""),
                "mtrl": ln.get("mtrl"),
                "qty": qty,
                "unit_net": round(final_net / qty / 100, 4),   # τιμή μονάδας (μετά εκπτώσεις) → PRICE
                "net": c(final_net),                           # καθαρή αξία γραμμής (μετά εκπτώσεις) → LINEVAL
                "gross": c(gross),                             # μικτή αξία γραμμής προ έκπτωσης
                "discount": c(gross - final_net),              # συνολική έκπτωση γραμμής (γραμμής + μερίδιο συνόλου)
                "vat_rate": ln.get("vat_rate", DEFAULT_VAT),
            })
    else:
        net = int(inv.get("net_amount", 0) or 0)
        out_lines = [{
            "description": inv.get("description", ""),
            "mtrl": inv.get("mtrl"),
            "qty": 1, "unit_net": c(net), "net": c(net), "gross": c(net), "discount": 0.0,
            "vat_rate": inv.get("vat_rate", DEFAULT_VAT),
        }]
    return {
        "ref": str(inv["_id"]),
        "kind": inv.get("kind"),
        "issue_date": inv.get("issue_date"),
        "series": inv.get("series"),
        "number": inv.get("number"),
        "doc_type": inv.get("doc_type"),
        "comments": inv.get("comments") or inv.get("description") or "",   # ΑΙΤΙΟΛΟΓΙΑ (π.χ. περίοδος συνδρομής)
        "customer": inv.get("customer") or {},
        "lines": out_lines,
        "totals": {"net": c(inv.get("net_amount")), "vat": c(inv.get("vat_amount")),
                   "total": c(inv.get("total")), "discount": c((inv.get("discount") or {}).get("amount"))},
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
    backoff_min = 5                                  # σταθερό retry κάθε 5 λεπτά (έως MAX_ATTEMPTS)
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
    if not (cfg.get("js_endpoint") or "").strip():
        return {"skipped": "no_js_endpoint"}
    now = _now()
    issued = failed = 0
    # Τα ΧΕΙΡΟΚΙΝΗΤΑ παραστατικά (auto != True) στέλνονται πάντα (ρητή ενέργεια admin)· τα ΑΥΤΟΜΑΤΑ
    # (από χρεώσεις) μόνο όταν είναι ON το master switch «Αυτόματη έκδοση τιμολογίων».
    q: dict = {"status": "pending", "next_attempt_at": {"$lte": now}}
    if not cfg.get("auto_invoicing"):
        q["auto"] = {"$ne": True}
    cur = db["invoices"].find(q).sort("created_at", 1).limit(BATCH)
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
