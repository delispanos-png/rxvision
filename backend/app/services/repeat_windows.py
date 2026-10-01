"""Παράθυρα εκτέλεσης επαναλαμβανόμενης συνταγής — ΕΝΑΣ ορισμός για ingestion, Μελλοντικές,
Σύμβουλο, Συμμόρφωση/Recall, δέντρο επαναλήψεων και Copilot.

Κανόνας ΗΔΥΚΑ (διόρθωση πελάτη 01/10/2026, συνταγή 2607080987171 — ΗΔΥΚΑ: 18/10 & 15/11):
• 1η επανάληψη: ανοίγει την ημερομηνία έκδοσης («ισχύς ΑΠΟ»).
• 2η: ΑΠΟ + βήμα − 10 ημέρες.  • 3η και μετά: + βήμα από την προηγούμενη έναρξη.
  ⇒ θέση k ≥ 2 ανοίγει ΑΠΟ + (k−1)×βήμα − 10.  Π.χ. ΑΠΟ 08/07, βήμα 28: 26/07, 23/08, 20/09, 18/10, 15/11.
Μετρημένο (εκτελέσεις 2η+): βήμα 28 → 3/14.843 πριν από το άνοιγμα· 30 → 61/147.153· 60 → 0/419
(βήμα 56 δεν εμφανίζεται σε κανένα φαρμακείο· ο κανόνας είναι ίδιος για κάθε βήμα).

Λήξη θέσης: το «ΕΩΣ» της ΗΔΥΚΑ = ΑΠΟ + (k−1)×βήμα + 30 (72%) ή + 40…44 (27%) — δηλαδή ΑΝΟΙΓΜΑ + 40
για k ≥ 2. Για ανεκτέλεστη θέση: προειδοποιούμε με αυτό (ποτέ αργά)· «χαμένη» μόνο μετά το +54 από
το άνοιγμα (ποτέ πρόωρα). Το «ΕΩΣ» μιας ΕΚΤΕΛΕΣΜΕΝΗΣ εγγραφής αφορά τη ΔΙΚΗ της θέση.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

OPEN_SHIFT_DAYS = 10        # η θέση k ≥ 2 ανοίγει 10 ημέρες πριν από το ονομαστικό ΑΠΟ + (k−1)×βήμα
DEADLINE_AFTER_NOMINAL = 30 # συνήθης λήξη: ονομαστική ημερομηνία + 30
LOST_AFTER_NOMINAL = 44     # μετά από αυτό, σίγουρα δεν εκτελείται πια
DEADLINE_AFTER_OPEN = OPEN_SHIFT_DAYS + DEADLINE_AFTER_NOMINAL   # 40: λήξη από το (αποθηκευμένο) άνοιγμα k ≥ 2


def period_days(details: dict | None) -> int:
    d = details or {}
    return int(d.get("repeat_period_days") or (d.get("interval_months") or 1) * 30)


def _nominal(valid_from: datetime, k: int, period: int) -> datetime:
    return valid_from + timedelta(days=period * (max(1, int(k)) - 1))


def position_open(valid_from: datetime, k: int, period: int) -> datetime:
    """Άνοιγμα της θέσης k (1-based): 1η = ΑΠΟ· k ≥ 2 = ΑΠΟ + (k−1)×βήμα − 10."""
    k = max(1, int(k))
    nominal = _nominal(valid_from, k, period)
    return nominal if k == 1 else nominal - timedelta(days=OPEN_SHIFT_DAYS)


def position_deadline(valid_from: datetime, k: int, period: int) -> datetime:
    return _nominal(valid_from, k, period) + timedelta(days=DEADLINE_AFTER_NOMINAL)


def position_lost_after(valid_from: datetime, k: int, period: int) -> datetime:
    return _nominal(valid_from, k, period) + timedelta(days=LOST_AFTER_NOMINAL)


def next_repeat_open(valid_from: datetime | None, executed_at: datetime, repeat_current: int,
                     period: int) -> datetime:
    """Άνοιγμα της ΕΠΟΜΕΝΗΣ θέσης (k+1). Χωρίς «ΑΠΟ» → εκτέλεση + βήμα − 10 (εφεδρεία)."""
    if valid_from is None:
        return executed_at + timedelta(days=period - OPEN_SHIFT_DAYS)
    return position_open(valid_from, int(repeat_current or 1) + 1, period)


# Για ΑΠΟΘΗΚΕΥΜΕΝΟ άνοιγμα επόμενης θέσης (next_open_date / expected_open_date — πάντα k ≥ 2):
def deadline(opens: datetime) -> datetime:
    return opens + timedelta(days=DEADLINE_AFTER_OPEN)


def lost_after(opens: datetime) -> datetime:
    return opens + timedelta(days=OPEN_SHIFT_DAYS + LOST_AFTER_NOMINAL)


_ATHENS = timezone(timedelta(hours=3))


def days_until(when: datetime, now: datetime) -> int:
    """Ημερολογιακές ημέρες (ώρα Ελλάδας) έως `when` — «σήμερα»=0, «αύριο»=1. Όχι διαφορά ωρών/24:
    λήξη 02/10 00:00 ειδωμένη 01/10 το βράδυ έβγαινε «σήμερα»."""
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return max(0, (when.astimezone(_ATHENS).date() - now.astimezone(_ATHENS).date()).days)
