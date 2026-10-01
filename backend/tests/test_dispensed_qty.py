"""Τεμάχια ΑΥΤΗΣ της εγγραφής (01/10/2026): κάθε `barcode:N` κουβαλά όλη τη συνταγή — το άθροισμα
`executed_qty` ανά εγγραφή φούσκωνε τις αναλύσεις (+5,6% σε ένα φαρμακείο τον Σεπτέμβριο)."""

from __future__ import annotations

from app.services.dispensed import qty_here, record_no, rx_root


def _c(*nos):
    return [{"execution_no": n} for n in nos]


def test_record_and_root():
    assert record_no("2608276126652:3") == 3 and record_no("2608276126652") == 1
    assert rx_root("2608276126652:3") == "2608276126652"


def test_phase_split_counts_only_this_phase():
    # 2608276126652: FILICINE 2 κουπόνια στη φάση 1, SOLUMAG 2 στη φάση 3 — executed_qty τελικό = 2
    assert qty_here(_c(1, 1), 2, 2, True, 1) == 2
    assert qty_here(_c(3, 3), 2, 2, True, 1) == 0       # SOLUMAG στη φάση 1: δεν δόθηκε εδώ
    assert qty_here(_c(3, 3), 2, 2, True, 3) == 2
    assert qty_here(_c(1, 2), 2, 2, True, 2) == 1       # ένα ανά φάση


def test_single_phase_trusts_executed_qty():
    assert qty_here(_c(1, 1), 2, 2, True, 1) == 2
    assert qty_here([], 1, 2, True, 1) == 1             # μερική χωρίς κουπόνια
    assert qty_here([], None, 2, False, 1) == 0         # ανεκτέλεστη γραμμή
    assert qty_here([{"execution_no": None}], 2, 2, True, 1) == 2   # κουπόνια χωρίς αριθμό φάσης
