"""PII masking για «πελάτη παρουσίασης» (demo mode) — GDPR-safe επιδείξεις.

Όταν ο tenant είναι σε demo, κρύβουμε ευαίσθητα στοιχεία ασθενή (επίθετο + μέρος ΑΜΚΑ)
παντού όπου εμφανίζονται, ώστε να γίνεται παρουσίαση χωρίς έκθεση πραγματικών δεδομένων.
"""
from __future__ import annotations


def mask_name(name: str | None, demo: bool) -> str | None:
    """Κρύβει το ΕΠΙΘΕΤΟ (1ο token) → αρχικό + «•••», κρατά το όνομα.
    π.χ. «ΠΑΠΑΔΟΠΟΥΛΟΣ ΜΑΡΙΑ» → «Π••• ΜΑΡΙΑ». Μονολεκτικό → αρχικό + «•••»."""
    if not demo or not name:
        return name
    parts = str(name).split()
    if len(parts) >= 2:
        return f"{parts[0][:1]}••• " + " ".join(parts[1:])
    return f"{str(name)[:1]}•••"


def mask_amka(amka: str | None, demo: bool) -> str | None:
    """Κρύβει το μεσαίο/μοναδικό τμήμα του ΑΜΚΑ — κρατά 4 πρώτα + 2 τελευταία.
    π.χ. «01017002607» → «0101•••07»."""
    if not demo or not amka:
        return amka
    s = str(amka)
    if len(s) <= 6:
        return "•" * len(s)
    return s[:4] + "•" * (len(s) - 6) + s[-2:]
