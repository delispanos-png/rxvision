"""ΕΝΑΣ συγχρονισμός ανά φαρμακείο στην ουρά (02/11/2026): το beat των 5′ έβαζε νέο ενώ ο προηγούμενος
περίμενε ακόμη → ~710 συγχρονισμοί/φαρμακείο/ημέρα, ουρά «sync» ως 3.300 και ψεύτικα SMS του φύλακα.
Διαφορετικά φαρμακεία μπαίνουν ΠΑΡΑΛΛΗΛΑ — το φρένο είναι ανά φαρμακείο."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from mongomock_motor import AsyncMongoMockClient

from app.workers import ingestion as ing


class FakeRedis:
    store: dict = {}

    def exists(self, k):
        return int(k in self.store)

    def set(self, k, v, nx=False, ex=None):
        if nx and k in self.store:
            return None
        self.store[k] = v
        return True

    def get(self, k):
        return self.store.get(k)

    def delete(self, *keys):
        for k in keys:
            self.store.pop(k, None)

    def close(self):
        pass


@pytest.fixture
def env(monkeypatch):
    FakeRedis.store = {}
    monkeypatch.setattr(ing._redis, "from_url", lambda *a, **k: FakeRedis())
    sent = []
    monkeypatch.setattr(ing.hdika_incremental_sync, "apply_async",
                        lambda args, kwargs=None, **k: sent.append((args[0], (kwargs or {}).get("queued_token"))))
    return sent


def test_second_enqueue_for_same_pharmacy_is_refused(env):
    assert ing.enqueue_incremental_sync("ph1") is True
    assert ing.enqueue_incremental_sync("ph1") is False          # περιμένει ήδη στην ουρά
    assert ing.enqueue_incremental_sync("ph2") is True           # άλλο φαρμακείο → παράλληλα
    assert [t for t, _ in env] == ["ph1", "ph2"]


def test_running_sync_blocks_new_enqueue(env):
    FakeRedis.store["hdika:sync:lock:ph1"] = "1"
    assert ing.enqueue_incremental_sync("ph1") is False
    assert env == []


def test_finished_task_frees_only_its_own_marker(env):
    ing.enqueue_incremental_sync("ph1")
    token = env[0][1]
    ing._clear_queued("ph1", "κάποιο-άλλο")                       # παλιά/ξένη εργασία → δεν αγγίζει
    assert ing.enqueue_incremental_sync("ph1") is False
    ing._clear_queued("ph1", token)                               # η δική του → ελευθερώνει
    assert ing.enqueue_incremental_sync("ph1") is True


def test_task_always_clears_marker_even_when_skipped(env, monkeypatch):
    ing.enqueue_incremental_sync("ph1")
    token = env[0][1]
    FakeRedis.store["hdika:sync:lock:ph1"] = "1"                  # ήδη τρέχει → skipped
    r = ing.hdika_incremental_sync.run("ph1", queued_token=token)
    assert r["status"] == "skipped"
    assert "hdika:sync:queued:ph1" not in FakeRedis.store


def test_stale_backlog_task_skips_after_recent_success(env, monkeypatch):
    db = AsyncMongoMockClient()["sse"]
    monkeypatch.setattr(ing, "_fresh_db", lambda: (type("C", (), {"close": lambda s: None})(), db))

    async def not_paused(*a):
        return False
    monkeypatch.setattr(ing, "_hdika_auth_paused", not_paused)
    import asyncio
    asyncio.run(db.sync_jobs.insert_one({
        "tenant_id": "ph1", "type": "incremental", "status": "success",
        "finished_at": datetime.now(timezone.utc) - timedelta(minutes=1)}))
    r = ing.hdika_incremental_sync.run("ph1")                     # παλιά εργασία χωρίς token
    assert r == {"tenant_id": "ph1", "status": "skipped", "note": "synced moments ago"}


def test_failed_enqueue_releases_marker(env, monkeypatch):
    def boom(*a, **k):
        raise ConnectionError("broker down")
    monkeypatch.setattr(ing.hdika_incremental_sync, "apply_async", boom)
    with pytest.raises(ConnectionError):
        ing.enqueue_incremental_sync("ph1")
    assert "hdika:sync:queued:ph1" not in FakeRedis.store          # δεν κρατά το φαρμακείο 40′
