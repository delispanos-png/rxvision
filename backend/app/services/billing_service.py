"""Subscription billing orchestration over Revolut (self-managed recurring).

Trial → card saved at signup → daily task charges off-session when the period ends →
success advances the period; repeated failure suspends the tenant (auto-deactivate).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.services import revolut_service as rv
from app.services import viva_service

logger = logging.getLogger(__name__)

CURRENCY = "EUR"


async def active_provider() -> str:
    """Ποιος πάροχος χρεώνει τις συνδρομές: 'revolut' (default) ή 'viva'. Ρυθμίζεται στο adminpanel
    (platform_settings._id='billing'.active_provider). Default = revolut → διατηρεί την υπάρχουσα ροή."""
    doc = await shared_db()["platform_settings"].find_one({"_id": "billing"}) or {}
    p = doc.get("active_provider")
    return p if p in ("revolut", "viva") else "revolut"


async def any_provider_configured() -> bool:
    return await rv.is_configured() or await viva_service.is_configured()


# Επιστροφή μετά την πληρωμή ανανέωσης στη Revolut. Η σελίδα εισόδου δουλεύει και για τον κλειδωμένο
# (χωρίς σύνδεση) και για τον συνδεδεμένο πελάτη.
RENEWAL_RETURN_URL = "https://app.rxvision.gr/login?renewed=1"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _period_end(cycle: str, frm: datetime) -> datetime:
    return frm + (timedelta(days=365) if cycle == "yearly" else timedelta(days=30))


def effective_status(sub: dict | None) -> str:
    """ΜΙΑ συνεκτική κατάσταση πελάτη — η **ΠΕΡΙΟΔΟΣ** (current_period_end) είναι η πηγή αλήθειας, όπως
    ζήτησε ο ιδιοκτήτης: ΕΝΤΟΣ περιόδου → ενεργός· ΕΚΤΟΣ → ληγμένος. ΔΕΝ εμπιστεύεται παλιό/ξεχασμένο
    status="expired" όταν η λήξη είναι στο μέλλον (π.χ. μετά από επέκταση/αλλαγή πλάνου).
      active · trial · past_due (περιθώριο) · expired · suspended · cancelled · none"""
    if not sub:
        return "none"
    st = (sub.get("status") or "").lower()
    if st in ("cancelled", "canceled"):
        return "cancelled"
    if sub.get("complimentary"):
        return "active"                          # δωρεάν πελάτης → πάντα ενεργός (δεν λήγει)
    if st == "suspended":
        return "suspended"
    now = _now()
    if st in ("trial", "trialing"):              # ΔΟΚΙΜΑΣΤΙΚΗ → μετράει η ΛΗΞΗ TRIAL (μία περίοδος)
        tend = sub.get("trial_ends_at") or sub.get("current_period_end")
        return "expired" if (tend is not None and tend <= now) else "trial"
    pend = sub.get("current_period_end")
    if pend is not None:                         # ΠΛΗΡΩΜΕΝΗ → η ΠΕΡΙΟΔΟΣ αποφασίζει (όχι το ξεχασμένο status)
        return "active" if pend > now else ("past_due" if st == "past_due" else "expired")
    if st in ("expired", "past_due"):            # χωρίς ημερομηνία → raw status
        return st
    return "active"


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
        # ΜΟΝΟ ο κωδικός παραγγελίας. Πάροχος/κατάσταση κάρτας αλλάζουν ΟΤΑΝ η κάρτα αποθηκευτεί (webhook):
        # μισή αλλαγή κάρτας δεν πρέπει να «χαλάει» την κάρτα που ήδη δουλεύει (18/10/2026).
        if res.get("ok"):
            await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
                "viva_order_code": res.get("order_code")}})
        res["provider"] = "viva"
        return res
    res = await rv.create_save_card_order(
        amount=amount, currency=sub.get("currency", CURRENCY), email=email, name=name,
        tenant_id=tenant_id, description=f"RxVision {sub.get('billing_cycle', 'monthly')} — card setup")
    if res.get("ok"):   # όπως στη Viva: πάροχος + πελάτης Revolut γράφονται ΜΟΝΟ στο webhook επιτυχίας
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
            "revolut_order_id": res.get("order_id")}})
        res["mode"] = (await rv.config()).get("mode", "sandbox")
    res["provider"] = "revolut"
    return res


async def start_renewal(tenant_id: str, package_code: str, billing_cycle: str = "yearly",
                        coupon_code: str | None = None, accept_extras: bool = False) -> dict:
    """Ανανέωση ΛΗΓΜΕΝΗΣ συνδρομής: ο πελάτης διαλέγει πακέτο (+ προαιρετικό coupon) & πληρώνει μέσω
    τον ΕΝΕΡΓΟ πάροχο (Viva ή Revolut). Αποθηκεύει `pending_renewal`· η ενεργοποίηση + εξαργύρωση coupon
    γίνεται στο webhook (ή στο reconcile, αν το webhook δεν φτάσει) — ΠΑΝΤΑ με επαλήθευση από τον πάροχο."""
    db = shared_db()
    pkg = await db["packages"].find_one({"_id": package_code})
    if not pkg:
        return {"ok": False, "error": "package_not_found"}
    yearly = billing_cycle == "yearly"
    amount = int(pkg.get("price_yearly" if yearly else "price_monthly", 0) or 0)
    if amount <= 0:
        return {"ok": False, "error": "invalid_amount"}
    provider = await active_provider()
    from app.services import feedback_service
    amount, coupon = await feedback_service.apply_discount(amount, coupon_code, tenant_id)
    tenant = await db["tenants"].find_one({"_id": tenant_id}) or {}
    # + ό,τι επαναλαμβάνεται (πρόσθετα, έξτρα χρήστες, διατήρηση, SLA) — ΟΧΙ σιωπηλά: αν υπάρχουν,
    # ο πελάτης βλέπει πρώτα την ανάλυση και επιβεβαιώνει (το coupon αφορά μόνο το πακέτο)
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {"tenant_id": tenant_id}
    extras = await recurring_extras(db, sub, pkg, yearly)
    # καθαρό → χρεώσιμο ΜΕ ΦΠΑ (αν οι τιμές είναι καθαρές)
    from app.services.invoice_service import gross_from_price
    inc_vat = bool(pkg.get("price_includes_vat"))
    if extras["total"] > 0 and not accept_extras:
        return {"ok": False, "error": "extras_confirm", "breakdown": {
            "package": gross_from_price(amount, inc_vat, tenant.get("country")),
            "addons": gross_from_price(extras["addons"] + extras["retention"], inc_vat, tenant.get("country")),
            "seats": gross_from_price(extras["seats"], inc_vat, tenant.get("country")),
            "extra_users": extras["extra_users"],
            "sla": gross_from_price(extras["sla"], inc_vat, tenant.get("country")),
            "total": gross_from_price(amount + extras["total"], inc_vat, tenant.get("country"))}}
    amount = gross_from_price(amount + extras["total"], inc_vat, tenant.get("country"))
    bp = tenant.get("billing_profile") or {}
    email = bp.get("email") or bp.get("billing_email") or ""
    name = bp.get("name") or tenant.get("name") or tenant_id
    pending = {"plan": package_code, "billing_cycle": billing_cycle, "amount": amount, "provider": provider}
    if coupon:
        pending["coupon"] = coupon["code"]
    if provider == "revolut":
        # ίδια εμπειρία με τη Viva: ανακατεύθυνση σε σελίδα πληρωμής → επιστροφή στην εφαρμογή
        order = await rv.create_renewal_order(
            amount=amount, currency=sub.get("currency", CURRENCY), email=email, name=name,
            tenant_id=tenant_id, description=f"RxVision ανανέωση {billing_cycle} — {name}"[:1024],
            redirect_url=RENEWAL_RETURN_URL)
        if not order.get("ok"):
            return {"ok": False, "error": order.get("error", "revolut_error")}
        pending["order_id"] = order["order_id"]
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {"pending_renewal": pending}})
        return {"ok": True, "checkout_url": order["checkout_url"], "amount_cents": amount,
                "discount_pct": (coupon or {}).get("discount_pct"), "provider": "revolut"}
    order = await viva_service.create_checkout_order(
        amount=amount, ref=f"renew:{tenant_id}",
        description=f"RxVision ανανέωση {billing_cycle} — {name}"[:2048],
        email=email, full_name=name, allow_recurring=True)
    if not order.get("ok"):
        return {"ok": False, "error": order.get("error", "viva_error")}
    # ο κωδικός παραγγελίας της ΑΝΑΝΕΩΣΗΣ ζει ΜΕΣΑ στο pending_renewal: το `viva_order_code` της συνδρομής
    # το γράφει και η αποθήκευση κάρτας (0,10 €) — έτσι μια επαλήθευση κάρτας περάστηκε ως ανανέωση (02/10/2026)
    pending["order_code"] = order.get("order_code")
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
        "pending_renewal": pending, "viva_order_code": order.get("order_code")}})
    return {"ok": True, "checkout_url": order["checkout_url"], "amount_cents": amount,
            "discount_pct": (coupon or {}).get("discount_pct")}


def seats_for_package(pkg: dict | None, *, current: int | None = None,
                      requested: int | None = None, prev_pkg: dict | None = None) -> int:
    """Πόσους ταυτόχρονους χρήστες δικαιούται μια συνδρομή σε ΑΥΤΟ το πακέτο.

    ΜΙΑ πηγή αλήθειας για ΟΛΕΣ τις διαδρομές (εγγραφή, ανανέωση, αναβάθμιση, ανάθεση από
    adminpanel). ΓΙΑΤΙ: ο κανόνας ήταν γραμμένος ξεχωριστά σε 6 σημεία και είχε αποκλίνει — άλλα
    ξεκινούσαν από 1 κι άλλα από τους περιλαμβανόμενους, με αποτέλεσμα πελάτης να πληρώνει πακέτο
    με 6 χρήστες και να έχει 1.

    Κανόνας: **ποτέ λιγότεροι από όσους περιλαμβάνει το πακέτο** (τους πληρώνει μέσα στην τιμή),
    και ό,τι παραπάνω έχει ζητήσει/είχε ήδη διατηρείται. Κανένα εμπορικό πλαφόν — μόνο φράχτης
    κατά παραλόγου input.

    ΑΛΛΑΓΗ ΠΑΚΕΤΟΥ (`prev_pkg` = το παλιό): μεταφέρονται ΜΟΝΟ οι θέσεις που ο πελάτης ΑΓΟΡΑΣΕ πέρα από
    όσες περιλάμβανε το παλιό πακέτο — όχι όσες ήταν μέσα στην τιμή του. Πριν (12/10/2026): Κολέλης
    Advanced (6 μέσα) → Growth (3 μέσα) κράτησε 6 και πλήρωνε 3 «επιπλέον» που δεν ζήτησε ποτέ.
    """
    included = int((pkg or {}).get("included_users") or 1)
    if requested:
        want = requested
    elif prev_pkg is not None and (prev_pkg or {}).get("_id") != (pkg or {}).get("_id"):
        bought = max(0, int(current or 0) - int((prev_pkg or {}).get("included_users") or 1))
        want = included + bought
    else:
        want = current or included
    return max(included, min(999, int(want or included)))


def includes_vat(pkg: dict | None, sub: dict | None) -> bool:
    """Η τιμή περιλαμβάνει ήδη ΦΠΑ; ΕΝΑΣ κανόνας για κάθε χρέωση: η σημαία του ΤΡΕΧΟΝΤΟΣ πακέτου·
    μόνο χωρίς πακέτο, η αποθηκευμένη της συνδρομής. Πριν: χρήστες/πρόσθετα έκαναν «πακέτο Ή συνδρομή»,
    η ανανέωση «πακέτο αλλιώς συνδρομή» → σε διαφωνία, άλλη χρέωση με ΦΠΑ κι άλλη χωρίς (01/10/2026)."""
    if pkg:
        return bool(pkg.get("price_includes_vat"))
    return bool((sub or {}).get("price_includes_vat"))


# Καταστάσεις που ΤΙΜΟΛΟΓΟΥΝΤΑΙ (πραγματικό επαναλαμβανόμενο έσοδο)
BILLED_STATES = ("active", "past_due")


def monthly_value(sub: dict | None) -> int:
    """Μηνιαίο επαναλαμβανόμενο έσοδο (καθαρό, cents) ΜΙΑΣ συνδρομής — ΕΝΑΣ ορισμός για κάθε MRR του
    adminpanel. Πριν (6 σημεία): `τιμή × limits.pharmacies` — όπου το `limits.pharmacies` είναι στην πράξη
    οι ΘΕΣΕΙΣ χρηστών (×4 για πελάτη με 4 χρήστες) και η τιμή ετήσιου πελάτη είναι η ΕΤΗΣΙΑ (×12)."""
    sub = sub or {}
    if sub.get("complimentary"):
        return 0
    total = (int(sub.get("price_per_pharmacy") or 0) + int(sub.get("addons_total") or 0)
             + int(sub.get("sla_price") or 0))
    return round(total / 12) if sub.get("billing_cycle") == "yearly" else total


async def recurring_extras(db, sub: dict, pkg: dict | None, yearly: bool) -> dict:
    """ΤΙ ΕΠΑΝΑΛΑΜΒΑΝΕΤΑΙ πέρα από την τιμή του πακέτου — ΕΝΑΣ υπολογισμός για την αυτόματη χρέωση,
    τη χειροκίνητη ανανέωση, το `addons_total` και την ένδειξη ποσού (01/10/2026).

    Πριν: η αυτόματη χρέωση διάβαζε ένα `addons_total` που η εγγραφή αποθήκευε ΧΩΡΙΣ τους έξτρα
    χρήστες, το SLA δεν ξαναχρεωνόταν ποτέ, και η χειροκίνητη ανανέωση χρέωνε ΜΟΝΟ το πακέτο — ενώ
    η σελίδα χρηστών λέει στον πελάτη «+€/έτος στην ανανέωση».

    Πρόσθετα που ΠΕΡΙΛΑΜΒΑΝΕΙ ήδη το πακέτο δεν χρεώνονται ξανά. Τιμές για τον ζητούμενο κύκλο."""
    from app.services.data_retention import retention_surcharge_monthly
    from app.services.seats_service import _included, _seat_price
    in_plan = set((pkg or {}).get("modules") or [])
    ids = [a for a in (sub.get("addons") or []) if a not in in_plan]
    addons = 0
    lines: list[dict] = []          # αναλυτικά (ίδια ποσά) — για την καρτέλα πελάτη στο adminpanel
    if ids:
        async for a in db["addons"].find({"_id": {"$in": ids}}):
            amt = int(a.get("price_yearly" if yearly else "price_monthly", 0) or 0)
            addons += amt
            lines.append({"kind": "addon", "label": f"Πρόσθετο: {a.get('name') or a['_id']}", "amount": amt})
    monthly_ret = await retention_surcharge_monthly(db, sub.get("tenant_id"))
    retention = monthly_ret * 12 if yearly else monthly_ret
    if retention:
        lines.append({"kind": "retention", "label": "Επέκταση διατήρησης δεδομένων", "amount": retention})
    # προεπισκόπηση ΑΛΛΟΥ πακέτου (ανανέωση με αλλαγή): ίδιος κανόνας μεταφοράς θέσεων με την εφαρμογή
    prev = (await db["packages"].find_one({"_id": sub.get("plan")})
            if sub.get("plan") and pkg and sub.get("plan") != pkg.get("_id") else None)
    extra_users = max(0, seats_for_package(pkg, current=sub.get("seats"), prev_pkg=prev) - _included(pkg))
    seats = extra_users * _seat_price(pkg, sub, yearly)
    if extra_users:
        lines.append({"kind": "seats", "label": f"Επιπλέον χρήστες: {extra_users} × {_seat_price(pkg, sub, yearly) / 100:.2f} €"
                      f" (το πακέτο περιλαμβάνει {_included(pkg)})", "amount": seats})
    sla = 0
    if sub.get("sla"):
        tier = await db["sla_tiers"].find_one({"_id": sub["sla"]}) or {}
        sla = int(tier.get("price_yearly" if yearly else "price_monthly", 0) or 0)
        if sla:
            lines.append({"kind": "sla", "label": f"SLA: {tier.get('name') or sub['sla']}", "amount": sla})
    return {"addons": addons, "retention": retention, "seats": seats, "extra_users": extra_users,
            "sla": sla, "total": addons + retention + seats + sla, "lines": lines}


async def next_charge(db, sub: dict) -> dict:
    """Η ΕΠΟΜΕΝΗ χρέωση μιας συνδρομής, αναλυτικά — ΑΚΡΙΒΩΣ όπως θα τη χρεώσει το `bill_due`
    (τιμή πακέτου της συνδρομής + recurring_extras, ΦΠΑ με includes_vat). Για την καρτέλα πελάτη."""
    from app.services.invoice_service import gross_from_price
    pkg = await db["packages"].find_one({"_id": sub.get("plan")}) if sub.get("plan") else None
    yearly = sub.get("billing_cycle") == "yearly"
    ex = await recurring_extras(db, sub, pkg, yearly)
    base = int(sub.get("price_per_pharmacy", 0) or 0)
    lines = [{"kind": "package", "label": f"Πακέτο {(pkg or {}).get('name') or sub.get('plan_name') or sub.get('plan') or ''}"
              f" ({'ετήσια' if yearly else 'μηνιαία'})", "amount": base}] + ex["lines"]
    net = base + ex["total"]
    country = ((await db["tenants"].find_one({"_id": sub.get("tenant_id")}, {"country": 1})) or {}).get("country")
    gross = 0 if sub.get("complimentary") else gross_from_price(net, includes_vat(pkg, sub), country)
    return {"lines": lines, "net": net, "vat": max(0, gross - net) if gross else 0, "gross": gross,
            "includes_vat": includes_vat(pkg, sub),
            "complimentary": bool(sub.get("complimentary")), "billing_cycle": "yearly" if yearly else "monthly",
            "date": sub.get("current_period_end"), "addons": sub.get("addons") or []}


async def complete_renewal(tenant_id: str, viva_transaction_id: str, provider: str = "viva") -> None:
    """Webhook/reconcile ανανέωσης → ενεργοποιεί τη συνδρομή με το επιλεγμένο πακέτο (idempotent).
    `viva_transaction_id` = η αναφορά πληρωμής του παρόχου (Viva TransactionId ή Revolut order id)."""
    db = shared_db()
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id})
    if not sub:
        return
    pr = sub.get("pending_renewal") or {}
    # FAIL-CLOSED: η συναλλαγή ΠΡΕΠΕΙ να είναι ολοκληρωμένη ανανέωση ΑΥΤΟΥ του φαρμακείου, με τουλάχιστον το
    # ποσό της ανανέωσης (viva_service.verify_payment). Αλλιώς ΤΙΠΟΤΑ — ούτε επέκταση ούτε παραστατικό.
    # Περιστατικό 29/09/2026: επαλήθευση κάρτας 0,10 € έγινε «ανανέωση 110,36 €» + παραστατικό + μήνας δωρεάν.
    if provider == "revolut":
        # ΜΟΝΟ η παραγγελία ΑΥΤΗΣ της ανανέωσης (όχι π.χ. αποθήκευση κάρτας του ίδιου φαρμακείου)
        if not pr or pr.get("provider") != "revolut" or str(pr.get("order_id")) != str(viva_transaction_id):
            return
        v = await rv.verify_payment(str(viva_transaction_id), reference=tenant_id,
                                    expected_cents=int(pr.get("amount") or 1))
    else:
        v = await viva_service.verify_payment(str(viva_transaction_id), merchant_trns=f"renew:{tenant_id}",
                                              expected_cents=int(pr.get("amount") or 1))
    if not v["ok"]:
        await payment_rejected("ανανέωση", tenant_id, v, int(pr.get("amount") or 0), provider=provider)
        return
    plan = pr.get("plan") or sub.get("plan")
    cycle = pr.get("billing_cycle") or sub.get("billing_cycle") or "yearly"
    pkg = await db["packages"].find_one({"_id": plan}) or {}
    prev_pkg = (await db["packages"].find_one({"_id": sub.get("plan")}) or {}) if sub.get("plan") else None
    yearly = cycle == "yearly"
    price = int(pkg.get("price_yearly" if yearly else "price_monthly", 0) or 0)
    now = _now()
    # Επέκταση: αν η τρέχουσα λήξη είναι ΜΕΛΛΟΝΤΙΚΗ (προληπτική ανανέωση), συνεχίζουμε ΑΠΟ ΕΚΕΙ ώστε ο
    # πελάτης να ΜΗ χάσει τις υπόλοιπες μέρες· αν έχει λήξει, ξεκινά από τώρα.
    cur_end = sub.get("current_period_end")
    base = cur_end if (cur_end and cur_end > now) else now
    # Κλειδωμένη για ΑΠΛΗΡΩΤΟ (lock_unpaid): η περίοδος ξεκινά από την ημερομηνία που ΕΠΡΕΠΕ να είχε πληρωθεί
    if sub.get("unpaid_since"):
        base = sub["unpaid_since"]
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {
        "$set": {"status": "active", "plan": plan, "plan_name": pkg.get("name"),
                 # Οι χρήστες του ΝΕΟΥ πακέτου: τουλάχιστον όσους περιλαμβάνει (ο πελάτης τους πληρώνει
                 # μέσα στην τιμή), ή όσους είχε ήδη αν ήταν περισσότεροι. Χωρίς αυτό, όποιος ερχόταν
                 # από δοκιμή έμενε με 1 χρήστη ενώ πλήρωνε πακέτο με 6.
                 "seats": seats_for_package(pkg, current=sub.get("seats"), prev_pkg=prev_pkg),
                 "billing_cycle": cycle, "price_per_pharmacy": price,
                 "price_includes_vat": bool(pkg.get("price_includes_vat")),
                 "modules_included": pkg.get("modules", sub.get("modules_included", [])),
                 "current_period_end": base + (timedelta(days=365) if yearly else timedelta(days=30)),
                 "started_at": base, "payment_provider": provider, "payment_status": "card_saved",
                 # η πληρωμή αποθήκευσε και την κάρτα → από εδώ και πέρα αυτόματες χρεώσεις στον ίδιο πάροχο
                 **({"revolut_customer_id": v["customer_id"]} if provider == "revolut" and v.get("customer_id")
                    else {} if provider == "revolut" else {"viva_transaction_id": viva_transaction_id}),
                 "failed_attempts": 0},
        "$unset": {"pending_renewal": "", "unpaid_since": "", "unpaid_amount": "", "unpaid_reason": "",
                   "lock_message": ""}})
    await db["tenants"].update_one({"_id": tenant_id}, {"$set": {"status": "active"}})
    from app.services import addon_service     # MRR/επόμενη χρέωση = ίδιος υπολογισμός με τη χρέωση
    await addon_service._recompute_total(tenant_id)
    if pr.get("coupon"):     # εξαργύρωσε το coupon (single-use)
        from app.services import feedback_service
        await feedback_service.redeem_coupon(pr["coupon"])
    # Παραστατικό ανανέωσης — πραγματικό χρεωμένο ποσό (με τυχόν coupon), αλλιώς τιμή πακέτου.
    from app.services import invoice_service
    await invoice_service.create_for_payment(
        tenant_id=tenant_id, kind="renewal",
        gross_cents=int(pr.get("amount") or price or 0),
        description=(f"Συνδρομή RxVision «{pkg.get('name') or plan}» ({invoice_service.cycle_el(cycle)}) — "
                     f"περίοδος {invoice_service.fmt_d(base)} έως "
                     f"{invoice_service.fmt_d(base + (timedelta(days=365) if yearly else timedelta(days=30)))}"),
        payment={"method": "card", "provider": provider, "transaction_id": viva_transaction_id})


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


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else (v or None)


def _days_left(sub: dict) -> int | None:
    """Μέρες μέχρι τη λήξη (trial → trial_ends_at, αλλιώς current_period_end). <0 = ληγμένη.
    Δωρεάν πελάτης → None (δεν λήγει· αλλιώς το banner έδειχνε αρνητικές μέρες)."""
    if sub.get("complimentary"):
        return None
    end = (sub.get("trial_ends_at") if (sub.get("status") in ("trial", "trialing")) else None) \
        or sub.get("current_period_end")
    if not end:
        return None
    return (end.date() - _now().date()).days


async def status(tenant_id: str) -> dict:
    sub = await shared_db()["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    return {
        "plan": sub.get("plan"), "status": sub.get("status"),
        # ΜΙΑ ενοποιημένη κατάσταση + μέρες μέχρι λήξη → για in-app banner ανανέωσης
        "effective_status": effective_status(sub) if sub else "none",
        "days_to_expiry": _days_left(sub) if sub else None,
        "billing_cycle": sub.get("billing_cycle"),
        "payment_status": sub.get("payment_status", "trial"),
        "trial_ends_at": _iso(sub.get("trial_ends_at")),
        "current_period_end": _iso(sub.get("current_period_end")),
        "amount": (int(sub.get("price_per_pharmacy", 0) or 0) + int(sub.get("addons_total", 0) or 0)
                   + int(sub.get("sla_price", 0) or 0)),
        "base_amount": int(sub.get("price_per_pharmacy", 0) or 0),
        "addons_total": int(sub.get("addons_total", 0) or 0),
        "currency": sub.get("currency", CURRENCY),
        "card_on_file": (sub.get("payment_status") in CARD_ON_FILE_STATES
                         and bool(sub.get("revolut_customer_id") or sub.get("viva_transaction_id"))),
        "complimentary": bool(sub.get("complimentary")),   # δωρεάν πελάτης → δεν χρειάζεται κάρτα
        "lock_message": sub.get("lock_message"),           # απλήρωτη → «Η πληρωμή σας δεν πέρασε…»
        "payment_provider": sub.get("payment_provider") or await active_provider(),
        "revolut_configured": await rv.is_configured(),
        "viva_configured": await viva_service.is_configured(),
    }


UNPAID_MESSAGE = ("Η πληρωμή σας δεν επιβεβαιώθηκε από τον πάροχο πληρωμών {provider}. "
                  "Παρακαλώ, κάντε ξανά τη διαδικασία πληρωμής.")
_PROVIDER_NAME = {"viva": "Viva", "revolut": "Revolut"}


def unpaid_message(sub: dict, due_from: datetime, amount: int = 0) -> str:
    """Το μήνυμα προς τον πελάτη για απλήρωτη συνδρομή — ΗΡΕΜΟ, χωρίς υπονοούμενα (οδηγία ιδιοκτήτη 02/10/2026):
    ποια περίοδος, πότε έπρεπε να γίνει η πληρωμή, πακέτο/ποσό, και ότι δεν χάνει τίποτα."""
    yearly = sub.get("billing_cycle") == "yearly"
    end = due_from + (timedelta(days=365) if yearly else timedelta(days=30))
    pkg = sub.get("plan_name") or sub.get("plan") or ""
    what = f"{pkg}, {'ετήσια' if yearly else 'μηνιαία'}" + (f", {amount / 100:.2f} €".replace(".", ",") if amount else "")
    return (f"Κάτι πήγε στραβά με την πληρωμή της συνδρομής σας για την περίοδο "
            f"{due_from.strftime('%d/%m/%Y')} – {end.strftime('%d/%m/%Y')} ({what}), "
            f"που ήταν προγραμματισμένη για {due_from.strftime('%d/%m/%Y')}. "
            f"{UNPAID_MESSAGE.format(provider=_PROVIDER_NAME.get(sub.get('payment_provider') or 'viva', 'Viva'))} Δεν χρειάζεται να ανησυχείτε: μόλις ολοκληρωθεί, η συνδρομή σας συνεχίζει "
            f"κανονικά από {due_from.strftime('%d/%m/%Y')}, χωρίς να χάσετε καμία ημέρα ή κανένα δεδομένο.")


async def lock_unpaid(tenant_id: str, *, due_from: datetime, amount: int = 0, reason: str = "") -> bool:
    """ΑΠΛΗΡΩΤΗ συνδρομή → ΚΛΕΙΔΩΜΑ + αίτημα επαναπληρωμής (απόφαση ιδιοκτήτη 02/10/2026). ΕΝΑΣ ορισμός για:
    αποτυχημένη αυτόματη χρέωση (bill_due) και «πληρωμένο» παραστατικό που η Viva δεν επιβεβαιώνει (νυχτερινός).
    • `due_from` = η ημερομηνία που ΕΠΡΕΠΕ να είχαμε πληρωθεί· η νέα περίοδος μετά την πληρωμή ξεκινά ΑΠΟ ΕΚΕΙ
      (complete_renewal), όχι από την ημέρα πληρωμής.
    • ο πελάτης βλέπει UNPAID_MESSAGE (σύνδεση + banner) και παίρνει email· ο ιδιοκτήτης ειδοποίηση.
    Idempotent: ήδη κλειδωμένη για απλήρωτο → τίποτα."""
    db = shared_db()
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    if not sub or sub.get("complimentary") or sub.get("unpaid_since"):
        return False
    now = _now()
    if due_from.tzinfo is None:
        due_from = due_from.replace(tzinfo=timezone.utc)
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
        "status": "expired", "payment_status": "payment_failed", "expired_at": now,
        "current_period_end": min(due_from, now),           # ≤ τώρα → effective_status = expired → κλείδωμα
        "unpaid_since": due_from, "unpaid_amount": int(amount or 0), "unpaid_reason": reason[:300],
        "lock_message": unpaid_message(sub, due_from, amount)}, "$unset": {"pending_renewal": ""}})
    logger.warning("ΚΛΕΙΔΩΜΑ απλήρωτης συνδρομής %s από %s (%s)", tenant_id, due_from.date(), reason)
    tenant = await db["tenants"].find_one({"_id": tenant_id}) or {}
    try:
        from app.services import mailer
        email = await _billing_email(db, tenant_id, tenant)
        if email:
            await mailer.send_email(
                email, "RxVision — Χρειάζεται να επαναλάβετε την πληρωμή της συνδρομής σας",
                f"<p>Καλησπέρα σας,</p><p>{unpaid_message(sub, due_from, amount)}</p>"
                f"<p>Συνδεθείτε στο <a href='https://app.rxvision.gr/login'>RxVision</a> με τα ίδια στοιχεία· "
                f"θα σας εμφανιστεί αμέσως η οθόνη πληρωμής.</p><p>Ευχαριστούμε,<br>Η ομάδα του RxVision</p>")
    except Exception:  # noqa: BLE001
        logger.exception("lock_unpaid: email απέτυχε %s", tenant_id)
    try:
        from app.services.comms import admin_alert
        await admin_alert(f"🔒 RxVision: κλειδώθηκε η συνδρομή του {tenant.get('name') or tenant_id} — "
                          f"απλήρωτη από {due_from.strftime('%d/%m/%Y')} ({int(amount or 0)/100:.2f} €). {reason}"[:600])
    except Exception:  # noqa: BLE001
        pass
    return True


async def lock_for_unverified_invoice(inv: dict) -> bool:
    """Παραστατικό ανανέωσης/συνδρομής που η Viva ΔΕΝ επιβεβαιώνει, ενώ η συνδρομή επεκτάθηκε βάσει αυτού →
    κλείδωμα από την αρχή της περιόδου που (δεν) πλήρωσε. Μόνο για το ΤΕΛΕΥΤΑΙΟ τέτοιο παραστατικό."""
    if inv.get("kind") not in ("renewal", "subscription"):
        return False
    db = shared_db()
    tid = inv.get("tenant_id")
    last = await db["invoices"].find_one({"tenant_id": tid, "kind": {"$in": ["renewal", "subscription"]}},
                                         sort=[("created_at", -1)])
    if not last or last["_id"] != inv["_id"]:
        return False
    sub = await db["subscriptions"].find_one({"tenant_id": tid}) or {}
    end = sub.get("current_period_end")
    if not end or effective_status(sub) not in ("active", "past_due"):
        return False
    yearly = (sub.get("billing_cycle") or inv.get("billing_cycle")) == "yearly"
    due = end - (timedelta(days=365) if yearly else timedelta(days=30))
    return await lock_unpaid(tid, due_from=due, amount=int(inv.get("total") or 0),
                             reason=f"Η Viva δεν επιβεβαιώνει την πληρωμή του {inv.get('softone_number') or inv.get('full_number') or ''}")


async def payment_rejected(what: str, tenant_id: str, v: dict, expected: int = 0,
                           provider: str = "viva") -> None:
    """Ο πάροχος (Viva/Revolut) ΔΕΝ επιβεβαίωσε την πληρωμή → log + ειδοποίηση ιδιοκτήτη (καμία ενέργεια)."""
    name = _PROVIDER_NAME.get(provider, provider)
    _why = {"not_found": f"δεν βρέθηκε στη {name}", "not_finished": "δεν ολοκληρώθηκε",
            "other_payment": "αφορά άλλη πληρωμή", "other_order": "αφορά άλλη παραγγελία",
            "amount_short": "μικρότερο ποσό", "no_transaction": "χωρίς συναλλαγή", "failed": "απορρίφθηκε"}
    logger.warning("%s πληρωμή ΑΠΟΡΡΙΦΘΗΚΕ (%s) %s: %s", name, what, tenant_id, v)
    try:
        from app.services.comms import admin_alert
        await admin_alert(
            f"⚠️ RxVision: απορρίφθηκε {what} για {tenant_id} — η {name} δεν επιβεβαιώνει πληρωμή "
            f"({_why.get(v.get('reason') or '', v.get('reason'))}· πληρώθηκαν {int(v.get('amount_cents') or 0)/100:.2f} €"
            f"{f', αναμενόμενα {expected/100:.2f} €' if expected else ''}· συναλλαγή {v.get('transaction_id') or '—'}).")
    except Exception:  # noqa: BLE001
        pass


async def _charge_recurring(sub: dict, amount: int, tid: str) -> dict:
    """Off-session χρέωση ανανέωσης μέσω του παρόχου της συνδρομής (Revolut ή Viva)."""
    prov = sub.get("payment_provider") or "revolut"
    desc = f"RxVision {sub.get('billing_cycle', 'monthly')} renewal"
    if prov == "viva":
        if not sub.get("viva_transaction_id"):
            return {"ok": False, "error": "no_viva_transaction"}
        r = await viva_service.charge_recurring(
            original_transaction_id=sub["viva_transaction_id"], amount=amount, description=desc,
            merchant_trns=f"recurring:{tid}")
        if r.get("ok"):   # ΔΕΝ αρκεί το «ΟΚ» της απάντησης: η Viva πρέπει να δείχνει ΑΥΤΟ το ποσό εισπραγμένο
            v = await viva_service.verify_payment(r.get("transaction_id"), expected_cents=amount)
            if not v["ok"]:
                await payment_rejected("αυτόματη χρέωση", tid, v, amount)
                return {"ok": False, "error": f"viva_unverified:{v.get('reason')}", "provider": "viva"}
        else:
            logger.warning("Viva αυτόματη χρέωση απέτυχε %s: %s", tid, r.get("error"))
        return {"ok": r.get("ok"), "order_id": r.get("transaction_id"), "provider": "viva",
                "error": r.get("error")}
    if not sub.get("revolut_customer_id"):
        return {"ok": False, "error": "no_revolut_customer"}
    r = await rv.charge_off_session(
        amount=amount, currency=sub.get("currency", CURRENCY),
        customer_id=sub["revolut_customer_id"], tenant_id=tid, description=desc)
    if not r.get("order_id"):
        return {"ok": False, "error": r.get("error") or f"revolut_{r.get('state') or 'error'}", "provider": "revolut"}
    # ΠΛΗΡΩΜΕΝΟ = ό,τι επιβεβαιώνει η ΙΔΙΑ η Revolut (ολοκληρωμένη, αυτό το ποσό, αυτό το φαρμακείο).
    # Πριν: «pending»/«authorised» μετρούσε ως επιτυχία → επέκταση + παραστατικό χωρίς είσπραξη.
    v = await settle_revolut_charge(r["order_id"], amount, tid)
    if v["ok"]:
        return {"ok": True, "order_id": r["order_id"], "provider": "revolut"}
    if v.get("reason") == "not_finished":
        return {"ok": False, "pending": True, "order_id": r["order_id"], "provider": "revolut",
                "error": "revolut_pending"}
    await payment_rejected("αυτόματη χρέωση", tid, v, amount, provider="revolut")
    return {"ok": False, "order_id": r["order_id"], "provider": "revolut",
            "error": f"revolut_unverified:{v.get('reason')}"}


async def settle_revolut_charge(order_id: str, amount: int, tid: str, *, tries: int = 6,
                                wait: float = 2.0) -> dict:
    """Ρωτά τη Revolut μέχρι η χρέωση να ΟΛΟΚΛΗΡΩΘΕΙ ή να ΑΠΟΤΥΧΕΙ (συνήθως σε δευτερόλεπτα).
    Αν μείνει σε εξέλιξη → reason=not_finished· ο καλών ΔΕΝ την ξαναχρεώνει (διπλή χρέωση)."""
    v: dict = {"ok": False, "reason": "not_finished"}
    for i in range(max(1, tries)):
        v = await rv.verify_payment(order_id, expected_cents=amount, reference=tid)
        if v.get("reason") != "not_finished":
            return v
        if i < tries - 1:
            await asyncio.sleep(wait)
    return v


async def bill_due() -> dict:
    """Χρεώνει τις συνδρομές που έληξαν. Αποτυχία (επιβεβαιωμένη από τον πάροχο) → ΑΜΕΣΟ κλείδωμα."""
    db = shared_db()
    if not await any_provider_configured():
        return {"skipped": "no_provider_configured"}
    now = _now()
    charged = failed = suspended = 0
    cur = db["subscriptions"].find({"$and": [  # tenant-ok: beat χρεώσεων — όλες οι συνδρομές
        {"status": {"$in": ["trial", "trialing", "active"]}},
        {"current_period_end": {"$lte": now}},
        {"$or": [{"revolut_customer_id": {"$ne": None}}, {"viva_transaction_id": {"$ne": None}}]},
        {"$or": [{"price_per_pharmacy": {"$gt": 0}}, {"addons_total": {"$gt": 0}}]},
    ]})
    async for sub in cur:
        tid = sub["tenant_id"]
        pc = sub.get("pending_charge") or {}
        if pc.get("order_id"):
            # Χρέωση Revolut που έμεινε «σε εξέλιξη»: ΔΕΝ ξαναχρεώνουμε — ρωτάμε πώς κατέληξε.
            v = await settle_revolut_charge(pc["order_id"], int(pc.get("amount") or 0), tid, tries=1)
            if v.get("reason") == "not_finished":
                continue
            await db["subscriptions"].update_one({"tenant_id": tid}, {"$unset": {"pending_charge": ""}})
            if v["ok"]:
                await _renewal_charged(db, sub, int(pc["amount"]), now,
                                       {"ok": True, "order_id": pc["order_id"], "provider": "revolut"})
                charged += 1
            else:
                await lock_unpaid(tid, due_from=sub["current_period_end"], amount=int(pc.get("amount") or 0),
                                  reason=f"Αποτυχία αυτόματης χρέωσης: revolut {v.get('reason')}")
                failed += 1
            continue
        if sub.get("complimentary"):     # δωρεάν πελάτης → καμία χρέωση/παραστατικό· κράτα ζωντανή την περίοδο
            await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
                "current_period_end": _period_end(sub.get("billing_cycle", "monthly"), now),
                "payment_status": "complimentary"}})
            continue
        # full recurring amount = πακέτο + ό,τι επαναλαμβάνεται (recurring_extras: πρόσθετα, έξτρα
        # χρήστες, διατήρηση, SLA) — ΦΡΕΣΚΟ, όχι το αποθηκευμένο addons_total (καθαρά) → +ΦΠΑ
        _rpkg = await db["packages"].find_one({"_id": sub.get("plan")}) if sub.get("plan") else None
        _ex = await recurring_extras(db, sub, _rpkg, sub.get("billing_cycle") == "yearly")
        net_total = int(sub.get("price_per_pharmacy", 0) or 0) + _ex["total"]
        if net_total <= 0:
            continue
        from app.services import invoice_service
        tcountry = (await db["tenants"].find_one({"_id": tid}, {"country": 1}) or {}).get("country")
        # flag από το τρέχον πακέτο (single source)· fallback στο αποθηκευμένο της συνδρομής
        _pkg = await db["packages"].find_one({"_id": sub.get("plan")}, {"price_includes_vat": 1}) if sub.get("plan") else None
        _inc_vat = includes_vat(_pkg, sub)
        amount = invoice_service.gross_from_price(net_total, _inc_vat, tcountry)
        res = await _charge_recurring(sub, amount, tid)
        if res.get("ok"):
            await _renewal_charged(db, sub, amount, now, res)
            charged += 1
        elif res.get("pending"):
            # η Revolut δεν έχει αποφανθεί ακόμη: ούτε επέκταση ούτε κλείδωμα — το επόμενο πέρασμα ρωτά ξανά
            await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {"pending_charge": {
                "provider": "revolut", "order_id": res["order_id"], "amount": amount, "at": now}}})
        else:
            # Απόφαση ιδιοκτήτη 02/10/2026: επιτυχία = σιωπή· αποτυχία = ΑΜΕΣΟ κλείδωμα + «πληρώστε ξανά»
            # (χωρίς περιθώριο/επαναπροσπάθειες). Η νέα περίοδος θα ξεκινήσει από τη λήξη που δεν πληρώθηκε.
            await lock_unpaid(tid, due_from=sub["current_period_end"], amount=amount,
                              reason=f"Αποτυχία αυτόματης χρέωσης: {res.get('error') or 'άγνωστο'}")
            failed += 1
    return {"charged": charged, "failed": failed, "suspended": suspended}


async def _renewal_charged(db, sub: dict, amount: int, now: datetime, res: dict) -> None:
    """ΕΠΙΒΕΒΑΙΩΜΕΝΗ αυτόματη χρέωση ανανέωσης → νέα περίοδος + απόδειξη + παραστατικό."""
    tid = sub["tenant_id"]
    cycle = sub.get("billing_cycle", "monthly")
    await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
        "status": "active", "payment_status": "active", "failed_attempts": 0,
        "current_period_end": _period_end(cycle, now), "last_charged_at": now}})
    from app.services import invoice_service, receipts
    await receipts.record(tid, "subscription", f"Συνδρομή {sub.get('plan', '')} ({cycle})",
                          amount, method="card", provider=res.get("provider", "revolut"),
                          provider_order_id=res.get("order_id"))
    pkg = await db["packages"].find_one({"_id": sub.get("plan")}, {"name": 1}) if sub.get("plan") else None
    await invoice_service.create_for_payment(
        tenant_id=tid, kind="renewal", gross_cents=amount,
        description=(f"Συνδρομή RxVision «{sub.get('plan_name') or (pkg or {}).get('name') or sub.get('plan', '')}» "
                     f"({invoice_service.cycle_el(cycle)}) — περίοδος "
                     f"{invoice_service.fmt_d(now)} έως {invoice_service.fmt_d(_period_end(cycle, now))}"),
        payment={"method": "card", "provider": res.get("provider", "revolut"),
                 "transaction_id": res.get("order_id")})


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
    # δωρεάν πελάτες δεν χρεώνονται & δεν λήγουν ποτέ (χαρακτηρισμένοι στη συνδρομή)
    no_card = {"revolut_customer_id": None, "viva_transaction_id": None,
               "complimentary": {"$ne": True}}
    expired = graced = 0
    # 1) Δοκιμαστικές → λήξη άμεσα (grace 0 by default)
    async for sub in db["subscriptions"].find({  # tenant-ok: beat χρεώσεων — όλες οι συνδρομές
            "status": {"$in": ["trial", "trialing"]},
            "current_period_end": {"$lte": now - timedelta(days=trial_grace)}, **no_card}):
        await db["subscriptions"].update_one({"tenant_id": sub["tenant_id"]}, {"$set": {
            "status": "expired", "payment_status": "expired", "expired_at": now}})
        expired += 1
    # 2) Ενεργές → περιθώριο 10μ (past_due, κρατά πρόσβαση) → μετά expired
    async for sub in db["subscriptions"].find({  # tenant-ok: beat χρεώσεων — όλες οι συνδρομές
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


async def delete_tenant_fully(tenant_id: str) -> dict:
    """ΟΡΙΣΤΙΚΗ διαγραφή πελάτη + ΟΛΩΝ των tenant-scoped δεδομένων του. ΔΥΝΑΜΙΚΟ (future-proof): σαρώνει
    ΟΛΕΣ τις collections που φέρουν `tenant_id` — έτσι κάθε νέα collection καθαρίζεται αυτόματα, χωρίς να
    ξεχνιέται (πριν, στατική λίστα άφηνε ορφανά: amount_audit_log 44k, vaccinations, pharmacat, loyalty…).
    Καθαρίζει και GridFS σαρώσεις + tenant_serving. Επιστρέφει τι διαγράφηκε."""
    # GUARD (blast-radius): κενό/άκυρο tenant_id θα σάρωνε ΟΛΕΣ τις collections με
    # delete_many({"tenant_id": ""/None}) και θα έσβηνε μαζικά shared/platform docs (που έχουν tenant_id
    # null/απόν). Απαίτησε έγκυρο ΜΗ-ΚΕΝΟ string — ένα κανονικό tenant_id (π.χ. "T-XXXX") ταιριάζει ΜΟΝΟ
    # τα δικά του docs. (Δεν απαιτούμε ύπαρξη tenant doc: το purge_orphan_data καθαρίζει νόμιμα ορφανά.)
    if not tenant_id or not isinstance(tenant_id, str) or not tenant_id.strip():
        raise ValueError("delete_tenant_fully: κενό/άκυρο tenant_id — άρνηση (blast-radius guard)")
    db = shared_db()
    removed: dict = {}
    for c in await db.list_collection_names():
        if c.startswith("system.") or c.startswith("scans."):   # system + GridFS chunks (χειρίζονται χωριστά)
            continue
        try:
            r = await db[c].delete_many({"tenant_id": tenant_id})
            if r.deleted_count:
                removed[c] = r.deleted_count
        except Exception:  # noqa: BLE001 — π.χ. views/capped/shared collections
            continue
    # GridFS σαρώσεις (metadata.tenant_id) — σβήνει files + chunks
    try:
        from motor.motor_asyncio import AsyncIOMotorGridFSBucket
        bucket = AsyncIOMotorGridFSBucket(db, bucket_name="scans")
        n_files = 0
        async for f in db["scans.files"].find({"metadata.tenant_id": tenant_id}, {"_id": 1}):
            try:
                await bucket.delete(f["_id"]); n_files += 1
            except Exception:  # noqa: BLE001
                pass
        if n_files:
            removed["scans(GridFS)"] = n_files
    except Exception:  # noqa: BLE001
        pass
    # Vault secrets (ΗΔΥΚΑ/ΓΕΣΥ creds + pepper) — «υποδομή» εκτός Mongo· να μη μένει τίποτα.
    try:
        from app.services.vault_service import vault
        cleaned = vault.delete_tenant_secrets(tenant_id)
        if cleaned:
            removed["vault_secrets"] = len(cleaned)
    except Exception:  # noqa: BLE001 — Vault degraded δεν πρέπει να μπλοκάρει τη διαγραφή
        pass
    # tenant_serving (keyed by _id) + ο ίδιος ο tenant
    r = await db["tenant_serving"].delete_one({"_id": tenant_id})
    if r.deleted_count:
        removed["tenant_serving"] = r.deleted_count
    await db["tenants"].delete_one({"_id": tenant_id})
    return removed


#: Ώρα της νυχτερινής διαγραφής (celery beat `purge-expired-trials`: 05:45 UTC).
PURGE_RUN_UTC = (5, 45)
_TRIAL_PLANS = ("trial", "free_trial", None)


def purge_plan(sub: dict | None, cfg: dict, now: datetime | None = None) -> dict | None:
    """ΠΟΤΕ διαγράφεται αυτός ο λογαριασμός — ή ΤΙ τον προστατεύει. None = δεν είναι δοκιμαστικός.

    ΜΙΑ πηγή αλήθειας: το ίδιο κριτήριο εφαρμόζει και το `purge_expired_trials` (το Mongo ερώτημά
    του είναι απλώς προ-φίλτρο ταχύτητας). Αλλιώς η λίστα Πελατών θα μπορούσε να δείχνει ημερομηνία
    που δεν θα συμβεί ποτέ — ή να μη δείχνει μια που θα συμβεί αύριο το πρωί.

    → {"at": ώρα διαγραφής (η πρώτη νυχτερινή εκτέλεση μετά τη λήξη + N ημέρες), "days": ημέρες ως
       τότε, "protected": λόγος που ΔΕΝ διαγράφεται ή None, "enabled": αν η διαγραφή είναι ενεργή}"""
    if not sub or sub.get("plan") not in _TRIAL_PLANS:
        return None
    now = now or _now()
    protected = None
    if sub.get("complimentary") is True:
        protected = "complimentary"
    elif sub.get("revolut_customer_id") is not None or sub.get("viva_transaction_id") is not None:
        protected = "card"
    elif sub.get("status") not in ("expired", "trial", "trialing"):
        protected = "status"
    cpe = sub.get("current_period_end")
    if not isinstance(cpe, datetime):
        return {"at": None, "days": None, "protected": protected or "no_end_date",
                "enabled": cfg["purge_enabled"]}
    if cpe.tzinfo is None:
        cpe = cpe.replace(tzinfo=timezone.utc)
    due = cpe + timedelta(days=cfg["purge_days"])
    run = due.replace(hour=PURGE_RUN_UTC[0], minute=PURGE_RUN_UTC[1], second=0, microsecond=0)
    if run < due:
        run += timedelta(days=1)
    if run < now:                       # έπρεπε ήδη να έχει γίνει → η ΕΠΟΜΕΝΗ εκτέλεση
        nxt = now.replace(hour=PURGE_RUN_UTC[0], minute=PURGE_RUN_UTC[1], second=0, microsecond=0)
        run = nxt if nxt >= now else nxt + timedelta(days=1)
    return {"at": run, "days": max(0, (run.date() - now.date()).days),
            "protected": protected, "enabled": cfg["purge_enabled"]}


async def purge_expired_trials(*, dry_run: bool = False) -> dict:
    """ΔΟΚΙΜΑΣΤΙΚΕΣ συνδρομές που έληξαν >N ημέρες (default 20) & δεν μετατράπηκαν → αρχειοθέτηση ΑΦΜ/
    επικοινωνίας στη βάση leads και ΔΙΑΓΡΑΦΗ του λογαριασμού. Δεν αγγίζει πληρωμένους/με κάρτα."""
    from app.services import trial_leads
    db = shared_db()
    cfg = await trial_leads.config(db)
    if not cfg["purge_enabled"] and not dry_run:
        return {"enabled": False, "purged": 0}
    cutoff = _now() - timedelta(days=cfg["purge_days"])
    no_card = {"revolut_customer_id": None, "viva_transaction_id": None, "complimentary": {"$ne": True}}
    q = {"plan": {"$in": ["trial", "free_trial", None]},
         "status": {"$in": ["expired", "trial", "trialing"]},
         "current_period_end": {"$lte": cutoff}, **no_card}
    # Το ερώτημα είναι ΠΡΟ-ΦΙΛΤΡΟ· η απόφαση είναι του `purge_plan` — ίδια με τη λίστα Πελατών.
    targets = [s["tenant_id"] async for s in db["subscriptions"].find(q)  # tenant-ok: σάρωση πλατφόρμας
               if (pp := purge_plan(s, cfg)) and not pp["protected"]]
    purged, archived = 0, []
    for tid in targets:
        if dry_run:
            continue                       # προεπισκόπηση: ΜΟΝΟ μέτρηση, καμία αλλαγή
        key = await trial_leads.archive_from_tenant(tid, db=db)   # 1ο αρχειοθέτηση (ΑΦΜ + επικοινωνία)
        archived.append(key)
        await delete_tenant_fully(tid)                            # 2ο διαγραφή λογαριασμού
        purged += 1
    return {"enabled": cfg["purge_enabled"], "purge_days": cfg["purge_days"],
            "candidates": len(targets), "purged": purged, "archived": [k for k in archived if k],
            "dry_run": dry_run}


async def purge_orphan_data(*, dry_run: bool = False, limit: int = 50) -> dict:
    """Self-healing «κλείσιμο» της διαγραφής: δεδομένα tenant που έμειναν ΧΩΡΙΣ tenants doc (ορφανά —
    υπόλειμμα παλιάς/μερικής διαγραφής) καθαρίζονται ΟΡΙΣΤΙΚΑ ώστε να μη μένει ΤΙΠΟΤΑ πίσω (GDPR + χώρος).

    ΑΣΦΑΛΕΙΑ: σβήνει tenant_id ΜΟΝΟ όταν δεν έχει tenants doc ΚΑΙ δεν έχει subscription ΚΑΙ δεν έχει users
    (δηλ. πλήρως εγκαταλελειμμένο). Αν βρεθεί orphan με subscription/users, ΔΕΝ το αγγίζει — αφήνεται για
    χειροκίνητο έλεγχο (μπορεί να είναι ενεργός πελάτης που έχασε μόνο το tenants doc)."""
    db = shared_db()
    active = {t["_id"] async for t in db["tenants"].find({}, {"_id": 1})}
    with_data = {t for t in await db["prescription_executions"].distinct("tenant_id") if t}
    orphans = sorted(with_data - active)
    purged: list[str] = []
    skipped: list[str] = []
    for tid in orphans[:limit]:
        has_sub = await db["subscriptions"].find_one({"tenant_id": tid}, {"_id": 1})
        has_users = await db["users"].find_one({"tenant_id": tid}, {"_id": 1})
        if has_sub or has_users:
            skipped.append(tid)
            continue
        if dry_run:
            purged.append(tid)
            continue
        removed = await delete_tenant_fully(tid)
        logger.info("purge_orphan_data cleaned orphan %s → %s", tid, removed)
        purged.append(tid)
    return {"orphans": len(orphans), "purged": purged, "skipped": skipped, "dry_run": dry_run}


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
    "warn_days": [30, 14, 7, 3, 1], "expired_max_days": 30,   # ειδοποίηση ΑΠΟ 1 μήνα πριν
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
    async for sub in db["subscriptions"].find({  # tenant-ok: beat χρεώσεων — όλες οι συνδρομές
            "status": {"$in": ["trial", "trialing", "active", "past_due", "expired"]},
            "complimentary": {"$ne": True},       # δωρεάν πελάτης: καμία «λήγει/έληξε» ειδοποίηση
            "current_period_end": {"$ne": None}}):
        pend = sub.get("current_period_end")
        if not pend:
            continue
        days = (pend.date() - now.date()).days      # >0 πριν, <=0 μετά
        # Παράθυρο υπενθύμισης ανά κύκλο: ΕΤΗΣΙΑ = τελευταίες 20 μέρες, ΜΗΝΙΑΙΑ (& trial/άλλο) = 5.
        # (Μην ειδοποιείς μηνιαίο πελάτη από τη 1η μέρα — το warn_day=30 = όλη η μηνιαία περίοδος.)
        win = 20 if sub.get("billing_cycle") == "yearly" else 5
        if not (((days in warn and days <= win) and sub.get("status") in ("trial", "trialing", "active"))
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
    # FAIL-CLOSED: re-fetch της συναλλαγής από το Viva (source of truth). Εμπιστευόμαστε ΜΟΝΟ το re-fetch,
    # ΟΧΙ το StatusId του payload (πλαστογραφήσιμο). Χωρίς επιτυχές fetch με StatusId="F" (Finished) →
    # σταματάμε (αλλιώς κενό/άγνωστο status περνούσε σαν επιτυχία → εγγραφή/ανανέωση/wallet χωρίς πληρωμή).
    # Δρομολόγηση με τα στοιχεία της ΙΔΙΑΣ της Viva (MerchantTrns/OrderCode του re-fetch), ΟΧΙ του payload.
    v = await viva_service.verify_payment(str(txn))
    if not v["ok"]:
        return
    paid = int(v["amount_cents"])
    mt0 = v["merchant_trns"]
    order_code = v["order_code"] or order_code
    # (0) signup «πληρωμή-πρώτα»: MerchantTrns = "signup:<pending_id>" → μαρκάρισε την pending ως paid
    #     (ο λογαριασμός δημιουργείται όταν ο πελάτης βάλει κωδικό στο /register-complete)
    if mt0.startswith("signup:"):
        from app.services.onboarding_service import OnboardingService
        await OnboardingService().mark_pending_paid(mt0[len("signup:"):], str(txn))
        return
    if mt0.startswith("renew:"):     # ανανέωση ληγμένης συνδρομής → ενεργοποίηση (επαληθεύει ποσό)
        await complete_renewal(mt0[len("renew:"):], str(txn))
        return
    if mt0.startswith("recurring:"):  # δική μας αυτόματη χρέωση — την έχει ήδη χειριστεί το bill_due
        return
    # (1) top-up μηνυμάτων Ή AI credits (order_code = viva order_code) → πίστωση ΜΟΝΟ αν πληρώθηκε η τιμή
    if order_code:
        from app.services import ai_credits, message_wallet
        if await ai_credits.complete_topup(order_code, paid_cents=paid):
            return
        if await message_wallet.complete_topup(order_code, paid_cents=paid):
            return
    # (2) συνδρομή: card-save + recurring seed. MerchantTrns = tenant_id (τα top-up έχουν "topup:"/"ai_topup:" → αγνόησε)
    mt = mt0
    tid = mt if (mt and not str(mt).startswith(("topup:", "ai_topup:"))) else None
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
    # ΜΟΝΟ αναβάθμιση που περιμένει πληρωμή VIVA και ΜΟΝΟ αν πληρώθηκε το ποσό της. Πριν: ΟΠΟΙΑΔΗΠΟΤΕ
    # συναλλαγή του φαρμακείου (π.χ. επαλήθευση κάρτας 0,10 €) εφάρμοζε ακόμη και αναβάθμιση Revolut.
    if pend.get("method") == "viva" and pend.get("status") == "awaiting_payment":
        need = int(pend.get("charge_amount", pend.get("new_price", 0)) or 0)
        if paid >= need > 0:
            await plan_change_service.apply_change(tid, source="viva")
        else:
            await payment_rejected("αναβάθμιση πακέτου", tid, {**v, "reason": "amount_short"}, need)


async def handle_webhook(event: str, order: dict) -> None:
    """Update billing state from a Revolut order webhook (reference = tenant_id)."""
    db = shared_db()
    tid = (order.get("merchant_order_data") or {}).get("reference")
    if not tid:
        return
    # Wallet top-up orders: credit the message wallet (idempotent) and stop — not a subscription event.
    if event == "ORDER_COMPLETED" and order.get("id"):
        from app.services import ai_credits, message_wallet
        # πίστωση ΜΟΝΟ για ολοκληρωμένη παραγγελία και με το ποσό που λέει η ΙΔΙΑ η Revolut (όπως στη Viva)
        if str(order.get("state") or "").lower() != "completed":
            return
        paid = rv.order_amount_cents(order)
        if await ai_credits.complete_topup(order["id"], paid_cents=paid):
            return
        if await message_wallet.complete_topup(order["id"], paid_cents=paid):
            return
        sub = await db["subscriptions"].find_one({"tenant_id": tid}) or {}
        # Ανανέωση πληρωμένη στη Revolut → complete_renewal (επαληθεύει ξανά από τη Revolut, ποσό & παραγγελία)
        pr = sub.get("pending_renewal") or {}
        if pr.get("provider") == "revolut" and str(pr.get("order_id")) == str(order["id"]):
            await complete_renewal(tid, str(order["id"]), provider="revolut")
            return
        # Δική μας αυτόματη χρέωση: την αποφασίζει ΜΟΝΟ το bill_due (με επαλήθευση) — όχι το webhook
        if str((sub.get("pending_charge") or {}).get("order_id")) == str(order["id"]):
            return
        # Plan-upgrade paid by card: apply the pending change when its Revolut order completes.
        pend = sub.get("pending_change") or {}
        if (pend.get("method") == "card" and pend.get("status") == "awaiting_payment"
                and pend.get("revolut_order_id") == order["id"]):
            # ίδιος κανόνας με τη Viva: εφαρμόζεται ΜΟΝΟ αν πληρώθηκε το ποσό της αναβάθμισης
            need = int(pend.get("charge_amount", pend.get("new_price", 0)) or 0)
            if paid >= need > 0:
                from app.services import plan_change_service
                await plan_change_service.apply_change(tid, source="revolut")
            else:
                await payment_rejected("αναβάθμιση πακέτου", tid, {"reason": "amount_short", "amount_cents": paid,
                                                                    "transaction_id": order["id"]}, need,
                                       provider="revolut")
            return
    cust = (order.get("customer") or {}).get("id")
    if event in ("ORDER_COMPLETED", "ORDER_AUTHORISED"):
        # Αποθήκευση κάρτας: ΜΟΝΟ η παραγγελία που ξεκίνησε το start_card_capture, ξαναδιαβασμένη από τη
        # Revolut (get_order στο router). ΤΟΤΕ μόνο αλλάζει ο πάροχος της συνδρομής σε Revolut.
        sub = await db["subscriptions"].find_one({"tenant_id": tid}) or {}
        if str(sub.get("revolut_order_id") or "") != str(order.get("id") or "") or not cust:
            return
        if str(order.get("state") or "").lower() not in ("completed", "authorised"):
            return
        await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
            "payment_provider": "revolut", "revolut_customer_id": cust,
            "payment_status": "card_saved", "failed_attempts": 0}})
    # ORDER_PAYMENT_FAILED / ORDER_CANCELLED: τίποτα. Εγκαταλελειμμένη αλλαγή κάρτας ή ανανέωσης ΔΕΝ είναι
    # απλήρωτη συνδρομή (πριν: past_due + αναστολή μετά από 3). Την αποτυχία αυτόματης χρέωσης την
    # αποφασίζει το bill_due (επαλήθευση → κλείδωμα), όπως στη Viva.
