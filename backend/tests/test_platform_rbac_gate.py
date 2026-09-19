"""Συμπεριφορά του back-office gate — όχι μόνο ότι ο χάρτης είναι πλήρης, αλλά ότι
όντως απαγορεύει.

Τρέχει σε mongomock, χωρίς παραγωγικά δεδομένα. Στήνει τρεις ταυτότητες (super admin,
μέλος «Μόνο ανάγνωση», μέλος χωρίς ομάδα) και χτυπά πραγματικές διαδρομές μέσω
TestClient, ώστε να ελέγχεται η ΑΛΥΣΙΔΑ: token → ομάδες → δικαίωμα → 200/403.
"""

from __future__ import annotations

import pytest
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app.core import db as db_mod
from app.core.security import create_platform_token
from app.services import platform_rbac as prbac

pytestmark = pytest.mark.asyncio


@pytest.fixture
def mongo(monkeypatch):
    client = AsyncMongoMockClient()
    database = client["rxvision_test"]
    monkeypatch.setattr(db_mod, "shared_db", lambda: database)
    monkeypatch.setattr(prbac, "shared_db", lambda: database)
    return database


@pytest.fixture
def app_client(mongo):
    """Μικρό app με ΜΟΝΟ τον admin router — αρκεί για να δοκιμαστεί το gate, και
    αποφεύγει το στήσιμο ολόκληρης της εφαρμογής."""
    from fastapi import APIRouter, Depends

    from app.core.deps import require_padmin

    inner = APIRouter()

    @inner.get("/tenants")
    async def _tenants():
        return {"items": []}

    @inner.post("/tenants")
    async def _create_tenant():
        return {"ok": True}

    @inner.post("/tenants/{tenant_id}/impersonate")
    async def _impersonate(tenant_id: str):
        return {"ok": True}

    @inner.get("/audit-logs")
    async def _audit():
        return {"items": []}

    @inner.get("/subscriptions")
    async def _subs():
        return {"items": []}

    @inner.get("/not-in-the-map")
    async def _unmapped():
        return {"ok": True}

    outer = APIRouter()
    outer.include_router(inner, prefix="/admin",
                         dependencies=[Depends(require_padmin("admin"))])
    app = FastAPI()
    app.include_router(outer, prefix="/api/v1")
    return TestClient(app, raise_server_exceptions=False)


async def _make_admin(mongo, *, super_admin=False, group_keys=()) -> str:
    await prbac.seed_platform_groups()
    gids = [g["_id"] async for g in mongo["platform_groups"].find(
        {"key": {"$in": list(group_keys)}}, {"_id": 1})]
    res = await mongo["platform_admins"].insert_one({
        "email": "x@cloudon.gr", "status": "active",
        "super_admin": super_admin, "group_ids": gids})
    return str(res.inserted_id)


def _auth(admin_id: str) -> dict:
    return {"Authorization": "Bearer " + create_platform_token(
        admin_id=admin_id, email="x@cloudon.gr")}


async def test_super_admin_passes_everything(mongo, app_client):
    h = _auth(await _make_admin(mongo, super_admin=True))
    for method, path in [("get", "/api/v1/admin/tenants"),
                         ("post", "/api/v1/admin/tenants"),
                         ("get", "/api/v1/admin/audit-logs"),
                         ("post", "/api/v1/admin/tenants/t1/impersonate")]:
        r = getattr(app_client, method)(path, headers=h)
        assert r.status_code == 200, f"{method.upper()} {path} → {r.status_code}"


async def test_readonly_member_can_read_but_not_write(mongo, app_client):
    h = _auth(await _make_admin(mongo, group_keys=["readonly"]))
    assert app_client.get("/api/v1/admin/tenants", headers=h).status_code == 200
    assert app_client.get("/api/v1/admin/subscriptions", headers=h).status_code == 200
    # Οι μεταβολές απαγορεύονται — αυτό ακριβώς δεν ίσχυε στο παλιό section gate.
    assert app_client.post("/api/v1/admin/tenants", headers=h).status_code == 403


async def test_readonly_member_cannot_impersonate_or_read_audit(mongo, app_client):
    """Τα δύο πιο ευαίσθητα: πρόσβαση σε δεδομένα ασθενών και στο αρχείο ενεργειών."""
    h = _auth(await _make_admin(mongo, group_keys=["readonly"]))
    assert app_client.post("/api/v1/admin/tenants/t1/impersonate", headers=h).status_code == 403
    assert app_client.get("/api/v1/admin/audit-logs", headers=h).status_code == 403


async def test_member_without_groups_sees_nothing(mongo, app_client):
    h = _auth(await _make_admin(mongo))
    assert app_client.get("/api/v1/admin/tenants", headers=h).status_code == 403


async def test_unmapped_route_is_denied_not_allowed(mongo, app_client):
    """Η καρδιά του deny-by-default: άγνωστη διαδρομή = 403, ακόμη και για μέλος με ομάδα."""
    h = _auth(await _make_admin(mongo, group_keys=["readonly"]))
    r = app_client.get("/api/v1/admin/not-in-the-map", headers=h)
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "route_not_mapped"


async def test_suspended_admin_is_locked_out(mongo, app_client):
    admin_id = await _make_admin(mongo, group_keys=["readonly"])
    await mongo["platform_admins"].update_one(
        {"_id": ObjectId(admin_id)}, {"$set": {"status": "suspended"}})
    assert app_client.get("/api/v1/admin/tenants", headers=_auth(admin_id)).status_code == 403


async def test_removing_a_group_takes_effect_without_relogin(mongo, app_client):
    """Τα δικαιώματα ΔΕΝ είναι στο token: αφαίρεση ομάδας ισχύει στο επόμενο request,
    με το ΙΔΙΟ token."""
    admin_id = await _make_admin(mongo, group_keys=["readonly"])
    h = _auth(admin_id)
    assert app_client.get("/api/v1/admin/tenants", headers=h).status_code == 200
    await mongo["platform_admins"].update_one(
        {"_id": ObjectId(admin_id)}, {"$set": {"group_ids": []}})
    assert app_client.get("/api/v1/admin/tenants", headers=h).status_code == 403
