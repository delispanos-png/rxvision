"""Όρια AI ερωτημάτων ΑΝΑ φαρμακείο (PharmaCat/Copilot/Advice) — ΕΝΙΑΙΑ γλώσσα με τα ΠΑΚΕΤΑ.

ΤΟ ΜΟΝΤΕΛΟ, ΜΕ ΔΥΟ ΠΡΟΤΑΣΕΙΣ:
1. Κάθε φαρμακείο έχει ΔΩΡΕΑΝ προϋπολογισμό σε ΕΥΡΩ κάθε μήνα — ένα πεδίο, το
   `packages.ai_budget_cents` (0 = κανένα δωρεάν AI). Ανανεώνεται την 1η του μήνα.
2. Ό,τι ξεπερνά αυτόν αντλείται από το ΠΡΟΠΛΗΡΩΜΕΝΟ ΠΟΡΤΟΦΟΛΙ του (`ai_credits`), που **δεν
   λήγει ποτέ**: αγοράζει π.χ. 100 € και τα ξοδεύει σε μία μέρα ή σε έναν χρόνο, όπως θέλει.

ΓΙΑΤΙ ΣΕ ΕΥΡΩ ΚΑΙ ΟΧΙ ΣΕ ΕΡΩΤΗΣΕΙΣ: μία ερώτηση κοστίζει 0,03€–0,32€ (διαφορά 10×), οπότε ένα
όριο «Ν ερωτήσεις» δεν λέει τίποτα για την έκθεσή μας.

Τα cache-hits ΜΕΤΡΟΥΝ ως ερωτήσεις (source="cache") αλλά ΔΕΝ χρεώνονται: η απάντηση υπήρχε ήδη
και δεν μας κόστισε τίποτα. Κρατάμε breakdown (n_llm/n_cache) για διαφάνεια προς τον πελάτη.

Μετρητής: `llm_daily_usage` doc `_id="ai:{tenant}:{YYYY-MM-DD}"`· μηνιαία μέτρηση = άθροισμα των
ημερήσιων docs του μήνα. ⚠ ΤΟ TTL ΤΟΥ ΕΙΝΑΙ ΜΕΡΟΣ ΤΟΥ ΦΡΕΝΟΥ: ήταν 2 ΗΜΕΡΕΣ και έσβηνε τη
μέτρηση, οπότε ο μηνιαίος προϋπολογισμός ΔΕΝ γέμιζε ΠΟΤΕ και το πορτοφόλι δεν χρεωνόταν ποτέ
(διορθώθηκε 24/09/2026 → 400 ημέρες, βλ. `core/db.py`).
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
        # ΜΟΝΟ ΓΙΑ ΕΜΦΑΝΙΣΗ: πλήθος ερωτήσεων. Η ΧΡΕΩΣΗ γίνεται αποκλειστικά σε ΕΥΡΩ
        # (`included_budget`) — μία ερώτηση κοστίζει 0,03€–0,32€, οπότε το πλήθος δεν λέει τίποτα
        # για την έκθεσή μας. Δεν υπάρχει πεδίο στο adminpanel· μένει για τα παλιά πακέτα.
        pkg = await db["packages"].find_one({"_id": plan}, {"ai_included": 1})
        if pkg and pkg.get("ai_included") is not None:
            try:
                return max(0, int(pkg["ai_included"])), "month"
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
            # ΔΥΟ ΔΙΑΦΟΡΕΤΙΚΕΣ ΠΕΡΙΟΔΟΙ, και δεν επιτρέπεται να μπερδεύονται: το `period` αφορά το
            # όριο ΕΡΩΤΗΣΕΩΝ (ημερήσιο), το `budget_period` τον προϋπολογισμό σε € (πάντα μηνιαίος).
            # Όποιος έδειχνε το ποσό με την ετικέτα του `period` έγραφε «5,00 €/μέρα» για μηνιαίο
            # όριο — 30× λάθος, και στην οθόνη του ΠΕΛΑΤΗ. (Διόρθωση 25/09/2026.)
            "budget_period": b_period,
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
        pkg = await db["packages"].find_one({"_id": plan}, {"ai_budget_cents": 1})
        # ΕΝΑ ΠΕΔΙΟ, ΜΙΑ ΑΛΗΘΕΙΑ: το ποσό αποφασίζει· 0 = κανένα δωρεάν AI. Υπήρχαν ΔΥΟ
        # χειριστήρια (διακόπτης `ai_free_enabled` + ποσό) και αναπόφευκτα διαφώνησαν: το Growth
        # έγραφε 3,00 € με τον διακόπτη κλειστό, δηλαδή έδινε μηδέν ενώ η οθόνη έλεγε 3 €.
        # Η περίοδος είναι ΠΑΝΤΑ μήνας — ποτέ δεν χρησιμοποιήθηκε άλλη. (Καθαρισμός 24/09/2026.)
        if pkg and pkg.get("ai_budget_cents") is not None:
            try:
                return max(0, int(pkg["ai_budget_cents"])), "month"
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


# ── ΚΑΘΟΛΙΚΟ ΦΡΕΝΟ ΠΛΑΤΦΟΡΜΑΣ ───────────────────────────────────────────────────────────────
# ΓΙΑΤΙ: τα όρια ανά φαρμακείο δεν προστατεύουν ΕΜΑΣ. Οι δικές μας εργασίες (κατηγοριοποιήσεις,
# εμπλουτισμοί) δεν ανήκουν σε κανένα φαρμακείο — έτρεχαν χωρίς κανένα όριο και μπόρεσαν να
# κάνουν 12 € σε μία ημέρα. Αυτό εδώ είναι ένα ΣΚΛΗΡΟ ταβάνι σε ευρώ για ΟΛΑ μαζί.
PLATFORM_DAILY_CAP_CENTS = 800          # 8,00 €/ημέρα — ρυθμιζόμενο από το adminpanel


async def platform_daily_cap(db=None) -> int:
    db = db if db is not None else shared_db()
    doc = await db["platform_settings"].find_one({"_id": "ai_quota"}) or {}
    try:
        v = int(doc.get("platform_daily_cap_cents"))
        return max(0, v)
    except (TypeError, ValueError):
        return PLATFORM_DAILY_CAP_CENTS


async def platform_spent_today(db=None) -> float:
    """Ό,τι ξοδεύτηκε ΣΗΜΕΡΑ συνολικά — πελάτες ΚΑΙ δικές μας εργασίες — σε λεπτά €."""
    db = db if db is not None else shared_db()
    rows = await db["llm_daily_usage"].aggregate([   # tenant-ok: μετρητής πλατφόρμας
        {"$match": {"_id": {"$regex": f":{_day()}$"}}},
        {"$group": {"_id": None, "c": {"$sum": "$cost_micro"}}}]).to_list(length=1)
    return (int(rows[0]["c"]) if rows and rows[0].get("c") else 0) / 1_000_000


async def platform_allows(db=None) -> tuple[bool, float, int]:
    """(επιτρέπεται, ξοδεύτηκε_σήμερα_λεπτά, ταβάνι_λεπτά). 0 ταβάνι = χωρίς όριο."""
    db = db if db is not None else shared_db()
    cap = await platform_daily_cap(db)
    if cap <= 0:
        return (True, 0.0, 0)
    spent = await platform_spent_today(db)
    return (spent < cap, spent, cap)


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
    db = shared_db()
    # ΤΟ ΚΑΘΟΛΙΚΟ ΤΑΒΑΝΙ ΑΦΟΡΑ ΜΟΝΟ ΤΙΣ ΔΙΚΕΣ ΜΑΣ ΕΡΓΑΣΙΕΣ — ποτέ πελάτη που πληρώνει.
    # Ο πελάτης έχει ΔΙΚΟ του όριο, αυτό του πακέτου του· θα ήταν λάθος να τον κόψει μια δική
    # μας μαζική κατηγοριοποίηση που ξέφυγε. Το ταβάνι φυλάει ΕΜΑΣ από εμάς.
    if not tenant_id or str(tenant_id).startswith("__"):
        ok_platform, _spent, cap = await platform_allows(db)
        if not ok_platform:
            return (False, 0, cap, "platform_cap")
    if not tenant_id:
        # ΠΑΛΙΑ: «χωρίς tenant → μη περιοριστικό». Αυτό σήμαινε ΑΠΕΡΙΟΡΙΣΤΕΣ κλήσεις χωρίς
        # καταγραφή. Τώρα δένεται στον κάδο πλατφόρμας, που έχει το δικό του ταβάνι παραπάνω.
        return (True, 0, AI_DEFAULT_DAILY, None)
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
