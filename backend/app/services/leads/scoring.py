"""Σκορ δραστηριότητας lead — ΜΟΝΟ από σήματα που πραγματικά μετράμε.

Ο κανόνας του ιδιοκτήτη είναι «καμία ψεύτικη μέτρηση». Εδώ αυτό σημαίνει ότι το σκορ ΔΕΝ
περιλαμβάνει ανοίγματα email (δεν υπάρχουν πριν τη Φάση 2) ούτε προβολές σελίδων (το
`audit_logs` καταγράφει μόνο μεταβολές, όχι GET). Θα ήταν μηδενικά ντυμένα σαν μέτρηση.

Κάθε σήμα κουβαλά τον ΛΟΓΟ του σε ελληνικά, ώστε το UI να μπορεί πάντα να εξηγήσει το
νούμερο. Νούμερο που δεν εξηγείται δεν το εμπιστεύεται κανείς — και σωστά.
"""

from __future__ import annotations

import math

from app.services.leads import config as cfg


def compute(activity: dict, flags: dict, weights: dict) -> dict:
    """activity = τα μετρημένα (ενέργειες, ημέρες, περιοχές)· flags = γεγονότα (ζήτησε demo…)."""
    signals: list[dict] = []

    def add(key: str, points: int, why: str) -> None:
        if points:
            signals.append({"key": key, "points": int(points), "why": why})

    if flags.get("data_connected"):
        add("data_connected", weights["data_connected"], "Σύνδεσε τα δεδομένα του από την ΗΔΥΚΑ")

    # Λογαριθμικά: η διαφορά 5→50 ενέργειες μετράει πολύ, η 500→5.000 σχεδόν καθόλου.
    # Γραμμικά, το ΜΠΙΝΙΚΟΣ με 9.601 ενέργειες θα έπνιγε κάθε άλλο σήμα.
    n30 = int(activity.get("actions_30d") or 0)
    if n30 > 0:
        add("actions_30d", round(weights["actions_30d"] * min(1.0, math.log10(n30 + 1) / 2.0)),
            f"{n30} ενέργειες μέσα στον μήνα")

    days = int(activity.get("active_days_30d") or 0)
    if days > 0:
        add("active_days_30d", round(weights["active_days_30d"] * min(1.0, days / 12.0)),
            f"Μπήκε {days} διαφορετικές ημέρες")

    areas = list(activity.get("features") or [])
    if len(areas) >= 3:
        add("breadth", weights["breadth"], f"Δοκίμασε {len(areas)} διαφορετικά μέρη του RxVision")

    if flags.get("asked_for_demo"):
        add("asked_for_demo", weights["asked_for_demo"], "Ζήτησε δοκιμή ή παρουσίαση")
    if activity.get("returned_after_days"):
        add("returned", weights["returned"],
            f"Ξαναμπήκε μετά από {int(activity['returned_after_days'])} ημέρες σιωπής")
    if flags.get("reached_checkout"):
        add("reached_checkout", weights["reached_checkout"], "Έφτασε στο ταμείο χωρίς να ολοκληρώσει")

    if flags.get("never_logged_in"):
        add("never_logged_in", weights["never_logged_in"], "Δεν συνδέθηκε ποτέ")
    else:
        idle = activity.get("days_since_activity")
        if idle is not None and idle > 30:
            add("no_activity", weights["no_activity"], f"Καμία κίνηση εδώ και {int(idle)} ημέρες")

    value = max(0, min(100, sum(s["points"] for s in signals)))
    key, label = cfg.band(value)
    return {"value": value, "band": key, "band_label": label,
            "signals": sorted(signals, key=lambda s: -abs(s["points"]))}
