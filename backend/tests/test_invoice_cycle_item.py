"""Παραστατικό συνδρομής: είδος SoftOne ανά ΚΥΚΛΟ — ετήσια ποτέ με το μηνιαίο είδος (02/10/2026)."""

from __future__ import annotations

import app.services.invoice_service as inv
from mongomock_motor import AsyncMongoMockClient


async def _make(monkeypatch, cycle, mtrl_map):
    db = AsyncMongoMockClient()["invc"]
    monkeypatch.setattr(inv, "shared_db", lambda: db)

    async def cfg():
        return {"series": "7002", "mtrl_map": mtrl_map}
    monkeypatch.setattr(inv.softone_service, "platform_config", cfg)
    await db["tenants"].insert_one({"_id": "t", "name": "Φαρμακείο", "billing_profile": {"afm": "123", "email": "a@b.gr"}})
    await db["subscriptions"].insert_one({"tenant_id": "t", "plan": "pro", "billing_cycle": cycle})
    return await inv.create_for_payment(tenant_id="t", kind="renewal", gross_cents=12400,
                                        description="Ανανέωση συνδρομής RxVision — Pro",
                                        payment={"transaction_id": f"x-{cycle}"})


async def test_yearly_uses_yearly_item(monkeypatch):
    d = await _make(monkeypatch, "yearly", {"pkg:pro:monthly": "M1", "pkg:pro:yearly": "Y1"})
    assert d["mtrl"] == "Y1" and d["item_key"] == "pkg:pro:yearly" and "(ετήσια)" in d["description"]


async def test_yearly_without_code_never_falls_to_monthly(monkeypatch):
    d = await _make(monkeypatch, "yearly", {"pkg:pro": "M_OLD", "default": "GEN"})
    assert d["mtrl"] == "GEN"


async def test_monthly_keeps_old_key(monkeypatch):
    d = await _make(monkeypatch, "monthly", {"pkg:pro": "M_OLD"})
    assert d["mtrl"] == "M_OLD" and "(μηνιαία)" in d["description"]
