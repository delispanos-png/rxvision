"""Νυχτερινός αυτοέλεγχος: πιάνει ό,τι μας ξέφυγε 28/09–01/10/2026 (mongomock, χωρίς prod)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.services import integrity_checks as ic
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

T = "tenant-int"
NOW = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)


async def _seed(db, *, split_ok=True, lines_ok=True):
    ex = ObjectId()
    await db["prescription_executions"].insert_one({
        "_id": ex, "tenant_id": T, "external_id": "2609000000001:1", "status": "executed",
        "executed_at": NOW - timedelta(days=3), "valid_from": datetime(2026, 9, 25, tzinfo=timezone.utc),
        "repeat_current": 1, "repeat_total": 3, "details": {"repeat_period_days": 30},
        "amount_total": 1000, "amount_claimed": 700 if split_ok else 650, "patient_share": 300})
    await db["prescription_items"].insert_one({
        "_id": ObjectId(), "tenant_id": T, "execution_id": ex, "retail_price": 500,
        "qty_here": 2 if lines_ok else 3, "details": {"patient_share": 300, "difference": 0}})
    return ex


async def test_clean_data_has_no_findings():
    db = AsyncMongoMockClient()["int_ok"]
    ex = await _seed(db)
    await db["future_prescriptions"].insert_one({
        "tenant_id": T, "status": "pending", "source_execution_id": ex,
        "expected_open_date": datetime(2026, 10, 15, tzinfo=timezone.utc)})   # ΑΠΟ 25/09 + 30 − 10
    assert await ic.check_tenant(db, T, NOW) == []


async def test_catches_split_lines_phantom_duplicate_and_date():
    db = AsyncMongoMockClient()["int_bad"]
    ex = await _seed(db, split_ok=False, lines_ok=False)
    await db["future_prescriptions"].insert_many([
        {"tenant_id": T, "status": "pending", "source_execution_id": ex,
         "expected_open_date": datetime(2026, 10, 27, tzinfo=timezone.utc)},     # εκτέλεση + 30 (παλιό λάθος)
        {"tenant_id": T, "status": "pending", "source_execution_id": ex,
         "expected_open_date": datetime(2026, 10, 15, tzinfo=timezone.utc)},     # διπλή
        {"tenant_id": T, "status": "pending", "source_execution_id": ObjectId(),
         "expected_open_date": datetime(2026, 10, 15, tzinfo=timezone.utc)}])    # φάντασμα
    got = {f.check for f in await ic.check_tenant(db, T, NOW)}
    assert {"exec_split", "lines_vs_total", "prediction_phantom", "prediction_duplicate",
            "prediction_date"} <= got


async def test_platform_flags_stale_catalog():
    db = AsyncMongoMockClient()["int_plat"]
    await db["medicine_catalog"].insert_one({"_id": "1", "updated_at": NOW - timedelta(days=96)})
    got = {f.check for f in await ic.check_platform(db, NOW)}
    assert "catalog_stale" in got
