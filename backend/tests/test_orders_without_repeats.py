"""Παραγγελίες «Να μη συμμετέχουν οι επαναλήψεις» (06/11/2026): η λίστα βγαίνει από τις εκτελέσεις,
αλλιώς θα έμενε άδεια, και η επιλογή δεν αγγίζει τον ορίζοντα του Συμβούλου Παραγγελίας."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from mongomock_motor import AsyncMongoMockClient

from app.api.v1.routers import orders as router
from app.repositories import base as base_mod
from app.repositories.future import FuturePrescriptionRepository

TODAY = datetime(2026, 11, 6, tzinfo=timezone.utc)
HIST = [{"_id": "p1", "units": 90, "cost": 18000, "product_name": "A", "substance": "S",
         "category": "C", "barcode": None},
        {"_id": "p2", "units": 1, "cost": 500, "product_name": "B", "substance": None,
         "category": None, "barcode": None},
        {"_id": None, "units": 4, "cost": 100}]


def _repo(monkeypatch, results):
    db = AsyncMongoMockClient()["orders_repeats"]
    monkeypatch.setattr(base_mod.db_resolver, "resolve", lambda **_: db)
    agg = AsyncMock(side_effect=results)
    monkeypatch.setattr(base_mod.BaseRepository, "aggregate", agg)
    return FuturePrescriptionRepository(tenant_id="t1"), agg


async def test_without_repeats_the_list_comes_from_executions(monkeypatch):
    repo, agg = _repo(monkeypatch, [HIST])
    out = await repo.order_suggestions(today=TODAY, lead_horizon=TODAY + timedelta(days=7),
                                       use_warehouse=False, include_repeats=False)
    assert agg.await_count == 1                                      # καμία ανάγνωση επαναλήψεων
    assert "$lookup" in str(agg.await_args.args[0][-3])              # τα ονόματα έρχονται από το ιστορικό
    assert [i["product_id"] for i in out] == ["p1", "p2"]            # χωρίς γραμμή δίχως προϊόν
    assert out[0]["avg_daily"] == 1.0 and out[0]["expected_demand"] == 7
    assert out[0]["suggested_qty"] == 9 and out[0]["unit_cost"] == 200
    assert out[0]["est_cost"] == 1800


async def test_with_repeats_only_opening_repeats_are_listed(monkeypatch):
    demand = [{"product_id": "p2", "expected_demand": 3, "suggested_qty": 4,
               "product_name": "B", "barcode": None}]
    repo, agg = _repo(monkeypatch, [demand, HIST])
    out = await repo.order_suggestions(today=TODAY, lead_horizon=TODAY + timedelta(days=7),
                                       use_warehouse=False)
    assert agg.await_count == 2
    assert [i["product_id"] for i in out] == ["p2"]


async def test_setting_keeps_the_advisor_horizon(monkeypatch):
    db = AsyncMongoMockClient()["orders_setting"]
    monkeypatch.setattr("app.core.db.shared_db", lambda: db)
    await db.tenants.insert_one({"_id": "t1", "order_horizon_days": 14})
    ctx = SimpleNamespace(tenant_id="t1")

    assert (await router.set_horizon(router.HorizonIn(days=0), ctx=ctx))["days"] == 0
    assert await router.repeats_excluded("t1") is True
    assert await router.order_horizon("t1") == 14                    # ο Σύμβουλος μένει όπως ήταν

    assert (await router.set_horizon(router.HorizonIn(days=3), ctx=ctx))["days"] == 3
    assert await router.repeats_excluded("t1") is False
    assert await router.order_horizon("t1") == 3
