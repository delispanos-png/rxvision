"""GDPR data-subject-rights + consent-ledger tests (mongomock-motor, round-trip).

Verifies: full export gather, erasure with LEGAL HOLD (strip identifiers, keep statutory
prescription record), consent ledger current/withdrawn logic (the comms gate), rectify, and
tenant isolation. No prod DB, no containers."""

from __future__ import annotations

import app.repositories.base as base_mod
import app.services.gdpr_service as gdpr_service
from app.repositories.consents import PatientConsentRepository
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

T1 = "tenant-1"
T2 = "tenant-2"


def _wire(monkeypatch):
    """One shared mongomock DB behind both the repo resolver and gdpr_service.shared_db."""
    db = AsyncMongoMockClient()["rxvision_gdpr_test"]
    monkeypatch.setattr(base_mod.db_resolver, "resolve", lambda **_: db)
    monkeypatch.setattr(gdpr_service, "shared_db", lambda: db)
    return db


async def _seed_patient(db, tenant_id, oid):
    await db["patients_anonymized"].insert_one({
        "_id": oid, "tenant_id": tenant_id, "pseudo_id": "h" * 64, "full_name": "Α. Παπαδοπούλου",
        "amka": "01122334455", "sex": "F", "age_group": "35-49", "rx_count": 1, "lifecycle": "active"})
    await db["patient_contacts"].insert_one({
        "_id": oid, "tenant_id": tenant_id, "phone": "2101234567", "email": "a@b.gr",
        "address": "Οδός 1", "marketing_consent": True})
    ex_id = ObjectId()
    await db["prescription_executions"].insert_one({
        "_id": ex_id, "tenant_id": tenant_id, "patient_ref": oid, "amount_total": 500,
        "icd10": ["E11.9"]})
    await db["prescription_items"].insert_one({
        "_id": ObjectId(), "tenant_id": tenant_id, "execution_id": ex_id, "retail_price": 500})
    await db["future_prescriptions"].insert_one({
        "_id": ObjectId(), "tenant_id": tenant_id, "patient_ref": oid, "status": "pending"})
    return ex_id


async def test_export_gathers_everything(monkeypatch):
    db = _wire(monkeypatch)
    oid = ObjectId()
    await _seed_patient(db, T1, oid)

    bundle = await gdpr_service.export_subject(T1, str(oid), actor_user_id="u1")
    assert bundle["identity"]["full_name"] == "Α. Παπαδοπούλου"
    assert bundle["contact"]["phone"] == "2101234567"
    assert bundle["counts"]["executions"] == 1
    assert bundle["counts"]["items"] == 1
    assert bundle["counts"]["future"] == 1
    # export (a GET) is audited explicitly with the subject id
    log = await db["audit_logs"].find_one({"action": "gdpr.export", "subject_id": str(oid)})
    assert log is not None and log["tenant_id"] == T1 and log["category"] == "gdpr"


async def test_erase_strips_identifiers_but_keeps_legal_hold(monkeypatch):
    db = _wire(monkeypatch)
    oid = ObjectId()
    await _seed_patient(db, T1, oid)

    res = await gdpr_service.erase_subject(T1, str(oid), actor_user_id="u1", reason="patient request")
    assert res["contact_deleted"] == 1

    # contact PII gone
    assert await db["patient_contacts"].find_one({"_id": oid}) is None
    # direct identifiers stripped, pseudonymous aggregate kept
    pat = await db["patients_anonymized"].find_one({"_id": oid})
    assert pat is not None and "full_name" not in pat and "amka" not in pat
    assert pat["erased"] is True and pat["pseudo_id"] == "h" * 64
    # LEGAL HOLD: statutory prescription records remain
    assert await db["prescription_executions"].count_documents({"patient_ref": oid}) == 1
    assert await db["prescription_items"].count_documents({"tenant_id": T1}) == 1
    # erasure withdraws all consent + is audited
    assert (await PatientConsentRepository(tenant_id=T1).current(oid)).get("all") == "withdrawn"
    assert await db["audit_logs"].find_one({"action": "gdpr.erase", "subject_id": str(oid)}) is not None


async def test_consent_ledger_current_and_withdrawn(monkeypatch):
    db = _wire(monkeypatch)
    oid = ObjectId()
    repo = PatientConsentRepository(tenant_id=T1)

    await repo.record(patient_id=oid, channel="email", status="granted",
                      source="ui", policy_version="v1")
    assert (await repo.current(oid))["email"] == "granted"
    assert oid not in await repo.withdrawn_patient_ids("email")   # granted → still in audience

    await repo.record(patient_id=oid, channel="email", status="withdrawn",
                      source="ui", policy_version="v1")
    assert (await repo.current(oid))["email"] == "withdrawn"      # latest event wins
    assert oid in await repo.withdrawn_patient_ids("email")       # comms gate excludes them


async def test_rectify_updates_contact(monkeypatch):
    db = _wire(monkeypatch)
    oid = ObjectId()
    await _seed_patient(db, T1, oid)
    updated = await gdpr_service.rectify_contact(T1, str(oid), {"phone": "2109999999"}, actor_user_id="u1")
    assert updated["phone"] == "2109999999"
    assert await db["audit_logs"].find_one({"action": "gdpr.rectify", "subject_id": str(oid)}) is not None


async def test_export_is_tenant_scoped(monkeypatch):
    db = _wire(monkeypatch)
    oid = ObjectId()
    await _seed_patient(db, T1, oid)
    # the SAME id queried under another tenant returns nothing (isolation by construction)
    bundle = await gdpr_service.export_subject(T2, str(oid))
    assert bundle["identity"] is None
    assert bundle["counts"]["executions"] == 0
