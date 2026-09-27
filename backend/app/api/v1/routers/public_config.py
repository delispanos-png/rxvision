"""Δημόσιες ρυθμίσεις που χρειάζεται ο browser ΠΡΙΝ τη σύνδεση.

ΓΙΑΤΙ ΔΗΜΟΣΙΟ: το script της παρακολούθησης πρέπει να φορτώσει και στη σελίδα σύνδεσης, όπου
κανείς δεν έχει ακόμη διακριτικό. Το project id του Clarity **δεν είναι μυστικό** — βρίσκεται
στον πηγαίο κώδικα κάθε σελίδας που το χρησιμοποιεί.

ΤΙ ΔΕΝ ΜΠΑΙΝΕΙ ΕΔΩ: ο,τιδήποτε μπορεί να διαβαστεί από τον καθένα και δεν πρέπει.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.core.db import shared_db

router = APIRouter()

_SURFACES = {"app": "clarity_app", "portal": "clarity_portal"}


@router.get("/clarity/{surface}")
async def clarity(surface: str) -> dict:
    """Project id του Clarity για `app` (εφαρμογή φαρμακείου) ή `portal` (πύλη πελατών).

    Το adminpanel ΔΕΝ παρακολουθείται — ρητή επιλογή ιδιοκτήτη.
    """
    key = _SURFACES.get(surface)
    if not key:
        return {"id": ""}
    d = await shared_db()["platform_settings"].find_one({"_id": "analytics"}) or {}
    if not d.get("clarity_enabled", True):
        return {"id": ""}
    return {"id": str(d.get(key) or "")}
