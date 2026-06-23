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


# Κλειδιά dict που περιέχουν PII ασθενή — μασκάρονται ομοιόμορφα σε κάθε λίστα αποτελεσμάτων.
_NAME_KEYS = ("name", "full_name", "patient_name")
_AMKA_KEYS = ("amka",)
_CONTACT_KEYS = ("phone", "mobile", "email")  # σε demo → None (καμία επικοινωνία/έκθεση)


def mask_row(row: dict, demo: bool) -> dict:
    """In-place masking ενός dict αποτελέσματος: επίθετο (name/full_name/patient_name),
    ΑΜΚΑ, και μηδενισμός τηλεφώνου/email. No-op αν δεν είμαστε σε demo."""
    if not demo or not isinstance(row, dict):
        return row
    for k in _NAME_KEYS:
        if row.get(k):
            row[k] = mask_name(row[k], True)
    for k in _AMKA_KEYS:
        if row.get(k):
            row[k] = mask_amka(row[k], True)
    for k in _CONTACT_KEYS:
        if k in row:
            row[k] = None
    return row


def mask_rows(rows: list[dict] | None, demo: bool) -> list[dict] | None:
    """Μασκάρει κάθε dict μιας λίστας (in-place). Επιστρέφει την ίδια λίστα για chaining."""
    if demo and rows:
        for r in rows:
            mask_row(r, True)
    return rows
