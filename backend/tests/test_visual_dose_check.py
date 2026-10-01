"""Οπτικός έλεγχος δοσολογίας — ΕΝΑΣ κανόνας (αναφορά πελάτη 01/10/2026, έλεγχος έως 21/09).

Κλειδώνει: 1 τεμάχιο → ποτέ (και κολλύρια/σπρέι)· δισκία/κάψουλες → ποτέ· >1 μη-αυτόματης μορφής →
ναι· αμπούλες ακόμη και με «E»· το μήνυμα ονομάζει το σκεύασμα."""

from __future__ import annotations

from app.services.prescription_checks import check_item, needs_visual_dose_check

COSOPT = {"form_code": "EY.DRO.SOL", "package_form": "BTX1BOTTLE (LDPE)X10ML", "overdose_message_type": None}
FLUTINASAL = {"form_code": "NASPR.SUS", "package_form": "BT x 1 BOTTLE x 16 G", "overdose_message_type": None}
FILICINE = {"form_code": "TAB", "package_form": "BTX30 (ΣΕ BLISTERS)", "overdose_message_type": "E"}
SOLUMAG = {"form_code": "OR.SOL.SD", "package_form": "BTx20 VIALSx10 ML", "overdose_message_type": "E"}
TOUJEO = {"form_code": "IN.SO.PF.P", "package_form": "BTx3 PF.PENS  (Solostar) x1,5ml", "overdose_message_type": None}


def test_single_piece_never_needs_check_even_drops_and_sprays():
    # 2609024633332: COSOPT & FLUTINASAL με 1 τεμάχιο — δεν θέλουν οπτικό έλεγχο
    assert not needs_visual_dose_check(COSOPT, "COSOPT IMULTI", 1)
    assert not needs_visual_dose_check(FLUTINASAL, "FLUTINASAL", 1)
    assert not needs_visual_dose_check(TOUJEO, "TOUJEO", 1)        # 2607209380248: δόθηκε 1


def test_tablets_are_checked_by_hdika():
    # 2608276126652: FILICINE δισκία ×2 — η ΗΔΥΚΑ το ελέγχει στη συνταγογράφηση
    assert not needs_visual_dose_check(FILICINE, "FILICINE", 2)


def test_more_than_one_of_non_auto_form_needs_check():
    assert needs_visual_dose_check(COSOPT, "COSOPT IMULTI", 2)
    assert needs_visual_dose_check(TOUJEO, "TOUJEO", 2)
    assert needs_visual_dose_check(SOLUMAG, "SOLUMAG FORTE", 2)     # αμπούλες: ακόμη και με «E»


def test_zero_pieces_in_this_phase_never_flags():
    assert not needs_visual_dose_check(SOLUMAG, "SOLUMAG FORTE", 0)


def test_message_names_the_medicine():
    checks = check_item({"name": "SOLUMAG FORTE", "quantity": 2}, SOLUMAG)
    od = [c for c in checks if c["type"] == "overdose"]
    assert od and "SOLUMAG FORTE" in od[0]["title"] and "2 τεμ." in od[0]["title"]
