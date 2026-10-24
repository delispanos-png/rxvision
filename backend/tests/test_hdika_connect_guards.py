"""Σύνδεση ΗΔΥΚΑ (24/10/2026, ΑΡΧΟΝΤΑΚΗΣ): (α) κανένας συγχρονισμός πριν ολοκληρωθεί η σύνδεση
(pharmacy_id), (β) κάθε προσπάθεια σύνδεσης καταγράφεται με την αιτία αποτυχίας."""

from __future__ import annotations

from mongomock_motor import AsyncMongoMockClient

from app.services import ingestion_gate


async def test_no_sync_before_pharmacy_id(monkeypatch):
    db = AsyncMongoMockClient()["gate"]

    async def no_stop(_db, _tid):
        return False
    monkeypatch.setattr(ingestion_gate, "_should_stop", no_stop)
    base = {"country": "GR", "status": "trial", "credentials_ref": {"hdika": "vault://x"}}
    await db.tenants.insert_many([
        {"_id": "ready", **base, "ingestion_config": {"hdika": {"pharmacy_id": "72257"}}},
        {"_id": "half", **base, "ingestion_config": {"hdika": {"pharmacy_id": None}}},   # μόλις έβαλε κωδικούς
        {"_id": "none", **base},
    ])
    assert await ingestion_gate.eligible_tenant_ids(db) == ["ready"]


async def test_connect_attempt_is_recorded(monkeypatch):
    import app.core.db as core_db
    from app.api.v1.routers import ingestion
    db = AsyncMongoMockClient()["rec"]
    monkeypatch.setattr(core_db, "shared_db", lambda: db)
    await ingestion._record_connect("ph1", False, "HdikaAuthError: λάθος κωδικός")
    await ingestion._record_connect("ph1", True)
    rows = [r async for r in db.sync_events.find({"tenant_id": "ph1", "kind": "hdika_connect"})]
    assert [r["ok"] for r in rows] == [False, True] and "λάθος κωδικός" in rows[0]["error"]
