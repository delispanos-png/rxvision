"""Κοινή αποθήκευση Patient Intelligence (22/10/2026): ίδια απάντηση με/χωρίς cache, ανά φαρμακείο,
ανοιχτή αποτυχία αν πέσει το Redis, και φρένο στην προετοιμασία μετά τον συγχρονισμό."""

from __future__ import annotations

from datetime import datetime, timezone

from app.core import shared_cache


class FakeRedis:
    def __init__(self):
        self.d: dict = {}

    async def get(self, k):
        return self.d.get(k)

    async def set(self, k, v, ex=None, nx=False):
        if nx and k in self.d:
            return None
        self.d[k] = v
        return True


class DeadRedis:
    async def get(self, k):
        raise ConnectionError("down")

    async def set(self, *a, **k):
        raise ConnectionError("down")


async def test_cached_computes_once_and_returns_same_json(monkeypatch):
    r = FakeRedis()
    monkeypatch.setattr(shared_cache, "_redis", lambda: r)
    calls = []

    async def compute():
        calls.append(1)
        return {"when": datetime(2026, 10, 22, tzinfo=timezone.utc), "n": 3}

    a = await shared_cache.cached("k1", 60, compute)
    b = await shared_cache.cached("k1", 60, compute)
    assert a == b == {"when": "2026-10-22T00:00:00+00:00", "n": 3} and len(calls) == 1


async def test_fail_open_when_redis_down(monkeypatch):
    monkeypatch.setattr(shared_cache, "_redis", lambda: DeadRedis())

    async def compute():
        return {"ok": 1}
    assert await shared_cache.cached("k", 60, compute) == {"ok": 1}
    assert await shared_cache.claim("lock", 60) is False


def test_keys_are_per_tenant():
    assert shared_cache.key("T-A", "pi", "overview") != shared_cache.key("T-B", "pi", "overview")


async def test_view_cache_is_per_tenant(monkeypatch):
    from app.repositories.patient_intelligence import PatientIntelligenceRepository as R
    r = FakeRedis()
    monkeypatch.setattr(shared_cache, "_redis", lambda: r)

    async def fake_overview(self):
        return {"tenant": self.tenant_id}
    monkeypatch.setattr(R, "overview", fake_overview)
    assert (await R(tenant_id="T-A").cached_view("overview"))["tenant"] == "T-A"
    assert (await R(tenant_id="T-B").cached_view("overview"))["tenant"] == "T-B"
    assert (await R(tenant_id="T-A").cached_view("overview"))["tenant"] == "T-A"


async def test_warm_after_ingest_is_throttled(monkeypatch):
    import app.workers.intelligence_warm as w
    r = FakeRedis()
    monkeypatch.setattr(shared_cache, "_redis", lambda: r)
    sent = []
    monkeypatch.setattr(w.celery_app, "send_task", lambda name, args=None: sent.append(args))
    assert await w.schedule_after_ingest("T-A") is True
    assert await w.schedule_after_ingest("T-A") is False      # μέσα στο 30λεπτο → όχι ξανά
    assert await w.schedule_after_ingest("T-B") is True       # άλλο φαρμακείο → ανεξάρτητο
    assert sent == [["T-A"], ["T-B"]]
