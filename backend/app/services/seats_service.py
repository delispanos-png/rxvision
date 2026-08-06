"""Self-service αύξηση/μείωση χρηστών (seats) για ενεργό πελάτη.

Μοντέλο (απόφαση ιδιοκτήτη 2026-08-05):
* **Αύξηση** → ΑΜΕΣΗ: αναλογική (prorated) χρέωση της διαφοράς για τις μέρες που απομένουν στην
  τρέχουσα περίοδο (off-session στην αποθηκευμένη κάρτα) + η επιβάρυνση μπαίνει στο `addons_total`
  ώστε να χρεώνεται πλήρης κάθε επόμενο κύκλο (billing_service.bill_due). Απαιτείται κάρτα.
* **Μείωση** → SCHEDULED στην ανανέωση (yearly renewal / period end): κρατάει ό,τι πλήρωσε μέχρι
  τότε· `pending_seats` εφαρμόζεται από beat (apply_due_seat_changes).

Κάθε πλάνο περιλαμβάνει 1 δωρεάν seat· επιπλέον χρεώνονται με την τιμή/χρήστη του πακέτου
(`extra_user_price` μηνιαία / `extra_user_price_yearly` ετήσια — καθαρές τιμές, +ΦΠΑ στη χρέωση).
Το ανώτατο = `package.seats`· πέρα από αυτό ο πελάτης πρέπει να αναβαθμίσει πλάνο.
Money = integer cents (project convention).
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db
from app.services import billing_service
from app.services.invoice_service import gross_from_price

INCLUDED_FREE = 1   # DEFAULT: πλάνο χωρίς ρύθμιση → 1 δωρεάν seat


def _included(pkg: dict | None) -> int:
    """Πόσους ταυτόχρονους χρήστες περιλαμβάνει ΔΩΡΕΑΝ η τιμή του πακέτου (ρυθμιζόμενο· default 1)."""
    return int((pkg or {}).get("included_users") or INCLUDED_FREE)


class CardRequired(Exception):
    """Ζητήθηκε αύξηση seats χωρίς αποθηκευμένη κάρτα."""


class SeatError(Exception):
    """Παραβίαση κανόνα (πάνω από το όριο πακέτου, αποτυχία χρέωσης, κ.λπ.)."""


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else (v or None)


def _seat_price(pkg: dict | None, sub: dict, yearly: bool) -> int:
    """Καθαρή τιμή ανά επιπλέον χρήστη για τον κύκλο (fallback στο αποθηκευμένο rate της συνδρομής)."""
    if pkg:
        v = pkg.get("extra_user_price_yearly") if yearly else pkg.get("extra_user_price")
        if v is not None:
            return int(v or 0)
    return int(sub.get("extra_user_rate", 0) or 0)


async def _load(tenant_id: str) -> tuple[dict, dict | None]:
    db = shared_db()
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    pkg = await db["packages"].find_one({"_id": sub.get("plan")}) if sub.get("plan") else None
    return sub, pkg


def _max_seats(pkg: dict | None, sub: dict) -> int:
    return int((pkg or {}).get("seats") or sub.get("seats") or INCLUDED_FREE)


async def seat_surcharge_for_cycle(db, tenant_id: str) -> int:
    """Επιβάρυνση seats για τον ΚΥΚΛΟ της συνδρομής (μπαίνει ΑΠΕΥΘΕΙΑΣ στο addons_total — η ετήσια
    τιμή/χρήστη είναι ήδη ανά έτος, δεν πολλαπλασιάζεται ×12). = extra_users × τιμή/χρήστη."""
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    pkg = await db["packages"].find_one({"_id": sub.get("plan")}) if sub.get("plan") else None
    included = _included(pkg)
    seats = int(sub.get("seats") or included)
    extra_users = max(0, seats - included)
    yearly = sub.get("billing_cycle") == "yearly"
    return extra_users * _seat_price(pkg, sub, yearly)


def _prorated_increase(delta: int, per_seat: int, sub: dict, yearly: bool) -> tuple[int, int]:
    """(prorated_net_cents, remaining_days) για `delta` επιπλέον seats στο υπόλοιπο της περιόδου."""
    period_days = 365 if yearly else 30
    period_end = sub.get("current_period_end")
    remaining_days = max(0, (period_end - _now()).days) if period_end else period_days
    frac = min(1.0, max(0.0, remaining_days / period_days))
    return max(0, round(delta * per_seat * frac)), remaining_days


async def get_seats(tenant_id: str) -> dict:
    """Εικόνα seats για τη σελίδα «Χρέωση»: τρέχοντα/ανώτατο/τιμή/κατάσταση κάρτας/εκκρεμής μείωση."""
    sub, pkg = await _load(tenant_id)
    yearly = sub.get("billing_cycle") == "yearly"
    included = _included(pkg)
    seats = int(sub.get("seats") or included)
    pend = sub.get("pending_seats") or None
    from app.services import session_service
    return {
        "seats": seats,
        "included_free": included,
        "max_seats": _max_seats(pkg, sub),
        "extra_users": max(0, seats - included),
        "per_seat_price_cents": _seat_price(pkg, sub, yearly),   # καθαρή, ανά κύκλο
        "billing_cycle": sub.get("billing_cycle", "monthly"),
        "currency": sub.get("currency", "EUR"),
        "card_on_file": await billing_service.card_on_file(tenant_id),
        "live_sessions": await session_service.live_count(tenant_id),
        "pending_decrease": ({"seats": pend.get("seats"), "effective_at": _iso(pend.get("effective_at"))}
                             if pend else None),
    }


async def preview(tenant_id: str, new_seats: int) -> dict:
    """Τι θα χρεωθεί ΤΩΡΑ (αναλογικά) αν αυξήσει σε `new_seats` — χωρίς να εφαρμόζει τίποτα."""
    sub, pkg = await _load(tenant_id)
    yearly = sub.get("billing_cycle") == "yearly"
    included = _included(pkg)
    cur = int(sub.get("seats") or included)
    new_seats = max(included, min(_max_seats(pkg, sub), int(new_seats)))
    per_seat = _seat_price(pkg, sub, yearly)
    delta = new_seats - cur
    tenant = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"country": 1}) or {}
    inc_vat = bool((pkg or {}).get("price_includes_vat") or sub.get("price_includes_vat"))
    result = {"new_seats": new_seats, "current_seats": cur, "delta": delta,
              "per_seat_price_cents": per_seat, "direction": "none",
              "immediate_charge_gross_cents": 0, "recurring_delta_net_cents": 0}
    if delta > 0:
        prorated_net, rem = _prorated_increase(delta, per_seat, sub, yearly)
        result.update(direction="increase",
                      immediate_charge_gross_cents=gross_from_price(prorated_net, inc_vat, tenant.get("country")),
                      recurring_delta_net_cents=delta * per_seat, remaining_days=rem)
    elif delta < 0:
        result.update(direction="decrease", recurring_delta_net_cents=delta * per_seat)
    return result


async def change_seats(tenant_id: str, new_seats: int) -> dict:
    """Αύξηση (άμεση, prorated χρέωση) ή μείωση (scheduled στην ανανέωση) των seats."""
    db = shared_db()
    sub, pkg = await _load(tenant_id)
    if not sub:
        raise SeatError("no_subscription")
    yearly = sub.get("billing_cycle") == "yearly"
    included = _included(pkg)
    cur = int(sub.get("seats") or included)
    max_seats = _max_seats(pkg, sub)
    new_seats = int(new_seats)
    if new_seats < included:
        raise SeatError("below_minimum")   # οι περιλαμβανόμενοι χρήστες είναι δωρεάν — δεν πέφτεις κάτω
    if new_seats > max_seats:
        raise SeatError("exceeds_plan_max")   # πάνω από το όριο → αναβάθμιση πλάνου
    if new_seats == cur:
        # καθαρισμός τυχόν εκκρεμούς μείωσης αν επανήλθε στο τρέχον
        if sub.get("pending_seats"):
            await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$unset": {"pending_seats": ""}})
        return await get_seats(tenant_id)

    per_seat = _seat_price(pkg, sub, yearly)

    # ── ΑΥΞΗΣΗ → ΑΜΕΣΗ prorated χρέωση + εγγραφή στο recurring ──────────────────────────────────
    if new_seats > cur:
        # κάρτα απαιτείται ΜΟΝΟ όταν υπάρχει πραγματικό κόστος (per_seat>0)· π.χ. trial με δωρεάν
        # 2η άδεια (per_seat=0) δεν χρειάζεται κάρτα.
        if per_seat > 0 and not await billing_service.card_on_file(tenant_id):
            raise CardRequired("seats")
        delta = new_seats - cur
        tenant = await db["tenants"].find_one({"_id": tenant_id}, {"country": 1}) or {}
        inc_vat = bool((pkg or {}).get("price_includes_vat") or sub.get("price_includes_vat"))
        prorated_net, _ = _prorated_increase(delta, per_seat, sub, yearly)
        gross = gross_from_price(prorated_net, inc_vat, tenant.get("country"))
        if gross > 0:
            res = await billing_service._charge_recurring(sub, gross, tenant_id)
            if not res.get("ok"):
                raise SeatError(f"charge_failed:{res.get('error', 'unknown')}")
            from app.services import receipts, invoice_service
            await receipts.record(
                tenant_id, "extra", f"Επιπλέον χρήστες RxVision (+{delta}) — αναλογικά",
                gross, method="card", provider=res.get("provider", "viva"),
                provider_order_id=res.get("order_id"))
            await invoice_service.create_for_payment(
                tenant_id=tenant_id, kind="extra", gross_cents=gross,
                description=f"Επιπλέον χρήστες RxVision (+{delta}) — αναλογική χρέωση περιόδου",
                payment={"method": "card", "provider": res.get("provider", "viva"),
                         "transaction_id": res.get("order_id")},
                item_key="seats")
        # εφαρμογή seats ΤΩΡΑ + καθαρισμός τυχόν εκκρεμούς μείωσης (η αύξηση υπερισχύει)
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {
            "$set": {"seats": new_seats, "extra_users": max(0, new_seats - included),
                     "extra_user_rate": per_seat, "limits.users": new_seats,
                     "limits.pharmacies": new_seats, "updated_at": _now()},
            "$unset": {"pending_seats": ""}})
        from app.services import addon_service
        await addon_service._recompute_total(tenant_id)
        return await get_seats(tenant_id)

    # ── ΜΕΙΩΣΗ → SCHEDULED στην ανανέωση (κρατάει ό,τι πλήρωσε) ─────────────────────────────────
    eff = sub.get("current_period_end") or billing_service._period_end(sub.get("billing_cycle", "monthly"), _now())
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
        "pending_seats": {"seats": new_seats, "effective_at": eff, "requested_at": _now()}}})
    return await get_seats(tenant_id)


async def apply_due_seat_changes() -> dict:
    """Beat: εφαρμόζει εκκρεμείς ΜΕΙΩΣΕΙΣ seats που έφτασε η ημερομηνία ισχύος (ανανέωση)."""
    db = shared_db()
    now = _now()
    applied = 0
    cur = db["subscriptions"].find({"pending_seats.effective_at": {"$lte": now}})
    async for sub in cur:
        pend = sub.get("pending_seats") or {}
        pkg = await db["packages"].find_one({"_id": sub.get("plan")}) if sub.get("plan") else None
        included = _included(pkg)
        seats = int(pend.get("seats") or included)
        await db["subscriptions"].update_one({"tenant_id": sub["tenant_id"]}, {
            "$set": {"seats": seats, "extra_users": max(0, seats - included),
                     "limits.users": seats, "limits.pharmacies": seats, "updated_at": now},
            "$unset": {"pending_seats": ""}})
        from app.services import addon_service
        await addon_service._recompute_total(sub["tenant_id"])
        applied += 1
    return {"applied": applied}
