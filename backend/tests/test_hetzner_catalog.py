"""Διαθεσιμότητα Hetzner από `server_types[].locations[]` (το /datacenters καταργήθηκε, 22/10/2026).

Φυλάει ότι ο φύλακας (α) βλέπει cx43 ΜΟΝΟ στην τοποθεσία των app nodes και (β) ξεχωρίζει το
«δεν υπάρχει απόθεμα» από το «δεν μπορώ να δω» — το δεύτερο ήταν η σιωπηλή τύφλωση."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services import hetzner_catalog as hc


def _t(name, avail):
    return {"id": hash(name) % 1000, "name": name, "cores": 8, "memory": 16, "disk": 160,
            "prices": [{"location": "hel1", "price_monthly": {"gross": "15.99"}}],
            "locations": [{"name": ln, "available": ok} for ln, ok in avail.items()]}


class _Cl:
    def __init__(self, st, lc):
        self.r = {"server_types": st, "locations": lc}

    async def get(self, url, headers=None):
        for k, r in self.r.items():
            if k in url:
                return r


def _resp(code, body):
    return SimpleNamespace(status_code=code, json=lambda: body)


def test_available_in_reads_locations():
    t = _t("cx43", {"fsn1": True, "hel1": False, "nbg1": True})
    assert hc.available_in(t) == ["fsn1", "nbg1"]
    assert hc.available_in(None) == []


async def test_fetch_distinguishes_blind_from_empty():
    ok = _Cl(_resp(200, {"server_types": [_t("cx43", {"hel1": False})]}),
             _resp(200, {"locations": [{"name": "hel1", "network_zone": "eu-central"}]}))
    types, locs = await hc.fetch(ok, {})
    assert hc.available_in(types[0]) == [] and locs["hel1"]["network_zone"] == "eu-central"
    # API που απαντά σφάλμα ή άλλαξε σχήμα → ΣΦΑΛΜΑ, όχι «κανένα απόθεμα»
    for st in (_resp(410, {"error": {}}), _resp(200, {"server_types": [{"name": "cx43"}]})):
        with pytest.raises(hc.HetznerUnavailable):
            await hc.fetch(_Cl(st, _resp(200, {"locations": [{"name": "hel1"}]})), {})
