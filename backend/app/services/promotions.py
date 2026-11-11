"""Προωθητικές ενέργειες συνδρομών — ΜΙΑ πηγή για το «ποια προσφορά ισχύει και τι δίνει».

Μια ενέργεια = ΠΟΤΕ (χρονικό παράθυρο) + ΣΕ ΠΟΙΟΝ (πακέτα, κύκλος χρέωσης, νέος ή παλιός πελάτης,
κωδικός προσφοράς, σύσταση από άλλο φαρμακείο, όριο χρήσεων) + ΤΙ ΔΙΝΕΙ (λίστα αποτελεσμάτων:
έκπτωση %, έκπτωση σε ευρώ, δωρεάν δυνατότητα για Χ ημέρες στον νέο πελάτη, σε όποιον τον σύστησε
ή και στους δύο). Ο ιδιοκτήτης τις στήνει από το adminpanel, χωρίς αλλαγή κώδικα.

Σήμερα εφαρμόζονται στη ΝΕΑ ΣΥΝΔΡΟΜΗ από τη σελίδα εγγραφής: η έκπτωση μειώνει το ποσό της πρώτης
πληρωμής (και άρα το παραστατικό), και τα δώρα δίνονται όταν ανοίξει ο λογαριασμός (`redeem_signup`).

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
    return None


def lock_text(lock: dict | None) -> str:
    lock = lock or {}
    if lock.get("kind") == "years":
        n = int(lock.get("years") or 0)
        return f"η τιμή μένει ίδια για {n} {'χρόνο' if n == 1 else 'χρόνια'} από την αγορά"
    if lock.get("kind") == "until":
        return f"η τιμή μένει ίδια έως {'/'.join(reversed((lock.get('until_on') or '').split('-')))}"
    return ""


def matches(p: dict, ctx: dict, now: datetime) -> bool:
    """Ισχύει η ενέργεια `p` για αυτή την αγορά; `ctx`: package, cycle, returning (bool),
    promo_code, referrer (tenant id ή None)."""
    if not p.get("active"):
        return False
    if not (_aware(p["starts_at"]) <= now <= _aware(p["ends_at"])):
        return False
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


def _capped(discount: int, total_net: int) -> int:
    return max(0, min(discount, total_net - MIN_PAYABLE_NET))


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
    discount = _capped(sum(raw), total_net)
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
                        "gifts": gifts_of(p)})
    lock = None
    if ends:
        lock = {"until": max(ends), "package_net": max(0, package_net - package_part),
                "list_package_net": package_net, "package": ctx.get("package"), "cycle": ctx.get("cycle")}
    return {"promotions": applied, "discount_net": discount, "price_lock": lock}


def gift_targets(gift: dict, buyer: str, referrer: str | None) -> list[tuple[str, str]]:
    """(tenant_id, ρόλος) που παίρνουν ένα δώρο."""
    to = gift.get("to") or "buyer"
    out = []
    if to in ("buyer", "both"):
        out.append((buyer, "buyer"))
    if to in ("referrer", "both") and referrer:
        out.append((referrer, "referrer"))
    return out


def validate(doc: dict, addon_ids: set[str], package_ids: set[str]) -> dict:
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
            if kind == "discount_pct" and not 1 <= value <= 95:
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
    return {"name": name, "public_text": (doc.get("public_text") or "").strip()[:240],
            "active": bool(doc.get("active")), "starts_at": starts_at, "ends_at": ends_at,
            "starts_on": doc["starts_on"], "ends_on": doc["ends_on"],
            "packages": packages, "cycles": cycles, "customer": customer, "code": code,
            "requires_referral": requires_referral, "exclusive": bool(doc.get("exclusive")),
            "max_redemptions": int(limit) if limit else None, "effects": effects,
            "lock": lock, "show_on_site": bool(doc.get("show_on_site"))}


# ── Βάση ─────────────────────────────────────────────────────────────────────────────────────
async def _with_counts(promos: list[dict]) -> list[dict]:
    db = shared_db()
    counts = {r["_id"]: r["n"] async for r in db["promotion_redemptions"].aggregate([
        {"$group": {"_id": "$promotion_id", "n": {"$sum": 1}}}])}
    for p in promos:
        p["redeemed"] = counts.get(p["_id"], 0)
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
    clean = validate(doc, addon_ids, package_ids)
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
           "promo_code": effective_code, "referrer": referrer, "addon_prices": addon_prices or {}}
    res = evaluate(promos, ctx, package_net=package_net, total_net=total_net)
    code = normalize_code(promo_code)
    res.update({
        "referrer_tenant_id": referrer,
        "lock_text": next((p["lock_text"] for p in res["promotions"] if p["lock_text"]), ""),
        "referral_valid": None if not normalize_code(referral_code) else bool(referrer),
        "promo_code": code,
        "promo_code_valid": None if not code else any(p["code"] == code for p in res["promotions"]),
    })
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
    for p in pending.get("promotions") or []:
        rid = f"{p['id']}:{pending['_id']}"
        if await db["promotion_redemptions"].find_one({"_id": rid}, {"_id": 1}):
            continue
        grants = []
        for gift in p.get("gifts") or []:
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
               "grants": grants, "at": _now()}
        await db["promotion_redemptions"].insert_one(doc)
        out.append(doc)
        await _thank_referrer(doc)
    return out


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
        if not p.get("show_on_site"):
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
        gifts = [g for g in gifts_of(p)
                 if p.get("requires_referral") or g["referral_only"] or g["to"] != "buyer"]
        if not gifts:
            continue
        out.append({"name": p.get("name"), "public_text": p.get("public_text") or "",
                    "ends_on": p.get("ends_on"), "packages": p.get("packages") or [], "gifts": gifts})
    return out
