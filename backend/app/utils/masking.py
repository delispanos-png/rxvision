"""PII redaction για «πελάτη παρουσίασης» (demo mode) — GDPR-safe επιδείξεις.

Όταν ο tenant είναι σε demo, ΚΑΘΕ προσωπικό στοιχείο ασθενή/ιατρού ΑΠΟΚΡΥΠΤΕΤΑΙ ως «****» (redaction).
ΔΕΝ αλλάζουμε τα ονόματα σε άλλα (ψευδώνυμα): προκαλούσε πρόβλημα στο κομμάτι ερωτήσεων του AI/copilot
(το LLM νόμιζε ότι τα fake ονόματα είναι πραγματικά). Το «****» είναι σαφές, ουδέτερο, δεν παραπλανά.
"""
from __future__ import annotations

REDACT = "****"


def mask_surname(surname: str | None, demo: bool) -> str | None:
    """Επίθετο → πρώτο γράμμα + «****» (π.χ. «ΠΑΠΑΔΟΠΟΥΛΟΥ» → «Π****»)."""
    if not demo or not surname:
        return surname
    s = str(surname).strip()
    return f"{s[:1]}****" if s else s


def mask_name(name: str | None, demo: bool) -> str | None:
    """Ονοματεπώνυμο ασθενή/ιατρού → κρύβουμε ΚΥΡΙΩΣ το ΕΠΙΘΕΤΟ (1ο token) με αστεράκια, ΚΡΑΤΑΜΕ το
    μικρό όνομα. Μορφή δεδομένων «ΕΠΙΘΕΤΟ ΟΝΟΜΑ» → π.χ. «ΠΑΠΑΔΟΠΟΥΛΟΥ ΜΑΡΙΑ» → «Π**** ΜΑΡΙΑ».
    Μονολεκτικό → πρώτο γράμμα + «****»."""
    if not demo or not name:
        return name
    parts = str(name).split()
    if len(parts) >= 2:
        return f"{parts[0][:1]}**** " + " ".join(parts[1:])
    return f"{parts[0][:1]}****" if parts else name


# alias παλιάς ονομασίας ψευδωνύμων — όλα τα call sites συνεχίζουν να δουλεύουν
pseudo_name = mask_name


def mask_amka(amka: str | None, demo: bool) -> str | None:
    """ΑΜΚΑ → «****» σε demo (καμία μερική έκθεση)."""
    return REDACT if (demo and amka) else amka


pseudo_amka = mask_amka


def pseudo_phone(phone: str | None, demo: bool) -> str | None:
    return REDACT if (demo and phone) else phone


def pseudo_email(email: str | None, demo: bool) -> str | None:
    return REDACT if (demo and email) else email


def pseudo_area(area: str | None, demo: bool) -> str | None:
    return REDACT if (demo and area) else area


def pseudo_address(addr: str | None, demo: bool) -> str | None:
    return REDACT if (demo and addr) else addr


def pseudo_id(idnum: str | None, demo: bool) -> str | None:
    return REDACT if (demo and idnum) else idnum


# ── Κλειδιά dict που περιέχουν PII — αποκρύπτονται ομοιόμορφα σε κάθε λίστα αποτελεσμάτων ──
_NAME_KEYS = ("name", "full_name", "patient_name", "doctor_name", "prescriber_name", "member_name",
              "pharmacy_name")   # το όνομα φαρμακείου = όνομα φαρμακοποιού (προσωπικό) → μερική απόκρυψη
_REDACT_KEYS = (
    "amka", "phone", "mobile", "telephone", "tel", "email",
    "residence_area", "residence_area_canonical", "area", "city",
    "address", "street", "id_number", "id_card", "identity_number",
)


def mask_row(row: dict, demo: bool) -> dict:
    """In-place απόκρυψη ενός dict αποτελέσματος: όνομα(τα), ΑΜΚΑ, τηλέφωνο, email, περιοχή,
    διεύθυνση, ταυτότητα → «****». No-op αν δεν είμαστε σε demo."""
    if not demo or not isinstance(row, dict):
        return row
    for k in _NAME_KEYS:
        if row.get(k):
            row[k] = mask_name(row[k], True)   # μερικό: κρύβει επίθετο, κρατά μικρό όνομα
    for k in _REDACT_KEYS:
        if row.get(k):
            row[k] = REDACT
    return row


def mask_rows(rows: list[dict] | None, demo: bool) -> list[dict] | None:
    """Αποκρύπτει κάθε dict μιας λίστας (in-place). Επιστρέφει την ίδια λίστα για chaining."""
    if demo and rows:
        for r in rows:
            mask_row(r, True)
    return rows
