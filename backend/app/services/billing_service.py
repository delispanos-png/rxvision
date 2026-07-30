"""Subscription billing orchestration over Revolut (self-managed recurring).

Trial → card saved at signup → daily task charges off-session when the period ends →
success advances the period; repeated failure suspends the tenant (auto-deactivate).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.services import revolut_service as rv
from app.services import viva_service

CURRENCY = "EUR"
MAX_ATTEMPTS = 3


async def active_provider() -> str:
    """Ποιος πάροχος χρεώνει τις συνδρομές: 'revolut' (default) ή 'viva'. Ρυθμίζεται στο adminpanel
    (platform_settings._id='billing'.active_provider). Default = revolut → διατηρεί την υπάρχουσα ροή."""
    doc = await shared_db()["platform_settings"].find_one({"_id": "billing"}) or {}
    p = doc.get("active_provider")
    return p if p in ("revolut", "viva") else "revolut"


async def any_provider_configured() -> bool:
    return await rv.is_configured() or await viva_service.is_configured()


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _period_end(cycle: str, frm: datetime) -> datetime:
    return frm + (timedelta(days=365) if cycle == "yearly" else timedelta(days=30))


async def start_card_capture(tenant_id: str) -> dict:
    """Ξεκίνα αποθήκευση κάρτας για τη συνδρομή, μέσω του ΕΝΕΡΓΟΥ παρόχου.
    Revolut → {ok, token, mode} (widget). Viva → {ok, checkout_url} (redirect· κάρτα ή IRIS)."""
    db = shared_db()
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id})
    if not sub:
        return {"ok": False, "error": "no_subscription"}
    tenant = await db["tenants"].find_one({"_id": tenant_id}) or {}
    bp = tenant.get("billing_profile") or {}
    email = bp.get("email") or bp.get("billing_email") or ""
    name = bp.get("name") or tenant.get("name") or tenant_id
    # ΑΠΟΘΗΚΕΥΣΗ κάρτας (card-on-file): ΜΙΚΡΗ επαλήθευση/tokenization — ΟΧΙ χρέωση συνδρομής.
    # (Το amount αποθηκεύει την κάρτα για μελλοντικές off-session χρεώσεις: extras, top-ups, ανανέωση.)
    amount = 10  # €0,10 — μικρή επαλήθευση για αποθήκευση κάρτας
    prov = await active_provider()
    if prov == "viva":
        res = await viva_service.create_checkout_order(
            amount=amount, ref=tenant_id, description="RxVision — αποθήκευση κάρτας (επαλήθευση)",
            email=email, full_name=name, allow_recurring=True)
        if res.get("ok"):
            await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
                "payment_provider": "viva", "viva_order_code": res.get("order_code"),
                "payment_status": "card_pending"}})
        res["provider"] = "viva"
        return res
    res = await rv.create_save_card_order(
        amount=amount, currency=sub.get("currency", CURRENCY), email=email, name=name,
        tenant_id=tenant_id, description=f"RxVision {sub.get('billing_cycle', 'monthly')} — card setup")
    if res.get("ok"):
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
            "payment_provider": "revolut",
            "revolut_order_id": res.get("order_id"),
            "revolut_customer_id": res.get("customer_id"),
            "payment_status": "card_pending"}})
        res["mode"] = (await rv.config()).get("mode", "sandbox")
    res["provider"] = "revolut"
    return res


async def start_renewal(tenant_id: str, package_code: str, billing_cycle: str = "yearly") -> dict:
    """Ανανέωση ΛΗΓΜΕΝΗΣ συνδρομής: ο πελάτης διαλέγει πακέτο & πληρώνει μέσω Viva. Αποθηκεύει
    `pending_renewal` στη συνδρομή· η ενεργοποίηση γίνεται στο webhook (complete_renewal)."""
    db = shared_db()
    pkg = await db["packages"].find_one({"_id": package_code})
    if not pkg:
        return {"ok": False, "error": "package_not_found"}
    yearly = billing_cycle == "yearly"
    amount = int(pkg.get("price_yearly" if yearly else "price_monthly", 0) or 0)
    if amount <= 0:
        return {"ok": False, "error": "invalid_amount"}
    if await active_provider() != "viva":
        return {"ok": False, "error": "provider_not_viva"}
    tenant = await db["tenants"].find_one({"_id": tenant_id}) or {}
    bp = tenant.get("billing_profile") or {}
    email = bp.get("email") or bp.get("billing_email") or ""
    name = bp.get("name") or tenant.get("name") or tenant_id
    order = await viva_service.create_checkout_order(
        amount=amount, ref=f"renew:{tenant_id}",
        description=f"RxVision ανανέωση {billing_cycle} — {name}"[:2048],
        email=email, full_name=name, allow_recurring=True)
    if not order.get("ok"):
        return {"ok": False, "error": order.get("error", "viva_error")}
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
        "pending_renewal": {"plan": package_code, "billing_cycle": billing_cycle, "amount": amount},
        "viva_order_code": order.get("order_code")}})
    return {"ok": True, "checkout_url": order["checkout_url"], "amount_cents": amount}


async def complete_renewal(tenant_id: str, viva_transaction_id: str) -> None:
    """Viva webhook (renew:<tid>) → ενεργοποιεί τη συνδρομή με το επιλεγμένο πακέτο (idempotent)."""
    db = shared_db()
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id})
    if not sub:
        return
    pr = sub.get("pending_renewal") or {}
    plan = pr.get("plan") or sub.get("plan")
    cycle = pr.get("billing_cycle") or sub.get("billing_cycle") or "yearly"
    pkg = await db["packages"].find_one({"_id": plan}) or {}
    yearly = cycle == "yearly"
    price = int(pkg.get("price_yearly" if yearly else "price_monthly", 0) or 0)
    now = _now()
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {
        "$set": {"status": "active", "plan": plan, "plan_name": pkg.get("name"),
                 "billing_cycle": cycle, "price_per_pharmacy": price,
                 "modules_included": pkg.get("modules", sub.get("modules_included", [])),
                 "current_period_end": now + (timedelta(days=365) if yearly else timedelta(days=30)),
                 "started_at": now, "payment_provider": "viva", "payment_status": "card_saved",
                 "viva_transaction_id": viva_transaction_id, "failed_attempts": 0},
        "$unset": {"pending_renewal": ""}})
    await db["tenants"].update_one({"_id": tenant_id}, {"$set": {"status": "active"}})


# Καταστάσεις πληρωμής που σημαίνουν «υπάρχει αποθηκευμένη κάρτα που μπορούμε να χρεώσουμε off-session».
CARD_ON_FILE_STATES = ("card_saved", "active", "past_due")


async def card_on_file(tenant_id: str) -> bool:
    """True αν το φαρμακείο έχει αποθηκευμένη κάρτα (ξεκλειδώνει τα χρεώσιμα extras).
    Single source of truth για το gate — δεκτό είτε Revolut customer είτε Viva recurring transaction."""
    if not tenant_id:
        return False
    sub = await shared_db()["subscriptions"].find_one(
        {"tenant_id": tenant_id},
        {"payment_status": 1, "revolut_customer_id": 1, "viva_transaction_id": 1}) or {}
    return (sub.get("payment_status") in CARD_ON_FILE_STATES
            and bool(sub.get("revolut_customer_id") or sub.get("viva_transaction_id")))


async def mark_card_saved(tenant_id: str, customer_id: str | None = None) -> None:
    upd = {"payment_status": "card_saved", "failed_attempts": 0}
    if customer_id:
        upd["revolut_customer_id"] = customer_id
    await shared_db()["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": upd})


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else (v or None)


async def status(tenant_id: str) -> dict:
    sub = await shared_db()["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    return {
        "plan": sub.get("plan"), "status": sub.get("status"),
        "billing_cycle": sub.get("billing_cycle"),
        "payment_status": sub.get("payment_status", "trial"),
        "trial_ends_at": _iso(sub.get("trial_ends_at")),
        "current_period_end": _iso(sub.get("current_period_end")),
        "amount": int(sub.get("price_per_pharmacy", 0) or 0) + int(sub.get("addons_total", 0) or 0),
        "base_amount": int(sub.get("price_per_pharmacy", 0) or 0),
        "addons_total": int(sub.get("addons_total", 0) or 0),
        "currency": sub.get("currency", CURRENCY),
        "card_on_file": (sub.get("payment_status") in CARD_ON_FILE_STATES
                         and bool(sub.get("revolut_customer_id") or sub.get("viva_transaction_id"))),
        "payment_provider": sub.get("payment_provider") or await active_provider(),
        "revolut_configured": await rv.is_configured(),
        "viva_configured": await viva_service.is_configured(),
    }


async def _suspend(tenant_id: str, reason: str) -> None:
    db = shared_db()
    await db["tenants"].update_one({"_id": tenant_id}, {"$set": {
        "status": "suspended", "suspended_reason": reason, "updated_at": _now()}})
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
        "status": "suspended", "payment_status": "failed"}})


async def _charge_recurring(sub: dict, amount: int, tid: str) -> dict:
    """Off-session χρέωση ανανέωσης μέσω του παρόχου της συνδρομής (Revolut ή Viva)."""
    prov = sub.get("payment_provider") or "revolut"
    desc = f"RxVision {sub.get('billing_cycle', 'monthly')} renewal"
    if prov == "viva":
        if not sub.get("viva_transaction_id"):
            return {"ok": False, "error": "no_viva_transaction"}
        r = await viva_service.charge_recurring(
            original_transaction_id=sub["viva_transaction_id"], amount=amount, description=desc)
        return {"ok": r.get("ok"), "order_id": r.get("transaction_id"), "provider": "viva"}
    if not sub.get("revolut_customer_id"):
        return {"ok": False, "error": "no_revolut_customer"}
    r = await rv.charge_off_session(
        amount=amount, currency=sub.get("currency", CURRENCY),
        customer_id=sub["revolut_customer_id"], tenant_id=tid, description=desc)
    return {"ok": r.get("ok"), "order_id": r.get("order_id"), "provider": "revolut"}


async def bill_due() -> dict:
    """Charge subscriptions whose trial/period has ended. Auto-suspend after MAX_ATTEMPTS."""
    db = shared_db()
    if not await any_provider_configured():
        return {"skipped": "no_provider_configured"}
    now = _now()
    charged = failed = suspended = 0
    cur = db["subscriptions"].find({"$and": [
        {"status": {"$in": ["trial", "trialing", "active"]}},
        {"current_period_end": {"$lte": now}},
        {"$or": [{"revolut_customer_id": {"$ne": None}}, {"viva_transaction_id": {"$ne": None}}]},
        {"$or": [{"price_per_pharmacy": {"$gt": 0}}, {"addons_total": {"$gt": 0}}]},
    ]})
    async for sub in cur:
        tid = sub["tenant_id"]
        # full recurring amount = base subscription + active à-la-carte add-ons
        amount = int(sub.get("price_per_pharmacy", 0) or 0) + int(sub.get("addons_total", 0) or 0)
        if amount <= 0:
            continue
        res = await _charge_recurring(sub, amount, tid)
        if res.get("ok"):
            await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
                "status": "active", "payment_status": "active", "failed_attempts": 0,
                "current_period_end": _period_end(sub.get("billing_cycle", "monthly"), now),
                "last_charged_at": now}})
            from app.services import receipts
            await receipts.record(tid, "subscription",
                                  f"Συνδρομή {sub.get('plan', '')} ({sub.get('billing_cycle', 'monthly')})",
                                  amount, method="card", provider=res.get("provider", "revolut"),
                                  provider_order_id=res.get("order_id"))
            charged += 1
        else:
            attempts = sub.get("failed_attempts", 0) + 1
            await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
                "payment_status": "past_due", "failed_attempts": attempts}})
            failed += 1
            if attempts >= MAX_ATTEMPTS:
                await _suspend(tid, "payment_failed")
                suspended += 1
    return {"charged": charged, "failed": failed, "suspended": suspended}


async def _grace_cfg() -> tuple[int, int]:
    """(trial_grace, active_grace) σε ημέρες. Trials: 0 (λήγουν άμεσα). Ενεργές: 10μ περιθώριο."""
    cfg = await shared_db()["platform_settings"].find_one({"_id": "billing"}) or {}
    return max(0, int(cfg.get("trial_grace_days", 0))), max(0, int(cfg.get("active_grace_days", 10)))


async def expire_overdue() -> dict:
    """ΚΑΘΕ συνδρομή έχει περίοδο αρχή–τέλος· η επιβολή είναι ΑΝΕΞΑΡΤΗΤΗ τρόπου πληρωμής.
    • Δοκιμαστική (trial/trialing): λήγει ΑΜΕΣΩΣ στο τέλος (grace 0) → 'expired' (μπλόκο).
    • Ενεργή (active): μετά τη λήξη μπαίνει σε ΠΕΡΙΘΩΡΙΟ (past_due, ΚΡΑΤΑ πρόσβαση) για `active_grace`
      ημέρες· αν δεν ανανεωθεί → 'expired' (μπλόκο).
    Πιάνει όσες ΔΕΝ έχουν κάρτα να χρεωθεί (το bill_due αναλαμβάνει τις κάρτες). Ανανέωση = επέκταση
    της period από τον admin (π.χ. έγκριση κατάθεσης)."""
    db = shared_db()
    now = _now()
    trial_grace, active_grace = await _grace_cfg()
    no_card = {"revolut_customer_id": None, "viva_transaction_id": None}
    expired = graced = 0
    # 1) Δοκιμαστικές → λήξη άμεσα (grace 0 by default)
    async for sub in db["subscriptions"].find({
            "status": {"$in": ["trial", "trialing"]},
            "current_period_end": {"$lte": now - timedelta(days=trial_grace)}, **no_card}):
        await db["subscriptions"].update_one({"tenant_id": sub["tenant_id"]}, {"$set": {
            "status": "expired", "payment_status": "expired", "expired_at": now}})
        expired += 1
    # 2) Ενεργές → περιθώριο 10μ (past_due, κρατά πρόσβαση) → μετά expired
    async for sub in db["subscriptions"].find({
            "status": {"$in": ["active", "past_due"]},
            "current_period_end": {"$lte": now}, **no_card}):
        days_over = (now - sub["current_period_end"]).days
        if days_over > active_grace:
            await db["subscriptions"].update_one({"tenant_id": sub["tenant_id"]}, {"$set": {
                "status": "expired", "payment_status": "expired", "expired_at": now}})
            expired += 1
        elif sub.get("status") != "past_due":
            await db["subscriptions"].update_one({"tenant_id": sub["tenant_id"]}, {"$set": {
                "status": "past_due", "payment_status": "past_due"}})   # μπαίνει σε περιθώριο
            graced += 1
    return {"expired": expired, "graced": graced, "trial_grace": trial_grace, "active_grace": active_grace}


async def _billing_email(db, tid: str, tenant: dict) -> str | None:
    """Email χρέωσης του φαρμακείου: billing_profile → αλλιώς ο ιδιοκτήτης χρήστης."""
    bp = tenant.get("billing_profile") or {}
    email = bp.get("email") or bp.get("billing_email")
    if not email:
        u = await db["users"].find_one({"tenant_id": tid}, {"email": 1}, sort=[("created_at", 1)])
        email = (u or {}).get("email")
    return email or None


# Προεπιλογές ειδοποιήσεων συνδρομής — ό,τι ΔΕΝ ρυθμιστεί στο adminpanel πέφτει εδώ (ίδιο κείμενο με πριν).
NOTIF_DEFAULTS = {
    "trial_grace_days": 0, "active_grace_days": 10,
    "warn_days": [7, 3, 1], "expired_max_days": 30,
    "sales_email": "", "sales_phone": "",
    "warn_subject": "Η συνδρομή σας λήγει σε {days}",
    "warn_body": ("Αγαπητέ/ή {name},\n\nΗ συνδρομή σας στο RxVision λήγει σε {days}. Για να συνεχίσετε "
                  "χωρίς διακοπή, ανανεώστε τη συνδρομή σας ή επικοινωνήστε με το τμήμα πωλήσεων.{sales}"
                  "\n\n— RxVision"),
    "expired_subject": "Η συνδρομή σας έχει λήξει",
    "expired_body": ("Αγαπητέ/ή {name},\n\nΗ συνδρομή σας στο RxVision έχει λήξει. Παρακαλούμε "
                     "επικοινωνήστε με το τμήμα πωλήσεων για ενεργοποίηση/ανανέωση, ώστε να αποκατασταθεί "
                     "η πρόσβασή σας.{sales}\n\n— RxVision"),
}


async def notification_config() -> dict:
    """Ρυθμίσεις ειδοποιήσεων συνδρομής (adminpanel) πάνω στα NOTIF_DEFAULTS."""
    cfg = await shared_db()["platform_settings"].find_one({"_id": "billing"}) or {}
    out = dict(NOTIF_DEFAULTS)
    for k in NOTIF_DEFAULTS:
        if cfg.get(k) not in (None, ""):
            out[k] = cfg[k]
    return out


def _sales_line(cfg: dict) -> str:
    parts = [p for p in [cfg.get("sales_email"), cfg.get("sales_phone")] if p]
    return f" (Τμήμα πωλήσεων: {' · '.join(parts)})" if parts else ""


def _sub_email_html(name: str, days_left: int, cfg: dict) -> tuple[str, str]:
    """(subject, html) από τα ρυθμιζόμενα templates. days_left>0 = προειδοποίηση· <=0 = έχει λήξει."""
    d = ("1 ημέρα" if days_left == 1 else f"{days_left} ημέρες") if days_left > 0 else ""
    repl = {"{name}": name or "πελάτη", "{days}": d, "{sales}": _sales_line(cfg),
            "{sales_email}": cfg.get("sales_email", ""), "{sales_phone}": cfg.get("sales_phone", "")}
    key = "warn" if days_left > 0 else "expired"
    subject = cfg.get(f"{key}_subject") or NOTIF_DEFAULTS[f"{key}_subject"]
    body = cfg.get(f"{key}_body") or NOTIF_DEFAULTS[f"{key}_body"]
    for a, b in repl.items():
        subject = subject.replace(a, b); body = body.replace(a, b)
    html = "<p>" + body.replace("\n\n", "</p><p>").replace("\n", "<br>") + "</p>"
    return subject, html


async def subscription_reminders() -> dict:
    """Ημερήσια emails: προειδοποίηση ΠΡΙΝ τη λήξη (ρυθμιζόμενες μέρες) + ΚΑΘΗΜΕΡΙΝΑ ΜΕΤΑ (έως όριο).
    Κείμενα/μέρες/επαφή ρυθμίζονται στο adminpanel. Idempotent ανά ημέρα (last_reminder_date)."""
    from app.services import mailer
    db = shared_db()
    now = _now()
    today = now.date().isoformat()
    cfg = await notification_config()
    warn = {int(x) for x in (cfg.get("warn_days") or [])}
    max_after = int(cfg.get("expired_max_days") or 30)
    sent = 0
    async for sub in db["subscriptions"].find({
            "status": {"$in": ["trial", "trialing", "active", "past_due", "expired"]},
            "current_period_end": {"$ne": None}}):
        pend = sub.get("current_period_end")
        if not pend:
            continue
        days = (pend.date() - now.date()).days      # >0 πριν, <=0 μετά
        if not ((days in warn and sub.get("status") in ("trial", "trialing", "active"))
                or (-max_after <= days <= 0)):
            continue
        if sub.get("last_reminder_date") == today:   # ήδη στάλθηκε σήμερα
            continue
        tid = sub["tenant_id"]
        tenant = await db["tenants"].find_one({"_id": tid}) or {}
        email = await _billing_email(db, tid, tenant)
        if not email:
            continue
        subject, html = _sub_email_html(tenant.get("name") or "", days, cfg)
        try:
            await mailer.send_email(email, subject, html)
            await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {"last_reminder_date": today}})
            sent += 1
        except Exception:  # noqa: BLE001 — ένα αποτυχημένο email δεν ρίχνει το batch
            pass
    return {"sent": sent}


async def send_test_reminder(to_email: str, kind: str = "expired") -> dict:
    """Στείλε ΔΟΚΙΜΑΣΤΙΚΟ email (προεπισκόπηση) στη διεύθυνση που δίνει ο admin."""
    from app.services import mailer
    cfg = await notification_config()
    subject, html = _sub_email_html("Δοκιμαστικό Φαρμακείο", (3 if kind == "warn" else 0), cfg)
    try:
        await mailer.send_email(to_email, "[ΔΟΚΙΜΗ] " + subject, html)
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200]}


async def handle_viva_webhook(event_data: dict) -> None:
    """Viva «Transaction Payment Created» webhook → αποθήκευσε το transaction id (recurring seed) &
    μάρκαρε card_saved. tenant = MerchantTrns· επιβεβαίωση με re-fetch της συναλλαγής (StatusId 'F')."""
    db = shared_db()
    order_code = str(event_data.get("OrderCode") or "")
    txn = event_data.get("TransactionId") or event_data.get("transactionId")
    if not txn:
        return
    # επιβεβαίωση: re-fetch της συναλλαγής από το Viva (source of truth) — μη εμπιστεύεσαι το payload
    info = await viva_service.get_transaction(str(txn))
    status_id = str((info or {}).get("StatusId") or event_data.get("StatusId") or "")
    if status_id and status_id != "F":       # F = Finished (επιτυχής)
        return
    # (0) signup «πληρωμή-πρώτα»: MerchantTrns = "signup:<pending_id>" → μαρκάρισε την pending ως paid
    #     (ο λογαριασμός δημιουργείται όταν ο πελάτης βάλει κωδικό στο /register-complete)
    mt0 = str(event_data.get("MerchantTrns") or event_data.get("merchantTrns") or "")
    if mt0.startswith("signup:"):
        from app.services.onboarding_service import OnboardingService
        await OnboardingService().mark_pending_paid(mt0[len("signup:"):], str(txn))
        return
    if mt0.startswith("renew:"):     # ανανέωση ληγμένης συνδρομής → ενεργοποίηση
        await complete_renewal(mt0[len("renew:"):], str(txn))
        return
    # (1) top-up μηνυμάτων (order_code = viva order_code, αποθηκευμένο ως order_id στο pending) → πίστωση wallet
    if order_code:
        from app.services import message_wallet
        if await message_wallet.complete_topup(order_code):
            return
    # (2) συνδρομή: card-save + recurring seed. MerchantTrns = tenant_id (τα top-up έχουν "topup:…" → αγνόησε)
    mt = event_data.get("MerchantTrns") or event_data.get("merchantTrns")
    tid = mt if (mt and not str(mt).startswith("topup:")) else None
    if not tid and order_code:
        sub = await db["subscriptions"].find_one({"viva_order_code": order_code}, {"tenant_id": 1})
        tid = (sub or {}).get("tenant_id")
    if not tid:
        return
    await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
        "payment_provider": "viva", "viva_transaction_id": str(txn),
        "payment_status": "card_saved", "failed_attempts": 0}})
    from app.services import plan_change_service   # αναβάθμιση πληρωμένη με Viva → εφάρμοσε την
    sub = await db["subscriptions"].find_one({"tenant_id": tid}) or {}
    pend = sub.get("pending_change") or {}
    if pend.get("method") in ("card", "viva") and pend.get("status") == "awaiting_payment":
        await plan_change_service.apply_change(tid, source="viva")


async def handle_webhook(event: str, order: dict) -> None:
    """Update billing state from a Revolut order webhook (reference = tenant_id)."""
    db = shared_db()
    tid = (order.get("merchant_order_data") or {}).get("reference")
    if not tid:
        return
    # Wallet top-up orders: credit the message wallet (idempotent) and stop — not a subscription event.
    if event == "ORDER_COMPLETED" and order.get("id"):
        from app.services import message_wallet
        if await message_wallet.complete_topup(order["id"]):
            return
        # Plan-upgrade paid by card: apply the pending change when its Revolut order completes.
        sub = await db["subscriptions"].find_one({"tenant_id": tid}) or {}
        pend = sub.get("pending_change") or {}
        if (pend.get("method") == "card" and pend.get("status") == "awaiting_payment"
                and pend.get("revolut_order_id") == order["id"]):
            from app.services import plan_change_service
            await plan_change_service.apply_change(tid, source="revolut")
            return
    cust = (order.get("customer") or {}).get("id")
    if event in ("ORDER_COMPLETED", "ORDER_AUTHORISED"):
        upd = {"payment_status": "card_saved", "failed_attempts": 0}
        if cust:
            upd["revolut_customer_id"] = cust
        await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": upd})
    elif event in ("ORDER_PAYMENT_FAILED", "ORDER_CANCELLED"):
        sub = await db["subscriptions"].find_one({"tenant_id": tid}) or {}
        attempts = sub.get("failed_attempts", 0) + 1
        await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
            "payment_status": "past_due", "failed_attempts": attempts}})
        if attempts >= MAX_ATTEMPTS:
            await _suspend(tid, "payment_failed")
