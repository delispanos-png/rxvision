"""Κουπόνια που η ΗΔΥΚΑ κρέμασε ΑΡΓΟΤΕΡΑ (27/11/2026): η εγγραφή 2610198794238:3 είχε κουπόνια μόνο
των φάσεων 1–2 → «Έλεγχος Barcode» χωρίς φάρμακο και qty_here=0. Τα τεστ κλειδώνουν κανόνα, θεραπεία
και ότι το hash αλλάζει ΜΟΝΟ για μπαγιάτικες εγγραφές (καμία μαζική επανεγγραφή)."""

from __future__ import annotations

from datetime import datetime, timezone

from app.services.ingestion import coupon_refresh as cr
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

T = "tenant-cp"
BC = "2610198794238"


def _c(*nos):
    return [{"execution_no": float(n), "qr": True} for n in nos]


def test_stale_rule():
    assert cr.stale_phase([_c(1), _c(1, 2)], 3) is True        # η περίπτωση του screenshot
    assert cr.stale_phase([_c(1), _c(1, 2, 3)], 3) is False
    assert cr.stale_phase([_c(1)], 1) is False
    assert cr.stale_phase([[], []], 2) is False                 # χωρίς κουπόνια: δεν ξέρουμε → όχι
    assert cr.stale_phase([[{"execution_no": None}]], 2) is False


async def _seed(db):
    ids = {}
    for n, nordex in ((1, _c(1)), (2, _c(1, 2)), (3, _c(1, 2))):
        ex = ObjectId()
        ids[n] = ex
        await db["prescription_executions"].insert_one({
            "_id": ex, "tenant_id": T, "source": "HDIKA", "external_id": f"{BC}:{n}",
            "executed_at": datetime(2026, 11, 18 + n, tzinfo=timezone.utc),
            "amount_total": 1000, "wholesale_cost": 0, "coupons_stale": n == 3})
        await db["prescription_items"].insert_many([
            {"tenant_id": T, "execution_id": ex, "quantity": 1, "executed_qty": 1, "is_executed": True,
             "retail_price": 600, "wholesale_price": 400, "qty_here": 1 if n == 1 else 0,
             "details": {"eof_code": "FIL", "coupons": _c(1)}},
            {"tenant_id": T, "execution_id": ex, "quantity": 4, "executed_qty": 3, "is_executed": False,
             "retail_price": 500, "wholesale_price": 300, "qty_here": 1 if n < 3 else 0,
             "details": {"eof_code": "NORDEX", "coupons": nordex}},
        ])
    return ids


async def test_apply_fresh_coupons_heals_phase_3():
    db = AsyncMongoMockClient()["cp1"]
    ids = await _seed(db)
    lines = [{"eof_code": "FIL", "coupons": _c(1)}, {"eof_code": "NORDEX", "coupons": _c(1, 2, 3)}]
    res = await cr.apply_fresh_coupons(db, T, BC, lines)
    assert res["still_stale"] == 0 and res["items"] == 3        # NORDEX σε κάθε μία από τις 3 εγγραφές
    nordex3 = await db["prescription_items"].find_one({"execution_id": ids[3], "details.eof_code": "NORDEX"})
    assert [c["execution_no"] for c in nordex3["details"]["coupons"]] == [1.0, 2.0, 3.0]
    assert nordex3["qty_here"] == 1                             # το δόθηκε-εδώ αποκαταστάθηκε
    fil3 = await db["prescription_items"].find_one({"execution_id": ids[3], "details.eof_code": "FIL"})
    assert fil3["qty_here"] == 0                                # FILICINE δόθηκε στη φάση 1, όχι στην 3
    ex3 = await db["prescription_executions"].find_one({"_id": ids[3]})
    assert ex3["coupons_stale"] is False
    assert ex3["wholesale_cost"] == 600                         # 300 × 1000/500
    # η φάση 1 δεν αλλάζει νούμερα (FIL 1 + NORDEX 1 πριν και μετά)
    nordex1 = await db["prescription_items"].find_one({"execution_id": ids[1], "details.eof_code": "NORDEX"})
    assert nordex1["qty_here"] == 1


async def test_still_stale_counts_attempts():
    db = AsyncMongoMockClient()["cp2"]
    ids = await _seed(db)
    lines = [{"eof_code": "FIL", "coupons": _c(1)}, {"eof_code": "NORDEX", "coupons": _c(1, 2)}]
    res = await cr.apply_fresh_coupons(db, T, BC, lines)
    assert res["still_stale"] == 1
    ex3 = await db["prescription_executions"].find_one({"_id": ids[3]})
    assert ex3["coupons_stale"] is True and ex3["coupon_refresh_attempts"] == 1


async def test_mark_stale_finds_existing():
    db = AsyncMongoMockClient()["cp3"]
    ids = await _seed(db)
    await db["prescription_executions"].update_many({}, {"$unset": {"coupons_stale": ""}})
    assert await cr.mark_stale(db, T) == 1
    ex3 = await db["prescription_executions"].find_one({"_id": ids[3]})
    assert ex3["coupons_stale"] is True


def test_hash_unchanged_for_healthy_records():
    from app.services.ingestion.canonical import CanonicalExecution
    from app.services.ingestion.engine import _content_hash
    ex = CanonicalExecution.__new__(CanonicalExecution)
    ex.source, ex.external_id = "HDIKA", f"{BC}:3"
    ex.executed_at = datetime(2026, 11, 24, tzinfo=timezone.utc)
    ex.repeat_current, ex.repeat_total, ex.icd10, ex.items = 1, 1, [], []
    assert _content_hash(ex, 1, 1) == _content_hash(ex, 1, 1, False)
    assert _content_hash(ex, 1, 1) != _content_hash(ex, 1, 1, True)
