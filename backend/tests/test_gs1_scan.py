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


def test_owner_barcode_rule_22_10_2026():
    """Κανόνας ιδιοκτήτη: κουπόνι ΕΟΦ 13ψήφιο «280…» · LOT ταινίας 12ψήφιο · άυλο 20ψήφιο «00…» ·
    QR με πεδία 01/17/10/21 σε ΟΠΟΙΑΔΗΠΟΤΕ σειρά · οτιδήποτε άλλο = άλλος κωδικός."""
    from app.services.gs1_scan import classify
    assert classify("2801960303013") == {"kind": "eof_code", "code": "2801960303013"}
    assert classify("250093253638") == {"kind": "eof_lot", "code": "250093253638"}
    assert classify("21009325363")["kind"] == "other"                 # 11 ψηφία: ούτε LOT ούτε QR
    assert classify("00000055646536565123") == {"kind": "intangible", "code": "00000055646536565123"}
    q = classify("010403212910497610195Y01 172901312177430166686137")
    assert q["kind"] == "qr" and q["qr"]["gtin"] == "04032129104976"
    # ίδιο κουτί, πεδία σε άλλη σειρά: σειριακός πρώτα, μετά λήξη, κωδικός, παρτίδα
    r = classify("2177430166686137 1729013101040321291049761095Y01")
    assert r["kind"] == "qr" and r["qr"]["gtin"] == "04032129104976" and r["qr"]["expiry"] == "290131"
    assert classify("5201234567890")["kind"] == "other"               # παραφάρμακο / ΜΗ.ΣΥ.ΦΑ.
    assert classify("0104032129104X01 172810312110623731217451")["kind"] == "corrupt"


async def test_lone_lot_needs_the_eof_coupon(monkeypatch):
    from app.repositories.advance_dispensings import AdvanceDispensingRepository
    from mongomock_motor import AsyncMongoMockClient
    import app.core.db as core_db
    db = AsyncMongoMockClient()["adv_lot"]
    monkeypatch.setattr(core_db.db_resolver, "resolve", lambda **k: db)
    repo = AdvanceDispensingRepository(tenant_id="T")
    import pytest
    with pytest.raises(ValueError, match="lot_needs_eof_coupon"):
        await repo.create(patient_name="Π", patient_ref="p1", items=[{"lot": "250093253638", "strip": "250093253638"}])
    await db["medicine_catalog"].insert_one({"_id": "304100202", "barcode": "2801960303013", "full_name": "REGAINE 5%"})
    loan = await repo.create(patient_name="Π", patient_ref="p1",
                             items=[{"barcode": "2801960303013", "lot": "250093253638", "strip": "250093253638"}])
    it = loan["items"][0] if isinstance(loan, dict) and loan.get("items") else (await db["advance_dispensings"].find_one({}))["items"][0]
    assert it["barcode"] == "2801960303013" and it["lot"] == "250093253638" and it["name"] == "REGAINE 5%"
