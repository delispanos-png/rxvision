"""Πολιτική πρόσβασης (Φάση 0 — μέτρηση): αναγνώριση χρήστη από ΕΠΑΛΗΘΕΥΜΕΝΟ token, μετρητές ανά
λεπτό, μεταφορά στη Mongo χωρίς διπλομέτρηση, ποσοστημόρια, γεγονός AI browser, εξαιρέσεις."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from mongomock_motor import AsyncMongoMockClient

from app.core.security import create_access_token, create_patient_token
from app.services import access_policy as ap


class _Pipe:
    def __init__(self, r):
        self.r, self.ops = r, []

    def __getattr__(self, name):
        def _q(*a, **k):
            self.ops.append((name, a, k))
            return self
        return _q

    async def execute(self):
        return [await getattr(self.r, n)(*a, **k) for n, a, k in self.ops]


class FakeRedis:
    def __init__(self):
        self.kv, self.sets = {}, {}

    def pipeline(self, transaction=False):
        return _Pipe(self)

    async def incr(self, k):
        self.kv[k] = int(self.kv.get(k, 0)) + 1
        return self.kv[k]

    async def expire(self, *a, **k):
        return True

    async def sadd(self, k, v):
        self.sets.setdefault(k, set()).add(v)

    async def smembers(self, k):
        return set(self.sets.get(k, set()))

    async def exists(self, k):
        return int(k in self.sets or k in self.kv)

    async def set(self, k, v, nx=False, ex=None):
        if nx and k in self.kv:
            return None
        self.kv[k] = v
        return True

    async def delete(self, *keys):
        for k in keys:
            self.kv.pop(k, None)

    async def mget(self, keys):
        return [self.kv.get(k) for k in keys]


@pytest.fixture
def fake(monkeypatch):
    r = FakeRedis()
    db = AsyncMongoMockClient()["t"]
    monkeypatch.setattr(ap, "_redis", lambda: r)
    monkeypatch.setattr("app.core.db.shared_db", lambda: db)
    return r, db


def _tenant_tok():
    return "Bearer " + create_access_token(user_id="u1", tenant_id="T1", roles=[], modules={})


def test_identify_only_verified_tokens():
    assert ap.identify(_tenant_tok()) == ("tenant", "u1", "T1")
    pt = create_patient_token(account_id="A9", tenant_id="T1", patient_ref="P")
    assert ap.identify("Bearer " + pt) == ("patient", "A9", "T1")
    assert ap.identify("Bearer not.a.token") is None          # πλαστό → καμία μέτρηση
    assert ap.identify(None) is None                           # webhook / ICS / ανώνυμο


async def test_counts_aggregate_once_and_percentiles(fake):
    r, db = fake
    t0 = datetime(2026, 11, 25, 10, 0, 30, tzinfo=timezone.utc)
    for _ in range(30):
        await ap.observe(path="/api/v1/x", query="limit=500", auth=_tenant_tok(), ua="Mozilla/5.0", ip="1.1.1.1", now=t0)
    for _ in range(3):
        await ap.observe(path="/api/v1/x", query="", auth=_tenant_tok(), ua="Mozilla/5.0", ip="1.1.1.1",
                         now=t0.replace(minute=1))
    now = t0.replace(minute=5)
    assert await ap.aggregate(db, r=r, now=now) == 2
    assert await ap.aggregate(db, r=r, now=now) == 0          # ιδεμποτεντικό — καμία διπλομέτρηση
    day = await db[ap.DAILY].find_one({"_id": "2026-11-25:tenant"})
    assert day["hist"] == {"30": 1, "3": 1}
    u = await db[ap.USERS].find_one({"uid": "u1"})
    assert (u["max_per_min"], u["total"], u["minutes"], u["big_limit"]) == (30, 33, 2, 30)
    assert ap.percentiles({"3": 98, "30": 2}) == {"minutes": 100, "p50": 3, "p95": 3, "p99": 30, "max": 30}


def _scope(path="/api/v1/patients", ua="Mozilla/5.0", auth=None):
    h = [(b"user-agent", ua.encode())]
    if auth:
        h.append((b"authorization", auth.encode()))
    return {"type": "http", "path": path, "query_string": b"", "headers": h, "client": ("1.2.3.4", 1)}


CLAUDE_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Claude/6.1.2 Chrome/140 Safari/537.36 MSIX"


async def test_claude_desktop_blocked_everywhere_even_without_token(fake):
    """Κανόνας ιδιοκτήτη: το Claude Desktop δεν παίρνει ΟΥΤΕ ΕΝΑ δεδομένο — ούτε login, ούτε με token."""
    r, db = fake
    for path, auth in (("/api/v1/auth/login", None), ("/api/v1/patients", _tenant_tok()),
                       ("/api/v1/patient/prescriptions", None), ("/health", None)):
        res = await ap.guard(_scope(path, CLAUDE_DESKTOP, auth))
        assert res is not None and res.status_code == 403, path
    assert await db[ap.EVENTS].count_documents({"type": "agent_blocked"}) >= 1


async def test_ai_block_is_fail_closed_without_redis_or_mongo(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("down")
    monkeypatch.setattr(ap, "_redis", _boom)
    monkeypatch.setattr("app.core.db.shared_db", _boom)
    res = await ap.guard(_scope(ua=CLAUDE_DESKTOP))
    assert res is not None and res.status_code == 403


async def test_script_ua_only_blocked_with_user_token_and_partner_exempt(fake):
    assert await ap.guard(_scope("/api/v1/webhook/viva", "curl/8.5")) is None          # webhook: περνά
    res = await ap.guard(_scope("/api/v1/patients", "python-requests/2.31", _tenant_tok()))
    assert res is not None and res.status_code == 403                                   # χρήστης με script
    assert await ap.guard(_scope("/api/partner/v1/x", "python-requests/2", _tenant_tok())) is None
    assert await ap.guard(_scope("/api/v1/patients", "Mozilla/5.0 Chrome/140", _tenant_tok())) is None


async def test_lock_blocks_requests_and_login_until_admin_unlocks(fake, monkeypatch):
    r, db = fake
    sent = []

    async def _send_bulk(to, subj, html):
        sent.append(subj)
    monkeypatch.setattr("app.services.mailer.send_bulk", _send_bulk)
    await db["platform_admins"].insert_one({"email": "owner@x", "status": "active"})
    res = await ap.lock_account(db, kind="tenant", uid="u1", tid="T1", reason="webdriver", ua="Mozilla", ip="9.9.9.9")
    assert res["locked"] and sent
    assert await ap.is_locked(db, "tenant", "u1")
    deny = await ap.guard(_scope(auth=_tenant_tok()))
    assert deny is not None and deny.status_code == 403 and b"account_locked" in deny.body
    lk = await db[ap.LOCKS].find_one({"uid": "u1"})
    assert await ap.unlock(db, str(lk["_id"]), admin_id="A", reason="μίλησα με τον πελάτη")
    assert not await ap.is_locked(db, "tenant", "u1")
    assert await ap.guard(_scope(auth=_tenant_tok())) is None


async def test_beacon_locks_user_but_not_impersonation(fake, monkeypatch):
    from starlette.requests import Request

    from app.api.v1.routers.access import BeaconIn, beacon
    r, db = fake

    async def _noop(*a, **k):
        return None
    monkeypatch.setattr(ap, "_email_admins", _noop)
    monkeypatch.setattr(ap, "_revoke", _noop)
    imp = "Bearer " + create_access_token(user_id="u2", tenant_id="T1", roles=[], modules={}, imp=True)
    out = await beacon(BeaconIn(signal="webdriver"), Request(_scope(auth=imp)))
    assert out["locked"] is False and not await ap.is_locked(db, "tenant", "u2")
    out = await beacon(BeaconIn(signal="webdriver"), Request(_scope(auth=_tenant_tok())))
    assert out["locked"] is True and await ap.is_locked(db, "tenant", "u1")


async def test_observe_fails_open(monkeypatch):
    def _boom():
        raise RuntimeError("redis down")
    monkeypatch.setattr(ap, "_redis", _boom)
    await ap.observe(path="/api/v1/x", query="", auth=_tenant_tok(), ua="x", ip="1")   # δεν σκάει
