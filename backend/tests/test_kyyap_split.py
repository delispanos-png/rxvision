"""Επιμερισμός ΚΥΥΑΠ/ΕΤΥΑΠ στις φάσεις μιας συνταγής.

ΓΙΑΤΙ ΕΧΕΙ ΤΕΣΤ: εδώ βγαίνουν ΧΡΗΜΑΤΙΚΑ ΠΟΣΑ που ο φαρμακοποιός συγκρίνει με το έντυπο της
ΗΔΥΚΑ. Ένα λάθος λεπτό είναι λάθος νούμερο — και το πρώτο πράγμα που χάνει την εμπιστοσύνη του.
Η βασική περίπτωση είναι ΠΡΑΓΜΑΤΙΚΗ (συνταγή 2609033481768, 04/09/2026) και επαληθεύτηκε στο
λεπτό με το SoftOne του πελάτη.
"""

from app.services.ingestion.kyyap_split import allocate


def _row(ext, total, claimed, kyyap=478):
    return {"external_id": ext, "amount_total": total, "amount_claimed": claimed,
            "details": {"kyyap_covered": kyyap}}


def test_real_case_matches_idyka_to_the_cent():
    """ΚΥΥΑΠ 4,78 σε δύο φάσεις 14,46 + 4,66 → 3,62 / 1,16 (ΗΔΥΚΑ: ταμείο 9,84 στη φάση 1)."""
    shares = allocate([_row("2609033481768:1", 1446, 1346), _row("2609033481768:2", 466, 466)])
    assert shares["2609033481768:1"] == 362
    assert shares["2609033481768:2"] == 116
    assert 1346 - shares["2609033481768:1"] == 984


def test_single_execution_keeps_the_whole_amount():
    assert allocate([_row("2607019540750:1", 4278, 3666, 1326)])["2607019540750:1"] == 1326


def test_execution_without_phase_suffix():
    assert allocate([_row("2607019540750", 4278, 3666, 1326)])["2607019540750"] == 1326


def test_nothing_is_lost_to_rounding():
    """Το άθροισμα των μεριδίων είναι ΠΑΝΤΑ ακριβώς η κάλυψη της συνταγής."""
    rows = [_row(f"X:{i}", t, t, 1000) for i, t in enumerate([333, 333, 334, 1], start=1)]
    assert sum(allocate(rows).values()) == 1000


def test_no_kyyap_gives_zero_not_none():
    rows = [{"external_id": "Y:1", "amount_total": 100, "amount_claimed": 100, "details": {}}]
    assert allocate(rows) == {"Y:1": 0}


def test_share_never_exceeds_the_claim_of_its_own_execution():
    """Αλλιώς το ταμείο βγαίνει αρνητικό και η οθόνη το μηδενίζει σιωπηλά, χάνοντας το ποσό."""
    shares = allocate([_row("Y:1", 1000, 10, 500), _row("Y:2", 1000, 900, 500)])
    assert shares["Y:1"] <= 10 and shares["Y:2"] <= 900
    assert sum(shares.values()) == 500


def test_zero_amounts_fall_back_to_first_phase():
    shares = allocate([_row("Z:1", 0, 0, 300), _row("Z:2", 0, 0, 300)])
    assert shares == {"Z:1": 300, "Z:2": 0}
