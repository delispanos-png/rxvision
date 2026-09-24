"""ΕΝΑ σημείο απόφασης: «μπορεί ακόμη να δοθεί;»

Μια ανεκτέλεστη γραμμή είναι ανακτήσιμη μόνο αν ΙΣΧΥΟΥΝ ΔΥΟ ΑΝΕΞΑΡΤΗΤΑ πράγματα:

  1. Ο ΛΟΓΟΣ — η συνταγή έμεινε ανοιχτή (ΗΔΥΚΑ execution_case 0). Όταν έκλεισε με τη συμφωνία
     του ασθενή (2) ή λόγω ασυμφωνίας δοσολογίας (3), δεν ξανανοίγει ποτέ.
  2. ΤΟ ΡΟΛΟΪ — δεν έχει περάσει η προθεσμία (`valid_until` / deadline_date). Μετά από αυτήν
     η ΗΔΥΚΑ ΔΕΝ επιτρέπει εκτέλεση· το παράθυρο έκλεισε οριστικά.

Ελέγχαμε μόνο τον λόγο. Στα πραγματικά δεδομένα (24/09/2026) οι 25.325 από τις 26.778 ανοιχτές
με ανεκτέλεστα είχαν ΗΔΗ ΛΗΞΕΙ — οι 14.586 πάνω από έναν χρόνο — και τις δείχναμε στον
φαρμακοποιό ως «ο ασθενής μπορεί να γυρίσει».

⚠ ΠΡΟΣΟΧΗ ΣΤΗ ΔΙΑΚΡΙΣΗ — ΜΗΝ το βάλεις παντού:
  • «ΑΝΑΚΤΗΣΙΜΟ» = πράξη που μπορείς να κάνεις ΣΗΜΕΡΑ (τηλέφωνο, υπενθύμιση, Copilot) → ΕΔΩ.
  • «ΧΑΘΗΚΕ»     = ιστορικό γεγονός. Συνταγή που έληξε ανεκτέλεστη ΟΝΤΩΣ χάθηκε, και η
                   αναφορά χαμένου τζίρου σωστά τη μετράει. ΜΗ φιλτράρεις εκεί με τη λήξη.
"""

from __future__ import annotations

from datetime import datetime, time, timezone

# ΗΔΥΚΑ execution_case 0 = μερική που ΜΕΝΕΙ ΑΝΟΙΧΤΗ (το μόνο ανακτήσιμο). Αποθηκεύεται
# άλλοτε ως συμβολοσειρά κι άλλοτε ως αριθμός — δέξου και τα δύο.
RECOVERABLE_CASE = {"$in": ["0", 0]}


def _naive(dt: datetime | None) -> datetime | None:
    """Σε naive UTC — οι ημερομηνίες ισχύος γράφονται naive, το `now()` συχνά aware."""
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def deadline_floor(now: datetime | None = None) -> datetime:
    """Το κατώφλι σύγκρισης: η ΑΡΧΗ της σημερινής ημέρας.

    Το `valid_until` είναι μεσάνυχτα της ημέρας λήξης. Συνταγή με λήξη «σήμερα» εκτελείται
    ΚΑΝΟΝΙΚΑ σήμερα — σύγκριση με την τρέχουσα ΩΡΑ θα τη σκότωνε από το πρωί. Όπου υπάρχει
    αμφιβολία γέρνουμε προς το «ακόμη ανακτήσιμο»: καλύτερα να προτείνουμε μια φορά παραπάνω
    παρά να κρύψουμε συνταγή που ο φαρμακοποιός μπορεί να εκτελέσει.
    """
    n = _naive(now) or datetime.now(timezone.utc).replace(tzinfo=None)
    return datetime.combine(n.date(), time.min)


def mongo_filter(now: datetime | None = None) -> dict:
    """Κομμάτι query για εκτελέσεις που ΜΠΟΡΟΥΝ ακόμη να ολοκληρωθούν."""
    # `$not: {$lt}` αντί για `$gte`: πιάνει ΚΑΙ όσες δεν έχουν ημερομηνία λήξης, ακριβώς όπως
    # κάνει η `reason()` («δεν μαντεύουμε → μένει ανοιχτή»). Με σκέτο `$gte` οι δύο συναρτήσεις
    # θα απαντούσαν διαφορετικά μόλις μια πηγή σταματούσε να στέλνει προθεσμία.
    return {"has_unexecuted_substances": True,
            "details.execution_case": RECOVERABLE_CASE,
            "valid_until": {"$not": {"$lt": deadline_floor(now)}}}


def is_recoverable(ex: dict, now: datetime | None = None) -> bool:
    return reason(ex, now) == "open"


def reason(ex: dict, now: datetime | None = None) -> str | None:
    """Γιατί έμειναν ανεκτέλεστα — σε γλώσσα που οδηγεί σε ΠΡΑΞΗ.

    None            → δεν έχει ανεκτέλεστα
    "open"          → ΜΕΝΕΙ ΑΝΟΙΧΤΗ και ΣΕ ΙΣΧΥ: ο ασθενής μπορεί να γυρίσει — το μόνο ανακτήσιμο
    "expired"       → έμεινε ανοιχτή αλλά ΠΕΡΑΣΕ Η ΠΡΟΘΕΣΜΙΑ: δεν δίνεται πια
    "patient_choice"→ έκλεισε ΜΕ ΤΗ ΣΥΜΦΩΝΙΑ του: επέλεξε να μην τα πάρει
    "dosage_mismatch"→ έκλεισε λόγω ασυμφωνίας δοσολογίας/ποσότητας
    "unknown"       → η ΗΔΥΚΑ δεν έδωσε τύπο εκτέλεσης
    """
    if not ex.get("has_unexecuted_substances"):
        return None
    case = (ex.get("details") or {}).get("execution_case")
    why = {"0": "open", 0: "open",
           "2": "patient_choice", 2: "patient_choice",
           "3": "dosage_mismatch", 3: "dosage_mismatch"}.get(case, "unknown")
    if why != "open":
        return why
    vu = _naive(ex.get("valid_until"))
    # Χωρίς ημερομηνία λήξης δεν μαντεύουμε — μένει «ανοιχτή» (η παλιά συμπεριφορά).
    return "expired" if vu is not None and vu < deadline_floor(now) else "open"
