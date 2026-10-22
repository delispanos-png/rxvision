"""Πρωτότυπη ιατρού (22/10/2026, παρατήρηση Παπαγιαννόπουλου): οι συνταγές «92…» τις δημιουργεί ο φαρμακοποιός
(π.χ. αντιγριπικός εμβολιασμός ΧΩΡΙΣ ιατρική συνταγή) — δεν υπάρχει πρωτότυπη ιατρού να κατατεθεί."""

from app.repositories.reimbursement import ReimbursementRepository, needs_doctor_original


def test_pharmacist_created_92_never_needs_doctor_original():
    assert needs_doctor_original("9261014887772", intangible=False, first_phase=True) is False
    assert needs_doctor_original("9261014887772:1", intangible=False, first_phase=True) is False


def test_printed_doctor_prescription_needs_original_only_in_first_phase():
    assert needs_doctor_original("2607209397248", intangible=False, first_phase=True) is True
    assert needs_doctor_original("2607209397248", intangible=False, first_phase=False) is False
    assert needs_doctor_original("2607209397248", intangible=True, first_phase=True) is False


def test_submission_flags_use_the_same_rule():
    f = ReimbursementRepository._submission_flags({"external_id": "9261014887772:1", "details": {"intangible": False}})
    assert f["needs_original"] is False
