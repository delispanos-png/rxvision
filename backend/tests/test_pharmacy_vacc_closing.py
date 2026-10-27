"""Εμβολιασμοί φαρμακείου (92…, `vaccinations`) στην ημερήσια συμφωνία & στην αναλυτική κατάθεση
(27/10/2026): εμφανίζονταν μόνο στον έλεγχο barcode. Μία πηγή (`_pharmacy_vacc`) για όλα —
χωρίς ακυρωμένους, χωρίς άλλα φαρμακεία. ΜΙΑ υποβολή με τα εκτελεσμένα εμβόλια: «ΕΟΠΥΥ - Εμβόλια»."""

from __future__ import annotations

from datetime import datetime, timezone

from mongomock_motor import AsyncMongoMockClient

from app.repositories import base as base_mod
from app.repositories.reimbursement import EOPYY_VAC, ReimbursementRepository

AT = datetime(2026, 10, 19, 9, 30, tzinfo=timezone.utc)


async def _repo(monkeypatch):
    db = AsyncMongoMockClient()["pv_closing"]
    monkeypatch.setattr(base_mod.db_resolver, "resolve", lambda **_: db)
    await db.prescription_executions.insert_one({
        "tenant_id": "t1", "external_id": "2610191234567:1", "executed_at": AT, "status": "executed",
        "fund_id": "F1", "amount_total": 1000, "amount_claimed": 750, "patient_share": 250, "details": {}})
    base = {"source": "INFLUENZA", "executed_at": AT, "total_price": 600, "insurance_part": 600,
            "patient_part": 0, "vaccine_name": "VAXIGRIP", "patient_name": "ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΙΑΝΝΗΣ"}
    await db.vaccinations.insert_many([
        {**base, "tenant_id": "t1", "barcode": "9210190000001"},
        {**base, "tenant_id": "t1", "barcode": "9210190000002", "cancelled": True},   # ακυρωμένος
        {**base, "tenant_id": "t2", "barcode": "9210190000003"},                       # άλλο φαρμακείο
    ])
    return ReimbursementRepository(tenant_id="t1")


async def test_daily_reconciliation_counts_pharmacy_vaccinations(monkeypatch):
    repo = await _repo(monkeypatch)
    d = await repo.daily_reconciliation("2026-10")
    assert EOPYY_VAC in d["groups"]
    assert d["totals"]["executions"] == 2 and d["totals"]["rx"] == 2
    assert d["totals"]["claim"] == 750 + 600
    only = await repo.daily_reconciliation("2026-10", group=EOPYY_VAC)
    assert only["totals"]["executions"] == 1 and only["totals"]["claim"] == 600
    picked = await repo.daily_reconciliation("2026-10", group=EOPYY_VAC, day_ids="2026-10-19")
    assert picked["ids"] == [] and [v["barcode"] for v in picked["vaccinations"]] == ["9210190000001"]


async def test_closing_report_has_pharmacy_vaccination_fund(monkeypatch):
    repo = await _repo(monkeypatch)
    rep = await repo.closing_report("2026-10")
    pv = next(f for f in rep["funds"] if f["fund"] == EOPYY_VAC)
    assert pv["rx"] == 1 and pv["claim"] == 600 and pv["invoice"]["issue"]
    assert pv["days"] == [{"date": "2026-10-19", "rx": 1, "claim": 600, "retail": 600, "patient": 0}]
    assert rep["grand"]["claim"] == 750 + 600
    assert rep["totals"]["rx"] == 2 and rep["totals"]["claim"] == 750 + 600


async def test_merges_with_executed_vaccines_into_one_submission(monkeypatch):
    repo = await _repo(monkeypatch)
    db = repo._db
    await db.fund_groups.insert_one({"name": "ΕΟΠΥΥ", "codes": ["EOPYY"]})
    await db.insurance_funds.insert_one({"_id": "F2", "tenant_id": "t1", "code": "EOPYY", "name": "ΕΟΠΥΥ"})
    await db.prescription_executions.insert_one({
        "tenant_id": "t1", "external_id": "2610197654321:1", "executed_at": AT, "status": "executed",
        "fund_id": "F2", "amount_total": 2000, "amount_claimed": 2000, "patient_share": 0,
        "details": {"vaccines": True}})
    rep = await repo.closing_report("2026-10")
    vac = [f for f in rep["funds"] if f["is_vaccine"]]
    assert [f["fund"] for f in vac] == [EOPYY_VAC]                    # ΜΙΑ γραμμή, όχι δύο
    assert vac[0]["rx"] == 2 and vac[0]["claim"] == 2000 + 600
    assert vac[0]["days"] == [{"date": "2026-10-19", "rx": 2, "claim": 2600, "retail": 2600, "patient": 0}]
    d = await repo.daily_reconciliation("2026-10", group=EOPYY_VAC)
    assert d["totals"]["executions"] == 2 and d["totals"]["claim"] == 2600
    assert d["groups"].count(EOPYY_VAC) == 1
