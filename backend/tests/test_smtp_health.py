"""Υγεία αποστολής email (19/10/2026): 12 ημέρες χωρίς κανένα email (λάθος κωδικός SMTP) χωρίς να το ξέρει
κανείς. Κάθε αποστολή/δοκιμή γράφει την κατάσταση· το adminpanel δείχνει κόκκινη μπάρα όσο ok=False."""

from __future__ import annotations

import smtplib

import app.services.mailer as mailer
from mongomock_motor import AsyncMongoMockClient


async def _db(monkeypatch):
    db = AsyncMongoMockClient(tz_aware=True)["smtp_h"]
    monkeypatch.setattr(mailer, "shared_db", lambda: db)

    async def cfg(**k):
        return {"host": "mail.x", "port": 465, "username": "u", "password": "p", "from_email": "n@x"}
    monkeypatch.setattr(mailer, "get_smtp", cfg)
    return db


async def test_auth_failure_marks_unhealthy_and_keeps_first_failure_time(monkeypatch):
    await _db(monkeypatch)

    def bad(*a, **k):
        raise smtplib.SMTPAuthenticationError(535, b"authentication failed")
    monkeypatch.setattr(mailer, "_send_one", bad)
    for _ in range(2):
        try:
            await mailer.send_email("a@b.gr", "s", "h")
        except smtplib.SMTPAuthenticationError:
            pass
    h = await mailer.health()
    assert h["ok"] is False and "535" in h["error"] and h["failures"] == 2
    first = h["failing_since"]
    monkeypatch.setattr(mailer, "_send_one", lambda *a, **k: None)
    await mailer.send_email("a@b.gr", "s", "h")
    h = await mailer.health()
    assert h["ok"] is True and "error" not in h and "failing_since" not in h
    assert first is not None


async def test_wrong_recipient_does_not_raise_alarm(monkeypatch):
    await _db(monkeypatch)

    def refused(*a, **k):
        raise smtplib.SMTPRecipientsRefused({"x@y": (550, b"no such user")})
    monkeypatch.setattr(mailer, "_send_one", refused)
    try:
        await mailer.send_email("x@y", "s", "h")
    except smtplib.SMTPRecipientsRefused:
        pass
    assert (await mailer.health()).get("ok") is not False


async def test_periodic_login_check(monkeypatch):
    await _db(monkeypatch)

    def bad(cfg):
        raise smtplib.SMTPAuthenticationError(535, b"authentication failed")
    monkeypatch.setattr(mailer, "_login_only", bad)
    assert (await mailer.check_login())["ok"] is False
    assert (await mailer.health())["last_source"] == "check"
    monkeypatch.setattr(mailer, "_login_only", lambda cfg: None)
    assert (await mailer.check_login())["ok"] is True and (await mailer.health())["ok"] is True
