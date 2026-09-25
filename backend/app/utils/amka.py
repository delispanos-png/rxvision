"""ΕΝΑ σημείο απόφασης για «είναι ανήλικος;».

ΓΙΑΤΙ ΧΡΕΙΑΖΕΤΑΙ: το `patients_anonymized` κρατά μόνο ΕΤΟΣ γέννησης (`birth_year`) — αρκεί για
ηλικιακές ομάδες, ΔΕΝ αρκεί για να ξέρεις πότε ακριβώς κάποιος ενηλικιώνεται. Η γονική πρόσβαση
στην πύλη πρέπει να παύει ΤΗ ΜΕΡΑ των 18ων γενεθλίων, όχι κάποια στιγμή μέσα στη χρονιά.

ΠΟΥ ΤΟ ΒΡΙΣΚΟΥΜΕ: το ΑΜΚΑ κωδικοποιεί ΗΗΜΜΕΕ στα 6 πρώτα ψηφία. Επαληθεύτηκε σε δείγμα 20.000
ασθενών (25/09/2026): 99,2% συμφωνία με το αποθηκευμένο `birth_year`, ΜΗΔΕΝ μη έγκυρες
ημερομηνίες.

ΤΟ ΕΤΟΣ ΤΟ ΔΙΝΕΙ ΤΟ `birth_year`, ΟΧΙ ΤΟ ΑΜΚΑ. Το ΑΜΚΑ έχει διψήφιο έτος: «26» είναι και 1926
(εκατό ετών) και 2026 (βρέφος). Άρα παίρνουμε ημέρα+μήνα από το ΑΜΚΑ, έτος από τη βάση, και
ΔΙΑΣΤΑΥΡΩΝΟΥΜΕ τα δύο τελευταία ψηφία. Αν δεν συμφωνούν, δεν μαντεύουμε.

⚠ ΠΟΤΕ ΑΠΟΘΗΚΕΥΜΕΝΗ ΣΗΜΑΙΑ «is_minor». Υπολογίζεται σε ΚΑΘΕ ανάγνωση. Το λάθος έχει ξαναγίνει
στις δοκιμές δυνατοτήτων (έληγαν «τεμπέλικα», μόνο στο login) — εκεί κόστιζε λάθος κατάσταση,
εδώ θα κόστιζε γονέα που συνεχίζει να βλέπει δεδομένα υγείας ΕΝΗΛΙΚΟΥ.
"""

from __future__ import annotations

import re
from datetime import date

ADULT_AGE = 18

_AMKA_RE = re.compile(r"^\d{11}$")


def birth_date(amka: str | None, birth_year: int | None) -> date | None:
    """Ακριβής ημερομηνία γέννησης, ή None αν δεν μπορεί να βεβαιωθεί.

    Θέλει ΚΑΙ τα δύο: ημέρα/μήνας από το ΑΜΚΑ, έτος από τη βάση, και συμφωνία στα δύο
    τελευταία ψηφία. Οτιδήποτε άλλο → None (δεν μαντεύουμε).
    """
    a = str(amka or "").strip()
    if not _AMKA_RE.match(a) or not birth_year:
        return None
    try:
        dd, mm, yy = int(a[0:2]), int(a[2:4]), int(a[4:6])
        if yy != int(birth_year) % 100:      # το ΑΜΚΑ δεν συμφωνεί με τη βάση → δεν το εμπιστευόμαστε
            return None
        return date(int(birth_year), mm, dd)
    except (ValueError, TypeError):          # 30/02, μήνας 13, ό,τι άλλο
        return None


def age_on(amka: str | None, birth_year: int | None, *, today: date | None = None) -> int | None:
    bd = birth_date(amka, birth_year)
    if bd is None:
        return None
    t = today or date.today()
    return t.year - bd.year - ((t.month, t.day) < (bd.month, bd.day))


def is_minor(amka: str | None, birth_year: int | None, *, today: date | None = None) -> bool:
    """Ανήλικος; ΑΓΝΩΣΤΟ → ΟΧΙ (αποτυγχάνουμε ΚΛΕΙΣΤΑ).

    Αν δεν μπορούμε να βεβαιωθούμε για την ημερομηνία (0,8% των περιπτώσεων: ΑΜΚΑ όχι 11ψήφιο ή
    ασυμφωνία έτους), θεωρούμε ΕΝΗΛΙΚΟ. Το κόστος του λάθους δεν είναι συμμετρικό: «ο γονέας
    χάνει πρόσβαση σε ένα παιδί» το λύνει ο φαρμακοποιός· «κάποιος βλέπει δεδομένα υγείας
    ενήλικου» είναι παραβίαση.
    """
    a = age_on(amka, birth_year, today=today)
    return a is not None and a < ADULT_AGE


def turns_adult_on(amka: str | None, birth_year: int | None) -> date | None:
    """Πότε ενηλικιώνεται — για να το ΔΕΙΧΝΟΥΜΕ στον φαρμακοποιό πριν συμβεί."""
    bd = birth_date(amka, birth_year)
    if bd is None:
        return None
    try:
        return bd.replace(year=bd.year + ADULT_AGE)
    except ValueError:                        # 29/02 → 1η Μαρτίου
        return date(bd.year + ADULT_AGE, 3, 1)
