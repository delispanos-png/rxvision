"""Παύση συγχρονισμού ΗΔΥΚΑ (24/10/2026): SMS ΜΙΑ φορά σε γνήσια αλλαγή κωδικού, ΤΙΠΟΤΑ σε διακοπή
της ΗΔΥΚΑ (23/10: 5 φαρμακεία πάγωσαν λάθος), και αυτόματη επανεκκίνηση όταν η πύλη ξαναστηθεί."""

from __future__ import annotations

from mongomock_motor import AsyncMongoMockClient

import app.workers.ingestion as ing


def test_mobile_detection():
    assert ing._is_mobile("6980340315") and ing._is_mobile("+30 698 034 0315") and ing._is_mobile("00306980340315")
    assert not ing._is_mobile("210-9319793") and not ing._is_mobile("2333026728") and not ing._is_mobile("")


def _setup(monkeypatch, tenants):
    db = AsyncMongoMockClient()["np"]
    monkeypatch.setattr(ing, "_fresh_db", lambda: (type("C", (), {"close": lambda s: None})(), db))
    sms, mails = [], []

    async def send_sms(to, text):
        sms.append((to, text))

    async def send_email(to, subject, html, **k):
        mails.append(to)

    async def never_stop(_db, _tid):
        return False
    import app.services.comms as comms
    import app.services.mailer as mailer
    import app.services.ingestion_gate as gate
    monkeypatch.setattr(comms, "send_otp_sms", send_sms)
    monkeypatch.setattr(mailer, "send_email", send_email)
    monkeypatch.setattr(gate, "_should_stop", never_stop)

    async def fake_link(tid):
        return f"https://app.rxvision.gr/hdika-update#t=tok-{tid}"
    import app.services.hdika_password_link as hl
    monkeypatch.setattr(hl, "create_link", fake_link)
    return db, sms, mails


def test_sms_once_on_password_change_none_on_gateway_outage(monkeypatch):
    import asyncio
    db, sms, mails = _setup(monkeypatch, [])
    asyncio.run(db.tenants.insert_many([
        {"_id": "pwd", "name": "ΦΑΡΜ Α", "status": "active", "billing_profile": {"phone": "2109319793",
         "email": "a@x.gr"}, "company": {"phone": "6911111111"},
         "ingestion_config": {"hdika": {"auth_paused": True, "auth_error_msg": "Η πύλη ΗΔΥΚΑ απέρριψε τα credentials (HTTP 401)."}}},
        {"_id": "outage", "name": "ΦΑΡΜ Β", "status": "active", "billing_profile": {"phone": "6922222222",
         "email": "b@x.gr"},
         "ingestion_config": {"hdika": {"auth_paused": True,
                                        "auth_error_msg": "Η πύλη ΗΔΥΚΑ επέστρεψε σελίδα σφάλματος: Third-party server not responding"}}},
    ]))
    ing.notify_hdika_auth_paused()
    assert sms == [("6911111111", sms[0][1])] and "ΦΑΡΜ Α" in sms[0][1]   # κινητό, όχι το σταθερό
    assert "hdika-update#t=tok-pwd" in sms[0][1]                         # σύνδεσμος «ένα κλικ»
    assert mails == ["a@x.gr"]                                              # κανένα email για τη διακοπή
    ing.notify_hdika_auth_paused()                                          # δεύτερη φορά: ΟΧΙ νέο SMS
    assert len(sms) == 1
