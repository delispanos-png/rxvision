"""Όποιος σβήνει εκτελέσεις σβήνει και ό,τι βγήκε από αυτές.

ΓΙΑΤΙ ΕΙΝΑΙ ΜΟΝΙΜΟΣ ΕΛΕΓΧΟΣ: στις 28/09/2026 βρέθηκαν 30.842 προβλέψεις επόμενης εκτέλεσης
(`future_prescriptions`) με πηγή που δεν υπήρχε πια — 10.049 από τη μεταφορά εκτέλεσης σε άλλο
φαρμακείο, 20.793 από τον καθαρισμό εκτός παραθύρου διατήρησης. Και οι δύο έσβηναν εκτελέσεις + είδη
αλλά όχι τις προβλέψεις. Επίσης η μεταφορά έσβηνε τον ορφανό ασθενή αλλά άφηνε τις επαφές του
(raw τηλέφωνο/email) και τις υπενθυμίσεις του.
"""

from __future__ import annotations

import inspect

from app.services import data_retention
from app.services.ingestion import engine
from app.repositories import prescriptions


def test_every_execution_delete_also_deletes_predictions():
    for fn in (engine.IngestionEngine._release_cross_tenant_clash,
               data_retention._purge_executions,
               prescriptions.PrescriptionRepository.delete_range):
        src = inspect.getsource(fn)
        assert "prescription_executions" in src or "_coll" in src
        assert "future_prescriptions" in src, f"{fn.__qualname__}: δεν σβήνει τις προβλέψεις"


def test_retention_purge_goes_through_the_dependent_aware_helper():
    src = inspect.getsource(data_retention.purge_old)
    assert "_purge_executions(" in src
    assert '_batched_delete(db["prescription_executions"]' not in src


def test_patient_dependents_classified_once():
    rel, owned = set(engine._PATIENT_RELATIONS), set(engine._PATIENT_OWNED)
    assert not rel & owned
    assert "future_prescriptions" in owned and "patient_links" in rel
