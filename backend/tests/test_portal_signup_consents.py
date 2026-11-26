"""Εγγραφή στην πύλη (Ελλάδα): αποδοχή όρων/ενημέρωσης + συγκατάθεση δεδομένων υγείας υποχρεωτικές,
επικοινωνία ανά κανάλι (email/SMS/Viber/push) και προωθητικά προαιρετικά — και εφαρμόζονται στον
λογαριασμό με την επιβεβαίωση του κωδικού (26/11/2026). Ίδιοι κανόνες με την αίτηση QR της Κύπρου."""

from __future__ import annotations

import pytest
from mongomock_motor import AsyncMongoMockClient

from app.services import patient_auth_service as pas


def test_terms_and_health_consent_are_required():
    with pytest.raises(pas.PatientError, match="terms_required"):
        pas.signup_consents(accept_terms=False, health_data=True, marketing=False, channels={}, source="t")
    with pytest.raises(pas.PatientError, match="health_consent_required"):
        pas.signup_consents(accept_terms=True, health_data=False, marketing=False, channels={}, source="t")
    c = pas.signup_consents(accept_terms=True, health_data=True, marketing=False,
                            channels={"sms": True, "telegram": True}, source="t")
    assert c["channels"] == {"email": False, "sms": True, "viber": False, "push": False}, "άγνωστα κανάλια αγνοούνται"
    assert c["version"] == pas.PORTAL_CONSENT_VERSION


async def test_verified_registration_applies_consents(monkeypatch):
    from app.core import db as core_db
    mock = AsyncMongoMockClient(tz_aware=True)
    monkeypatch.setattr(core_db, "get_client", lambda: mock)
    db = core_db.shared_db()
    svc = pas.PatientAuthService()

    async def contacts(amka):
        return [{"email": "onfile@x.gr"}]

    async def sent(self, code, emails, mobiles):
        sent.code = code
        return [{"type": "email", "hint": "o***@x.gr"}]

    async def session(self, acc, links, meta=None):
        return {"account_id": str(acc["_id"])}

    async def no_sync(*a, **k):
        return {}
    monkeypatch.setattr(svc.repo, "find_amka_contacts", contacts)
    monkeypatch.setattr(pas.PatientAuthService, "_send_otp", sent)
    monkeypatch.setattr(pas.PatientAuthService, "_start_session", session)
    from app.services import patient_contact_sync
    monkeypatch.setattr(patient_contact_sync, "sync_from_account", no_sync)

    consents = pas.signup_consents(accept_terms=True, health_data=True, marketing=True,
                                   channels={"email": True, "viber": True}, source="portal_register")
    r = await svc.start_registration(first_name="Α", last_name="Β", email="a@x.gr", phone="", amka="01017012345",
                                     password="Secret#123", consents=consents)
    await svc.verify_registration(r["challenge_id"], sent.code)
    acc = await db["patient_accounts"].find_one({"email": "a@x.gr"})
    assert acc["consents"]["health_data"]["granted"] is True and acc["consents"]["marketing"]["granted"] is True
    assert acc["terms_accepted"]["version"] == pas.PORTAL_CONSENT_VERSION
    assert acc["notify_prefs"] == {"email": True, "sms": False, "viber": True, "push": False}
    assert await db["patient_consent_log"].count_documents({"account_id": str(acc["_id"])}) == 2, "ίχνος GDPR"
