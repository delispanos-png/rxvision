"""Regression tests for coupon execution semantics (ΗΔΥΚΑ CDA).

Locks the invariant that a coupon's `qr` flag distinguishes QR (True) from paper
authenticity-strip / ταινία γνησιότητας (False) — it is NEVER a proxy for
executed-vs-unexecuted. Every stored coupon comes from an *executed-quantity*
block (CDA 2.10.8), so it is always an executed unit; non-execution is expressed
only at line level (`is_executed=False`, which yields no coupon).

Guards against the bug where 108k+ strip-dispensed medicines (e.g. LEXAVON,
barcode 2607069759638) were wrongly shown as «ανεκτέλεστο» right before month-close.
"""

from __future__ import annotations

from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app.repositories import base as base_mod
from app.repositories.reimbursement import ReimbursementRepository


def _repo(db, tenant_id, monkeypatch):
    monkeypatch.setattr(base_mod.db_resolver, "resolve", lambda **_: db)
    return ReimbursementRepository(tenant_id=tenant_id)


async def _seed_item(db, tenant_id, exec_id, *, name, coupons, is_executed=True):
    pid = ObjectId()
    await db["products"].insert_one(
        {"_id": pid, "tenant_id": tenant_id, "name": name, "barcode": f"EOF-{name}"})
    await db["prescription_items"].insert_one({
        "tenant_id": tenant_id, "execution_id": exec_id, "product_id": pid,
        "is_executed": is_executed, "quantity": 1, "category": "normal",
        "details": {"coupons": coupons}})


async def test_strip_coupon_is_executed(monkeypatch):
    """qr=False + strip (ταινία) → executed=True, NOT «ανεκτέλεστο»."""
    db = AsyncMongoMockClient()["rxvision_test"]
    repo = _repo(db, "t1", monkeypatch)
    exid = ObjectId()
    await _seed_item(db, "t1", exid, name="LEXAVON",
                     coupons=[{"qr": False, "strip": "240162468168", "execution_no": 1.0}])
    await _seed_item(db, "t1", exid, name="ADVANTAN",
                     coupons=[{"qr": True, "qr_batch": "YY0771H", "strip": "0971489661708559",
                               "execution_no": 1.0}])

    lines, _ = await repo._rx_lines([exid])
    by_name = {ln["name"]: ln for ln in lines}
    # both executed; NEITHER shown as unexecuted
    assert by_name["LEXAVON"]["executed"] is True
    assert by_name["LEXAVON"]["qr"] is False          # still flagged as a strip (κράτα την ταινία)
    assert by_name["LEXAVON"]["lot"] == "240162468168"
    assert by_name["ADVANTAN"]["executed"] is True
    assert by_name["ADVANTAN"]["qr"] is True
    assert not any(ln["executed"] is False for ln in lines)


async def test_line_level_unexecuted_has_no_coupon(monkeypatch):
    """Genuine non-execution (is_executed=False, no coupons) still reads as unexecuted."""
    db = AsyncMongoMockClient()["rxvision_test"]
    repo = _repo(db, "t1", monkeypatch)
    exid = ObjectId()
    await _seed_item(db, "t1", exid, name="DISPENSED",
                     coupons=[{"qr": False, "strip": "S1", "execution_no": 1.0}])
    await _seed_item(db, "t1", exid, name="NOTGIVEN", coupons=[], is_executed=False)

    lines, _ = await repo._rx_lines([exid])
    by_name = {ln["name"]: ln for ln in lines}
    assert by_name["DISPENSED"]["executed"] is True
    assert by_name["NOTGIVEN"]["executed"] is False   # line-level flag preserved
