"""Ένας αναγνώστης QR φαρμάκου (15/10/2026): διαχωριστής κενό/<GS>/κανένας, ελληνικό πληκτρολόγιο."""

from __future__ import annotations

from app.repositories.advance_dispensings import AdvanceDispensingRepository
from app.services.gs1_scan import parse
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient


def test_space_separator_binikos():
    p = parse("0105400835005815 1069028 21HHE0GY8K30 17290228")
    assert (p["batch"], p["serial"], p["expiry"], p["complete"]) == ("69028", "HHE0GY8K30", "290228", True)
    assert p["scanner"]["separator"] == "space"


def test_text_gs_in_greek_layout():
    p = parse("0108000000000002 17271031 101222904<ΓΣ>21ΑΠΦΓ9ΓΑΔΗ7")
    assert (p["batch"], p["serial"]) == ("1222904", "APFG9GADH7")
    assert p["scanner"] == {"separator": "text_gs", "greek_layout": True}


def test_no_separator_serial_containing_17_keeps_valid_expiry():
    p = parse("010541506210285521NN17891726093010XYZ")
    assert p["expiry"] == "260930" and p["serial"] == "NN1789" and p["batch"] == "XYZ"


def test_not_gs1_is_none():
    assert parse("000055646536565") is None


async def test_per_item_clear_closes_loan_only_when_all_cleared():
    db = AsyncMongoMockClient()["loan_items"]
    oid = ObjectId()
    await db["advance_dispensings"].insert_one({"_id": oid, "tenant_id": "t", "status": "open",
                                                "items": [{"name": "DOSTINEX"}, {"name": "DUOTRAV"}]})
    repo = AdvanceDispensingRepository(tenant_id="t")
    repo._db = db
    r = await repo.set_item_status(str(oid), 0, "cleared")
    assert r["loan_status"] == "open"
    r = await repo.set_item_status(str(oid), 1, "cleared")
    assert r["loan_status"] == "cleared"
    r = await repo.set_item_status(str(oid), 1, "open")
    assert r["loan_status"] == "open"


async def test_rescan_fixes_only_same_product():
    db = AsyncMongoMockClient()["loan_rescan"]
    oid = ObjectId()
    await db["advance_dispensings"].insert_one({"_id": oid, "tenant_id": "t", "status": "open", "items": [
        {"name": "DOSTINEX", "gtin": "05415062102855", "batch": "NN1989", "expiry": "073453"}]})
    await db["tenants"].insert_one({"_id": "t"})
    repo = AdvanceDispensingRepository(tenant_id="t")
    repo._db = db
    other = await repo.rescan_item(str(oid), 0, "0105400835005815 1069028 21HHE0GY8K30 17290228")
    assert other["error"] == "other_product"
    ok = await repo.rescan_item(str(oid), 0, "0105415062102855 21SER123 17280630 10NN1989")
    assert ok["ok"]
    it = (await db["advance_dispensings"].find_one({"_id": oid}))["items"][0]
    assert (it["strip"], it["expiry"], it["batch"]) == ("SER123", "280630", "NN1989")


async def test_history_lists_cleared_items_and_whole_closed_loans_with_filters():
    from datetime import datetime, timezone
    db = AsyncMongoMockClient(tz_aware=True)["loan_hist"]
    d1, d2 = datetime(2026, 10, 1, tzinfo=timezone.utc), datetime(2026, 10, 15, tzinfo=timezone.utc)
    await db["advance_dispensings"].insert_many([
        {"tenant_id": "t", "status": "open", "patient_name": "ΜΠΙΝΙΚΟΣ", "created_at": d1,
         "items": [{"name": "DOSTINEX", "status": "cleared", "closed_at": d2, "closed_by": "u1"}, {"name": "DUOTRAV"}]},
        {"tenant_id": "t", "status": "written_off", "patient_name": "ΤΣΟΥΛΟΥΒΗΣ", "created_at": d1,
         "closed_at": d2, "closed_by": "u2", "closed_reason": "απεβίωσε", "items": [{"name": "SALOSPIR"}]},
        {"tenant_id": "other", "status": "cleared", "patient_name": "X", "created_at": d1, "closed_at": d2,
         "items": [{"name": "DOSTINEX"}]}])
    repo = AdvanceDispensingRepository(tenant_id="t")
    repo._db = db
    allr = await repo.history()
    assert {(r["name"], r["status"]) for r in allr["items"]} == {("DOSTINEX", "cleared"), ("SALOSPIR", "written_off")}
    assert allr["items"][0]["days"] == 14
    assert [r["name"] for r in (await repo.history(product="dost"))["items"]] == ["DOSTINEX"]
    assert [r["reason"] for r in (await repo.history(kind="written_off"))["items"]] == ["απεβίωσε"]
    assert (await repo.history(date_from="2026-10-16"))["total"] == 0


async def test_history_tells_manual_from_prescription():
    db = AsyncMongoMockClient(tz_aware=True)["loan_via"]
    a, b = ObjectId(), ObjectId()
    await db["advance_dispensings"].insert_many([
        {"_id": a, "tenant_id": "t", "status": "open", "patient_name": "Α", "items": [{"name": "X"}, {"name": "Y"}]},
        {"_id": b, "tenant_id": "t", "status": "open", "patient_name": "Β", "items": [{"name": "Z"}]}])
    repo = AdvanceDispensingRepository(tenant_id="t")
    repo._db = db
    await repo.set_item_status(str(a), 0, "cleared", by="u1")
    await repo.set_status(str(b), "cleared", by="u1", execution_id="e1", external_id="2610000000001:1")
    h = {r["name"]: (r["via"], r["rx"]) for r in (await repo.history())["items"]}
    assert h == {"X": ("manual", None), "Z": ("prescription", "2610000000001:1")}
    assert [r["name"] for r in (await repo.history(via="prescription"))["items"]] == ["Z"]


def test_truncated_scan_is_corrupt_not_strip():
    """15/10/2026 (Μπινίκος, CRESTOR): χαμένοι χαρακτήρες από τη μέση → λάθος GTIN αποθηκευόταν ως χρέος."""
    from app.services import gs1_scan
    good = gs1_scan.parse("010403212910497610195Y01 172901312177430166686137")
    assert good["gtin"] == "04032129104976" and not good.get("corrupt")
    for bad in ("01040212910497610195Y01 172901312177430166686137",
                "0104032129110195Y01 172901312177430166686137",
                "0104032129104976Y01 172901312177430166686137",
                "0104032129104X01 172901312177430166686137"):
        assert gs1_scan.parse(bad)["corrupt"], bad
    assert gs1_scan.parse("2803120000123") is None          # ταινία ΕΟΦ μένει ταινία
