"""SoftOne (10/11/2026): παραστατικό χωρίς είδος (MTRL) δεν «Απέτυχε» πια — περιμένει χωρίς να καίει
προσπάθειες και φεύγει μόνο του μόλις γίνει η αντιστοίχιση ή οριστεί Γενικό είδος."""

from __future__ import annotations

from datetime import datetime, timezone

from mongomock_motor import AsyncMongoMockClient

from app.services import invoice_service, softone_service


async def _setup(monkeypatch, mtrl_map):
    db = AsyncMongoMockClient(tz_aware=True)["softone_unmapped"]
    calls = []

    async def cfg():
        return {"mtrl_map": mtrl_map}

    async def issue(payload):
        calls.append(payload)
        return {"ok": True, "findoc": 1, "mark": "M"} if payload.get("mode") != "find" else {"ok": True}
    monkeypatch.setattr(softone_service, "platform_config", cfg)
    monkeypatch.setattr(softone_service, "issue", issue)
    await db.invoices.insert_one({"_id": "i1", "kind": "extra", "item_key": "addon:connect:monthly",
                                  "status": "sending", "attempts": 0, "customer": {"afm": "1"},
                                  "created_at": datetime.now(tz=timezone.utc)})
    return db, calls


async def test_unmapped_waits_without_burning_attempts(monkeypatch):
    db, calls = await _setup(monkeypatch, {"pkg:pro:monthly": "9605"})
    assert await invoice_service._issue_one(db, await db.invoices.find_one({"_id": "i1"})) is False
    inv = await db.invoices.find_one({"_id": "i1"})
    assert inv["status"] == "pending" and inv["attempts"] == 0 and "Λείπει είδος SoftOne" in inv["last_error"]
    assert calls == []                                   # τίποτα δεν στάλθηκε στη SoftOne


async def test_mapping_later_sends_it(monkeypatch):
    db, calls = await _setup(monkeypatch, {"addon:connect:monthly": "9700"})
    assert await invoice_service._issue_one(db, await db.invoices.find_one({"_id": "i1"})) is True
    assert (await db.invoices.find_one({"_id": "i1"}))["mtrl"] == "9700"


async def test_general_item_is_the_safety_net(monkeypatch):
    db, calls = await _setup(monkeypatch, {"default": "9999"})
    assert await invoice_service._issue_one(db, await db.invoices.find_one({"_id": "i1"})) is True
    assert (await db.invoices.find_one({"_id": "i1"}))["mtrl"] == "9999"
