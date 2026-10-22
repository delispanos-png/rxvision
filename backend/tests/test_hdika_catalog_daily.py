"""Καθημερινή ενημέρωση συνταγογραφούμενων από ΗΔΥΚΑ (20/10/2026): κρατική λιανική/χονδρική σε ΟΛΕΣ τις
αποθήκες, ΜΟΝΟ σε rx· ΜΗ.ΣΥ.ΦΑ./παραφάρμακα (Profarm) δεν αγγίζονται· αποτυχία = κατάσταση για την μπάρα."""

from __future__ import annotations

from app.services.ingestion import hdika_catalog
from mongomock_motor import AsyncMongoMockClient


async def test_rx_prices_follow_catalog_everywhere_and_nothing_else():
    db = AsyncMongoMockClient(tz_aware=True)["hdika_daily"]
    await db["medicine_catalog"].insert_many([
        {"_id": "e1", "barcode": "2803041002020", "retail_cents": 4369, "wholesale_cents": 3088},   # FORXIGA
        {"_id": "e2", "barcode": "2801960303013", "retail_cents": 2149, "wholesale_cents": 1500}])
    await db["pharmacy_products"].insert_many([
        {"tenant_id": "A", "barcode": "2803041002020", "type": "rx_medicine", "price_cents": 4255, "wholesale_cents": 3088},
        {"tenant_id": "B", "barcode": "2803041002020", "type": "rx_medicine", "price_cents": 4255, "wholesale_cents": 3000},
        {"tenant_id": "A", "barcode": "2801960303013", "type": "otc_medicine", "price_cents": 2300, "wholesale_cents": 1607}])
    assert await hdika_catalog.apply_rx_prices(db) == 2
    a = await db["pharmacy_products"].find_one({"tenant_id": "A", "barcode": "2803041002020"})
    b = await db["pharmacy_products"].find_one({"tenant_id": "B", "barcode": "2803041002020"})
    otc = await db["pharmacy_products"].find_one({"tenant_id": "A", "barcode": "2801960303013"})
    assert a["price_cents"] == 4369 and b["price_cents"] == 4369 and b["wholesale_cents"] == 3088
    assert otc["price_cents"] == 2300 and otc["wholesale_cents"] == 1607          # Profarm μένει
    assert await hdika_catalog.apply_rx_prices(db) == 0                            # idempotent


async def test_failure_is_recorded_with_first_failure_time():
    db = AsyncMongoMockClient(tz_aware=True)["hdika_daily_h"]
    await hdika_catalog.record_catalog_health(db, ok=False, error="x")
    first = (await db["platform_settings"].find_one({"_id": "hdika_catalog_health"}))["failing_since"]
    await hdika_catalog.record_catalog_health(db, ok=False, error="y")
    h = await db["platform_settings"].find_one({"_id": "hdika_catalog_health"})
    assert h["ok"] is False and h["failing_since"] == first and h["error"] == "y"
    await hdika_catalog.record_catalog_health(db, ok=True, total=14197, changed=3, source_tenant="A")
    h = await db["platform_settings"].find_one({"_id": "hdika_catalog_health"})
    assert h["ok"] is True and "error" not in h and h["total"] == 14197
