"""Παράθυρα επανάληψης (01/10/2026): άνοιγμα = «ισχύς ΑΠΟ» + (k−1)×βήμα, όχι εκτέλεση + βήμα·
εκτελέσιμη από −10· λήγει ~+30· χαμένη μόνο μετά το +44. Ένας ορισμός: services/repeat_windows.py."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.repositories.patient_intelligence import chain_positions
from app.services import repeat_windows as rw
from app.services.ingestion.engine import next_repeat_open


def test_customer_rule_konstanteli_2607080987171():
    # έκδοση 08/07/2026, 6 επαναλήψεις, βήμα 28 — η ΗΔΥΚΑ δίνει 5η 18/10, 6η 15/11
    vf = datetime(2026, 7, 8)
    opens = [rw.position_open(vf, k, 28) for k in range(1, 7)]
    assert [d.strftime("%d/%m") for d in opens] == ["08/07", "26/07", "23/08", "20/09", "18/10", "15/11"]
    # 4η εκτελέστηκε 21/09 → επόμενη (5η) 18/10, ΟΧΙ από την ημ/νία εκτέλεσης
    assert next_repeat_open(vf, datetime(2026, 9, 21), 4, 28) == datetime(2026, 10, 18)


def test_sixty_day_step_same_rule():
    vf = datetime(2026, 1, 1)
    assert rw.position_open(vf, 2, 60) == datetime(2026, 2, 20)      # +60 −10
    assert rw.position_open(vf, 3, 60) == datetime(2026, 4, 21)      # +60 από την προηγούμενη


def test_missing_valid_from_falls_back_to_execution():
    assert next_repeat_open(None, datetime(2026, 10, 10), 1, 30) == datetime(2026, 10, 30)


def test_engine_uses_the_shared_rule():
    assert next_repeat_open is rw.next_repeat_open


def _chain(vf, done_positions, total=6, period=30):
    return [{"repeat_total": total, "repeat_current": k, "valid_from": vf,
             "executed_at": rw.position_open(vf, k, period), "amount_total": 1000,
             "details": {"repeat_period_days": period}} for k in done_positions]


def test_position_windows_open_and_close():
    vf = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ex = _chain(vf, [1, 2])                           # θέση 3: ονομαστικά 02/03, ανοίγει 20/02
    opens3 = vf + timedelta(days=60 - 10)
    st = lambda now: chain_positions(ex, now)["windows"][2]["status"]  # noqa: E731
    assert st(opens3 - timedelta(days=1)) == "future"
    assert st(opens3) == "available"
    assert st(opens3 + timedelta(days=50)) == "available"           # ονομαστική +40 ≤ +44
    assert st(opens3 + timedelta(days=54)) == "missed"
    w = chain_positions(ex, opens3)["windows"][2]
    assert w["due"] == opens3 and w["deadline"] == opens3 + timedelta(days=40)


def test_sixty_day_step_closes_on_its_own_window():
    vf = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ex = _chain(vf, [1], total=3, period=60)
    opens2 = rw.position_open(vf, 2, 60)
    assert chain_positions(ex, opens2 + timedelta(days=60))["windows"][1]["status"] == "missed"
