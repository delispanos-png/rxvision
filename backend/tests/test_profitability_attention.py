"""Χάρτης προσοχής της κερδοφορίας: κανόνες χαρακτηρισμού «πιέζει / βοηθά / αδιάφορο».

Καθαρές συναρτήσεις — χωρίς βάση. Τα όρια (±10%, 2%) είναι απόφαση προϊόντος: αν αλλάξουν, να
αλλάξει και το κείμενο της οθόνης που τα εξηγεί (AttentionMap.tsx) και το εγχειρίδιο.
"""

from __future__ import annotations

from app.repositories.profitability import (
    UNALLOCATED, _classify, _focus, _kind, _price_band,
)


def _by(rows):
    return {r["label"]: r for r in rows}


def test_impacts_sum_to_zero_and_verdicts_follow_the_bands():
    # μέσο περιθώριο = 250/1000 = 25%
    groups = {
        "Ακριβά": [300, 255, 0],     # 15%  → πιέζει (≤ 22,5%)
        "Φθηνά": [300, 195, 0],      # 35%  → βοηθά (≥ 27,5%)
        "Μέσα": [380, 285, 0],       # 25%  → κοντά στον μέσο όρο
        "Ψίχουλα": [20, 15, 0],      # 2% εσόδων, 2% κέρδους → μικρό βάρος
    }
    out = _by(_classify(groups, {}))
    assert sum(r["impact"] for r in out.values()) == 0
    assert out["Ακριβά"]["verdict"] == "pressure" and out["Ακριβά"]["impact"] == -30
    assert out["Φθηνά"]["verdict"] == "helps" and out["Φθηνά"]["impact"] == 30
    assert (out["Μέσα"]["verdict"], out["Μέσα"]["reason"]) == ("neutral", "near_avg")
    assert out["Ψίχουλα"]["reason"] == "near_avg"   # 2,0% ΔΕΝ είναι «κάτω από 2%»


def test_tiny_loss_is_not_pressure_but_a_material_loss_is():
    out = _by(_classify({"Μεγάλο": [100_000, 75_000, 0], "Περικοπή 10€": [0, 0, 10]}, {}))
    assert (out["Περικοπή 10€"]["verdict"], out["Περικοπή 10€"]["reason"]) == ("neutral", "small")
    out = _by(_classify({"Μεγάλο": [1000, 750, 0], "Ζημιά": [100, 120, 0]}, {}))
    assert (out["Ζημιά"]["verdict"], out["Ζημιά"]["reason"]) == ("pressure", "loss")


def test_fund_average_is_after_cuts_and_cuts_are_named():
    # Ο μέσος όρος της διάστασης ΠΕΡΙΛΑΜΒΑΝΕΙ τις περικοπές της· αλλιώς όλα θα «βοηθούσαν».
    out = _by(_classify({"ΕΟΠΥΥ": [900, 675, 0], "Ταμείο Χ": [100, 75, 15]}, {}))
    assert out["Ταμείο Χ"]["reason"] == "cuts" and out["Ταμείο Χ"]["verdict"] == "pressure"
    assert out["ΕΟΠΥΥ"]["verdict"] == "neutral"


def test_unallocated_is_never_judged():
    out = _by(_classify({UNALLOCATED: [500, 500, 0], "Α": [500, 300, 0]}, {}))
    assert out[UNALLOCATED]["reason"] == "unallocated"


def test_focus_takes_worst_pressure_per_dimension_and_real_declines():
    cat = _classify({"Α": [500, 375, 0], "Β": [500, 375, 0]},
                    {"Α": [500, 300, 0], "Β": [500, 376, 0]})   # Α: 200 → 125 κέρδος
    band = _classify({"Ακριβά": [400, 360, 0], "Φθηνά": [600, 390, 0]}, {})
    items = _focus([{"key": "category", "segments": cat}, {"key": "price_band", "segments": band}],
                   total_net=250)
    kinds = [(i["type"], i["label"]) for i in items]
    assert ("pressure", "Ακριβά") in kinds
    assert ("decline", "Α") in kinds and ("decline", "Β") not in kinds   # 1€ δεν είναι πτώση
    assert kinds[0][0] == "pressure"


def test_price_bands_and_kinds():
    assert _price_band(999) == "έως 10€"
    assert _price_band(1000) == "10–30€"
    assert _price_band(45000) == "πάνω από 300€"
    assert _price_band(None) == UNALLOCATED
    assert _kind({}, {"high_cost": True, "is_antibiotic": True}).startswith("ΦΥΚ")
    assert _kind({"category": "galenic"}, {}) == "Γαληνικά"
    assert _kind({}, None) == "Εκτός καταλόγου ΗΔΥΚΑ"
    assert _kind({}, {}) == "Κοινά σκευάσματα"
