"""Δοκιμαστικές δυνατότητες ανά πελάτη — παρακολούθηση & ειδοποίηση αγοράς.

Απαντά σε μία ερώτηση: «ποιος δοκιμάζει τι, πότε του λήγει, και το αγόρασε;»

ΓΙΑΤΙ ΞΕΧΩΡΙΣΤΟ ΚΥΚΛΩΜΑ: οι δοκιμές ΔΥΝΑΤΟΤΗΤΩΝ (module trials) δεν είναι δοκιμές ΣΥΝΔΡΟΜΗΣ.
Η δεύτερη ζει στο `subscriptions.trial_ends_at` (→ billing_service / lifecycle)· η πρώτη στο
`tenants.module_trials.<module>` και δεν την έβλεπε κανείς πουθενά.

ΠΡΟΣΟΧΗ — Η ΛΗΞΗ ΕΙΝΑΙ «ΤΕΜΠΕΛΙΚΗ»: το `auth_service` υποβιβάζει ένα ληγμένο trial σε `locked`
ΜΟΝΟ στο login/refresh του πελάτη. Όσο εκείνος δεν συνδέεται, το `tenants.modules.<m>` μένει
"trial" για πάντα. Γι' αυτό η κατάσταση εδώ βγαίνει ΠΑΝΤΑ από την ΗΜΕΡΟΜΗΝΙΑ — ποτέ από το πεδίο.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db

_SETTINGS_ID = "module_trials"

DEFAULTS: dict = {
    "enabled": True,
    "warn_days": [3, 1],        # πόσες μέρες ΠΡΙΝ τη λήξη φεύγει η ενημέρωση αγοράς
    "notify_on_expiry": True,   # + ένα μήνυμα ΤΗΝ ημέρα που έληξε
    "sales_email": "",
    "sales_phone": "",
}

# Ονόματα για modules που ΔΕΝ είναι add-ons (τα add-ons παίρνουν το όνομά τους από τον κατάλογο).
_FALLBACK_LABELS: dict[str, str] = {
    "dashboard": "Πίνακας Ελέγχου",
    "prescription_analytics": "Συνταγές",
    "doctor_analytics": "Ιατροί",
    "icd10_analytics": "ICD-10",
    "profitability": "Κερδοφορία",
    "future_prescriptions": "Μελλοντικές συνταγές",
    "order_suggestions": "Σύμβουλος Παραγγελιών",
    "ingestion": "Λήψη ΗΔΥΚΑ",
    "pharmacyone": "PharmacyOne",
}

_TRIAL_DAYS_FALLBACK = 14       # όσο δίνει το addon_service.start_trial — για δοκιμές χωρίς εγγραφή έναρξης


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def settings() -> dict:
    cfg = await shared_db()["platform_settings"].find_one({"_id": _SETTINGS_ID}) or {}
    out = dict(DEFAULTS)
    for k in DEFAULTS:
        if cfg.get(k) not in (None, ""):
            out[k] = cfg[k]
    return out


async def save_settings(values: dict) -> dict:
    clean = {k: v for k, v in values.items() if k in DEFAULTS}
    if "warn_days" in clean:
        clean["warn_days"] = sorted({int(d) for d in clean["warn_days"] if 0 <= int(d) <= 60}, reverse=True)
    await shared_db()["platform_settings"].update_one(
        {"_id": _SETTINGS_ID}, {"$set": {**clean, "updated_at": _now()}}, upsert=True)
    return await settings()


async def _labels() -> dict[str, str]:
    """module_key → ελληνικό όνομα. Ο κατάλογος add-ons είναι η πηγή αλήθειας· τα υπόλοιπα από fallback."""
    out = dict(_FALLBACK_LABELS)
    async for a in shared_db()["addons"].find({}, {"name": 1, "icon": 1}):
        out[a["_id"]] = a.get("name") or a["_id"]
    return out


async def _prices() -> dict[str, dict]:
    return {a["_id"]: a async for a in shared_db()["addons"].find({}, {"price_monthly": 1, "price_yearly": 1, "icon": 1})}


def _status(expires_at: datetime | None, *, bought: bool, in_plan: bool, state: str | None,
            warn_days: list[int], now: datetime) -> tuple[str, str]:
    """(κωδικός, ελληνική ετικέτα). Η σειρά μετράει: η κατοχή υπερισχύει της ημερομηνίας.

    ΑΓΟΡΑ ≠ ΠΑΚΕΤΟ. Το `modules_included` σημαίνει ότι η δυνατότητα είναι ΜΕΣΑ στη συνδρομή —
    δεν πουλήθηκε τίποτα, άρα ΔΕΝ είναι μετατροπή. Μόνο το `subscriptions.addons` είναι αγορά.
    (Λάθος που διορθώθηκε 21/09/2026: ο ΜΠΙΝΙΚΟΣ φαινόταν να «αγόρασε» 4 δυνατότητες που το
    πακέτο Advanced τού έδινε ήδη — και το ποσοστό μετατροπής έβγαινε ψεύτικο 100%.)"""
    if bought:
        return "converted", "Το αγόρασε"
    if in_plan:
        return "in_plan", "Μέσα στη συνδρομή"
    if not expires_at:
        return "unknown", "Χωρίς ημερομηνία λήξης"
    days = (expires_at.date() - now.date()).days
    # Η ΗΜΕΡΟΜΗΝΙΑ ΔΕΝ ΑΡΚΕΙ: το `tenants.modules.<m>` μπορεί να έχει γυρίσει σε `locked` από τον
    # πίνακα Modules του adminpanel ΟΣΟ η δοκιμή τρέχει. Τότε ο πελάτης ΔΕΝ βλέπει τίποτα, οπότε
    # «Σε δοκιμή» θα ήταν ψέμα — και η ειδοποίηση αγοράς θα μιλούσε για κάτι που δεν δοκίμασε ποτέ.
    if days >= 0 and state != "trial":
        return "revoked", "Διακόπηκε — κλειδωμένο"
    if days < 0:
        return "expired", "Έληξε — δεν αγόρασε"
    if days <= (max(warn_days) if warn_days else 3):
        return "expiring", "Λήγει σύντομα"
    return "active", "Σε δοκιμή"


async def list_trials(*, status: str | None = None, module: str | None = None) -> dict:
    """Όλες οι δοκιμές δυνατοτήτων με λήξη, από τις ΔΥΟ πηγές που τις γράφουν:
    `tenants.module_trials` (self-service) και `addon_grants` (παραχώρηση πλατφόρμας)."""
    db = shared_db()
    now = _now()
    cfg = await settings()
    warn = [int(x) for x in (cfg.get("warn_days") or [])]
    labels, prices = await _labels(), await _prices()

    # πότε ξεκίνησε + ποιος το έδωσε — μόνο το addon_grants το ξέρει
    grants: dict[tuple[str, str], dict] = {}
    async for g in db["addon_grants"].find({}).sort("at", 1):
        grants[(g["tenant_id"], g.get("module") or "")] = g

    rows: list[dict] = []
    async for t in db["tenants"].find({"module_trials": {"$exists": True, "$ne": {}}},
                                      {"name": 1, "modules": 1, "module_trials": 1, "billing_profile": 1}):
        sub = await db["subscriptions"].find_one(
            {"tenant_id": t["_id"]}, {"addons": 1, "modules_included": 1, "plan_name": 1}) or {}
        paid = set(sub.get("addons") or [])              # ΑΓΟΡΑΣΜΕΝΟ add-on → μετατροπή
        included = set(sub.get("modules_included") or [])  # μέσα στο πακέτο → ΔΕΝ είναι πώληση
        for mkey, exp in (t.get("module_trials") or {}).items():
            if module and mkey != module:
                continue
            g = grants.get((t["_id"], mkey))
            started = g.get("at") if g else (exp - timedelta(days=_TRIAL_DAYS_FALLBACK) if exp else None)
            state = (t.get("modules") or {}).get(mkey)
            code, label = _status(exp, bought=mkey in paid, in_plan=mkey in included,
                                  state=state, warn_days=warn, now=now)
            # Δυνατότητα που το ΠΑΚΕΤΟ δίνει ήδη δεν είναι εμπορική ευκαιρία: δεν πουλιέται,
            # δεν χάνεται, δεν ειδοποιείται. Δεν ανήκει καν σε λίστα δοκιμών — εκτός εντελώς.
            if code == "in_plan":
                continue
            if status and status != "all" and code != status:
                continue
            a = prices.get(mkey) or {}
            rows.append({
                "tenant_id": t["_id"], "tenant_name": t.get("name") or "—",
                "plan_name": sub.get("plan_name"),
                "module": mkey, "module_label": labels.get(mkey, mkey), "icon": a.get("icon"),
                "started_at": started, "started_exact": bool(g),
                "expires_at": exp,
                "days_left": (exp.date() - now.date()).days if exp else None,
                "status": code, "status_label": label,
                "source": "platform" if g else "self",
                "granted_by": (g or {}).get("by"),
                "price_monthly": a.get("price_monthly"), "price_yearly": a.get("price_yearly"),
                "state_field": (t.get("modules") or {}).get(mkey),
                "notified_at": (g or {}).get("notified_at"),
            })

    order = {"expiring": 0, "revoked": 1, "active": 2, "expired": 3,
             "converted": 4, "in_plan": 5, "unknown": 6}
    rows.sort(key=lambda r: (order.get(r["status"], 9), r["days_left"] if r["days_left"] is not None else 999))

    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    # Μετατροπή = ΑΓΟΡΕΣ / (αγορές + χαμένες). Εκτός μένουν οι ανοιχτές δοκιμές (δεν κρίθηκαν
    # ακόμα) ΚΑΙ όσες αφορούν δυνατότητα που το πακέτο δίνει ήδη (δεν υπήρχε τίποτα να πουληθεί).
    closed = counts.get("converted", 0) + counts.get("expired", 0)
    return {"items": rows, "counts": counts, "total": len(rows),
            "conversion_rate": round(100 * counts.get("converted", 0) / closed) if closed else None,
            "settings": cfg}


# ── ενημέρωση αγοράς ─────────────────────────────────────────────────────────────────────────
def _eur(cents: int | None) -> str:
    return f"{(cents or 0) / 100:.0f} €".replace(".", ",")


def _email_html(*, pharmacy: str, module_label: str, days_left: int,
                price_monthly: int | None, price_yearly: int | None, cfg: dict) -> tuple[str, str]:
    """(subject, html). days_left > 0 = «σου λήγει σε X»· <= 0 = «έληξε»."""
    if days_left > 0:
        when = "αύριο" if days_left == 1 else f"σε {days_left} ημέρες"
        subject = f"Η δοκιμή «{module_label}» λήγει {when}"
        lead = (f"Δοκιμάζεις τη δυνατότητα <b>«{module_label}»</b> και η δοκιμαστική περίοδος λήγει <b>{when}</b>. "
                f"Αν σου φάνηκε χρήσιμο, μπορείς να το κρατήσεις χωρίς διακοπή.")
    else:
        subject = f"Η δοκιμή «{module_label}» έληξε"
        lead = (f"Η δοκιμαστική περίοδος για τη δυνατότητα <b>«{module_label}»</b> ολοκληρώθηκε και "
                f"δεν είναι πλέον διαθέσιμη στον λογαριασμό σου. Μπορείς να την ενεργοποιήσεις όποτε θες.")

    price = ""
    if price_monthly or price_yearly:
        bits = [b for b in (f"{_eur(price_monthly)}/μήνα" if price_monthly else "",
                            f"{_eur(price_yearly)}/έτος" if price_yearly else "") if b]
        price = (f'<p style="margin:16px 0;padding:12px 16px;background:#f1f5f9;border-radius:8px">'
                 f'<b>{module_label}</b> — {" ή ".join(bits)}</p>')

    sales = [p for p in (cfg.get("sales_email"), cfg.get("sales_phone")) if p]
    contact = f'<p style="color:#64748b;font-size:13px">Ερωτήσεις; {" · ".join(sales)}</p>' if sales else ""
    html = (f'<div style="font-family:system-ui,sans-serif;line-height:1.6;color:#0f172a">'
            f'<p>Γεια σου {pharmacy or "συνάδελφε"},</p><p>{lead}</p>{price}'
            f'<p>Η ενεργοποίηση γίνεται μέσα από την εφαρμογή: <b>Συνδρομή → Πρόσθετα (Add-ons)</b>.</p>'
            f'{contact}<p style="color:#64748b;font-size:13px">— Η ομάδα του RxVision</p></div>')
    return subject, html


async def notify_one(tenant_id: str, module: str, *, by: str | None = None) -> dict:
    """Στέλνει ΤΩΡΑ την ενημέρωση αγοράς για μία δοκιμή. Καταγράφει ώστε το αυτόματο να μην ξαναστείλει."""
    from app.services import mailer
    from app.services.billing_service import _billing_email

    db = shared_db()
    now = _now()
    t = await db["tenants"].find_one({"_id": tenant_id})
    if not t:
        return {"ok": False, "error": "tenant_not_found"}
    exp = (t.get("module_trials") or {}).get(module)
    email = await _billing_email(db, tenant_id, t)
    if not email:
        return {"ok": False, "error": "no_email"}

    sub = await db["subscriptions"].find_one(
        {"tenant_id": tenant_id}, {"addons": 1, "modules_included": 1}) or {}
    if module in set(sub.get("addons") or []) | set(sub.get("modules_included") or []):
        return {"ok": False, "error": "already_owned",
                "message": "Ο πελάτης έχει ήδη τη δυνατότητα — δεν στέλνουμε πρόταση αγοράς."}

    cfg = await settings()
    labels, prices = await _labels(), await _prices()
    a = prices.get(module) or {}
    days = (exp.date() - now.date()).days if exp else 0
    subject, html = _email_html(pharmacy=t.get("name") or "", module_label=labels.get(module, module),
                                days_left=days, price_monthly=a.get("price_monthly"),
                                price_yearly=a.get("price_yearly"), cfg=cfg)
    try:
        await mailer.send_email(email, subject, html)
    except Exception as e:  # noqa: BLE001 — το γιατί το θέλει ο admin στην οθόνη
        return {"ok": False, "error": str(e)[:200]}
    await db["module_trial_notices"].insert_one({
        "tenant_id": tenant_id, "module": module, "date": now.date().isoformat(),
        "days_left": days, "email": email, "by": by or "auto", "at": now})
    return {"ok": True, "email": email, "days_left": days}


async def notify_expiring() -> dict:
    """Ημερήσιο: ενημέρωση αγοράς Χ μέρες ΠΡΙΝ τη λήξη (+ προαιρετικά την ημέρα που έληξε).

    Idempotent ανά (πελάτη, module, ΗΜΕΡΑ ΛΗΞΗΣ): κάθε δοκιμή ειδοποιείται ΜΙΑ φορά ανά κατώφλι,
    ακόμη κι αν το task ξανατρέξει ή ο admin έχει ήδη στείλει χειροκίνητα σήμερα."""
    db = shared_db()
    cfg = await settings()
    if not cfg.get("enabled"):
        return {"skipped": "disabled", "sent": 0}
    warn = {int(x) for x in (cfg.get("warn_days") or [])}
    now = _now()
    sent = failed = 0
    data = await list_trials()
    for r in data["items"]:
        # Ποτέ email για κάτι που ο πελάτης ΗΔΗ έχει: είτε το αγόρασε (`converted`) είτε του το
        # δίνει το πακέτο του (`in_plan`). Θα ήταν πρόταση να αγοράσει κάτι που ήδη πληρώνει.
        if r["status"] in ("converted", "in_plan", "revoked") or r["days_left"] is None:
            continue
        d = r["days_left"]
        if not (d in warn or (d == 0 and cfg.get("notify_on_expiry"))):
            continue
        # ΜΙΑ ειδοποίηση ανά κατώφλι — κλειδί το days_left, όχι η ημερομηνία αποστολής
        if await db["module_trial_notices"].find_one(
                {"tenant_id": r["tenant_id"], "module": r["module"], "days_left": d}):
            continue
        res = await notify_one(r["tenant_id"], r["module"], by="auto")
        sent += 1 if res.get("ok") else 0
        failed += 0 if res.get("ok") else 1
    return {"sent": sent, "failed": failed, "checked": len(data["items"]), "at": now}
