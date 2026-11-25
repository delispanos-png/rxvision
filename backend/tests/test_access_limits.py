"""Πολιτική πρόσβασης — Φάση 2: όρια ρυθμού (μέτρηση/επιβολή), strikes → κλείδωμα, όρια ανά φαρμακείο
(μόνο αυστηρότερα), εξαγωγές (όριο ημέρας, όριο γραμμών, υδατογράφημα, SHA-256)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from mongomock_motor import AsyncMongoMockClient

from app.services import access_limits as al
from app.services import access_policy as ap
from tests.test_access_policy import FakeRedis

NOW = datetime(2026, 11, 25, 10, 0, 5, tzinfo=timezone.utc)
M = "tenant|u1|T1"


@pytest.fixture
def env(monkeypatch):
    r = FakeRedis()
    db = AsyncMongoMockClient()["t"]
    monkeypatch.setattr(ap, "_redis", lambda: r)
    monkeypatch.setattr("app.core.db.shared_db", lambda: db)
    al._cache.update(at=0.0, val=None)
    al._tcache.clear()
    ap._SEEN.clear()

    async def _noop(*a, **k):
        return None
    monkeypatch.setattr(ap, "_email_admins", _noop)
    monkeypatch.setattr(ap, "_revoke", _noop)
    return r, db


async def _hit(r, db, n, *, path="/api/v1/x", query="", method="GET"):
    out = None
    for i in range(1, n + 1):
        out = await al.check(r, member=M, kind="tenant", tid="T1", exempt=False, method=method, path=path,
                             query=query, minute_count=i, now=NOW, db=db)
    return out


def test_classify_request():
    assert al.classify_request("GET", "/api/v1/patients", "limit=50&page=2") == "list"
    assert al.classify_request("GET", "/api/v1/patients/65a1b2c3d4e5f60718293a4b", "") == "detail"
    assert al.classify_request("GET", "/api/v1/prescriptions/2611251234567", "") == "detail"
    assert al.classify_request("POST", "/api/v1/patients", "limit=5") is None


async def test_observe_mode_never_denies_but_records(env):
    r, db = env
    rule, _ = await _hit(r, db, 40)
    assert rule is None                                            # μέτρηση: ΚΑΝΕΝΑ 429
    u = await db[ap.USERS].find_one({"uid": "u1"})
    assert u["over"]["per_min"] == 1                               # μία «θα έπαιρνε 429», όχι 15
    assert await db[ap.EVENTS].count_documents({"type": "would_limit"}) == 1
    assert not await ap.is_locked(db, "tenant", "u1")


async def test_enforce_429_and_two_strikes_lock(env):
    r, db = env
    await al.save_settings(db, {"mode": "enforce"}, admin_id="A")
    rule, retry = await _hit(r, db, 26)
    assert rule == "per_min" and 1 <= retry <= 60                  # 26ο αίτημα → 429
    assert not await ap.is_locked(db, "tenant", "u1")              # 1ο strike
    for k in list(r.kv):                                           # νέο λεπτό
        if k.startswith("acc:list:") or k.startswith("acc:detail:"):
            r.kv.pop(k)
    rule, _ = await _hit(r, db, 5, query="limit=20")               # 5η λίστα στο λεπτό → 2ο strike
    assert rule == "list_per_min"
    assert await ap.is_locked(db, "tenant", "u1")


async def test_admin_and_impersonation_exempt(env):
    r, db = env
    await al.save_settings(db, {"mode": "enforce"}, admin_id="A")
    for kind, exempt in (("admin", False), ("tenant", True)):
        rule, _ = await al.check(r, member=M, kind=kind, tid="T1", exempt=exempt, method="GET", path="/x",
                                 query="", minute_count=999, now=NOW, db=db)
        assert rule is None


async def test_tenant_limits_only_stricter(env):
    r, db = env
    base = await al.settings(db)
    assert al.stricter_only(base, {"per_min": 10, "per_hour": 9999, "exports_per_day": 0}) == {"per_min": 10}
    await db["tenants"].insert_one({"_id": "T1", "access_limits": {"per_min": 10, "per_hour": 9999}})
    eff = await al.tenant_limits(db, "T1", base)
    assert eff["per_min"] == 10 and eff["per_hour"] == base["per_hour"]


async def test_exports_limit_rows_and_watermark(env):
    r, db = env
    kw = dict(kind="tenant", uid="u1", tid="T1", exempt=False, fmt="xlsx", screen="/patients", filters="",
              ip="1.1.1.1", ua="Mozilla", user_label="Φαρμακοποιός Α")
    for _ in range(4):                                             # μέτρηση: η 4η ΔΕΝ αρνείται
        res = await al.export_authorize(db, rows=5000, **kw)
    assert res["allowed"] and res["max_rows"] == 2000 and "Φαρμακοποιός Α" in res["watermark"]
    await al.save_settings(db, {"mode": "enforce"}, admin_id="A")
    res = await al.export_authorize(db, rows=10, **kw)
    assert res["allowed"] is False                                 # επιβολή: πάνω από 3 → άρνηση
    ok = await al.export_done(db, (await db[al.EXPORTS].find_one({"status": "allowed"}))["_id"].__str__(),
                              uid="u1", sha256="a" * 64, rows=2000)
    assert ok
    assert not await al.export_done(db, "x", uid="u1", sha256="a" * 64, rows=1)


async def test_guard_end_to_end_429_and_exempt_paths(env):
    from tests.test_access_policy import _scope, _tenant_tok
    r, db = env
    await al.save_settings(db, {"mode": "enforce", "per_min": 3}, admin_id="A")
    outs = [await ap.guard(_scope("/api/v1/patients", auth=_tenant_tok())) for _ in range(4)]
    assert outs[:3] == [None, None, None]
    assert outs[3] is not None and outs[3].status_code == 429 and outs[3].headers.get("retry-after")
    # ζωντανή υποστήριξη / refresh / beacon: εκτός ορίων ρυθμού
    assert await ap.guard(_scope("/api/v1/support-live/incoming", auth=_tenant_tok())) is None
    assert await ap.guard(_scope("/api/v1/access/export", auth=_tenant_tok())) is None
