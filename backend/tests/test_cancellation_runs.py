"""Βραδινός έλεγχος ακυρώσεων (02/11/2026): 40 ημέρες πίσω, καταγραφή ΚΑΘΕ εκτέλεσης, και ο νυχτερινός
αυτοέλεγχος φωνάζει αν κάποιο φαρμακείο δεν ελέγχθηκε το τελευταίο 26ωρο."""

from __future__ import annotations

import inspect
from datetime import datetime, timedelta, timezone

from mongomock_motor import AsyncMongoMockClient

from app.services import integrity_checks as ic
from app.services.ingestion import cancellations


def test_window_is_40_days():
    assert inspect.signature(cancellations.reconcile_tenant).parameters["days"].default == 40


async def test_nightly_flags_missing_and_failed_runs(monkeypatch):
    db = AsyncMongoMockClient()["cr"]
    now = datetime(2026, 11, 3, 2, 40, tzinfo=timezone.utc)

    async def elig(_db):
        return ["ok1", "late", "bad"]
    import app.services.ingestion_gate as gate
    monkeypatch.setattr(gate, "eligible_tenant_ids", elig)
    await db.cancellation_runs.insert_many([
        {"tenant_id": "ok1", "at": now - timedelta(hours=7), "ok": True},
        {"tenant_id": "late", "at": now - timedelta(hours=40), "ok": True},          # χθες δεν έτρεξε
        {"tenant_id": "bad", "at": now - timedelta(hours=7), "ok": False, "reason": "too_few_days_fetched"},
    ])
    found = {f.check: f for f in await ic.check_platform(db, now)}
    assert found["cancellation_check_missing"].sample == ["late"]
    assert found["cancellation_check_failed"].sample == ["bad: too_few_days_fetched"]
