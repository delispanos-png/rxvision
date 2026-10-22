"""Αποστολή παραστατικού στη SoftOne (21/10/2026): από 06/10 ΚΑΘΕ αποστολή αποτύγχανε με
«connect_error:TypeError» — η ώρα επιβεβαίωσης Viva (datetime) περνούσε στο JSON της SoftOne."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from app.services.invoice_service import _build_payload


def test_payload_is_json_and_payment_has_only_what_softone_needs():
    inv = {"_id": "x", "tenant_id": "t", "kind": "renewal", "total": 1488, "net_amount": 1200, "vat_amount": 288,
           "created_at": datetime(2026, 10, 19, tzinfo=timezone.utc), "customer": {}, "lines": [],
           "payment": {"method": "card", "provider": "viva", "transaction_id": "abc", "verified": True,
                       "verified_at": datetime(2026, 10, 21, tzinfo=timezone.utc), "verified_amount": 1488}}
    p = _build_payload(inv)
    assert p["payment"] == {"method": "card", "provider": "viva", "transaction_id": "abc"}
    json.dumps(p["payment"])


async def test_pending_invoice_picks_up_mtrl_filled_in_later(monkeypatch):
    """Είδος SoftOne που αντιστοιχίστηκε ΜΕΤΑ τη δημιουργία του παραστατικού → μπαίνει στην αποστολή."""
    from mongomock_motor import AsyncMongoMockClient

    import app.services.invoice_service as inv_mod
    db = AsyncMongoMockClient()["s1_mtrl"]

    async def cfg():
        return {"mtrl_map": {"addon:advance_dispensing:yearly": "9601", "addon:catalog_seed": "9602"}}
    monkeypatch.setattr(inv_mod.softone_service, "platform_config", cfg)
    for ik in ("addon:advance_dispensing:yearly", "addon:catalog_seed:monthly", "addon:other:yearly"):
        await db["invoices"].insert_one({"item_key": ik, "mtrl": None})
    out = {d["item_key"]: (await inv_mod.ensure_mtrl(db, d)).get("mtrl") async for d in db["invoices"].find({})}
    assert out == {"addon:advance_dispensing:yearly": "9601", "addon:catalog_seed:monthly": "9602",
                   "addon:other:yearly": None}
