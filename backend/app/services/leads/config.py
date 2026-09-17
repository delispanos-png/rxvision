"""Ρυθμίσεις Lead Engine — ΟΛΑ τα κατώφλια, τα βάρη και τα παράθυρα σε ένα σημείο.

Γιατί ρύθμιση και όχι σταθερές στον κώδικα: τα νούμερα εδώ είναι εμπορικές αποφάσεις
(«πότε λέμε ότι τελειώνει μια δοκιμή», «πόσο μετράει ότι σύνδεσε τα δεδομένα του»), όχι
τεχνικές. Ο ιδιοκτήτης πρέπει να μπορεί να τα αλλάξει χωρίς deploy.
"""

from __future__ import annotations

from app.core.db import shared_db

SETTINGS_ID = "leads"

# ── χρονικά παράθυρα ────────────────────────────────────────────────────────────────────────
DEFAULTS: dict = {
    "trial_ending_days": 7,             # πόσες μέρες πριν λέμε «τελειώνει»
    "expired_buckets": [7, 30, 60, 90],  # καλάθια «πόσο καιρό πριν έληξε»
    "signup_abandoned_hours": 24,       # πότε μια ημιτελής εγγραφή γίνεται lead
    "inactive_days": 30,                # πάνω από τόσο = «δεν έχει επιστρέψει»
    "returned_after_days": 7,           # σιωπή τόσων ημερών → η επιστροφή είναι σήμα
    "needs_contact_days": 3,            # έληξε και δεν του μιλήσαμε τόσες μέρες → κόκκινο
    # ── επικοινωνία (Φάση 2) ──
    "require_optin": True,              # ΑΥΣΤΗΡΟ by default — βλ. LEAD_COMMUNICATION §5
    "frequency_cap": 3,                 # προωθητικά ανά 30 ημέρες
    "cooldown_days": 7,                 # ελάχιστο διάστημα μεταξύ δύο προωθητικών
    # ── προσφορές (Φάση 3) ──
    "max_discount_pct": 50,
    "lead_retention_months": 24,
}

# ── βάρη σκορ ───────────────────────────────────────────────────────────────────────────────
# Κάθε σήμα έχει ΛΟΓΟ σε ανθρώπινη γλώσσα — το σκορ πρέπει πάντα να μπορεί να εξηγηθεί.
WEIGHTS: dict = {
    "data_connected": 25,       # σύνδεσε ΗΔΥΚΑ — το ισχυρότερο σήμα πρόθεσης
    "actions_30d": 20,          # όγκος ενεργειών (λογαριθμικά, με ταβάνι)
    "active_days_30d": 15,      # πόσες ΔΙΑΦΟΡΕΤΙΚΕΣ μέρες μπήκε
    "breadth": 10,              # πόσες διαφορετικές περιοχές του προϊόντος άγγιξε
    "asked_for_demo": 15,       # ζήτησε δοκιμή/παρουσίαση από pop-up
    "returned": 10,             # ξαναμπήκε μετά από σιωπή
    "reached_checkout": 8,      # έφτασε στο ταμείο χωρίς να πληρώσει
    "no_activity": -15,         # καμία κίνηση πάνω από `inactive_days`
    "never_logged_in": -20,     # ποτέ δεν μπήκε
}

BANDS = [(81, "hot", "Το δούλεψε πολύ"), (51, "engaged", "Το δοκίμασε σοβαρά"),
         (21, "warm", "Μπήκε λίγο"), (0, "cold", "Σχεδόν δεν το άνοιξε")]


def band(value: int | None) -> tuple[str, str]:
    if value is None:
        return "unknown", "Δεν το ξέρουμε πια"
    for floor, key, label in BANDS:
        if value >= floor:
            return key, label
    return "cold", "Σχεδόν δεν το άνοιξε"


async def get() -> dict:
    doc = await shared_db()["platform_settings"].find_one({"_id": SETTINGS_ID}) or {}
    out = {**DEFAULTS, **{k: v for k, v in doc.items() if k in DEFAULTS and v is not None}}
    out["weights"] = {**WEIGHTS, **(doc.get("weights") or {})}
    return out


async def save(data: dict, *, by: str | None = None) -> dict:
    """Μερική ενημέρωση — μόνο γνωστά κλειδιά. Άγνωστο κλειδί αγνοείται σιωπηλά ώστε μια
    παλιά φόρμα να μη γράφει σκουπίδια στις ρυθμίσεις."""
    from datetime import datetime, timezone
    upd = {k: v for k, v in (data or {}).items() if k in DEFAULTS and v is not None}
    weights = {k: int(v) for k, v in ((data or {}).get("weights") or {}).items() if k in WEIGHTS}
    if weights:
        upd["weights"] = {**WEIGHTS, **weights}
    if not upd:
        return await get()
    upd["updated_at"] = datetime.now(tz=timezone.utc)
    upd["updated_by"] = by
    await shared_db()["platform_settings"].update_one(
        {"_id": SETTINGS_ID}, {"$set": upd}, upsert=True)
    return await get()
