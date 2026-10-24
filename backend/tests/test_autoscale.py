"""Αυτόματη κλιμάκωση app nodes (24/10/2026): κανόνες του ιδιοκτήτη — 80%/30′ όλοι → +1 (έως 2),
cx33 αντικαθιστά τον ακριβό, 7 ημέρες <40% → −1 ο ακριβότερος· ΠΟΤΕ οι αρχικοί SRV01-03."""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from mongomock_motor import AsyncMongoMockClient

from app.workers import autoscale as a

NOW = datetime(2026, 10, 24, 12, tzinfo=timezone.utc)


def _t(name, cores, mem, eur, avail=("hel1",), arch="x86"):
    return {"id": hash(name) % 9999, "name": name, "cores": cores, "memory": mem, "architecture": arch,
            "prices": [{"location": "hel1", "price_monthly": {"gross": str(eur)}}],
            "locations": [{"name": "hel1", "available": "hel1" in avail}]}


def _srv(i, name, typ, created="2026-07-01"):
    return {"id": i, "name": name, "status": "running", "created": created,
            "server_type": {"name": typ, "cores": 4}}


BASE = [_srv(1, "RxVisionSRV01", "cx33"), _srv(2, "RxVisionSRV02", "cx33"), _srv(3, "RxVisionSRV03", "cx33")]


class Cl:
    """Ψεύτικη Hetzner: CPU ανά server (ίδιο για όλα τα δείγματα) + LB υγεία."""
    def __init__(self, cpu_pct: float, healthy=()):
        self.cpu, self.healthy = cpu_pct, healthy

    async def get(self, url, headers=None, params=None):
        if "/metrics" in url:
            step = int(params["step"])
            span = (datetime.fromisoformat(params["end"]) - datetime.fromisoformat(params["start"])).total_seconds()
            vals = [[0, str(self.cpu * 4)] for _ in range(int(span // step))]
            return SimpleNamespace(json=lambda: {"metrics": {"time_series": {"cpu": {"values": vals}}}})
        lb = {"targets": [{"server": {"id": i}, "health_status": [{"status": "healthy"}]} for i in self.healthy]}
        return SimpleNamespace(json=lambda: {"load_balancer": lb})


async def _run(cpu, servers, types, db=None, healthy=(), armed=True, **kw):
    db = db or AsyncMongoMockClient()["as"]
    if armed:
        await db.platform_settings.update_one({"_id": "autoscale"}, {"$set": {"armed": True}}, upsert=True)
    mails = []

    async def notify(_db, subj, body):
        mails.append(subj)
    r = await a.run(db, Cl(cpu, healthy), {}, types, servers, NOW, notify, **kw)
    return r, db, mails


def test_sustained_hot_and_choose_type():
    assert a.sustained_hot([340.0] * 30, 4) and not a.sustained_hot([340.0] * 29 + [200.0], 4)
    assert not a.sustained_hot([400.0] * 5, 4)          # λίγα δείγματα = άγνωστο = όχι
    types = [_t("cpx32", 4, 8, 35.49), _t("ccx23", 4, 16, 80), _t("cpx22", 2, 4, 19.49),
             _t("cax31", 8, 16, 20.99, arch="arm"), _t("cx33", 4, 8, 8.49, avail=())]
    avail = {t["name"]: (["hel1"] if t["locations"][0]["available"] else []) for t in types}
    assert a.choose_type(types, avail)["name"] == "cpx32"     # φθηνότερος x86 ≥4/8 (όχι ARM, όχι 2 vCPU)
    types[-1] = _t("cx33", 4, 8, 8.49)
    avail["cx33"] = ["hel1"]
    assert a.choose_type(types, avail)["name"] == "cx33"


async def test_all_hot_adds_node_one_hot_does_not():
    types = [_t("cx33", 4, 8, 8.49, avail=()), _t("cpx32", 4, 8, 35.49)]
    r, db, mails = await _run(85, BASE, types)
    assert r == {"autoscale": "add", "type": "cpx32"} and len(mails) == 1
    cmd = await db.ops_commands.find_one({})
    assert cmd["type"] == "add_node" and cmd["node"] == "RxVisionMGMT01" and cmd["server_type"] == "cpx32"
    r, _, mails = await _run(50, BASE, types)
    assert r["autoscale"] == "steady" and not mails


async def test_cap_and_busy():
    types = [_t("cpx32", 4, 8, 35.49)]
    two = BASE + [_srv(4, "RxVisionSRV04", "cpx32"), _srv(5, "RxVisionSRV05", "cpx32")]
    r, db, _ = await _run(90, two, types)
    assert r["autoscale"] == "cap_reached" and await db.ops_commands.count_documents({}) == 0
    db = AsyncMongoMockClient()["as2"]
    await db.ops_commands.insert_one({"type": "add_node", "status": "running", "requested_at": NOW})
    r, db, _ = await _run(90, BASE, types, db=db)
    assert r["autoscale"] == "busy_or_cooldown"


async def test_cold_week_removes_most_expensive_never_base():
    types = [_t("cx33", 4, 8, 8.49, avail=()), _t("cpx32", 4, 8, 35.49), _t("ccx23", 4, 16, 80)]
    srv = BASE + [_srv(4, "RxVisionSRV04", "cpx32"), _srv(5, "RxVisionSRV05", "ccx23")]
    r, db, mails = await _run(10, srv, types)
    assert r == {"autoscale": "remove", "name": "RxVisionSRV05"} and len(mails) == 1
    r, _, _ = await _run(10, BASE, types)          # μόνο αρχικοί → ΠΟΤΕ αφαίρεση
    assert r["autoscale"] == "steady"


async def test_cx33_replaces_pricey_node_after_new_is_healthy():
    types = [_t("cx33", 4, 8, 8.49), _t("cpx32", 4, 8, 35.49)]
    srv = BASE + [_srv(4, "RxVisionSRV04", "cpx32", created="2026-10-20")]
    r, db, _ = await _run(50, srv, types)
    assert r == {"autoscale": "replace_add", "old": "RxVisionSRV04"}
    await db.ops_commands.update_many({}, {"$set": {"status": "done"}})
    # ο νέος cx33 υπάρχει αλλά ΔΕΝ είναι ακόμη υγιής → περιμένουμε
    srv2 = srv + [_srv(6, "RxVisionSRV06", "cx33", created="2026-10-24")]
    r, db, _ = await _run(50, srv2, types, db=db)
    assert r["autoscale"] == "replace_waiting"
    r, db, _ = await _run(50, srv2, types, db=db, healthy=(6,))
    assert r == {"autoscale": "replace_remove", "name": "RxVisionSRV04"}
    assert await db.ops_commands.find_one({"type": "remove_node", "name": "RxVisionSRV04"})


async def test_db_move_has_priority_over_replacement():
    types = [_t("cx33", 4, 8, 8.49), _t("cpx32", 4, 8, 35.49)]
    srv = BASE + [_srv(4, "RxVisionSRV04", "cpx32")]
    r, _, _ = await _run(50, srv, types, db_move_pending=True)
    assert r["autoscale"] != "replace_add"


async def test_unarmed_only_records_never_buys():
    types = [_t("cpx32", 4, 8, 35.49)]
    r, db, mails = await _run(90, BASE, types, armed=False)
    assert r == {"autoscale": "would_add_node", "armed": False}
    assert await db.ops_commands.count_documents({}) == 0 and not mails
    assert await db.autoscale_events.find_one({"kind": "would_add_node"})


async def test_failed_add_is_reported_once():
    db = AsyncMongoMockClient()["as3"]
    await db.ops_commands.insert_one({"type": "add_node", "requested_by": "autoscale", "status": "done",
                                      "result": "unhealthy RxVisionSRV04 id=1", "requested_at": NOW})
    _, _, mails = await _run(10, BASE, [_t("cpx32", 4, 8, 35.49)], db=db)
    assert any("ΑΠΕΤΥΧΕ" in m for m in mails)
    _, _, mails = await _run(10, BASE, [_t("cpx32", 4, 8, 35.49)], db=db)
    assert not any("ΑΠΕΤΥΧΕ" in m for m in mails)
