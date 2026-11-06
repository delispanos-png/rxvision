"""Ζωντανή υποστήριξη: χωρίς κωδικό δεν βλέπει κανείς, τίποτα δεν στέλνεται πριν μπει supporter,
δεν μένει τίποτα μετά την ανάγνωση και κανείς τρίτος δεν μπαίνει στη συνεδρία."""

from __future__ import annotations

import pytest
from mongomock_motor import AsyncMongoMockClient

from app.middleware.audit import _is_live_stream
from app.services import platform_rbac as prbac
from app.services import support_live as svc


class FakeRedis:
    def __init__(self):
        self.kv, self.h, self.q = {}, {}, {}

    async def get(self, k):
        return self.kv.get(k)

    async def getdel(self, k):
        return self.kv.pop(k, None)

    async def set(self, k, v, ex=None, nx=False):
        if nx and k in self.kv:
            return None
        self.kv[k] = v
        return True

    async def delete(self, *ks):
        for k in ks:
            self.kv.pop(k, None)
            self.q.pop(k, None)
            self.h.pop(k, None)

    async def hset(self, k, field=None, value=None, mapping=None):
        d = self.h.setdefault(k, {})
        if field is not None:
            d[field] = str(value)
        d.update({a: str(b) for a, b in (mapping or {}).items()})

    async def hgetall(self, k):
        return dict(self.h.get(k, {}))

    async def hdel(self, k, field):
        return 1 if self.h.get(k, {}).pop(field, None) is not None else 0

    async def hincrby(self, k, field, n):
        d = self.h.setdefault(k, {})
        d[field] = str(int(d.get(field, 0)) + n)

    async def expire(self, k, s):
        return True

    async def ttl(self, k):
        return 100

    async def rpush(self, k, v):
        self.q.setdefault(k, []).append(v)
        return len(self.q[k])

    async def lpop(self, k, n):
        out, self.q[k] = self.q.get(k, [])[:n], self.q.get(k, [])[n:]
        return out or None


@pytest.fixture
def redis(monkeypatch):
    r = FakeRedis()
    db = AsyncMongoMockClient()["support_live"]
    monkeypatch.setattr(svc, "_redis", lambda: r)
    monkeypatch.setattr(svc, "shared_db", lambda: db)
    monkeypatch.setattr(svc, "penc", lambda v: "enc:" + v)
    monkeypatch.setattr(svc, "pdec", lambda v: v.removeprefix("enc:"))
    r.db = db
    return r


async def _live(redis):
    s = await svc.start("t1", "u1", "Μαρία", "Φαρμακείο")
    joined = await svc.join(s["code"], "a1", "Νίκος", "n@rxvision.gr")
    return s["sid"], joined


async def test_nothing_is_accepted_before_the_supporter_joins(redis):
    s = await svc.start("t1", "u1", "Μαρία", "Φαρμακείο")
    m = await svc.customer_session(s["sid"], "t1", "u1")
    assert await svc.push(s["sid"], m, "οθόνη") is False
    assert redis.q == {}


async def test_code_is_single_use(redis):
    s = await svc.start("t1", "u1", "Μαρία", "Φαρμακείο")
    assert await svc.join(s["code"], "a1", "Νίκος", "n@x") is not None
    assert await svc.join(s["code"], "a2", "Άλλος", "o@x") is None
    assert await svc.join("000000", "a2", "Άλλος", "o@x") is None


async def test_only_the_session_owners_reach_it(redis):
    sid, _ = await _live(redis)
    assert await svc.customer_session(sid, "t2", "u1") is None        # άλλο φαρμακείο
    assert await svc.customer_session(sid, "t1", "u2") is None        # άλλος χρήστης
    assert await svc.admin_session(sid, "a2") is None                 # άλλος supporter
    assert await svc.admin_session(sid, "a1") is not None


async def test_screen_is_encrypted_and_gone_once_read(redis):
    sid, _ = await _live(redis)
    m = await svc.customer_session(sid, "t1", "u1")
    assert await svc.push(sid, m, "οθόνη") is True
    assert redis.q[svc._q(sid)] == ["enc:οθόνη"]
    assert (await svc.pull(sid, await svc.admin_session(sid, "a1")))["batches"] == ["οθόνη"]
    assert not redis.q[svc._q(sid)]


async def test_slow_supporter_does_not_pile_up_data(redis, monkeypatch):
    monkeypatch.setattr(svc, "MAX_QUEUE", 2)
    sid, _ = await _live(redis)
    m = await svc.customer_session(sid, "t1", "u1")
    for _ in range(3):
        await svc.push(sid, m, "x")
    assert svc._q(sid) not in redis.q
    assert (await svc.customer_state(sid, m))["need_snapshot"] is True


async def test_ending_stops_the_stream_and_keeps_a_trace(redis):
    sid, _ = await _live(redis)
    m = await svc.customer_session(sid, "t1", "u1")
    await svc.push(sid, m, "x")
    await svc.end(sid, by="customer")
    assert svc._q(sid) not in redis.q
    m = await svc.customer_session(sid, "t1", "u1")
    assert m["status"] == "ended" and await svc.push(sid, m, "x") is False
    actions = [a["action"] async for a in redis.db.audit_logs.find({"tenant_id": "t1"})]
    assert actions == ["support_live_started", "support_live_joined", "support_live_ended"]


LOGIN = {"login_sid": "L1", "tenant_id": "t1", "user_id": "u1", "user_label": "Μαρία",
         "tenant_name": "Φαρμακείο"}


async def test_direct_connection_needs_no_code_and_shows_the_supporter(redis):
    res = await svc.connect(LOGIN, "a1", "Νίκος", "n@x")
    m = await svc.customer_session(res["sid"], "t1", "u1")
    state = await svc.customer_state(res["sid"], m)
    assert state["status"] == "live" and state["supporter"] == "Νίκος"
    audit = await redis.db.audit_logs.find_one({"action": "support_live_joined"})
    assert audit["by"] == "n@x" and audit["without_code"] is True


async def test_only_one_tab_of_the_targeted_login_claims_it(redis):
    res = await svc.connect(LOGIN, "a1", "Νίκος", "n@x")
    assert await svc.claim("άλλη-σύνδεση") is None
    assert await svc.claim(None) is None
    assert await svc.claim("L1") == res["sid"]
    assert await svc.claim("L1") is None


async def test_ending_cancels_an_unclaimed_connection(redis):
    res = await svc.connect(LOGIN, "a1", "Νίκος", "n@x")
    await svc.end(res["sid"], by="supporter")
    assert await svc.claim("L1") is None


def test_background_check_does_not_keep_a_seat_alive():
    from app.core.deps import NO_SEAT_TOUCH
    assert "/api/v1/support-live/incoming".endswith(NO_SEAT_TOUCH)
    assert not "/api/v1/support-live/abc".endswith(NO_SEAT_TOUCH)


def test_live_view_is_a_separate_sensitive_permission():
    assert "support:live" in prbac.SENSITIVE_KEYS
    assert prbac._ADMIN[("POST", "/support-live/join")] == "support:live"


def test_stream_does_not_flood_the_audit_log():
    assert _is_live_stream("/api/v1/support-live/abc/events")
    assert _is_live_stream("/api/v1/admin/support-live/abc/pointer")
    assert not _is_live_stream("/api/v1/support-live/abc/end")
    assert not _is_live_stream("/api/v1/admin/support-live/join")
