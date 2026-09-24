"""RxVision Connect — ΕΝΑ σημείο υπολογισμού «πόσο μπορώ να διαθέσω».

ΓΙΑΤΙ ΕΔΩ ΚΑΙ ΠΟΥΘΕΝΑ ΑΛΛΟΥ (§35 της προδιαγραφής): ο υπολογισμός ακουμπά απόθεμα, πολιτική
ανά ομάδα, καθολικό όριο, απόθεμα ασφαλείας και ενεργές κρατήσεις. Αν επαναλαμβανόταν στην
οθόνη ή σε δεύτερο service, θα απέκλιναν και το φαρμακείο θα υποσχόταν τεμάχια που δεν έχει.

ΔΥΟ ΤΡΟΠΟΙ (απόφαση ιδιοκτήτη 24/09/2026):
  · Το είδος ΕΧΕΙ απόθεμα στο RxVision  → «υπολογισμένη» διαθεσιμότητα, αυτόματη απάντηση.
  · Το είδος ΔΕΝ έχει                   → `None` = «ρώτα τον φαρμακοποιό».

Το `None` ΔΕΝ είναι μηδέν. Μηδέν σημαίνει «δεν έχω»· None σημαίνει «δεν ξέρουμε» — και η
διαφορά είναι όλο το κύκλωμα: σήμερα 13 από τα 41.127 είδη έχουν καταχωρημένο απόθεμα.
"""

from __future__ import annotations

DEFAULTS = {
    "global_pct": 30,          # ό,τι κι αν λένε οι ομάδες, ποτέ πάνω απ' αυτό
    "safety_qty": 0,           # τεμάχια που κρατώ ΠΑΝΤΑ για το φαρμακείο μου
    "auto_offer": True,        # αυτόματη απάντηση όπου ξέρουμε το ράφι
    "reservation_minutes": 60,
    "require_doc_ref": False,  # να ζητείται αρ. παραστατικού πριν το κλείσιμο κίνησης
}


def policy_for(policy: dict | None, group_id: str | None) -> dict:
    """Η ενεργή πολιτική για μια ομάδα: προεπιλογές ← πολιτική φαρμακείου ← πολιτική ομάδας."""
    p = {**DEFAULTS, **{k: v for k, v in (policy or {}).items() if v is not None}}
    per_group = (policy or {}).get("per_group") or {}
    if group_id and group_id in per_group:
        try:
            p["group_pct"] = max(0, min(100, int(per_group[group_id])))
        except (TypeError, ValueError):
            p["group_pct"] = p["global_pct"]
    else:
        p["group_pct"] = p["global_pct"]
    p["global_pct"] = max(0, min(100, int(p.get("global_pct") or 0)))
    p["safety_qty"] = max(0, int(p.get("safety_qty") or 0))
    return p


def available_qty(stock_qty: int | None, policy: dict | None, *, group_id: str | None = None,
                  reserved: int = 0) -> int | None:
    """Πόσα τεμάχια επιτρέπεται να προσφερθούν ΤΩΡΑ. `None` = άγνωστο απόθεμα → ρώτα άνθρωπο.

    Το `reserved` είναι ΚΑΘΟΛΙΚΟ (όλες οι ομάδες μαζί): δύο ομάδες δεν επιτρέπεται να
    καταναλώσουν το ίδιο τεμάχιο δύο φορές (σενάριο 13 της προδιαγραφής).
    """
    if stock_qty is None:
        return None
    stock = int(stock_qty)
    if stock <= 0:
        return 0
    p = policy_for(policy, group_id)
    pct = min(p["group_pct"], p["global_pct"])
    by_pct = (stock * pct) // 100
    by_safety = stock - p["safety_qty"]
    return max(0, min(by_pct, by_safety) - max(0, int(reserved or 0)))
