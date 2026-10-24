"""ΑΦΜ — ΕΝΑ σημείο για «είναι έγκυρο;» (24/10/2026).

ΓΙΑΤΙ: η εγγραφή δοκιμής δεχόταν φαρμακείο ΧΩΡΙΣ ΑΦΜ (ΦΑΡΜΑΚΕΙΟ ΑΡΧΟΝΤΑΚΗ, 24/10/2026). Χωρίς ΑΦΜ:
  · δεν βγαίνει παραστατικό (SoftOne/myDATA) αν ο πελάτης συνεχίσει μετά τη δοκιμή·
  · ο φραγμός «έχει ξαναπάρει δοκιμή;» (`trial_leads.afm_had_trial`) πέφτει μόνο στο email →
    δωρεάν δοκιμές επ' αόριστον με καινούργιο email.

Αλγόριθμος ΑΑΔΕ: τα 8 πρώτα ψηφία × 2^(8..1), άθροισμα mod 11 mod 10 = 9ο ψηφίο.
"""

from __future__ import annotations

import re
from typing import Any


def normalize(v: Any) -> str:
    """Μόνο ψηφία — ο φαρμακοποιός το γράφει με κενά/τελείες/«EL» μπροστά."""
    return re.sub(r"\D", "", str(v or ""))


def is_valid(v: Any) -> bool:
    a = normalize(v)
    if len(a) != 9 or a == "000000000":
        return False
    s = sum(int(a[i]) * (2 ** (8 - i)) for i in range(8))
    return (s % 11) % 10 == int(a[8])
