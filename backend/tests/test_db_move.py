"""Αυτόματη μεταφορά DB01 → cx33 (24/10/2026): ΠΟΤΕ σβήσιμο της βάσης αν τα άλλα μέλη δεν είναι
έτοιμα να κρατήσουν την παραγωγή· και ο φύλακας δεν σταματά πια πρόωρα (24/10/2026)."""

from __future__ import annotations

import inspect
from datetime import datetime, timedelta, timezone

from app.workers import capacity, db_move

T0 = datetime(2026, 10, 24, 12, tzinfo=timezone.utc)


def _h(primary=False, secondary=False, lag=0):
    return {"isWritablePrimary": primary, "secondary": secondary,
            "lastWrite": {"lastWriteDate": T0 - timedelta(seconds=lag)}}


def test_replica_ready_only_when_all_three_in_sync():
    assert db_move.replica_ready({"a": _h(primary=True), "b": _h(secondary=True, lag=2),
                                  "c": _h(secondary=True, lag=5)})
    # ένα μέλος πίσω > 15″ → ΟΧΙ
    assert not db_move.replica_ready({"a": _h(primary=True), "b": _h(secondary=True, lag=60),
                                      "c": _h(secondary=True)})
    # λείπει μέλος (δεν απάντησε) → ΟΧΙ
    assert not db_move.replica_ready({"a": _h(primary=True), "b": _h(secondary=True)})
    # κανένας primary ή δύο primaries → ΟΧΙ
    assert not db_move.replica_ready({"a": _h(secondary=True), "b": _h(secondary=True), "c": _h(secondary=True)})
    assert not db_move.replica_ready({"a": _h(primary=True), "b": _h(primary=True), "c": _h(secondary=True)})
    # μέλος σε RECOVERING (ούτε primary ούτε secondary) → ΟΧΙ
    assert not db_move.replica_ready({"a": _h(primary=True), "b": _h(), "c": _h(secondary=True)})


def test_move_always_powers_on_again():
    src = inspect.getsource(db_move.run)
    assert "finally:" in src and "actions/poweron" in src.split("finally:")[-2]


def test_watcher_no_longer_stops_when_staging_exists():
    src = inspect.getsource(capacity.watch_node_type)
    assert '"already_exists"' not in src
    assert "_watch_upgrade(" in src and "_watch_db_downgrade(" in src


def test_watcher_never_buys_servers():
    """Ο ιδιοκτήτης διέγραψε τον αυτόματα αγορασμένο STAGE01 (24/10/2026): καμία αγορά από φύλακα."""
    src = inspect.getsource(capacity)
    assert 'cl.post(f"{_API}/servers"' not in src
