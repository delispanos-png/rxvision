"""ΑΦΜ υποχρεωτικό στην αυτοεγγραφή + συμπλήρωση από ΗΔΥΚΑ (24/10/2026, ΦΑΡΜΑΚΕΙΟ ΑΡΧΟΝΤΑΚΗ).

Χωρίς ΑΦΜ: δεν βγαίνει παραστατικό αν ο πελάτης συνεχίσει, και ο φραγμός επανα-δοκιμής πέφτει
μόνο στο email (δωρεάν δοκιμές επ' αόριστον με καινούργιο email)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

from app.api.v1.routers.onboarding import _require_afm
from app.utils import afm


def test_afm_checksum():
    assert afm.is_valid("802845657") and afm.is_valid("EL 802 845 657")
    assert not afm.is_valid("802845658") and not afm.is_valid("12345678") and not afm.is_valid("")
    assert not afm.is_valid("000000000")


@pytest.mark.parametrize("value,country,err", [
    (None, "GR", "afm_required"), ("", "GR", "afm_required"),
    ("123456789", "GR", "afm_invalid"), ("", "CY", "afm_required")])
def test_signup_rejects_missing_or_invalid(value, country, err):
    with pytest.raises(HTTPException) as e:
        _require_afm(SimpleNamespace(afm=value), country)
    assert e.value.detail == {"error": err}


def test_signup_accepts_and_normalizes():
    c = SimpleNamespace(afm="802 845 657")
    _require_afm(c, "GR")
    assert c.afm == "802845657"
    _require_afm(SimpleNamespace(afm="12345678X"), "CY")        # Κύπρος: άλλη μορφή


async def _setup(monkeypatch, billing):
    import app.services.billing_identity as bi
    db = AsyncMongoMockClient()["afm"]
    monkeypatch.setattr(bi, "shared_db", lambda: db)

    async def lookup(a):
        return {"ok": True, "doy": "Α' ΗΡΑΚΛΕΙΟΥ", "address": "ΟΔΟΣ 1", "postal_code": "71201",
                "city": "ΗΡΑΚΛΕΙΟ", "title": "ΦΑΡΜΑΚΕΙΟ"}
    import app.services.aade_service as aade
    monkeypatch.setattr(aade, "lookup", lookup)
    await db.tenants.insert_one({"_id": "ph1", "billing_profile": dict(billing), "company": dict(billing)})
    await db.leads.insert_one({"_id": "x@mail.gr", "tenant_id": "ph1", "stage": "trial_active",
                               "activity": {"actions_total": 5}})
    return bi, db


async def test_fill_from_hdika_only_empty_fields_and_rekeys_lead(monkeypatch):
    bi, db = await _setup(monkeypatch, {"name": "ΦΑΡΜΑΚΕΙΟ Χ", "address": "ΔΙΚΗ ΤΟΥ 5", "afm": ""})
    r = await bi.fill_from_hdika("ph1", {"afm": "802845657", "address": "ΑΠΟ ΗΔΥΚΑ"})
    assert r["filled"]
    t = await db.tenants.find_one({"_id": "ph1"})
    assert t["billing_profile"]["afm"] == "802845657" and t["company"]["afm"] == "802845657"
    assert t["billing_profile"]["doy"] == "Α' ΗΡΑΚΛΕΙΟΥ"
    assert t["billing_profile"]["address"] == "ΔΙΚΗ ΤΟΥ 5"            # ό,τι έγραψε ο πελάτης ΜΕΝΕΙ
    assert t["billing_profile"]["name"] == "ΦΑΡΜΑΚΕΙΟ Χ"
    lead = await db.leads.find_one({"_id": "802845657"})
    assert lead and lead["activity"]["actions_total"] == 5 and lead["afm"] == "802845657"
    assert await db.leads.count_documents({}) == 1                    # όχι διπλό lead


async def test_fill_never_overwrites_existing_afm_or_accepts_invalid(monkeypatch):
    bi, db = await _setup(monkeypatch, {"afm": "094014201"})
    assert (await bi.fill_from_hdika("ph1", {"afm": "802845657"}))["reason"] == "already_has_afm"
    bi, db = await _setup(monkeypatch, {"afm": ""})
    assert (await bi.fill_from_hdika("ph1", {"afm": "123456789"}))["reason"] == "no_valid_afm"
