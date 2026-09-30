"""Διορθώσεις από την ανατροφοδότηση φαρμακοποιού (29/09/2026).

1. Σύμβουλος «σταμάτησε να έρχεται»: 326 από 379 τέτοιους πελάτες είχαν έρθει κανονικά, γιατί η
   πρόβλεψη της θέσης 1/3 δεν έκλεινε ποτέ όταν εκτελούνταν η 2/3.
2. Διατροφή: διάβαζε ΟΛΟ το ιστορικό (παλιό αντιβιοτικό αντί για τη στατίνη)· τώρα ενεργή αγωγή +
   μετρήσεις, σε ΜΙΑ πρόταση με ρητές συγκρούσεις.
"""

from __future__ import annotations

import inspect

from app.repositories import daily_coach
from app.repositories.advisor import _items, measurement_sections, nutrition_summary
from app.services.ingestion import engine


def test_later_repeat_closes_earlier_predictions():
    src = inspect.getsource(engine.IngestionEngine._post_process)
    assert "_fulfil_earlier_in_chain(" in src and "_later_in_chain(" in src
    # ο καθημερινός συγχρονισμός ΔΕΝ πρέπει να ξανανοίγει κλεισμένες προβλέψεις
    upsert = src[src.index('self.db["future_prescriptions"].update_one('):]
    set_part = upsert[:upsert.index('"$setOnInsert"')]
    assert '"status": "pending"' not in set_part


def test_lapsed_card_checks_real_executions():
    src = inspect.getsource(daily_coach.DailyCoachRepository._sig_lapsed_chronic)
    assert "prescription_executions" in src and "COUNTABLE_EXEC" in src


def test_items_respect_parentheses_and_labels():
    assert _items("Λιπαρά ψάρια, κάλιο (μπανάνα, ντομάτα)") == ["Λιπαρά ψάρια", "κάλιο (μπανάνα, ντομάτα)"]
    assert _items("Δίαιτα DASH: λαχανικά, φρούτα") == ["Δίαιτα DASH", "λαχανικά", "φρούτα"]


def test_measurements_become_sections_with_same_thresholds_as_screen():
    ms = measurement_sections({"bp": {"systolic": 150, "diastolic": 95},
                               "glucose": {"value": 110.0}, "weight": {"value": 70}}, 175)
    titles = [m["title"] for m in ms]
    assert titles[0].startswith("Υψηλή πίεση") and titles[1].startswith("Οριακό σάκχαρο")
    assert len(ms) == 2                         # ΔΜΣ 22,9 = φυσιολογικός → καμία ενότητα
    assert all(m["source"] == "measurement" for m in ms)
    assert measurement_sections({}, None) == []


def test_summary_flags_potassium_and_warfarin_conflicts():
    ms = measurement_sections({"bp": {"systolic": 145, "diastolic": 92}}, None)
    th = [{"source": "therapy", "title": "Αντιπηκτικά", "drugs": ["X"],
           "favor": "Σταθερή ημερήσια ποσότητα πράσινων φυλλωδών", "avoid": "αλκοόλ"}]
    s = nutrition_summary(ms, th, ["C09AA05", "B01AA03"])
    assert len(s["conflicts"]) == 2
    assert s["favor"][0].startswith("Κάλιο")      # οι «high» μετρήσεις μπαίνουν πρώτες
    assert nutrition_summary([], [], [])["conflicts"] == []


def test_cross_tenant_transfer_asks_the_holder_first():
    """Πινγκ-πονγκ ~20.000 εκτελέσεων: η μεταφορά ΠΡΕΠΕΙ να ρωτά πρώτα το feed του κατόχου."""
    src = inspect.getsource(engine.IngestionEngine._persist)
    ask, move = src.index("holder_owns("), src.index("_release_cross_tenant_clash(")
    assert ask < move and "cross_tenant_skip" in src


def test_ownership_never_uses_paused_credentials():
    from app.services.ingestion import ownership
    src = inspect.getsource(ownership.HdikaOwnership._keys)
    assert src.index("auth_paused") < src.index("_effective_hdika_creds(holder)")


def test_one_prediction_per_prescription_and_only_dispensed_lines():
    """30/09/2026: 3.041 διπλές προβλέψεις (μία ανά εγγραφή `barcode:N`) και 23 προτάσεις
    παραγγελίας για φάρμακα που ο ασθενής δεν πήρε ποτέ."""
    src = inspect.getsource(engine.IngestionEngine._post_process)
    assert "_newer_record_of_same_rx(" in src and "_retire_sibling_predictions(" in src
    assert 'it.get("executed_qty") or 0) > 0' in src
