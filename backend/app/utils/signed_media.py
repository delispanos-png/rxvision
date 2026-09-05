"""Υπογεγραμμένα (signed) URLs για μέσα που ΔΕΝ μπορούν να στείλουν bearer token.

ΓΙΑΤΙ (έλεγχος ασφαλείας 2026-09, L4): η φωτογραφία προφίλ ασθενή σερβιριζόταν δημόσια με βάση ένα
opaque ObjectId. Είναι **βιομετρικού τύπου PII** (πρόσωπο) — αν το id διαρρεύσει (log, referer,
screenshot URL, ιστορικό), η φωτογραφία είναι προσβάσιμη από οποιονδήποτε, για πάντα.

Τα `<img>` δεν στέλνουν Authorization header, οπότε η λύση είναι υπογεγραμμένο URL με λήξη:
`/patient/avatar/<id>?exp=<unix>&sig=<hmac>`. Το κλειδί είναι το JWT_PATIENT_SECRET (ίδιο πεδίο
εμπιστοσύνης με την πύλη ασθενή) — δεν προστίθεται νέο μυστικό προς διαχείριση.
"""
from __future__ import annotations

import hashlib
import hmac
import time

from app.core.config import settings

# Οι διευθύνσεις επιστρέφονται σε κάθε κλήση προφίλ, οπότε μια εβδομάδα είναι άνετη για caching
# χωρίς να αφήνει μόνιμα ανοιχτό σύνδεσμο.
AVATAR_URL_TTL_SECONDS = 7 * 24 * 3600


def _sig(image_id: str, exp: int) -> str:
    msg = f"avatar:{image_id}:{exp}".encode()
    return hmac.new(settings.JWT_PATIENT_SECRET.encode(), msg, hashlib.sha256).hexdigest()[:32]


def avatar_url(image_id: str | None) -> str | None:
    """Υπογεγραμμένο, ληγόμενο URL για τη φωτογραφία προφίλ. None → None."""
    if not image_id:
        return None
    exp = int(time.time()) + AVATAR_URL_TTL_SECONDS
    return f"/patient/avatar/{image_id}?exp={exp}&sig={_sig(str(image_id), exp)}"


def avatar_sig_valid(image_id: str, exp: str | int | None, sig: str | None) -> bool:
    """Έλεγχος υπογραφής + λήξης, σε σταθερό χρόνο."""
    if not exp or not sig:
        return False
    try:
        exp_i = int(exp)
    except (TypeError, ValueError):
        return False
    if exp_i < int(time.time()):
        return False
    return hmac.compare_digest(_sig(str(image_id), exp_i), str(sig))
