"""Μία ενεργή ανακοίνωση ανά πρόσθετο (αίτημα ιδιοκτήτη 29/09/2026).

Και οι ΔΥΟ δρόμοι ενεργοποίησης πρέπει να ελέγχουν: η αποθήκευση με «ενεργή» ΚΑΙ ο διακόπτης on/off
της λίστας. Αν ελέγχει μόνο ο ένας, ο άλλος παρακάμπτει τον κανόνα.
"""

from __future__ import annotations

import inspect

from app.services import announcements


def test_both_activation_paths_check_for_a_running_announcement():
    assert "active_conflict(" in inspect.getsource(announcements.save)
    assert "active_conflict(" in inspect.getsource(announcements.set_active)


def test_news_without_addon_is_never_blocked():
    src = inspect.getsource(announcements.active_conflict)
    assert src.index("if not addon_key") < src.index("find(")
