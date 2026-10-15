"""Δανεικό από QR (HMVS): όνομα από το GTIN & ταύτιση με συνταγή ίδιου πελάτη χωρίς σειριακό (15/10/2026)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.repositories.advance_dispensings import AdvanceDispensingRepository
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

T = "ph-loan"
G = "05415062102855"


async def _repo():
    db = AsyncMongoMockClient(tz_aware=True)["loan_gtin"]
    await db["medicine_catalog"].insert_one({"_id": "207520106", "name": "DOSTINEX 0,5MG/TAB"})
    await db["prescription_items"].insert_one({
        "tenant_id": "other-pharmacy", "product_id": ObjectId(), "executed_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "details": {"eof_code": "207520106", "coupons": [{"qr_product_code": G, "qr": True}]}})
    repo = AdvanceDispensingRepository(tenant_id=T)
    repo._db = db
    return db, repo


async def test_name_resolved_from_gtin_on_create():
    db, repo = await _repo()
    pid = ObjectId()
    await db["patients_anonymized"].insert_one({"_id": pid, "tenant_id": T, "full_name": "ΜΠΙΝΙΚΟΣ ΝΙΚΟΛΑΟΣ"})
    r = await repo.create(patient_name="x", patient_ref=str(pid), items=[{"gtin": G, "batch": "NN1989"}])
    loan = await db["advance_dispensings"].find_one({"_id": ObjectId(r["_id"])})
    assert loan["items"][0]["name"] == "DOSTINEX 0,5MG/TAB" and loan["items"][0]["eof_code"] == "207520106"


async def test_loan_without_serial_matches_same_drug_same_patient():
    db, repo = await _repo()
    pid, ex = ObjectId(), ObjectId()
    now = datetime.now(timezone.utc)
    await db["advance_dispensings"].insert_one({
        "tenant_id": T, "status": "open", "patient_ref": str(pid), "patient_name": "Π",
        "created_at": now - timedelta(days=2), "items": [{"gtin": G, "name": "DOSTINEX"}]})
    await db["prescription_executions"].insert_one({"_id": ex, "tenant_id": T, "patient_ref": pid,
                                                    "external_id": "2610000000001:1", "executed_at": now})
    await db["prescription_items"].insert_one({"tenant_id": T, "execution_id": ex, "executed_at": now,
                                               "details": {"coupons": [{"qr_product_code": G}]}})
    m = await repo.matches()
    assert len(m) == 1 and m[0]["same_patient"] and "ίδιο φάρμακο" in m[0]["matched_on"]


async def test_match_shows_and_clears_only_matched_items():
    db, repo = await _repo()
    pid, ex = ObjectId(), ObjectId()
    now = datetime.now(timezone.utc)
    lid = (await db["advance_dispensings"].insert_one({
        "tenant_id": T, "status": "open", "patient_ref": str(pid), "patient_name": "Π",
        "created_at": now - timedelta(days=2),
        "items": [{"name": "CRESTOR", "strip": "AAA111"}, {"name": "LEXOTANIL", "strip": "BBB222"}]})).inserted_id
    await db["prescription_executions"].insert_one({"_id": ex, "tenant_id": T, "patient_ref": pid,
                                                    "external_id": "2608147027202:1", "executed_at": now})
    await db["prescription_items"].insert_one({"tenant_id": T, "execution_id": ex, "executed_at": now,
                                               "details": {"coupons": [{"strip": "AAA111"}]}})
    m = await repo.matches()
    assert len(m) == 1 and m[0]["items"] == ["CRESTOR"] and m[0]["item_idxs"] == [0]
    r = await repo.clear_items_from_prescription(str(lid), m[0]["item_idxs"], by="u",
                                                 execution_id=m[0]["execution"]["id"], external_id="2608147027202:1")
    assert r["loan_status"] == "open"                       # το LEXOTANIL μένει χρέος
    loan = await db["advance_dispensings"].find_one({"_id": lid})
    assert [i.get("status") for i in loan["items"]] == ["cleared", None]
    assert loan["items"][0]["cleared_via"] == "prescription"
