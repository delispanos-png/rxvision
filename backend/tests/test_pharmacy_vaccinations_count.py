"""Εμβολιασμοί φαρμακείου («92…», Μητρώο ΗΔΥΚΑ) μετρούν ως συνταγές στο Dashboard & τους Δείκτες.

ΓΙΑΤΙ (23/10/2026): Μπινίκος 19/10 — RxVision 105 συνταγές, SoftOne 121· οι 13 ήταν αντιγριπικοί
εμβολιασμοί που ζουν μόνο στο `vaccinations`. Απόφαση ιδιοκτήτη: μετρούν, ως ξεχωριστός τύπος."""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app.repositories.prescriptions import PrescriptionRepository

T = "ph-vacc"
D0 = datetime(2026, 10, 19, 8, tzinfo=timezone.utc)
LO, HI = datetime(2026, 10, 19, tzinfo=timezone.utc), datetime(2026, 10, 20, tzinfo=timezone.utc)


async def _repo():
    db = AsyncMongoMockClient()["pv"]
    pa, pb = ObjectId(), ObjectId()
    await db.patients_anonymized.insert_many([
        {"_id": pa, "tenant_id": T, "pseudo_id": "ps-a"},
        {"_id": pb, "tenant_id": T, "pseudo_id": "ps-b"}])
    await db.prescription_executions.insert_many([
        {"tenant_id": T, "executed_at": D0, "amount_total": 1000, "amount_claimed": 800,
         "wholesale_cost": 500, "patient_ref": pa, "status": "executed", "fund_id": "F1"},
        {"tenant_id": T, "executed_at": D0, "amount_total": 2000, "amount_claimed": 1500,
         "wholesale_cost": 900, "patient_ref": pb, "status": "executed", "fund_id": "F1"}])
    await db.vaccinations.insert_many([
        # ο ασθενής Α έχει ΚΑΙ συνταγή → μετρά μία φορά στους ασθενείς
        {"tenant_id": T, "source": "INFLUENZA", "executed_at": D0, "barcode": "920001",
         "total_price": 700, "insurance_part": 700, "patient_ref": "ps-a"},
        {"tenant_id": T, "source": "INFLUENZA", "executed_at": D0, "barcode": "920002",
         "total_price": 700, "insurance_part": 700, "patient_ref": "ps-c"},
        {"tenant_id": T, "source": "INFLUENZA", "executed_at": D0, "barcode": "920003",
         "total_price": 700, "cancelled": True, "patient_ref": "ps-d"},          # ακυρωμένος → εκτός
        {"tenant_id": T, "source": "PRESCRIPTION", "executed_at": D0, "barcode": "26xxx",
         "patient_ref": "ps-a"},                         # με συνταγή γιατρού — είναι ήδη εκτέλεση
        {"tenant_id": "other", "source": "INFLUENZA", "executed_at": D0, "barcode": "929999",
         "total_price": 700}])                                                     # άλλο φαρμακείο
    r = PrescriptionRepository(tenant_id=T)
    r._db = db                      # _coll = self._db[collection_name] (property)
    return r


async def test_summary_counts_pharmacy_vaccinations_once():
    s = await (await _repo()).dashboard_summary(LO, HI)
    assert s["executions"] == 4 and s["pharmacy_vaccinations"] == 2
    assert s["value"] == 3000 + 1400 and s["claimed"] == 2300 + 1400
    assert s["patient_count"] == 2      # Α (συνταγή+εμβόλιο) + Β· ο «ps-c» δεν έχει καρτέλα εδώ


async def test_fund_filter_leaves_vaccinations_out():
    s = await (await _repo()).dashboard_summary(LO, HI, fund_id="F1")
    assert s["executions"] == 2 and s["pharmacy_vaccinations"] == 0


async def test_indicators_have_pharmacy_vaccination_row():
    b = await (await _repo()).characteristics_breakdown(LO, HI)
    assert b["items"]["pharmacy_vaccination"] == {"count": 2, "value": 1400}
    assert b["total"] == 4
