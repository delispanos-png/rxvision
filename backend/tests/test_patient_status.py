"""Κατάσταση πελάτη από την τελευταία επίσκεψη — ίδια όρια με την Εικόνα Ασθενών (01/10/2026)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.services import patient_status
from mongomock_motor import AsyncMongoMockClient

NOW = datetime(2026, 10, 1, tzinfo=timezone.utc)


async def test_states_follow_last_visit_and_never_touch_erased():
    db = AsyncMongoMockClient()["ps"]
    d = lambda n: NOW - timedelta(days=n)  # noqa: E731
    rows = {"new": (10, 10), "active": (400, 30), "at_risk": (400, 75), "lost": (400, 200),
            "inactive": (900, 500)}
    for name, (first, last) in rows.items():
        await db["patients_anonymized"].insert_one({"_id": name, "tenant_id": "t", "lifecycle": "active",
                                                    "first_seen_at": d(first), "last_seen_at": d(last)})
    await db["patients_anonymized"].insert_one({"_id": "gdpr", "tenant_id": "t", "lifecycle": "erased",
                                                "first_seen_at": d(900), "last_seen_at": d(900)})
    await db["patients_anonymized"].insert_one({"_id": "other", "tenant_id": "x", "lifecycle": "active",
                                                "first_seen_at": d(900), "last_seen_at": d(900)})
    await patient_status.refresh(db, "t", NOW)
    got = {p["_id"]: p["lifecycle"] async for p in db["patients_anonymized"].find({})}
    assert {k: got[k] for k in rows} == {k: k for k in rows}
    assert got["gdpr"] == "erased" and got["other"] == "active"     # GDPR & άλλο φαρμακείο ανέγγιχτα
