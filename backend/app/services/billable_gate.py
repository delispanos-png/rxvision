"""ΕΝΑ σημείο απόφασης: ποια χρεώσιμα κυκλώματα επιτρέπονται χωρίς καταχωρημένη κάρτα.

ΓΙΑΤΙ ΚΕΝΤΡΙΚΑ: ο κανόνας «ό,τι μας χρωστάει χρήματα θέλει κάρτα» θα ξαναγραφόταν σε κάθε νέο
χρεώσιμο κύκλωμα, και το πρώτο που θα τον ξεχνούσε θα ήταν αυτό που θα μας κόστιζε. Ίδια λογική
με το `ingestion_gate` για τον συγχρονισμό: ένας ορισμός, ένα σημείο ελέγχου, όλοι οι καλούντες
παίρνουν την ίδια απάντηση.

ΤΙ ΜΕΤΡΑΕΙ ΩΣ «ΧΡΕΩΣΙΜΟ»: ό,τι δημιουργεί οφειλή προς εμάς ΜΕΤΑ τη χρήση (post-paid) —
πρόσθετα, προμήθειες e-shop. Τα ΠΡΟΠΛΗΡΩΜΕΝΑ (credits μηνυμάτων) είναι διαφορετική περίπτωση:
εκεί ο πελάτης έχει ήδη πληρώσει, οπότε ο κανόνας ορίζεται ρητά ανά χαρακτηριστικό και όχι
σιωπηρά.
"""

from __future__ import annotations

#: feature → μήνυμα που βλέπει ο φαρμακοποιός όταν λείπει κάρτα.
_REASONS: dict[str, str] = {
    "addons": "Για να ενεργοποιήσεις χρεώσιμο πρόσθετο χρειάζεται καταχωρημένη κάρτα.",
    "eshop": "Για να λειτουργήσει το ηλεκτρονικό σου κατάστημα χρειάζεται καταχωρημένη κάρτα — "
             "η προμήθεια ανά παραγγελία χρεώνεται σ' αυτήν.",
    # ΠΡΟΣΟΧΗ: αφορά την ΑΓΟΡΑ credits, ΟΧΙ την αποστολή. Τα credits είναι προπληρωμένα — όποιος
    # τα έχει ήδη αγοράσει τα ξοδεύει κανονικά· θα ήταν παρακράτηση χρημάτων που έχει πληρώσει.
    "messaging_topup": "Για να αγοράσεις credits μηνυμάτων χρειάζεται καταχωρημένη κάρτα.",
}

WHERE_TO_FIX = " Πρόσθεσέ την από τις Ρυθμίσεις → Χρέωση."


async def blocked_reason(tenant_id: str, feature: str) -> str | None:
    """Μήνυμα αν το χαρακτηριστικό είναι κλειδωμένο λόγω έλλειψης κάρτας, αλλιώς None."""
    from app.services import billing_service
    if feature not in _REASONS:
        return None
    if await billing_service.card_on_file(tenant_id):
        return None
    return _REASONS[feature] + WHERE_TO_FIX


async def require_card(tenant_id: str, feature: str) -> None:
    """Ίδιος έλεγχος, αλλά πετάει 409 — για χρήση απευθείας σε endpoint."""
    reason = await blocked_reason(tenant_id, feature)
    if reason:
        from fastapi import HTTPException, status
        raise HTTPException(status.HTTP_409_CONFLICT,
                            detail={"error": "card_required", "message": reason})
