"""IngestionEngine end-to-end persist tests (mongomock-motor).

Covers the critical ingestion path that previously had no coverage (audit gap #4):
persist + reference upserts + pseudonymisation + content-hash dedup + tenant scoping.
"""

from __future__ import annotations

from datetime import datetime, timezone

from mongomock_motor import AsyncMongoMockClient

from app.services.ingestion import engine as engine_mod
from app.services.ingestion.canonical import (
    CanonicalDoctor,
    CanonicalExecution,
    CanonicalFund,
    CanonicalItem,
    CanonicalPatient,
)
from app.services.ingestion.engine import IngestionEngine


def _execution(external_id: str = "RX-1") -> CanonicalExecution:
    return CanonicalExecution(
        source="HDIKA",
        external_id=external_id,
        executed_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        patient=CanonicalPatient(national_id="01122334455", sex="F", birth_year=1960, area="Αττική"),
        doctor=CanonicalDoctor(full_name="Ιατρός Α", specialty="Παθολόγος"),
        fund=CanonicalFund(code="EOPYY", name="ΕΟΠΥΥ"),
        items=[CanonicalItem(barcode="5290001", name="Φάρμακο", quantity=2,
                             retail_price=420, wholesale_price=300, is_executed=True)],
        icd10=["E11.9"], repeat_current=1, repeat_total=3, patient_share=100, amount_total=840,
    )


def _engine(db, tenant_id, monkeypatch):
    # deterministic pepper — no Vault dependency in CI
    monkeypatch.setattr(engine_mod.vault, "tenant_pepper", lambda tid: f"pepper-{tid}")
    return IngestionEngine(tenant_id=tenant_id, db=db)


async def test_ingestion_engine_persists_pseudonymizes_and_dedups(monkeypatch):
    db = AsyncMongoMockClient()["rxvision_test"]
    eng = _engine(db, "t1", monkeypatch)

    job = await eng.ingest(source="HDIKA", job_type="backfill", records=[_execution()])
    assert job["stats"]["inserted"] == 1 and job["status"] == "success"

    ex = await db["prescription_executions"].find_one({"tenant_id": "t1", "external_id": "RX-1"})
    assert ex is not None
    assert ex["amount_total"] == 840                  # source-authoritative retail
    assert ex["amount_claimed"] == 740                # total − patient_share (100)
    assert ex["repeat_total"] == 3

    # exactly one priced item line, tenant-scoped to the execution
    assert await db["prescription_items"].count_documents(
        {"tenant_id": "t1", "execution_id": ex["_id"]}) == 1

    # patient pseudonymised — pseudo_id is a hash, never the raw national id
    pat = await db["patients_anonymized"].find_one({"tenant_id": "t1"})
    assert pat is not None
    assert pat["pseudo_id"] != "01122334455" and len(pat["pseudo_id"]) >= 32
    assert pat["rx_count"] == 1 and pat["rx_value_total"] == 840   # _post_process counters

    # re-ingest identical → idempotent duplicate (content-hash dedup), no second row
    job2 = await eng.ingest(source="HDIKA", job_type="backfill", records=[_execution()])
    assert job2["stats"]["duplicates"] == 1
    assert await db["prescription_executions"].count_documents({"tenant_id": "t1"}) == 1


async def test_ingestion_engine_is_tenant_scoped(monkeypatch):
    db = AsyncMongoMockClient()["rxvision_test"]
    await _engine(db, "t1", monkeypatch).ingest(
        source="HDIKA", job_type="backfill", records=[_execution("RX-A")])
    # a different tenant's scope sees none of t1's executions
    assert await db["prescription_executions"].count_documents({"tenant_id": "t2"}) == 0
    assert await db["prescription_executions"].count_documents({"tenant_id": "t1"}) == 1
