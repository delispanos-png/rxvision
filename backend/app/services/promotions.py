"""Προωθητικές ενέργειες συνδρομών — ΜΙΑ πηγή για το «ποια προσφορά ισχύει και τι δίνει».

Μια ενέργεια = ΠΟΤΕ (χρονικό παράθυρο) + ΣΕ ΠΟΙΟΝ (πακέτα, κύκλος χρέωσης, νέος ή παλιός πελάτης,
κωδικός προσφοράς, σύσταση από άλλο φαρμακείο, όριο χρήσεων) + ΤΙ ΔΙΝΕΙ (λίστα αποτελεσμάτων:
έκπτωση %, έκπτωση σε ευρώ, δωρεάν δυνατότητα για Χ ημέρες στον νέο πελάτη, σε όποιον τον σύστησε
ή και στους δύο). Ο ιδιοκτήτης τις στήνει από το adminpanel, χωρίς αλλαγή κώδικα.

Σήμερα εφαρμόζονται στη ΝΕΑ ΣΥΝΔΡΟΜΗ από τη σελίδα εγγραφής: η έκπτωση μειώνει το ποσό της πρώτης
πληρωμής (και άρα το παραστατικό), και τα δώρα δίνονται όταν ανοίξει ο λογαριασμός (`redeem_signup`).

ΕΙΔΙΚΗ ΠΡΟΣΦΟΡΑ (`audience = "afm_list"`, 20/11/2026): ισχύει ΜΟΝΟ για τα ΑΦΜ της λίστας της
(`special_offer_afms`), ΜΙΑ φορά ανά ΑΦΜ, σε ΕΝΑ πακέτο, για `offer_months` μήνες. Για όσο διαρκεί:
η τιμή μένει ίδια (κλείδωμα τιμής) και το φαρμακείο δεν αλλάζει πακέτο — μόνο πρόσθετα
(`subscriptions.offer_lock`, τον ελέγχει ΜΟΝΟ η `offer_lock_active`). Δεν εμφανίζεται ποτέ στο site.
Προδιαγραφή: docs/special-offers-spec.md.

ΠΛΗΡΩΤΗΣ ειδικής προσφοράς (Φάση 3): `pharmacy` (ως τώρα), `sponsor` (ο χορηγός πληρώνει όλη την
τιμή προσφοράς του πακέτου) ή `split` (ο χορηγός πληρώνει `sponsor_pct`%). Ο χορηγός χρεώνεται ΜΟΝΟ όταν
η ΗΔΥΚΑ επιβεβαιώσει το ΑΦΜ (`sponsors.bill_activation`). Δωρεάν (100%) ή με χορηγό: ΜΟΝΟ ετήσια,
12 μήνες — μία περίοδος = η προσφορά, άρα καμία ανανέωση μέσα της να «σπάσει» (μηδενική ανανέωση,
πρόωρη ανανέωση με την τιμή προσφοράς). Αν το φαρμακείο δεν έχει τίποτα να πληρώσει, η εγγραφή
γίνεται χωρίς πληρωμή (`onboarding_service.create_pending` → `no_payment`).

ΚΛΕΙΔΩΜΑ ΤΙΜΗΣ: μια ενέργεια μπορεί να κρατά την τιμή του πακέτου που πλήρωσε ο πελάτης και στις
ανανεώσεις, για Χ χρόνια από την αγορά ή έως μια ημερομηνία. Αποθηκεύεται στη συνδρομή ως
`price_lock` και τη διαβάζει ΜΟΝΟ η `billing_service.package_price`. Αλλαγή πακέτου ή κύκλου το λύνει.

Κανόνας συνδυασμού: όλες οι ενέργειες που ταιριάζουν ισχύουν μαζί, εκτός αν κάποια είναι
«αποκλειστική»· τότε ο πελάτης παίρνει ό,τι τον συμφέρει περισσότερο σε ευρώ — είτε τη μία
αποκλειστική είτε όλες τις υπόλοιπες μαζί. Το ποσό δεν πέφτει ποτέ κάτω από MIN_PAYABLE_NET.
"""

from __future__ import annotations

import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.core.db import shared_db

ATHENS = ZoneInfo("Europe/Athens")
MIN_PAYABLE_NET = 100            # λεπτά· μια εγγραφή χωρίς πληρωμή δεν περνά από τη ροή πληρωμής
EFFECT_TYPES = ("discount_pct", "discount_amount", "free_module", "addon_discount")
RECIPIENTS = ("buyer", "referrer", "both")
CUSTOMERS = ("new", "returning", "any")
AUDIENCES = ("all", "afm_list")
PAYERS = ("pharmacy", "sponsor", "split")
SPECIAL_AFM_STATES = ("invited", "redeemed", "verified")
SPECIAL_VERIFY_DAYS = 30         # χωρίς επιβεβαίωση από την ΗΔΥΚΑ μέσα σε τόσες ημέρες → ανάκληση
CODE_RE = re.compile(r"^[A-Z0-9-]{3,24}$")
_REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"     # χωρίς 0/O, 1/I: διαβάζεται στο τηλέφωνο


class PromotionError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _aware(d: datetime | None) -> datetime | None:
    if d is None:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def window(starts_on: str, ends_on: str) -> tuple[datetime, datetime]:
    """Ημερομηνίες της φόρμας (YYYY-MM-DD) → από 00:00 της έναρξης έως 23:59:59 της λήξης, ώρα Ελλάδας."""
    try:
        s = datetime.strptime(starts_on, "%Y-%m-%d").replace(tzinfo=ATHENS)
        e = datetime.strptime(ends_on, "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=ATHENS)
    except (TypeError, ValueError) as exc:
        raise PromotionError("dates_invalid") from exc
    if e < s:
        raise PromotionError("dates_invalid")
    return s.astimezone(timezone.utc), e.astimezone(timezone.utc)


def normalize_code(code: str | None) -> str | None:
    c = (code or "").strip().upper()
    return c or None


# ── Πυρήνας: καθαρές συναρτήσεις ─────────────────────────────────────────────────────────────
def lock_end(lock: dict | None, bought_at: datetime) -> datetime | None:
    """Μέχρι πότε κρατά την τιμή όποιος αγοράζει στις `bought_at` (None = καθόλου κλείδωμα)."""
    lock = lock or {}
    if lock.get("kind") == "years" and lock.get("years"):
        local = bought_at.astimezone(ATHENS)
        try:
            end = local.replace(year=local.year + int(lock["years"]))
        except ValueError:                          # 29/02 → 28/02
            end = local.replace(year=local.year + int(lock["years"]), day=28)
        return end.astimezone(timezone.utc)
    if lock.get("kind") == "until" and lock.get("until_at"):
        return _aware(lock["until_at"])
    if lock.get("kind") == "months" and lock.get("months"):
        return add_months(bought_at, int(lock["months"]))
    return None


def add_months(at: datetime, months: int) -> datetime:
    """Ίδια ημέρα Χ μήνες μετά, ώρα Ελλάδας (31/01 + 1 → 28 ή 29/02)."""
    local = at.astimezone(ATHENS)
    y, m = divmod(local.month - 1 + months, 12)
    year, month = local.year + y, m + 1
    for d in (local.day, 30, 29, 28):
        try:
            return local.replace(year=year, month=month, day=d).astimezone(timezone.utc)
        except ValueError:
            continue
    raise ValueError("unreachable")


def lock_text(lock: dict | None) -> str:
    lock = lock or {}
    if lock.get("kind") == "years":
        n = int(lock.get("years") or 0)
        return f"η τιμή μένει ίδια για {n} {'χρόνο' if n == 1 else 'χρόνια'} από την αγορά"
    if lock.get("kind") == "until":
        return f"η τιμή μένει ίδια έως {'/'.join(reversed((lock.get('until_on') or '').split('-')))}"
    if lock.get("kind") == "months":
        n = int(lock.get("months") or 0)
        return f"η τιμή και το πακέτο μένουν ίδια για {n} {'μήνα' if n == 1 else 'μήνες'}"
    return ""


def matches(p: dict, ctx: dict, now: datetime) -> bool:
    """Ισχύει η ενέργεια `p` για αυτή την αγορά; `ctx`: package, cycle, returning (bool),
    promo_code, referrer (tenant id ή None)."""
    if not p.get("active"):
        return False
    if not (_aware(p["starts_at"]) <= now <= _aware(p["ends_at"])):
        return False
    if p.get("audience") == "afm_list" and p["_id"] not in (ctx.get("special_ids") or ()):
        return False                     # ειδική προσφορά: μόνο ΑΦΜ της λίστας που δεν την έχουν πάρει
    if p.get("packages") and ctx.get("package") not in p["packages"]:
        return False
    if p.get("cycles") and ctx.get("cycle") not in p["cycles"]:
        return False
    customer = p.get("customer") or "any"
    if customer == "new" and ctx.get("returning"):
        return False
    if customer == "returning" and not ctx.get("returning"):
        return False
    if p.get("code") and normalize_code(ctx.get("promo_code")) != p["code"]:
        return False
    if p.get("requires_referral") and not ctx.get("referrer"):
        return False
    limit = p.get("max_redemptions")
    if limit and int(p.get("redeemed") or 0) >= int(limit):
        return False
    return True


def discount_of(p: dict, package_net: int, total_net: int, addon_prices: dict | None = None) -> int:
    """Έκπτωση μίας ενέργειας σε λεπτά (καθαρή αξία), πριν το συνολικό πλαφόν. Η έκπτωση σε πρόσθετο
    μετρά εδώ μόνο αν ο νέος πελάτης το αγοράζει μαζί με τη συνδρομή (`addon_prices`)."""
    out = 0
    for e in p.get("effects") or []:
        if e["type"] == "addon_discount":
            if (e.get("to") or "buyer") in ("buyer", "both") and e.get("module") in (addon_prices or {}):
                out += round(int(addon_prices[e["module"]]) * int(e.get("value") or 0) / 100)
            continue
        base = package_net if (e.get("on") or "package") == "package" else total_net
        if e["type"] == "discount_pct":
            out += round(base * int(e.get("value") or 0) / 100)
        elif e["type"] == "discount_amount":
            out += min(int(e.get("value") or 0), base)
    return out


def _capped(discount: int, total_net: int, floor: int = MIN_PAYABLE_NET) -> int:
    return max(0, min(discount, total_net - floor))


def is_free_or_sponsored(p: dict) -> bool:
    """Ειδική προσφορά όπου το φαρμακείο δεν πληρώνει (όλο ή μέρος) το πακέτο: χορηγός ή 100%."""
    if p.get("audience") != "afm_list":
        return False
    if (p.get("payer") or "pharmacy") != "pharmacy":
        return True
    return any(e.get("type") == "discount_pct" and int(e.get("value") or 0) >= 100
               and (e.get("on") or "package") == "package" for e in p.get("effects") or [])


def gifts_of(p: dict) -> list[dict]:
    """Τα οφέλη προς φαρμακεία (όχι στο ποσό): δωρεάν δυνατότητα ή έκπτωση σε πρόσθετο για Χ μήνες."""
    out = []
    for e in p.get("effects") or []:
        if e["type"] == "free_module":
            out.append({"kind": "free", "module": e["module"], "days": int(e["days"]), "to": e.get("to") or "buyer",
                        "referral_only": bool(e.get("referral_only"))})
        elif e["type"] == "addon_discount":
            out.append({"kind": "discount", "module": e["module"], "pct": int(e["value"]),
                        "months": int(e["months"]), "to": e.get("to") or "buyer",
                        "referral_only": bool(e.get("referral_only"))})
    return out


def gift_text(g: dict, name: str) -> str:
    if g.get("kind") == "discount":
        what = "δωρεάν" if g["pct"] >= 100 else f"με έκπτωση {g['pct']}%"
        return f"{name} {what} για {g['months']} {'μήνα' if g['months'] == 1 else 'μήνες'}"
    days = int(g["days"])
    span = (f"{days // 30} {'μήνα' if days == 30 else 'μήνες'}" if days % 30 == 0 else f"{days} ημέρες")
    return f"{name} δωρεάν για {span}"


def select(matching: list[dict], package_net: int, total_net: int,
           addon_prices: dict | None = None) -> list[dict]:
    """Ποιες από τις ενέργειες που ταιριάζουν εφαρμόζονται τελικά (βλ. κανόνα συνδυασμού)."""
    shared = [p for p in matching if not p.get("exclusive")]
    options: list[list[dict]] = [shared] if shared else []
    options += [[p] for p in matching if p.get("exclusive")]
    if not options:
        return []

    def value(group: list[dict]) -> tuple[int, int]:
        d = _capped(sum(discount_of(p, package_net, total_net, addon_prices) for p in group), total_net)
        gifts = sum(len(gifts_of(p)) for p in group)
        return d, gifts

    return max(options, key=value)          # σε ισοπαλία μένει η πρώτη = οι συνδυαζόμενες


def evaluate(promos: list[dict], ctx: dict, *, package_net: int, total_net: int,
             now: datetime | None = None) -> dict:
    """Το αποτέλεσμα για μία αγορά: ποιες ενέργειες, πόση έκπτωση, ποια δώρα σε ποιον."""
    now = now or _now()
    addon_prices = ctx.get("addon_prices") or {}
    # Οφέλη «μόνο με σύσταση» πέφτουν όταν δεν υπάρχει σύσταση· η υπόλοιπη ενέργεια ισχύει κανονικά
    views = []
    for p in promos:
        if not matches(p, ctx, now):
            continue
        effects = [e for e in p.get("effects") or [] if not e.get("referral_only") or ctx.get("referrer")]
        if effects or p.get("lock"):
            views.append({**p, "effects": effects})
    chosen = select(views, package_net, total_net, addon_prices)
    raw = [discount_of(p, package_net, total_net, addon_prices) for p in chosen]
    # ειδική προσφορά: επιτρέπεται να φτάσει στο 0 (δωρεάν ή με χορηγό)· οι δημόσιες κρατούν το 1 €
    floor = 0 if any(p.get("audience") == "afm_list" for p in chosen) else MIN_PAYABLE_NET
    discount = _capped(sum(raw), total_net, floor)
    applied = []
    left = discount
    ends = [e for e in (lock_end(p.get("lock"), now) for p in chosen) if e]
    package_part = min(package_net, sum(discount_of({"effects": [e for e in p.get("effects") or []
                                                                  if e["type"] in ("discount_pct", "discount_amount")
                                                                  and (e.get("on") or "package") == "package"]},
                                                    package_net, total_net) for p in chosen))
    for p, d in zip(chosen, raw):
        share = min(d, left)
        left -= share
        applied.append({"id": p["_id"], "name": p.get("name"), "public_text": p.get("public_text") or "",
                        "code": p.get("code"),
                        "discount_net": share,
                        "lock_text": lock_text(p.get("lock")),
                        "audience": p.get("audience") or "all",
                        "offer_months": p.get("offer_months"),
                        "payer": p.get("payer") or "pharmacy", "sponsor_id": p.get("sponsor_id"),
                        "sponsor_pct": p.get("sponsor_pct"),
                        "gifts": gifts_of(p)})
    lock = None
    if ends:
        lock = {"until": max(ends), "package_net": max(0, package_net - package_part),
                "list_package_net": package_net, "package": ctx.get("package"), "cycle": ctx.get("cycle")}
    # Χορηγός: πληρώνει `sponsor_pct`% της τιμής ΠΡΟΣΦΟΡΑΣ του πακέτου (μετά την έκπτωση)
    sponsor = None
    sp = next((p for p in chosen if p.get("audience") == "afm_list"
               and (p.get("payer") or "pharmacy") != "pharmacy" and p.get("sponsor_id")), None)
    if sp:
        pct = 100 if sp.get("payer") == "sponsor" else int(sp.get("sponsor_pct") or 0)
        offer_net = max(0, package_net - package_part)
        net = min(round(offer_net * pct / 100), max(0, total_net - discount))
        sponsor = {"sponsor_id": sp["sponsor_id"], "promotion_id": sp["_id"], "pct": pct, "net": net,
                   "package": ctx.get("package"), "cycle": ctx.get("cycle")}
    if any(is_free_or_sponsored(p) for p in chosen):
        lock = None          # μία περίοδος = όλη η προσφορά· κλείδωμα τιμής θα άνοιγε πρόωρη ανανέωση στο 0
    return {"promotions": applied, "discount_net": discount, "price_lock": lock, "sponsor": sponsor}


def gift_targets(gift: dict, buyer: str, referrer: str | None) -> list[tuple[str, str]]:
    """(tenant_id, ρόλος) που παίρνουν ένα δώρο."""
    to = gift.get("to") or "buyer"
    out = []
    if to in ("buyer", "both"):
        out.append((buyer, "buyer"))
    if to in ("referrer", "both") and referrer:
        out.append((referrer, "referrer"))
    return out


def validate(doc: dict, addon_ids: set[str], package_ids: set[str],
             sponsor_ids: set[str] | None = None) -> dict:
    """Ελέγχει και κανονικοποιεί μια ενέργεια από τη φόρμα του adminpanel."""
    name = (doc.get("name") or "").strip()
    if not name:
        raise PromotionError("name_required")
    starts_at, ends_at = window(doc.get("starts_on"), doc.get("ends_on"))
    packages = [p for p in doc.get("packages") or [] if p]
    if set(packages) - package_ids:
        raise PromotionError("unknown_package")
    cycles = [c for c in doc.get("cycles") or [] if c]
    if set(cycles) - {"monthly", "yearly"}:
        raise PromotionError("unknown_cycle")
    customer = doc.get("customer") or "any"
    if customer not in CUSTOMERS:
        raise PromotionError("unknown_customer")
    code = normalize_code(doc.get("code"))
    if code and not CODE_RE.match(code):
        raise PromotionError("code_invalid")
    requires_referral = bool(doc.get("requires_referral"))
    effects = []
    for e in doc.get("effects") or []:
        kind = e.get("type")
        if kind not in EFFECT_TYPES:
            raise PromotionError("unknown_effect")
        if kind == "addon_discount":
            module, value, months = e.get("module"), int(e.get("value") or 0), int(e.get("months") or 0)
            to = e.get("to") or "buyer"
            if module not in addon_ids:
                raise PromotionError("unknown_module")
            if not 1 <= value <= 100:
                raise PromotionError("addon_pct_invalid")
            if not 1 <= months <= 36:
                raise PromotionError("months_invalid")
            if to not in RECIPIENTS:
                raise PromotionError("unknown_recipient")
            effects.append({"type": kind, "module": module, "value": value, "months": months, "to": to,
                            "referral_only": bool(e.get("referral_only"))})
        elif kind == "free_module":
            module, days, to = e.get("module"), int(e.get("days") or 0), e.get("to") or "buyer"
            if module not in addon_ids:
                raise PromotionError("unknown_module")
            if not 1 <= days <= 1095:
                raise PromotionError("days_invalid")
            if to not in RECIPIENTS:
                raise PromotionError("unknown_recipient")
            effects.append({"type": kind, "module": module, "days": days, "to": to,
                            "referral_only": bool(e.get("referral_only"))})
        else:
            value = int(e.get("value") or 0)
            max_pct = 100 if doc.get("audience") == "afm_list" else 95     # ειδική: και δωρεάν
            if kind == "discount_pct" and not 1 <= value <= max_pct:
                raise PromotionError("pct_invalid")
            if kind == "discount_amount" and value < 1:
                raise PromotionError("amount_invalid")
            on = e.get("on") or "package"
            if on not in ("package", "total"):
                raise PromotionError("unknown_base")
            effects.append({"type": kind, "value": value, "on": on, "referral_only": bool(e.get("referral_only"))})
    if not effects:
        raise PromotionError("effects_required")
    limit = doc.get("max_redemptions")
    raw_lock = doc.get("lock") or {}
    kind = raw_lock.get("kind") or "none"
    if doc.get("audience") == "afm_list":
        kind = "none"                  # η ειδική προσφορά κλειδώνει από μόνη της για `offer_months`
    if kind == "years":
        years = int(raw_lock.get("years") or 0)
        if not 1 <= years <= 10:
            raise PromotionError("lock_years_invalid")
        lock = {"kind": "years", "years": years}
    elif kind == "until":
        until_on = raw_lock.get("until_on") or ""
        try:
            until_at = window(until_on, until_on)[1]
        except PromotionError:
            until_at = None
        if not until_at or until_at < ends_at:
            raise PromotionError("lock_until_invalid")
        lock = {"kind": "until", "until_on": until_on, "until_at": until_at}
    elif kind == "none":
        lock = None
    else:
        raise PromotionError("lock_invalid")
    audience = doc.get("audience") or "all"
    if audience not in AUDIENCES:
        raise PromotionError("unknown_audience")
    offer_months = None
    show_on_site = bool(doc.get("show_on_site"))
    if audience == "afm_list":
        # Ειδική προσφορά: ΕΝΑ πακέτο, συγκεκριμένη διάρκεια, μόνο για τον ίδιο τον αγοραστή.
        if len(packages) != 1:
            raise PromotionError("special_one_package")
        offer_months = int(doc.get("offer_months") or 0)
        if not 1 <= offer_months <= 36:
            raise PromotionError("offer_months_invalid")
        if any(e.get("to", "buyer") != "buyer" for e in effects):
            raise PromotionError("special_buyer_only")
        effects = [{**e, "referral_only": False} for e in effects]
        code, requires_referral, customer, show_on_site = None, False, "any", False
        lock = {"kind": "months", "months": offer_months}
    payer = doc.get("payer") or "pharmacy"
    sponsor_id, sponsor_pct = None, None
    if audience == "afm_list":
        if payer not in PAYERS:
            raise PromotionError("unknown_payer")
        if payer != "pharmacy":
            sponsor_id = doc.get("sponsor_id")
            if not sponsor_id or sponsor_id not in (sponsor_ids or set()):
                raise PromotionError("sponsor_required")
            sponsor_pct = 100 if payer == "sponsor" else int(doc.get("sponsor_pct") or 0)
            if payer == "split" and not 1 <= sponsor_pct <= 99:
                raise PromotionError("sponsor_pct_invalid")
        probe = {"audience": audience, "payer": payer, "effects": effects}
        if is_free_or_sponsored(probe) and (cycles != ["yearly"] or offer_months != 12):
            raise PromotionError("free_or_sponsored_yearly_12")
    else:
        payer = "pharmacy"
    return {"name": name, "audience": audience, "offer_months": offer_months,
            "payer": payer, "sponsor_id": sponsor_id, "sponsor_pct": sponsor_pct, "public_text": (doc.get("public_text") or "").strip()[:240],
            "active": bool(doc.get("active")), "starts_at": starts_at, "ends_at": ends_at,
            "starts_on": doc["starts_on"], "ends_on": doc["ends_on"],
            "packages": packages, "cycles": cycles, "customer": customer, "code": code,
            "requires_referral": requires_referral, "exclusive": bool(doc.get("exclusive")),
            "max_redemptions": int(limit) if limit else None, "effects": effects,
            "lock": lock, "show_on_site": show_on_site}


# ── Βάση ─────────────────────────────────────────────────────────────────────────────────────
async def _with_counts(promos: list[dict]) -> list[dict]:
    db = shared_db()
    counts = {r["_id"]: r["n"] async for r in db["promotion_redemptions"].aggregate([
        {"$group": {"_id": "$promotion_id", "n": {"$sum": 1}}}])}
    afms: dict[str, dict] = {}
    async for r in db["special_offer_afms"].aggregate([
            {"$group": {"_id": {"p": "$promotion_id", "s": "$status"}, "n": {"$sum": 1}}}]):
        afms.setdefault(r["_id"]["p"], {})[r["_id"]["s"]] = r["n"]
    for p in promos:
        p["redeemed"] = counts.get(p["_id"], 0)
        if p.get("audience") == "afm_list":
            c = afms.get(p["_id"], {})
            p["afm_counts"] = {"total": sum(c.values()), "invited": c.get("invited", 0),
                               "redeemed": c.get("redeemed", 0) + c.get("verified", 0),
                               "verified": c.get("verified", 0)}
    return promos


async def list_all() -> list[dict]:
    return await _with_counts([p async for p in shared_db()["promotions"].find({}).sort("starts_at", -1)])


async def live() -> list[dict]:
    """Ενεργές που δεν έχουν λήξει (το παράθυρο ελέγχεται στο `matches`)."""
    return await _with_counts([p async for p in shared_db()["promotions"].find(
        {"active": True, "ends_at": {"$gte": _now()}})])


async def save(doc: dict, *, by: str, pid: str | None = None) -> dict:
    db = shared_db()
    addon_ids = {a["_id"] async for a in db["addons"].find({}, {"_id": 1})}
    package_ids = {p["_id"] async for p in db["packages"].find({}, {"_id": 1})}
    from app.services import sponsors
    clean = validate(doc, addon_ids, package_ids, await sponsors.ids())
    if clean["code"]:
        clash = await db["promotions"].find_one({"code": clean["code"], "_id": {"$ne": pid}})
        if clash:
            raise PromotionError("code_taken")
        if await db["tenants"].find_one({"referral_code": clean["code"]}, {"_id": 1}):
            raise PromotionError("code_taken")
    clean.update({"updated_at": _now(), "updated_by": by})
    if pid:
        res = await db["promotions"].update_one({"_id": pid}, {"$set": clean})
        if not res.matched_count:
            raise PromotionError("not_found")
    else:
        pid = uuid.uuid4().hex[:12]
        await db["promotions"].insert_one({"_id": pid, **clean, "created_at": _now(), "created_by": by})
    return {"_id": pid, **clean}


async def delete(pid: str) -> dict:
    """Ενέργεια που έχει ήδη δοθεί σε πελάτες δεν σβήνεται (χάνεται το ιστορικό): απενεργοποιείται."""
    db = shared_db()
    if await db["promotion_redemptions"].find_one({"promotion_id": pid}, {"_id": 1}):
        await db["promotions"].update_one({"_id": pid}, {"$set": {"active": False, "updated_at": _now()}})
        return {"ok": True, "deactivated": True}
    await db["promotions"].delete_one({"_id": pid})
    await db["special_offer_afms"].delete_many({"promotion_id": pid, "status": "invited"})
    return {"ok": True, "deleted": True}


async def redemptions(pid: str) -> list[dict]:
    db = shared_db()
    rows = [r async for r in db["promotion_redemptions"].find({"promotion_id": pid}).sort("at", -1).limit(500)]
    ids = {r.get("tenant_id") for r in rows} | {r.get("referrer_tenant_id") for r in rows}
    names = {t["_id"]: t.get("name") async for t in db["tenants"].find(
        {"_id": {"$in": [i for i in ids if i]}}, {"name": 1})}
    for r in rows:
        r["tenant_name"] = names.get(r.get("tenant_id"))
        r["referrer_name"] = names.get(r.get("referrer_tenant_id"))
    return rows


def addon_discount_pct(sub: dict | None, module: str, at: datetime, period_days: int | None = None) -> int:
    """Έκπτωση % από προωθητική ενέργεια σε ΜΙΑ χρέωση αυτού του προσθέτου.

    Κάθε έκπτωση ισχύει σε παράθυρο [from, until). Χωρίς `period_days`: όση ισχύει τη στιγμή `at`.
    Με `period_days` (η χρέωση καλύπτει [at, at+period_days]): ΑΝΑΛΟΓΙΚΑ με τις ημέρες που
    καλύπτει το παράθυρο. Έτσι δώρο 5 μηνών σε ετήσια ανανέωση αφαιρεί τα 5/12, όχι όλο το έτος."""
    best = 0.0
    for d in (sub or {}).get("addon_discounts") or []:
        until, start = _aware(d.get("until")), _aware(d.get("from"))
        if d.get("module") != module or not until:
            continue
        pct = int(d.get("pct") or 0)
        if not period_days:
            if (start is None or start <= at) and at < until:
                best = max(best, pct)
            continue
        end = at + timedelta(days=period_days)
        overlap = (min(until, end) - max(start or at, at)).total_seconds()
        if overlap > 0:
            best = max(best, pct * min(1.0, overlap / (period_days * 86400)))
    return min(100, round(best))


def pays_addon(sub: dict | None, module: str) -> bool:
    """Το φαρμακείο ΠΛΗΡΩΝΕΙ ήδη αυτό το πρόσθετο (όχι μέσω πακέτου, όχι σε δοκιμή)."""
    sub = sub or {}
    return module in (sub.get("addons") or []) and module not in (sub.get("modules_included") or [])


# ── Κωδικοί σύστασης φαρμακείων ──────────────────────────────────────────────────────────────
async def referral_code_for(tenant_id: str) -> str:
    """Ο μόνιμος κωδικός σύστασης του φαρμακείου (δημιουργείται την πρώτη φορά που ζητηθεί)."""
    db = shared_db()
    t = await db["tenants"].find_one({"_id": tenant_id}, {"referral_code": 1})
    if t and t.get("referral_code"):
        return t["referral_code"]
    for _ in range(20):
        code = "RX-" + "".join(secrets.choice(_REF_ALPHABET) for _ in range(6))
        if await db["tenants"].find_one({"referral_code": code}, {"_id": 1}):
            continue
        if await db["promotions"].find_one({"code": code}, {"_id": 1}):
            continue
        res = await db["tenants"].update_one(
            {"_id": tenant_id, "referral_code": {"$exists": False}}, {"$set": {"referral_code": code}})
        if res.modified_count:
            return code
        t = await db["tenants"].find_one({"_id": tenant_id}, {"referral_code": 1})
        if t and t.get("referral_code"):
            return t["referral_code"]
    raise PromotionError("referral_code_failed")


async def resolve_referrer(code: str | None, *, buyer_afm: str = "", buyer_tenant: str | None = None) -> str | None:
    """Κωδικός σύστασης → φαρμακείο, ΜΟΝΟ αν έχει ενεργή συνδρομή και δεν είναι ο ίδιος ο αγοραστής."""
    code = normalize_code(code)
    if not code:
        return None
    db = shared_db()
    t = await db["tenants"].find_one({"referral_code": code}, {"billing_profile.afm": 1})
    if not t or t["_id"] == buyer_tenant:
        return None
    afm = ((t.get("billing_profile") or {}).get("afm") or "").strip()
    if buyer_afm and afm and afm == buyer_afm.strip():
        return None
    from app.services.billing_service import effective_status
    sub = await db["subscriptions"].find_one({"tenant_id": t["_id"]})
    return t["_id"] if effective_status(sub) == "active" else None


# ── Εφαρμογή στη νέα συνδρομή ────────────────────────────────────────────────────────────────
async def quote_signup(*, package: str | None, cycle: str, returning: bool, promo_code: str | None,
                       referral_code: str | None, buyer_afm: str, buyer_tenant: str | None,
                       package_net: int, total_net: int, addon_prices: dict | None = None) -> dict:
    referrer = await resolve_referrer(referral_code, buyer_afm=buyer_afm, buyer_tenant=buyer_tenant)
    promos = await live()
    effective_code = promo_code
    if referrer and not normalize_code(promo_code):
        effective_code = referral_promo_code(promos)      # η σύσταση φέρνει μαζί τον κωδικό της ενέργειας
    ctx = {"package": package, "cycle": cycle, "returning": returning,
           "promo_code": effective_code, "referrer": referrer, "addon_prices": addon_prices or {},
           "special_ids": await special_ids_for(buyer_afm)}
    res = evaluate(promos, ctx, package_net=package_net, total_net=total_net)
    code = normalize_code(promo_code)
    res.update({
        "referrer_tenant_id": referrer,
        "lock_text": next((p["lock_text"] for p in res["promotions"] if p["lock_text"]), ""),
        "referral_valid": None if not normalize_code(referral_code) else bool(referrer),
        "promo_code": code,
        "promo_code_valid": None if not code else any(p["code"] == code for p in res["promotions"]),
    })
    if res.get("sponsor"):
        sp = await shared_db()["sponsors"].find_one({"_id": res["sponsor"]["sponsor_id"]}, {"name": 1})
        res["sponsor"]["name"] = (sp or {}).get("name")
    return res


async def _module_names() -> dict[str, str]:
    return {a["_id"]: a.get("name") or a["_id"] async for a in shared_db()["addons"].find({}, {"name": 1})}


async def redeem_signup(pending: dict, tenant_id: str) -> list[dict]:
    """Ο λογαριασμός άνοιξε: καταγραφή χρήσης + δώρα. Ασφαλές να ξανακληθεί (μία φορά ανά εγγραφή)."""
    from app.services import addon_service
    db = shared_db()
    out = []
    referrer = pending.get("referrer_tenant_id")
    lock = pending.get("price_lock")
    if lock and not await db["promotion_redemptions"].find_one({"pending_id": pending["_id"]}, {"_id": 1}):
        # η αγορά έγινε στην εγγραφή, όχι στο άνοιγμα λογαριασμού: το κλείδωμα μετρά από τότε
        await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
            "price_per_pharmacy": int(lock["package_net"]),
            "price_lock": {**lock, "promotions": [p["id"] for p in pending.get("promotions") or []]}}})
    afm = ((pending.get("company") or {}).get("afm") or "").strip()
    for p in pending.get("promotions") or []:
        rid = f"{p['id']}:{pending['_id']}"
        if await db["promotion_redemptions"].find_one({"_id": rid}, {"_id": 1}):
            continue
        special_conflict = False
        if p.get("audience") == "afm_list":
            special_conflict = not await _claim_special(db, p, afm, tenant_id, pending)
        grants = []
        for gift in ([] if special_conflict else p.get("gifts") or []):
            for target, role in gift_targets(gift, tenant_id, referrer):
                start = None
                try:
                    status, start = await _give(db, addon_service, target, gift, p["id"])
                except Exception:  # noqa: BLE001 — η εγγραφή δεν πρέπει να αποτύχει για ένα δώρο
                    status = "failed"
                grants.append({**gift, "tenant_id": target, "role": role, "status": status, "from": start})
        doc = {"_id": rid, "promotion_id": p["id"], "promotion_name": p.get("name"),
               "trigger": "signup", "pending_id": pending["_id"], "tenant_id": tenant_id,
               "referrer_tenant_id": referrer, "package": pending.get("package_code"),
               "cycle": pending.get("billing_cycle"), "discount_net": int(p.get("discount_net") or 0),
               "price_lock_until": (lock or {}).get("until"),
               "audience": p.get("audience") or "all", "afm": afm or None,
               "special_conflict": special_conflict,
               "grants": grants, "at": _now()}
        await db["promotion_redemptions"].insert_one(doc)
        out.append(doc)
        await _thank_referrer(doc)
    return out


async def _claim_special(db, p: dict, afm: str, tenant_id: str, pending: dict) -> bool:
    """ΜΙΑ φορά ανά ΑΦΜ, εγγυημένα από τη βάση: μόνο ένα `invited → redeemed` μπορεί να πετύχει.
    Αν χαθεί η κούρσα (δύο πληρωμένες εγγραφές του ίδιου ΑΦΜ), η πληρωμή έχει ήδη γίνει με την
    έκπτωση: καταγράφεται ως `special_conflict` για να το δει το adminpanel — δεν δίνονται δώρα
    ούτε κλείδωμα πακέτου."""
    if not afm:
        return False
    sp = pending.get("sponsor") if (pending.get("sponsor") or {}).get("promotion_id") == p["id"] else None
    res = await db["special_offer_afms"].update_one(
        {"_id": f"{p['id']}:{afm}", "status": "invited"},
        {"$set": {"status": "redeemed", "tenant_id": tenant_id, "pending_id": pending["_id"],
                  "redeemed_at": _now(), "sponsor": sp,
                  "pharmacy_paid_cents": int(pending.get("amount_cents") or 0)}})
    if not res.modified_count:
        return False
    until = add_months(_now(), int(p.get("offer_months") or 0))
    sponsor_name = None
    if sp:
        sponsor_name = ((await db["sponsors"].find_one({"_id": sp["sponsor_id"]}, {"name": 1})) or {}).get("name")
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {"offer_lock": {
        "promotion_id": p["id"], "name": p.get("name"), "package": pending.get("package_code"),
        "since": _now(), "until": until, "sponsor_name": sponsor_name}}})
    # Επανενεργοποίηση φαρμακείου που έχει ΗΔΗ συνδέσει ΗΔΥΚΑ: επιβεβαίωση αμέσως
    t = await db["tenants"].find_one({"_id": tenant_id}, {"hdika_afm": 1})
    if ((t or {}).get("hdika_afm") or {}).get("afm"):
        await verify_special_afm(tenant_id, t["hdika_afm"]["afm"])
    return True


# ── Πιστοποίηση ΑΦΜ από την ΗΔΥΚΑ (Φάση 2) ─────────────────────────────────────────────────
# Το ΑΦΜ της φόρμας εγγραφής το γράφει ο καθένας. Πιστοποίηση = το ΑΦΜ που επιστρέφει η ΙΔΙΑ η
# ΗΔΥΚΑ (`fetch_user_info` → taxRegistryNo) όταν το φαρμακείο συνδεθεί με τους κωδικούς του.
# ⚠ ΟΧΙ το `ingestion_config.hdika.afm`: η φόρμα ΗΔΥΚΑ επιτρέπει να γραφτεί ΑΦΜ με το χέρι.
# Η μόνη αξιόπιστη πηγή είναι το `tenants.hdika_afm`, που γράφει ΜΟΝΟ η ανακάλυψη προφίλ
# (`billing_identity.on_hdika_profile`). Μέτρηση 20/11/2026: σε 9/9 φαρμακεία το ΑΦΜ της ΗΔΥΚΑ
# ταυτίζεται με το ΑΦΜ τιμολόγησης — η ασυμφωνία είναι πραγματικό σήμα, όχι θόρυβος.
async def verify_special_afm(tenant_id: str, hdika_afm: str | None) -> dict:
    """Ταιριάζει → `verified` (οριστικό). Δεν ταιριάζει → ανάκληση. Ασφαλές να ξανακληθεί."""
    from app.utils.afm import is_valid, normalize
    afm = normalize(hdika_afm)
    if not is_valid(afm):
        return {"verified": 0, "revoked": 0}
    db = shared_db()
    verified = revoked = 0
    async for r in db["special_offer_afms"].find({"tenant_id": tenant_id, "status": "redeemed"}):
        if r["afm"] == afm:
            res = await db["special_offer_afms"].update_one(
                {"_id": r["_id"], "status": "redeemed", "tenant_id": tenant_id},
                {"$set": {"status": "verified", "verified_at": _now()}})
            verified += res.modified_count
            started = not r.get("starts_at") or _aware(r["starts_at"]) <= _now()
            if res.modified_count and started and (r.get("sponsor") or {}).get("sponsor_id"):
                from app.services import sponsors
                await sponsors.bill_activation(r)          # χρέωση χορηγού ΜΟΝΟ μετά την επιβεβαίωση
            # (υπάρχων πελάτης: η προσφορά ξεκινά στην ανανέωση → χρεώνεται εκεί, `_start_offer`)
        else:
            revoked += await _revoke_special(db, r, "afm_mismatch", hdika_afm=afm)
    return {"verified": verified, "revoked": revoked}


async def _revoke_special(db, row: dict, reason: str, *, hdika_afm: str | None = None) -> int:
    """Η προσφορά δεν ανήκε σε αυτό το φαρμακείο (ή δεν επιβεβαιώθηκε ποτέ):
      · το ΑΦΜ ΞΑΝΑΓΙΝΕΤΑΙ διαθέσιμο (`invited`), για τον πραγματικό δικαιούχο, με ιστορικό·
      · στη συνδρομή φεύγουν το κλείδωμα πακέτου και το κλείδωμα τιμής της προσφοράς → η επόμενη
        ανανέωση γίνεται με κανονική τιμή. Η τρέχουσα περίοδος ΔΕΝ κόβεται: είναι πληρωμένη και
        η απόφαση για τη διαφορά είναι ανθρώπινη (το βλέπει το adminpanel / ο νυχτερινός έλεγχος).
    Επιστρέφει 1 αν έγινε ανάκληση, 0 αν κάποιος άλλος πρόλαβε."""
    pid, tid = row["promotion_id"], row.get("tenant_id")
    res = await db["special_offer_afms"].update_one(
        {"_id": row["_id"], "status": "redeemed", "tenant_id": tid},
        {"$set": {"status": "invited"},
         "$unset": {"tenant_id": "", "pending_id": "", "redeemed_at": ""},
         "$push": {"rejections": {"tenant_id": tid, "reason": reason, "hdika_afm": hdika_afm,
                                  "redeemed_at": row.get("redeemed_at"), "at": _now()}}})
    if not res.modified_count:
        return 0
    sub = await db["subscriptions"].find_one({"tenant_id": tid}, {"offer_lock": 1, "price_lock": 1}) or {}
    # Δωρεάν ή με χορηγό: την περίοδο δεν την πλήρωσε κανείς (ο χορηγός χρεώνεται μόνο μετά την
    # επιβεβαίωση) → λήγει τώρα· το φαρμακείο μπαίνει στο κανονικό περιθώριο και ανανεώνει πληρώνοντας.
    started = not row.get("starts_at") or _aware(row["starts_at"]) <= _now()
    unpaid = started and (bool((row.get("sponsor") or {}).get("sponsor_id"))
                          or not int(row.get("pharmacy_paid_cents") or 0))
    unset = {}
    if (sub.get("offer_lock") or {}).get("promotion_id") == pid:
        unset["offer_lock"] = ""
    if pid in ((sub.get("price_lock") or {}).get("promotions") or []):
        unset["price_lock"] = ""
    upd: dict = {"$set": {"offer_revoked": {"promotion_id": pid, "reason": reason, "at": _now(),
                                            "period_ended": unpaid}}}
    if unpaid:
        upd["$set"]["current_period_end"] = _now()
    if unset:
        upd["$unset"] = unset
    await db["subscriptions"].update_one({"tenant_id": tid}, upd)
    await db["promotion_redemptions"].update_many(
        {"promotion_id": pid, "tenant_id": tid},
        {"$set": {"revoked": {"reason": reason, "hdika_afm": hdika_afm, "at": _now()}}})
    return 1


async def expire_unverified(now: datetime | None = None) -> dict:
    """Καθημερινά: εξαργυρώσεις χωρίς επιβεβαίωση ΗΔΥΚΑ μετά από SPECIAL_VERIFY_DAYS → ανάκληση.
    Πριν την ανάκληση, μια τελευταία προσπάθεια με ό,τι έχει ήδη δει η ΗΔΥΚΑ (`hdika_afm`)."""
    now = now or _now()
    db = shared_db()
    out = {"verified": 0, "revoked": 0}
    cutoff = now - timedelta(days=SPECIAL_VERIFY_DAYS)
    async for r in db["special_offer_afms"].find({"status": "redeemed", "redeemed_at": {"$lte": cutoff}}):
        t = await db["tenants"].find_one({"_id": r.get("tenant_id")}, {"hdika_afm": 1})
        seen = ((t or {}).get("hdika_afm") or {}).get("afm")
        if seen:
            res = await verify_special_afm(r["tenant_id"], seen)
            out["verified"] += res["verified"]
            out["revoked"] += res["revoked"]
        else:
            out["revoked"] += await _revoke_special(db, r, "not_verified")
    return out


def offer_lock_active(sub: dict | None, now: datetime | None = None) -> dict | None:
    """Η ΜΟΝΗ ερώτηση «είναι κλειδωμένο το πακέτο λόγω ειδικής προσφοράς;». Μετά το `until` απλώς
    δεν ισχύει — δεν χρειάζεται εργασία καθαρισμού."""
    lock = (sub or {}).get("offer_lock") or {}
    until = _aware(lock.get("until"))
    if not until or until <= (now or _now()):
        return None
    return lock


def offer_lock_blocks(sub: dict | None, package: str | None) -> dict | None:
    """Κλείδωμα που εμποδίζει τη μετάβαση σε `package` (None = επιτρέπεται). Το ίδιο πακέτο
    επιτρέπεται πάντα — π.χ. ανανέωση."""
    lock = offer_lock_active(sub)
    if lock and package and package != lock.get("package"):
        return lock
    return None


# ── Υπάρχοντες πελάτες (Φάση 4) ───────────────────────────────────────────────────────────
# Απόφαση ιδιοκτήτη (20/11/2026): η ειδική προσφορά ισχύει ΚΑΙ για όσους έχουν ήδη συνδρομή, από την
# ΕΠΟΜΕΝΗ ανανέωση (η τρέχουσα περίοδος είναι πληρωμένη). Ο πελάτης τη βλέπει στη σελίδα Χρέωση και
# την ΑΠΟΔΕΧΕΤΑΙ (μπορεί να σημαίνει αλλαγή πακέτου). Η αποδοχή:
#   · δεσμεύει το ΑΦΜ (ίδιο ατομικό `invited → redeemed`) με `starts_at` = λήξη τρέχουσας περιόδου·
#   · γράφει `offer_lock` (από τώρα: δεν αλλάζει πακέτο εκτός από αυτό της προσφοράς) με
#     `pending_start` και `price_lock` για τη νέα περίοδο → η ΜΙΑ πηγή τιμής ανανέωσης
#     (`billing_service.package_price`) χρεώνει αυτόματα την τιμή της προσφοράς·
#   · στην ανανέωση `start_due_offers` (καλείται στην αρχή του `bill_due` και του `expire_overdue`)
#     αλλάζει πακέτο αν χρειάζεται, και αν δεν υπάρχει τίποτα να πληρώσει (δωρεάν/χορηγός χωρίς
#     πρόσθετα) ανοίγει μόνο του τη νέα περίοδο· ο χορηγός χρεώνεται τότε.
def _offer_cycle(p: dict, current: str | None) -> str:
    cycles = p.get("cycles") or []
    if len(cycles) == 1:
        return cycles[0]
    return current if current in ("monthly", "yearly") else "yearly"


def _existing_quote(p: dict, pkg: dict, cycle: str, now: datetime) -> dict:
    """Τιμή πακέτου της προσφοράς για υπάρχοντα πελάτη (χωρίς πρόσθετα: αυτά ακολουθούν τον
    συνηθισμένο υπολογισμό ανανέωσης)."""
    list_net = int(pkg.get("price_yearly" if cycle == "yearly" else "price_monthly") or 0)
    ctx = {"package": pkg["_id"], "cycle": cycle, "returning": True, "promo_code": None, "referrer": None,
           "special_ids": {p["_id"]}}
    res = evaluate([p], ctx, package_net=list_net, total_net=list_net, now=now)
    offer_net = max(0, list_net - int(res["discount_net"]))
    sponsor = res.get("sponsor")
    sponsor_net = int((sponsor or {}).get("net") or 0)
    return {"list_net": list_net, "offer_net": offer_net, "sponsor": sponsor, "sponsor_net": sponsor_net,
            "pharmacy_net": max(0, offer_net - sponsor_net), "applies": bool(res["promotions"]),
            "gifts": gifts_of(p)}


async def _tenant_offer_ctx(tenant_id: str) -> dict | None:
    from app.services.billing_service import BILLED_STATES, effective_status
    from app.utils.afm import is_valid, normalize
    db = shared_db()
    t = await db["tenants"].find_one({"_id": tenant_id}, {"billing_profile": 1, "company": 1, "country": 1,
                                                          "hdika_afm": 1})
    afm = normalize(((t or {}).get("billing_profile") or {}).get("afm") or ((t or {}).get("company") or {}).get("afm"))
    if not is_valid(afm):
        return None
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    if sub.get("plan") in (None, "free_trial", "trial") or effective_status(sub) not in BILLED_STATES:
        return None                       # δοκιμή/ληγμένη: η προσφορά δίνεται από τη σελίδα εγγραφής
    if offer_lock_active(sub) or sub.get("complimentary"):
        return None
    ids = await special_ids_for(afm)
    if not ids:
        return None
    now = _now()
    for p in await live():
        if p["_id"] not in ids or p.get("audience") != "afm_list":
            continue
        if not (_aware(p["starts_at"]) <= now <= _aware(p["ends_at"])):
            continue
        limit = p.get("max_redemptions")
        if limit and int(p.get("redeemed") or 0) >= int(limit):
            continue
        pkg = await db["packages"].find_one({"_id": p["packages"][0]})
        if not pkg:
            continue
        cycle = _offer_cycle(p, sub.get("billing_cycle"))
        q = _existing_quote(p, pkg, cycle, now)
        if not q["applies"]:
            continue
        return {"tenant": t, "sub": sub, "afm": afm, "promo": p, "pkg": pkg, "cycle": cycle, "quote": q}
    return None


async def offer_for_tenant(tenant_id: str) -> dict | None:
    """Για τη σελίδα Χρέωση: υπάρχει ειδική προσφορά για ΑΥΤΟ το φαρμακείο; (καθαρά ποσά)"""
    c = await _tenant_offer_ctx(tenant_id)
    if not c:
        return None
    p, q, sub = c["promo"], c["quote"], c["sub"]
    sp_name = None
    if q["sponsor"]:
        sp_name = ((await shared_db()["sponsors"].find_one({"_id": q["sponsor"]["sponsor_id"]}, {"name": 1}))
                   or {}).get("name")
    names = await _module_names()
    return {"id": p["_id"], "name": p.get("name"), "public_text": p.get("public_text") or "",
            "package": c["pkg"]["_id"], "package_name": c["pkg"].get("name"),
            "package_changes": c["pkg"]["_id"] != sub.get("plan"), "cycle": c["cycle"],
            "offer_months": p.get("offer_months"), "starts_at": sub.get("current_period_end"),
            "list_net": q["list_net"], "offer_net": q["offer_net"], "sponsor_net": q["sponsor_net"],
            "pharmacy_net": q["pharmacy_net"], "sponsor_name": sp_name,
            "price_includes_vat": bool(c["pkg"].get("price_includes_vat")),
            "gifts": [gift_text(g, names.get(g["module"], g["module"])) for g in q["gifts"]]}


async def accept_for_tenant(tenant_id: str, *, by: str | None = None) -> dict:
    """Ο υπάρχων πελάτης αποδέχεται την ειδική προσφορά: ισχύει από την επόμενη ανανέωση."""
    c = await _tenant_offer_ctx(tenant_id)
    if not c:
        raise PromotionError("no_offer")
    db = shared_db()
    p, q, sub, afm = c["promo"], c["quote"], c["sub"], c["afm"]
    seen = ((c["tenant"] or {}).get("hdika_afm") or {}).get("afm")
    if seen and seen != afm:
        # η ΗΔΥΚΑ έχει ήδη δείξει άλλο ΑΦΜ για αυτό το φαρμακείο: η προσφορά δεν του ανήκει
        raise PromotionError("afm_mismatch")
    now = _now()
    starts = _aware(sub.get("current_period_end")) or now
    starts = max(starts, now)
    until = add_months(starts, int(p.get("offer_months") or 0))
    sponsor = ({**q["sponsor"], "net": q["sponsor_net"]} if q["sponsor"] else None)
    res = await db["special_offer_afms"].update_one(
        {"_id": f"{p['_id']}:{afm}", "status": "invited"},
        {"$set": {"status": "redeemed", "tenant_id": tenant_id, "redeemed_at": now, "mode": "existing",
                  "starts_at": starts, "sponsor": sponsor, "pharmacy_paid_cents": q["pharmacy_net"],
                  "accepted_by": by}})
    if not res.modified_count:
        raise PromotionError("no_offer")                # κάποιος πρόλαβε (διπλό κλικ / δεύτερη συνεδρία)
    sp_name = None
    if sponsor:
        sp_name = ((await db["sponsors"].find_one({"_id": sponsor["sponsor_id"]}, {"name": 1})) or {}).get("name")
    pkg_id = c["pkg"]["_id"]
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {
        "offer_lock": {"promotion_id": p["_id"], "name": p.get("name"), "package": pkg_id, "cycle": c["cycle"],
                       "since": starts, "until": until, "sponsor_name": sp_name, "pending_start": True,
                       "accepted_at": now},
        "price_lock": {"until": until, "package_net": q["pharmacy_net"], "list_package_net": q["list_net"],
                       "package": pkg_id, "cycle": c["cycle"], "promotions": [p["_id"]], "from": starts}}})
    # δώρα της προσφοράς (δωρεάν/φθηνότερα πρόσθετα): όπως στην εγγραφή — αν τα πληρώνει ήδη,
    # φυλάγονται για την επόμενη ανανέωση (`_give`)
    from app.services import addon_service
    grants = []
    for gift in q["gifts"]:
        try:
            status, start = await _give(db, addon_service, tenant_id, gift, p["_id"])
        except Exception:  # noqa: BLE001
            status, start = "failed", None
        grants.append({**gift, "tenant_id": tenant_id, "role": "buyer", "status": status, "from": start})
    await db["promotion_redemptions"].update_one({"_id": f"{p['_id']}:existing:{tenant_id}"}, {"$setOnInsert": {
        "promotion_id": p["_id"], "promotion_name": p.get("name"), "trigger": "existing",
        "tenant_id": tenant_id, "package": pkg_id, "cycle": c["cycle"], "audience": "afm_list", "afm": afm,
        "discount_net": q["list_net"] - q["offer_net"], "special_conflict": False, "starts_at": starts,
        "grants": grants, "at": now}}, upsert=True)
    if seen:                                            # η ΗΔΥΚΑ το έχει ήδη επιβεβαιώσει
        await verify_special_afm(tenant_id, seen)
    return {"ok": True, "starts_at": starts, "until": until, "package": pkg_id, "cycle": c["cycle"],
            "pharmacy_net": q["pharmacy_net"]}


async def start_due_offers(now: datetime | None = None) -> dict:
    """Στην ανανέωση: οι αποδεκτές προσφορές υπαρχόντων πελατών που ξεκινούν. Idempotent."""
    now = now or _now()
    db = shared_db()
    started = 0
    async for sub in db["subscriptions"].find({  # tenant-ok: beat χρεώσεων — όλες οι συνδρομές
            "offer_lock.pending_start": True, "offer_lock.since": {"$lte": now}}):
        if await _start_offer(db, sub, now):
            started += 1
    return {"started": started}


async def _start_offer(db, sub: dict, now: datetime) -> bool:
    from app.services.billing_service import recurring_extras, seats_for_package
    tid = sub["tenant_id"]
    lock = sub.get("offer_lock") or {}
    row = await db["special_offer_afms"].find_one(
        {"promotion_id": lock.get("promotion_id"), "tenant_id": tid, "status": {"$in": ["redeemed", "verified"]}})
    if not row:                                         # ανακλήθηκε στο μεταξύ
        await db["subscriptions"].update_one({"tenant_id": tid}, {"$unset": {"offer_lock.pending_start": ""}})
        return False
    pkg = await db["packages"].find_one({"_id": lock["package"]}) or {}
    cycle = lock.get("cycle") or sub.get("billing_cycle") or "monthly"
    upd: dict = {"offer_lock.pending_start": False, "offer_lock.started_at": now,
                 "price_per_pharmacy": int(row.get("pharmacy_paid_cents") or 0), "billing_cycle": cycle}
    if lock["package"] != sub.get("plan"):
        prev = await db["packages"].find_one({"_id": sub.get("plan")}) if sub.get("plan") else None
        upd.update({"plan": lock["package"], "plan_name": pkg.get("name"),
                    "seats": seats_for_package(pkg, current=sub.get("seats"), prev_pkg=prev),
                    "modules_included": pkg.get("modules", []),
                    "price_includes_vat": bool(pkg.get("price_includes_vat")),
                    "last_plan_change": {"kind": "special_offer", "at": now, "source": "special_offer",
                                         "from": sub.get("plan"), "to": lock["package"]}})
        if pkg.get("sla"):
            upd["sla"] = pkg["sla"]
    sub2 = {**sub, **{k: v for k, v in upd.items() if "." not in k}}
    extras = await recurring_extras(db, sub2, pkg, cycle == "yearly", now)
    nothing_to_pay = int(row.get("pharmacy_paid_cents") or 0) + int(extras.get("total") or 0) <= 0
    if nothing_to_pay:
        # δωρεάν ή όλα από τον χορηγό: η νέα περίοδος ανοίγει χωρίς χρέωση (κανένας πάροχος)
        frm = _aware(sub.get("current_period_end")) or now
        upd.update({"status": "active", "started_at": frm, "current_period_end": add_months(frm, 12 if cycle == "yearly" else 1),
                    "payment_status": sub.get("payment_status") if sub.get("payment_status") in ("card_saved", "active") else "no_card",
                    "payment_source": "sponsor" if (row.get("sponsor") or {}).get("sponsor_id") else "offer"})
    await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": upd})
    from app.services import addon_service
    await addon_service._recompute_total(tid)
    if row.get("status") == "verified" and (row.get("sponsor") or {}).get("sponsor_id"):
        from app.services import sponsors
        await sponsors.bill_activation(row)
    return True


# ── Λίστα ΑΦΜ ειδικής προσφοράς ────────────────────────────────────────────────────────────
async def special_ids_for(afm: str | None) -> set[str]:
    """Οι ειδικές προσφορές που ΜΠΟΡΕΙ ακόμη να πάρει αυτό το ΑΦΜ (στη λίστα, όχι εξαργυρωμένες)."""
    afm = (afm or "").strip()
    if not afm:
        return set()
    return {r["promotion_id"] async for r in shared_db()["special_offer_afms"].find(
        {"afm": afm, "status": "invited"}, {"promotion_id": 1})}


async def special_offer_for_afm(afm: str | None) -> dict | None:
    """Για τη σελίδα εγγραφής: υπάρχει ειδική προσφορά σε εξέλιξη για αυτό το ΑΦΜ; Επιστρέφει μόνο
    όνομα/πακέτο/κύκλους — ποτέ τη λίστα ή άλλα ΑΦΜ."""
    ids = await special_ids_for(afm)
    if not ids:
        return None
    now = _now()
    db = shared_db()
    for p in await live():
        if p["_id"] in ids and p.get("audience") == "afm_list" and \
                _aware(p["starts_at"]) <= now <= _aware(p["ends_at"]):
            limit = p.get("max_redemptions")
            if limit and int(p.get("redeemed") or 0) >= int(limit):
                continue
            pkg = await db["packages"].find_one({"_id": p["packages"][0]}, {"name": 1})
            return {"name": p.get("name"), "public_text": p.get("public_text") or "",
                    "package": p["packages"][0], "package_name": (pkg or {}).get("name"),
                    "cycles": p.get("cycles") or [], "offer_months": p.get("offer_months")}
    return None


_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_AFM_TOKEN_RE = re.compile(r"(?<![\w@.])(?:EL)?(\d{8,9})(?![\w@])", re.I)


def parse_afm_lines(raw: list[str] | str) -> tuple[list[tuple[str, str | None]], list[str]]:
    """Επικόλληση από Excel/κείμενο → [(ΑΦΜ, email ή None)], [άκυρα]. Ένα ΑΦΜ ανά γραμμή με
    προαιρετικό email δίπλα («123456789;fa@x.gr»), ή πολλά ΑΦΜ χωρισμένα με κόμμα/κενό. 8ψήφιο =
    χαμένο αρχικό 0 από το Excel → συμπληρώνεται."""
    from app.utils.afm import is_valid
    lines = raw if isinstance(raw, list) else (raw or "").splitlines()
    out: dict[str, str | None] = {}
    invalid: list[str] = []
    for line in lines:
        line = str(line or "")
        emails = _EMAIL_RE.findall(line)
        afms = [m.group(1).zfill(9) for m in _AFM_TOKEN_RE.finditer(_EMAIL_RE.sub(" ", line))]
        leftovers = [t for t in re.split(r"[\s,;]+", _EMAIL_RE.sub(" ", line)) if re.fullmatch(r"(?:EL)?\d+", t or "", re.I)
                     and not re.fullmatch(r"(?:EL)?\d{8,9}", t, re.I)]
        invalid += leftovers
        email = emails[0].lower() if len(emails) == 1 and len(afms) == 1 else None
        for a in afms:
            if not is_valid(a):
                invalid.append(a)
            elif a not in out or (email and not out[a]):
                out[a] = email
    return list(out.items()), invalid


async def add_special_afms(pid: str, raw: list[str] | str, *, by: str) -> dict:
    """Προσθήκη ΑΦΜ (με προαιρετικό email για την πρόσκληση). Άκυρα κατά ΑΑΔΕ αναφέρονται και δεν
    μπαίνουν· όσα υπάρχουν ήδη μένουν ως έχουν (δεν «ξανανοίγει» ένα εξαργυρωμένο) — μόνο το email
    τους συμπληρώνεται/διορθώνεται."""
    db = shared_db()
    p = await db["promotions"].find_one({"_id": pid}, {"audience": 1})
    if not p:
        raise PromotionError("not_found")
    if p.get("audience") != "afm_list":
        raise PromotionError("not_special")
    pairs, invalid = parse_afm_lines(raw)
    if len(pairs) > 5000:
        raise PromotionError("too_many_afms")
    added = with_email = 0
    for a, email in pairs:
        upd: dict = {"$setOnInsert": {"promotion_id": pid, "afm": a, "status": "invited",
                                      "added_at": _now(), "added_by": by}}
        if email:
            upd["$set"] = {"email": email}
            with_email += 1
        res = await db["special_offer_afms"].update_one({"_id": f"{pid}:{a}"}, upd, upsert=True)
        added += 1 if res.upserted_id else 0
    return {"added": added, "existing": len(pairs) - added, "invalid": invalid, "with_email": with_email}


async def send_invitations(pid: str, *, resend: bool = False, only: list[str] | None = None) -> dict:
    """Email πρόσκλησης σε όσα ΑΦΜ της λίστας δεν την έχουν πάρει ακόμη. Παραλήπτης: το email της
    γραμμής, αλλιώς το email χρέωσης του φαρμακείου αν είναι ήδη πελάτης. Νέο φαρμακείο → σύνδεσμος
    εγγραφής με το ΑΦΜ συμπληρωμένο· υπάρχων πελάτης → σελίδα Χρέωση. Χωρίς `resend`, όποιος έχει
    ήδη λάβει πρόσκληση παραλείπεται (κανένα διπλό email από δεύτερο πάτημα)."""
    from app.services import mailer
    from app.services.billing_service import BILLED_STATES, _billing_email, effective_status
    db = shared_db()
    p = await db["promotions"].find_one({"_id": pid})
    if not p or p.get("audience") != "afm_list":
        raise PromotionError("not_special")
    q: dict = {"promotion_id": pid, "status": "invited"}
    if only:
        q["afm"] = {"$in": only}
    if not resend:
        q["invite_sent_at"] = None
    pkg = await db["packages"].find_one({"_id": (p.get("packages") or [None])[0]}, {"name": 1}) or {}
    sponsor = await db["sponsors"].find_one({"_id": p.get("sponsor_id")}, {"name": 1}) if p.get("sponsor_id") else None
    sent = skipped = failed = 0
    async for r in db["special_offer_afms"].find(q):
        t = await db["tenants"].find_one({"billing_profile.afm": r["afm"]}, {"name": 1, "billing_profile": 1})
        to = r.get("email") or (await _billing_email(db, t["_id"], t) if t else None)
        if not to:
            skipped += 1
            continue
        existing = False
        if t:
            sub = await db["subscriptions"].find_one({"tenant_id": t["_id"]}) or {}
            existing = effective_status(sub) in BILLED_STATES and sub.get("plan") not in (None, "free_trial", "trial")
        link = ("https://app.rxvision.gr/settings/modules" if existing
                else f"https://app.rxvision.gr/register?afm={r['afm']}&package={pkg.get('_id') or ''}")
        html = _invitation_html(p, pkg.get("name") or "", (sponsor or {}).get("name"), link, existing)
        try:
            await mailer.send_email(to, f"RxVision — Ειδική προσφορά για το φαρμακείο σας: {p.get('name')}", html)
        except Exception:  # noqa: BLE001 — ένα λάθος email δεν σταματά τα υπόλοιπα
            failed += 1
            await db["special_offer_afms"].update_one({"_id": r["_id"]}, {"$set": {"invite_error": _now()}})
            continue
        sent += 1
        await db["special_offer_afms"].update_one({"_id": r["_id"]}, {
            "$set": {"invite_sent_at": _now(), "invite_to": to}, "$inc": {"invite_count": 1},
            "$unset": {"invite_error": ""}})
    return {"sent": sent, "skipped_no_email": skipped, "failed": failed}


def _invitation_html(p: dict, package_name: str, sponsor_name: str | None, link: str, existing: bool) -> str:
    from html import escape
    months = int(p.get("offer_months") or 0)
    who = f" με την ευγενική χορηγία της εταιρείας <b>{escape(sponsor_name)}</b>" if sponsor_name else ""
    action = ("Συνδεθείτε στο RxVision και πατήστε «Αποδοχή» στη σελίδα <b>Ρυθμίσεις → Χρέωση</b>. "
              "Η προσφορά ξεκινά από την επόμενη ανανέωση της συνδρομής σας."
              if existing else
              "Πατήστε τον σύνδεσμο: η σελίδα εγγραφής ανοίγει με το ΑΦΜ σας συμπληρωμένο και την προσφορά έτοιμη.")
    return (f"<p>Καλησπέρα σας,</p>"
            f"<p>Το φαρμακείο σας έχει <b>ειδική προσφορά</b> για το RxVision{who}: "
            f"<b>«{escape(p.get('name') or '')}»</b>.</p>"
            + (f"<p>{escape(p.get('public_text') or '')}</p>" if p.get("public_text") else "")
            + f"<p>Ισχύει για το πακέτο <b>{escape(package_name)}</b>, για {months} {'μήνα' if months == 1 else 'μήνες'}, "
              f"μία φορά ανά ΑΦΜ.</p><p>{action}</p>"
            f"<p><a href=\"{link}\">{'Άνοιγμα RxVision' if existing else 'Εγγραφή με την προσφορά'}</a></p>"
            f"<p style=\"color:#64748b;font-size:12px\">Ή αντιγράψτε τον σύνδεσμο: {link}</p>"
            f"<p>Ευχαριστούμε,<br>Η ομάδα του RxVision</p>")


async def list_special_afms(pid: str) -> list[dict]:
    db = shared_db()
    rows = [r async for r in db["special_offer_afms"].find({"promotion_id": pid}).sort("added_at", -1)]
    tids = [r["tenant_id"] for r in rows if r.get("tenant_id")]
    tids += [x["tenant_id"] for r in rows for x in r.get("rejections") or [] if x.get("tenant_id")]
    names = {t["_id"]: t.get("name") async for t in db["tenants"].find({"_id": {"$in": tids}}, {"name": 1})}
    for r in rows:
        r["tenant_name"] = names.get(r.get("tenant_id"))
        for x in r.get("rejections") or []:
            x["tenant_name"] = names.get(x.get("tenant_id"))
    return rows


async def remove_special_afm(pid: str, afm: str) -> dict:
    """Αφαιρείται μόνο ΑΦΜ που δεν την έχει πάρει — το εξαργυρωμένο είναι ιστορικό χρέωσης."""
    res = await shared_db()["special_offer_afms"].delete_one(
        {"_id": f"{pid}:{(afm or '').strip()}", "status": "invited"})
    if not res.deleted_count:
        raise PromotionError("afm_not_removable")
    return {"ok": True}


async def _give(db, addon_service, target: str, gift: dict, promotion_id: str) -> tuple[str, datetime | None]:
    """Δίνει ΕΝΑ δώρο σε ΕΝΑ φαρμακείο → (κατάσταση, από πότε ισχύει).

    Αν το φαρμακείο ΠΛΗΡΩΝΕΙ ήδη το πρόσθετο, το δώρο ΔΕΝ χάνεται (απόφαση ιδιοκτήτη 11/11/2026): φυλάγεται
    και ισχύει από την ΕΠΟΜΕΝΗ ανανέωσή του, ως έκπτωση στη χρέωση του προσθέτου (100% για «δωρεάν»).
    Αν το πρόσθετο περιλαμβάνεται στο πακέτο του, δεν υπάρχει τι να δοθεί."""
    sub = await db["subscriptions"].find_one({"tenant_id": target}) or {}
    module = gift["module"]
    if module in (sub.get("modules_included") or []):
        return "included_in_plan", None
    paid = pays_addon(sub, module)
    days = 30 * int(gift["months"]) if gift.get("kind") == "discount" else int(gift["days"])
    pct = int(gift["pct"]) if gift.get("kind") == "discount" else 100
    if not paid and gift.get("kind") != "discount":
        res = await addon_service.grant_preview(target, module, days=days, by=f"promo:{promotion_id}")
        return ("ok" if res.get("ok") else res.get("error", "failed")), _now()
    start = _now()
    if paid and _aware(sub.get("current_period_end")) and _aware(sub["current_period_end"]) > start:
        start = _aware(sub["current_period_end"])       # η τρέχουσα περίοδος είναι ήδη πληρωμένη
    await db["subscriptions"].update_one({"tenant_id": target}, {"$push": {"addon_discounts": {
        "module": module, "pct": pct, "from": start, "until": start + timedelta(days=days),
        "promotion_id": promotion_id, "at": _now()}}})
    return ("banked" if paid else "ok"), start


async def _thank_referrer(red: dict) -> None:
    gifts = [g for g in red["grants"] if g["role"] == "referrer" and g["status"] in ("ok", "banked")]
    if not gifts:
        return
    db = shared_db()
    tenant = await db["tenants"].find_one({"_id": red["referrer_tenant_id"]}) or {}
    from app.services.billing_service import _billing_email
    email = await _billing_email(db, tenant["_id"], tenant) if tenant else None
    if not email:
        return
    names = await _module_names()
    def when(g: dict) -> str:
        if g["status"] != "banked" or not g.get("from"):
            return ""
        return (f" — το έχετε ήδη, οπότε ισχύει από την επόμενη ανανέωσή σας "
                f"({_aware(g['from']).astimezone(ATHENS).strftime('%d/%m/%Y')}): δεν θα χρεωθείτε γι' αυτό")
    items = "".join(f"<li>{gift_text(g, '<b>' + names.get(g['module'], g['module']) + '</b>')}{when(g)}</li>"
                    for g in gifts)
    html = (f"<p>Γεια σας,</p><p>Ένα φαρμακείο ξεκίνησε συνδρομή στο RxVision με τη δική σας σύσταση. "
            f"Σας ευχαριστούμε! Σας χαρίσαμε:</p><ul>{items}</ul>"
            f"<p>Ισχύει ήδη στον λογαριασμό σας. Η έκπτωση σε πρόσθετο εφαρμόζεται μόνη της όταν το "
            f"ενεργοποιήσετε από τις Ρυθμίσεις → Δυνατότητες, και σε κάθε χρέωσή του σε αυτό το διάστημα.</p>")
    try:
        from app.services import mailer
        await mailer.send_email(email, "RxVision — ευχαριστούμε για τη σύσταση", html)
    except Exception:  # noqa: BLE001
        pass


async def public_offers() -> list[dict]:
    """Ό,τι δείχνει το δημόσιο site: ενέργειες σε εξέλιξη με «Εμφάνιση στο site», με την τιμή
    κάθε πακέτου πριν και μετά, ανά κύκλο χρέωσης. Χωρίς ονόματα πελατών ή μετρητές χρήσεων."""
    from app.services.invoice_service import gross_from_price
    db = shared_db()
    now = _now()
    names = await _module_names()
    pkgs = [p async for p in db["packages"].find({"active": True, "trial_days": {"$in": [0, None]}})
            if (p.get("price_monthly") or 0) > 0]
    out = []
    for p in await live():
        if not p.get("show_on_site") or p.get("audience") == "afm_list":
            continue
        prices = []
        for pkg in pkgs:
            rows = []
            for cycle in ("monthly", "yearly"):
                net = int(pkg.get("price_yearly" if cycle == "yearly" else "price_monthly") or 0)
                ctx = {"package": pkg["_id"], "cycle": cycle, "returning": p.get("customer") == "returning",
                       "promo_code": p.get("code"), "referrer": "site" if p.get("requires_referral") else None}
                if not net or not matches(p, ctx, now):
                    continue
                d = evaluate([p], ctx, package_net=net, total_net=net, now=now)["discount_net"]
                dr = evaluate([p], {**ctx, "referrer": "site"}, package_net=net, total_net=net, now=now)["discount_net"]
                inc = bool(pkg.get("price_includes_vat"))
                rows.append({"cycle": cycle, "net_before": net, "net_after": net - d,
                             "gross_before": gross_from_price(net, inc), "gross_after": gross_from_price(net - d, inc),
                             "gross_after_with_referral": gross_from_price(net - dr, inc)})
            if rows:
                prices.append({"package": pkg["_id"], "name": pkg.get("name"), "cycles": rows,
                               "signup_url": f"https://app.rxvision.gr/register?package={pkg['_id']}"
                                             + (f"&code={p['code']}" if p.get("code") else "")})
        if not prices:
            continue
        out.append({"id": p["_id"], "name": p.get("name"), "text": p.get("public_text") or "",
                    "starts_on": p.get("starts_on"), "ends_on": p.get("ends_on"), "ends_at": p.get("ends_at"),
                    "code": p.get("code"), "requires_referral": bool(p.get("requires_referral")),
                    "new_customers_only": p.get("customer") == "new",
                    "price_lock": lock_text(p.get("lock")), "packages": prices,
                    "gifts": [{**g, "module_name": names.get(g["module"], g["module"]),
                               "text": gift_text(g, names.get(g["module"], g["module"]))} for g in gifts_of(p)]})
    return out


def referral_promo_code(promos: list[dict], now: datetime | None = None) -> str | None:
    """Ο κωδικός της ενέργειας που τρέχει και ανταμείβει τις συστάσεις. Τον κουβαλά ο σύνδεσμος
    σύστασης και τον εννοεί ο κωδικός σύστασης, ώστε ο νέος πελάτης να μη χρειάζεται δύο κωδικούς."""
    hints = {h["name"] for h in referral_window_hint(promos, now)}
    coded = [p for p in promos if p.get("code") and p.get("name") in hints]
    coded.sort(key=lambda p: _aware(p["starts_at"]), reverse=True)
    return coded[0]["code"] if coded else None


def referral_window_hint(promos: list[dict], now: datetime | None = None) -> list[dict]:
    """Τι κερδίζει ένα φαρμακείο αν συστήσει κάποιον, για τις ενέργειες που τρέχουν τώρα."""
    now = now or _now()
    out = []
    for p in promos:
        if not (p.get("active") and _aware(p["starts_at"]) <= now <= _aware(p["ends_at"])):
            continue
        if p.get("audience") == "afm_list":
            continue
        gifts = [g for g in gifts_of(p)
                 if p.get("requires_referral") or g["referral_only"] or g["to"] != "buyer"]
        if not gifts:
            continue
        out.append({"name": p.get("name"), "public_text": p.get("public_text") or "",
                    "ends_on": p.get("ends_on"), "packages": p.get("packages") or [], "gifts": gifts})
    return out
