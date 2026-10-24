"""Σύνδεσμος «ένα κλικ» για νέο κωδικό ΗΔΥΚΑ (24/10/2026): μίας χρήσης, 48ω, ≤3 προσπάθειες, ο
κωδικός δοκιμάζεται στην ΗΔΥΚΑ ΠΡΙΝ αποθηκευτεί, και στη βάση ΜΟΝΟ το hash του συνδέσμου."""

from __future__ import annotations

from datetime import timedelta

import pytest
from mongomock_motor import AsyncMongoMockClient

from app.services import hdika_password_link as link
from app.services.ingestion.hdika_client import HdikaAuthError

GOOD = "Swsto!2026"


@pytest.fixture
def env(monkeypatch):
    db = AsyncMongoMockClient()["hl"]
    monkeypatch.setattr(link, "shared_db", lambda: db)
    vault_store = {"tenants/ph1/hdika": {"username": "u", "password": "old"}}
    patched = {}

    class Vault:
        def get_secret(self, p):
            return dict(vault_store.get(p) or {})

        def set_tenant_credentials(self, tid, src, creds):
            vault_store[f"tenants/{tid}/{src}"] = creds

    class Repo:
        def __init__(self, tenant_id):
            self.tid = tenant_id

        async def patch_ingestion_config(self, src, fields):
            patched.update(fields)

    state = {"down": False}

    class Client:
        def __init__(self, creds):
            self.creds = creds

        def authenticate(self):
            if state["down"]:
                raise RuntimeError("gateway down")
            if self.creds.get("password") != GOOD:
                raise HdikaAuthError("HTTP 401")

        def close(self):
            pass

    async def eff(tid):
        return {"username": "u", "password": "old", "api_key": "k"}

    async def rec(*a, **k):
        return None
    import app.api.v1.routers.ingestion as ing
    import app.repositories.tenants as reps
    import app.services.ingestion.hdika_client as hc
    import app.services.vault_service as vs
    monkeypatch.setattr(vs, "vault", Vault())
    monkeypatch.setattr(reps, "TenantRepository", Repo)
    monkeypatch.setattr(hc, "HdikaClient", Client)
    monkeypatch.setattr(ing, "_effective_hdika_creds", eff)
    monkeypatch.setattr(ing, "_record_connect", rec)
    return db, vault_store, patched, state


async def _token(db) -> str:
    await db.tenants.insert_one({"_id": "ph1", "name": "ΦΑΡΜΑΚΕΙΟ Χ"})
    url = await link.create_link("ph1")
    return url.split("#t=")[1]


async def test_happy_path_saves_and_unpauses_once(env):
    db, vault_store, patched, _ = env
    t = await _token(db)
    assert t not in str([d async for d in db[link.COLL].find({})])        # μόνο hash στη βάση
    assert (await link.check(t)) == {"ok": True, "pharmacy_name": "ΦΑΡΜΑΚΕΙΟ Χ", "attempts_left": 3}
    assert (await link.submit(t, GOOD)) == {"ok": True}
    assert vault_store["tenants/ph1/hdika"]["password"] == GOOD and patched["auth_paused"] is False
    assert (await link.submit(t, GOOD))["error"] == "invalid_or_expired"   # μίας χρήσης


async def test_wrong_password_never_saved_and_capped(env):
    db, vault_store, patched, _ = env
    t = await _token(db)
    for left in (2, 1, 0):
        r = await link.submit(t, "lathos")
        assert r == {"ok": False, "error": "wrong_password", "attempts_left": left}
    assert vault_store["tenants/ph1/hdika"]["password"] == "old" and not patched
    assert (await link.submit(t, GOOD))["error"] == "invalid_or_expired"   # κλείδωσε μετά από 3


async def test_hdika_down_does_not_burn_attempt(env):
    db, _, _, state = env
    t = await _token(db)
    state["down"] = True
    assert (await link.submit(t, GOOD))["error"] == "hdika_unavailable"
    assert (await link.check(t))["attempts_left"] == 3
    state["down"] = False
    assert (await link.submit(t, GOOD))["ok"]


async def test_expired_link(env):
    db, _, _, _ = env
    t = await _token(db)
    await db[link.COLL].update_many({}, {"$set": {"expires_at": link._now() - timedelta(minutes=1)}})
    assert (await link.check(t))["ok"] is False and (await link.submit(t, GOOD))["ok"] is False
