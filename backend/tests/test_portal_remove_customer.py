"""Φαρμακοποιός διαγράφει πελάτη από την πύλη (15/10/2026): μόνο τη δική του σύνδεση αν ο πελάτης έχει
κι άλλο φαρμακείο· αλλιώς όλο τον λογαριασμό πύλης. Τα δεδομένα του φαρμακείου μένουν πάντα."""

from __future__ import annotations

from app.repositories.patient_portal import PatientAccountRepository
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient


async def _setup(tenants: list[str]):
    db = AsyncMongoMockClient()["portal_rm"]
    acc = ObjectId()
    await db["patient_accounts"].insert_one({"_id": acc, "email": "koylaspano@yahoo.gr", "amka": "17047902121"})
    for t in tenants:
        ref = ObjectId()
        await db["patient_links"].insert_one({"account_id": acc, "tenant_id": t, "patient_ref": ref})
        await db["patients_anonymized"].insert_one({"_id": ref, "tenant_id": t, "rx_count": 5})
    await db["shop_favorites"].insert_one({"account_id": acc, "tenant_id": tenants[0]})
    repo = PatientAccountRepository()
    repo.db = db
    return db, repo, acc


async def test_only_pharmacy_deletes_whole_portal_account_but_keeps_pharmacy_data():
    db, repo, acc = await _setup(["ph-a"])
    r = await repo.remove_by_pharmacy(acc, "ph-a", by="u1")
    assert r == {"ok": True, "mode": "deleted"}
    assert await db["patient_accounts"].count_documents({}) == 0          # email/ΑΜΚΑ ελεύθερα ξανά
    assert await db["patient_links"].count_documents({}) == 0
    assert await db["shop_favorites"].count_documents({}) == 0
    assert await db["patients_anonymized"].count_documents({}) == 1       # η καρτέλα του φαρμακείου μένει
    assert await db["portal_account_removals"].count_documents({"mode": "deleted", "by": "u1"}) == 1


async def test_multi_pharmacy_customer_only_unlinked_from_this_one():
    db, repo, acc = await _setup(["ph-a", "ph-b"])
    r = await repo.remove_by_pharmacy(acc, "ph-a")
    assert r["ok"] and r["mode"] == "unlinked"
    assert await db["patient_accounts"].count_documents({}) == 1
    assert [l["tenant_id"] async for l in db["patient_links"].find({})] == ["ph-b"]


async def test_cannot_remove_customer_of_another_pharmacy():
    db, repo, acc = await _setup(["ph-b"])
    assert (await repo.remove_by_pharmacy(acc, "ph-a"))["error"] == "not_linked"
    assert await db["patient_accounts"].count_documents({}) == 1
