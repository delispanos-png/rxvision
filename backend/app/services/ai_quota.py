"""Όρια AI ερωτημάτων ΑΝΑ φαρμακείο (PharmaCat/Copilot/Advice) — ΕΝΙΑΙΑ γλώσσα με τα ΠΑΚΕΤΑ.

Το AI key είναι ΚΕΝΤΡΙΚΟ (πλατφόρμα). Κάθε φαρμακείο δικαιούται έναν αριθμό ΔΩΡΕΑΝ ερωτημάτων που
ΟΡΙΖΕΤΑΙ ΑΠΟ ΤΟ ΠΑΚΕΤΟ ΤΟΥ (`packages.ai_included` + `ai_included_period` = "month" σύνολο/μήνα ή
"day" ανά ημέρα). Πάνω από αυτό → αγορά επιπλέον (AI credits — Phase C). Τα cache-hits ΜΕΤΡΟΥΝ κι αυτά
(source="cache"), αλλά κρατάμε breakdown ΓΙΑ ΕΜΑΣ (n_llm/n_cache).

Fallback: αν το πακέτο δεν έχει ορίσει `ai_included`, ισχύει το καθολικό `base_daily_free` (ημερήσιο).

Μετρητής: `llm_daily_usage` doc `_id="ai:{tenant}:{YYYY-MM-DD}"` (κοινό με το prescriptor cap)· μηνιαία
μέτρηση = άθροισμα των ημερήσιων docs του μήνα.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from pymongo import ReturnDocument

from app.core.db import shared_db

AI_DEFAULT_DAILY = 50            # καθολικό fallback (χωρίς ρύθμιση) — ημερήσιο
AI_MAX_DAILY = 20000            # ασφαλές ταβάνι για το ρυθμιζόμενο base
TRIAL_AI_CAP = 30               # ΣΥΝΟΛΙΚΟ όριο AI ερωτήσεων για ΟΛΗ τη δοκιμαστική (όλα τα AI μαζί)


def _day() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")


async def trial_ai_cap(db=None) -> int:
    """Συνολικό όριο AI ερωτήσεων για ΟΛΗ τη δοκιμαστική περίοδο (διατροφή + PharmaCat + Copilot μαζί).
    Ρυθμιζόμενο από platform admin (`platform_settings._id="ai_quota".trial_ai_cap`)· default TRIAL_AI_CAP."""
    db = db if db is not None else shared_db()
    doc = await db["platform_settings"].find_one({"_id": "ai_quota"})
    v = (doc or {}).get("trial_ai_cap")
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return TRIAL_AI_CAP


async def _is_trial(db, tenant_id: str) -> bool:
    """True όταν η συνδρομή του φαρμακείου είναι σε δοκιμαστική (effective_status == 'trial')."""
    from app.services.billing_service import effective_status
    sub = await db["subscriptions"].find_one(
        {"tenant_id": tenant_id},
        {"status": 1, "trial_ends_at": 1, "current_period_end": 1, "plan": 1})
    return effective_status(sub) == "trial"


async def base_daily_free(db=None) -> int:
    """Καθολικό δωρεάν ημερήσιο fallback (μόνο για πακέτα ΧΩΡΙΣ ai_included). Ρυθμιζόμενο από τον
    platform admin (`platform_settings._id="ai_quota".base_daily_free`)· default `AI_DEFAULT_DAILY`."""
    db = db if db is not None else shared_db()
    doc = await db["platform_settings"].find_one({"_id": "ai_quota"})
    v = (doc or {}).get("base_daily_free")
    try:
        return max(0, min(AI_MAX_DAILY, int(v)))
    except (TypeError, ValueError):
        return AI_DEFAULT_DAILY


async def included_allowance(db, tenant_id: str) -> tuple[int, str]:
    """Δωρεάν AI allowance ΑΠΟ ΤΟ ΠΑΚΕΤΟ του φαρμακείου: (πλήθος, περίοδος 'month'|'day'). Αν το πακέτο
    δεν έχει ορίσει `ai_included` → fallback στο καθολικό base_daily_free (ημερήσιο).
    ΔΟΚΙΜΑΣΤΙΚΗ: αγνοεί το πακέτο — ισχύει ΕΝΑ συνολικό όριο (period 'trial') για όλη τη δοκιμαστική."""
    if await _is_trial(db, tenant_id):
        return await trial_ai_cap(db), "trial"
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}, {"plan": 1})
    plan = (sub or {}).get("plan")
    if plan:
        pkg = await db["packages"].find_one(
            {"_id": plan}, {"ai_included": 1, "ai_included_period": 1, "ai_free_enabled": 1})
        # ΡΗΤΟΣ ΔΙΑΚΟΠΤΗΣ: ai_free_enabled=False → ΜΗΔΕΝ δωρεάν AI, τελεία. Λύνει την παγίδα όπου ένα
        # πακέτο χωρίς ρύθμιση έπεφτε στο καθολικό fallback (20/ημέρα ≈ 600/μήνα) και χάριζε AI σιωπηλά.
        # None/True = ως είχε (συμβατότητα με τα υπάρχοντα πακέτα).
        if pkg is not None and pkg.get("ai_free_enabled") is False:
            per = pkg.get("ai_included_period") if pkg.get("ai_included_period") in ("month", "day", "year") else "month"
            return 0, per
        if pkg and pkg.get("ai_included") is not None:
            period = pkg.get("ai_included_period") if pkg.get("ai_included_period") in ("month", "day", "year") else "month"
            try:
                return max(0, int(pkg["ai_included"])), period
            except (TypeError, ValueError):
                pass
    return await base_daily_free(db), "day"


async def _used_in_period(db, tenant_id: str, period: str) -> int:
    if period == "trial":                       # ΣΥΝΟΛΟ όλης της δοκιμαστικής (κάθε ημέρα)
        rows = await db["llm_daily_usage"].aggregate([
            {"$match": {"_id": {"$regex": "^" + re.escape(f"ai:{tenant_id}:")}}},
            {"$group": {"_id": None, "n": {"$sum": "$n"}}}]).to_list(length=1)
        return int(rows[0]["n"]) if rows else 0
    if period in ("month", "year"):
        fmt = "%Y-%m" if period == "month" else "%Y"
        prefix = f"ai:{tenant_id}:{datetime.now(tz=timezone.utc).strftime(fmt)}"
        rows = await db["llm_daily_usage"].aggregate([
            {"$match": {"_id": {"$regex": "^" + re.escape(prefix)}}},
            {"$group": {"_id": None, "n": {"$sum": "$n"}}}]).to_list(length=1)
        return int(rows[0]["n"]) if rows else 0
    doc = await db["llm_daily_usage"].find_one({"_id": f"ai:{tenant_id}:{_day()}"})
    return int((doc or {}).get("n", 0))


async def usage_today(db, tenant_id: str) -> int:
    doc = await db["llm_daily_usage"].find_one({"_id": f"ai:{tenant_id}:{_day()}"})
    return int((doc or {}).get("n", 0))


async def usage_breakdown_today(db, tenant_id: str) -> dict:
    """Σημερινή χρήση σπασμένη ανά πηγή: total, ai (πραγματική AI κλήση), local (τοπική βάση γνώσεων)."""
    doc = await db["llm_daily_usage"].find_one({"_id": f"ai:{tenant_id}:{_day()}"}) or {}
    return {"total": int(doc.get("n", 0)), "ai": int(doc.get("n_llm", 0)), "local": int(doc.get("n_cache", 0))}


async def status_for(db, tenant_id: str) -> dict:
    """Εικόνα ορίου AI για ΕΝΑ φαρμακείο, στη γλώσσα των πακέτων: πόσα δικαιούται (included) στην
    περίοδό του και πόσα έχει καταναλώσει (used) στην ΤΡΕΧΟΥΣΑ περίοδο."""
    included, period = await included_allowance(db, tenant_id)
    used = await _used_in_period(db, tenant_id, period)
    from app.services import ai_credits
    # ΜΟΝΑΔΑ = ΕΥΡΩ (2026-09). Το πλήθος ερωτήσεων μένει μόνο ως ένδειξη· η αλήθεια είναι τα λεπτά.
    budget_cents, b_period = await included_budget(db, tenant_id)
    spent_cents = await spent_cents_in_period(db, tenant_id, b_period)
    wallet_cents = await ai_credits.balance(tenant_id)
    return {"included": included, "period": period, "used": used,
            "remaining": max(0, included - used), "credits": wallet_cents,
            "budget_cents": budget_cents, "spent_cents": round(spent_cents, 2),
            "budget_remaining_cents": round(max(0.0, budget_cents - spent_cents), 2),
            "wallet_cents": wallet_cents}


async def included_budget(db, tenant_id: str) -> tuple[int, str]:
    """Δωρεάν AI **ΠΡΟΫΠΟΛΟΓΙΣΜΟΣ** του πακέτου σε λεπτά του ευρώ: (cents, περίοδος).

    ΓΙΑΤΙ ΥΠΑΡΧΕΙ: το όριο «Ν ερωτήσεις» ΔΕΝ είναι ασφαλές — μία ερώτηση μπορεί να κοστίσει από
    0,03€ (απλή, 1 κλήση) έως 0,32€ (βαριά, 6 κλήσεις με εργαλεία), δηλαδή διαφορά 10×. Έτσι το
    ίδιο όριο «400» μπορεί να μας κοστίσει από 12€ έως 127€ — πάνω από τη συνδρομή. Ο προϋπολογισμός
    σε ευρώ κάνει την έκθεσή μας ΝΤΕΤΕΡΜΙΝΙΣΤΙΚΗ: 5€ είναι 5€, ό,τι κι αν ρωτήσει ο πελάτης.

    0 = απενεργοποιημένο (ισχύει μόνο το όριο ερωτήσεων) — έτσι δεν αλλάζει τίποτα μέχρι να το ορίσεις.
    """
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}, {"plan": 1})
    plan = (sub or {}).get("plan")
    if plan:
        pkg = await db["packages"].find_one(
            {"_id": plan}, {"ai_budget_cents": 1, "ai_included_period": 1, "ai_free_enabled": 1})
        if pkg is not None and pkg.get("ai_free_enabled") is False:
            return 0, "month"        # χωρίς δωρεάν AI → δεν υπάρχει προϋπολογισμός να ξοδευτεί
        if pkg and pkg.get("ai_budget_cents") is not None:
            period = pkg.get("ai_included_period") if pkg.get("ai_included_period") in ("month", "day", "year") else "month"
            try:
                return max(0, int(pkg["ai_budget_cents"])), period
            except (TypeError, ValueError):
                pass
    return 0, "month"


async def spent_cents_in_period(db, tenant_id: str, period: str) -> float:
    """Πραγματικό κόστος (σε λεπτά €) που έχει ξοδέψει το φαρμακείο στην περίοδο — από cost_micro."""
    if period in ("month", "year"):
        fmt = "%Y-%m" if period == "month" else "%Y"
        prefix = f"ai:{tenant_id}:{datetime.now(tz=timezone.utc).strftime(fmt)}"
    elif period == "trial":
        prefix = f"ai:{tenant_id}:"
    else:
        prefix = f"ai:{tenant_id}:{_day()}"
    rows = await db["llm_daily_usage"].aggregate([
        {"$match": {"_id": {"$regex": "^" + re.escape(prefix)}}},
        {"$group": {"_id": None, "c": {"$sum": "$cost_micro"}}}]).to_list(length=1)
    return (int(rows[0]["c"]) if rows and rows[0].get("c") else 0) / 1_000_000


async def check_and_consume(tenant_id: str, source: str = "llm") -> tuple[bool, int, int, str | None]:
    """Καταγράφει 1 ερώτημα και αποφασίζει αν επιτρέπεται — **ΜΕ ΜΟΝΑΔΑ ΤΟ ΕΥΡΩ**.

    ΓΙΑΤΙ ΟΧΙ ΠΛΗΘΟΣ ΕΡΩΤΗΣΕΩΝ (αλλαγή 2026-09): μία ερώτηση κοστίζει 0,036€–0,141€ ανάλογα με το
    πόσες κλήσεις εργαλείων χρειάστηκε (έως 6) — διαφορά 10×. Άρα ένα όριο «Ν ερωτήσεις» δεν λέει
    τίποτα για την έκθεσή μας: «400» μπορεί να σημαίνει 12€ ή 127€. Ο προϋπολογισμός σε ευρώ την
    κάνει ντετερμινιστική. Το πλήθος συνεχίζει να μετριέται ΜΟΝΟ για εμφάνιση/στατιστικά.

    Σειρά: (1) εντός δωρεάν προϋπολογισμού περιόδου → ΟΚ· (2) αλλιώς, αν υπάρχει υπόλοιπο
    προπληρωμένων credits → ΟΚ (η πραγματική αφαίρεση γίνεται στο ai_cost.record με το ΑΛΗΘΙΝΟ
    κόστος)· (3) αλλιώς → μπλοκ.
    """
    if not tenant_id:
        return (True, 0, AI_DEFAULT_DAILY, None)   # χωρίς tenant → μη περιοριστικό (ασφάλεια)
    db = shared_db()
    budget_cents, period = await included_budget(db, tenant_id)
    included, _p = await included_allowance(db, tenant_id)      # μόνο για εμφάνιση
    key = f"ai:{tenant_id}:{_day()}"
    sub = "n_cache" if source == "cache" else "n_llm"
    await db["llm_daily_usage"].find_one_and_update(   # tenant-ok: platform usage meter
        {"_id": key}, {"$inc": {"n": 1, sub: 1}, "$setOnInsert": {"at": datetime.now(tz=timezone.utc)}},
        upsert=True, return_document=ReturnDocument.AFTER)
    used = await _used_in_period(db, tenant_id, period)

    spent = await spent_cents_in_period(db, tenant_id, period)
    if budget_cents > 0 and spent < budget_cents:
        return (True, used, included, None)          # εντός δωρεάν προϋπολογισμού

    from app.services import ai_credits
    if await ai_credits.balance(tenant_id) > 0:      # προπληρωμένο υπόλοιπο → επιτρέπεται
        return (True, used, included, "credit")

    await db["llm_daily_usage"].update_one({"_id": key}, {"$inc": {"n": -1, sub: -1}})   # rollback
    return (False, used, included, "budget_exhausted" if budget_cents > 0 else "quota_exceeded")
