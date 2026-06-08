"""Core invariant tests — the things that, if broken, break tenancy/security.

Pure-Python where possible (no live Mongo needed). Run: `make test`.
"""

from __future__ import annotations

from datetime import date

import pytest
from bson import ObjectId

from app.core.security import (
    create_access_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.repositories.base import BaseRepository, jsonsafe
from app.services.rbac_seed import ALL_PERMISSION_KEYS, DEFAULT_ROLES, PERMISSIONS
from app.utils.anonymization import age_group, pseudonymize


# ── serialization ──────────────────────────────────────────
def test_jsonsafe_converts_objectid_recursively():
    oid = ObjectId()
    out = jsonsafe({"_id": oid, "nested": [{"x": oid}], "n": 1})
    assert out["_id"] == str(oid)
    assert out["nested"][0]["x"] == str(oid)
    assert out["n"] == 1


# ── tenant isolation (THE invariant) ───────────────────────
def test_scope_injects_tenant_id():
    repo = BaseRepository(tenant_id="t-123")
    repo.collection_name = "anything"
    assert repo._scope({"a": 1}) == {"tenant_id": "t-123", "a": 1}
    assert repo._scope() == {"tenant_id": "t-123"}


@pytest.mark.asyncio
async def test_aggregate_prepends_tenant_match():
    captured = {}

    class FakeCursor:
        async def to_list(self, length=None):
            return [{"ok": 1}]

    class FakeColl:
        def aggregate(self, pipeline):
            captured["pipeline"] = pipeline
            return FakeCursor()

    class FakeDB:
        def __getitem__(self, _):
            return FakeColl()

    repo = BaseRepository(tenant_id="t-xyz")
    repo.collection_name = "prescription_executions"
    repo._db = FakeDB()
    await repo.aggregate([{"$group": {"_id": None}}])
    assert captured["pipeline"][0] == {"$match": {"tenant_id": "t-xyz"}}


# ── module resolution (core modules always available) ──────
def test_settings_is_always_enabled_regardless_of_plan():
    from app.services.auth_service import resolve_modules

    # plan with NO settings module, no overrides → settings still enabled
    mods = resolve_modules({"dashboard", "profitability"}, {})
    assert mods["settings"] == "enabled"
    assert mods["dashboard"] == "enabled"


def test_tenant_override_can_still_lock_a_core_module():
    from app.services.auth_service import resolve_modules

    mods = resolve_modules({"dashboard"}, {"settings": "locked", "dashboard": "trial"})
    assert mods["settings"] == "locked"   # explicit override wins
    assert mods["dashboard"] == "trial"


# ── hourly heatmap pipeline ────────────────────────────────
@pytest.mark.asyncio
async def test_hourly_heatmap_buckets_by_isodow_and_hour_in_athens():
    from datetime import datetime

    from app.repositories.prescriptions import PrescriptionRepository

    captured = {}

    class FakeCursor:
        async def to_list(self, length=None):
            return [{"dow": 1, "hour": 9, "value": 3}]

    class FakeColl:
        def aggregate(self, pipeline):
            captured["pipeline"] = pipeline
            return FakeCursor()

    class FakeDB:
        def __getitem__(self, _):
            return FakeColl()

    repo = PrescriptionRepository(tenant_id="t-1")
    repo._db = FakeDB()
    rows = await repo.hourly_heatmap(
        metric="executions", date_from=datetime(2026, 1, 1), date_to=datetime(2026, 2, 1)
    )

    assert rows == [{"dow": 1, "hour": 9, "value": 3}]
    pipe = captured["pipeline"]
    assert pipe[0] == {"$match": {"tenant_id": "t-1"}}            # tenant scope forced first
    group = next(s["$group"] for s in pipe if "$group" in s)
    assert group["_id"]["dow"]["$isoDayOfWeek"]["timezone"] == "Europe/Athens"
    assert group["_id"]["hour"]["$hour"]["timezone"] == "Europe/Athens"
    assert group["value"] == {"$sum": 1}                          # executions = count


@pytest.mark.asyncio
async def test_hourly_heatmap_value_metric_sums_amount():
    from datetime import datetime

    from app.repositories.prescriptions import PrescriptionRepository

    captured = {}

    class FakeColl:
        def aggregate(self, pipeline):
            captured["pipeline"] = pipeline

            class C:
                async def to_list(self, length=None):
                    return []

            return C()

    class FakeDB:
        def __getitem__(self, _):
            return FakeColl()

    repo = PrescriptionRepository(tenant_id="t-1")
    repo._db = FakeDB()
    await repo.hourly_heatmap(
        metric="value", date_from=datetime(2026, 1, 1), date_to=datetime(2026, 2, 1)
    )
    group = next(s["$group"] for s in captured["pipeline"] if "$group" in s)
    assert group["value"] == {"$sum": "$amount_total"}


# ── concept-doc features (per-patient, doctor, icd10, future, aging, unexecuted) ──
def _fake_mongo(monkeypatch, rows):
    """Patch the tenant DB resolver so EVERY repo (incl. inner ones) shares one fake
    Mongo that records the last pipeline and returns `rows`. Returns the capture dict."""
    captured = {"pipelines": []}

    class FakeColl:
        def aggregate(self, pipeline):
            captured["pipelines"].append(pipeline)
            captured["pipeline"] = pipeline

            class C:
                async def to_list(self, length=None):
                    return [dict(r) for r in rows]

            return C()

    class FakeDB:
        def __getitem__(self, _):
            return FakeColl()

    import app.repositories.base as base
    monkeypatch.setattr(base.db_resolver, "resolve",
                        lambda **_: FakeDB())
    return captured


@pytest.mark.asyncio
async def test_per_patient_groups_by_ref_and_joins_anonymized(monkeypatch):
    from datetime import datetime

    from app.repositories.patients import PatientExecutionsRepository

    cap = _fake_mongo(monkeypatch, [])
    await PatientExecutionsRepository(tenant_id="t").per_patient(
        date_from=datetime(2026, 1, 1), date_to=datetime(2026, 2, 1))
    pipe = cap["pipeline"]
    assert pipe[0] == {"$match": {"tenant_id": "t"}}
    group = next(s["$group"] for s in pipe if "$group" in s)
    assert group["_id"] == "$patient_ref"
    assert group["active_since"] == {"$min": "$executed_at"}
    assert any("$lookup" in s and s["$lookup"]["from"] == "patients_anonymized" for s in pipe)


@pytest.mark.asyncio
async def test_doctor_stats_counts_distinct_patients(monkeypatch):
    from datetime import datetime

    from app.repositories.doctors import DoctorExecutionsRepository

    cap = _fake_mongo(monkeypatch, [
        {"rx": 3, "value": 9, "claimed": 8, "cost": 5, "profit": 3,
         "margin_pct": 37.5, "distinct_patients": 2, "new_patients": 1}])
    out = await DoctorExecutionsRepository(tenant_id="t").stats(
        doctor_id="d1", date_from=datetime(2026, 1, 1), date_to=datetime(2026, 2, 1))
    group = next(s["$group"] for s in cap["pipelines"][0] if "$group" in s)
    assert group["patients"] == {"$addToSet": "$patient_ref"}
    assert out["distinct_patients"] == 2  # surfaced in the returned stats


@pytest.mark.asyncio
async def test_icd10_hierarchy_clamps_level_and_strips_dot(monkeypatch):
    from datetime import datetime

    from app.repositories.icd10 import Icd10Repository

    cap = _fake_mongo(monkeypatch, [])
    await Icd10Repository(tenant_id="t").aggregate_hierarchy(
        level=9, metric="value",  # 9 must clamp to 5
        date_from=datetime(2026, 1, 1), date_to=datetime(2026, 2, 1))
    node = next(s["$set"]["_node"] for s in cap["pipeline"]
                if "$set" in s and "_node" in s["$set"])
    assert node["$substrCP"][2] == 5  # clamped depth
    assert node["$substrCP"][0]["$replaceAll"]["find"] == "."  # dot stripped


@pytest.mark.asyncio
async def test_future_upcoming_filters_by_min_history(monkeypatch):
    from datetime import datetime

    from app.repositories.future import FuturePrescriptionRepository

    # min_history>0 triggers a sub-query for eligible patients, then an $in match.
    cap = _fake_mongo(monkeypatch, [{"_id": "p1"}, {"_id": "p2"}])
    await FuturePrescriptionRepository(tenant_id="t").upcoming(
        today=datetime(2026, 1, 1), horizon=datetime(2026, 2, 1), min_history=3)
    # aggregate() prepends the tenant-scope $match, so the user match is stage [1]
    match = cap["pipeline"][1]["$match"]
    assert match["patient_ref"]["$in"] == ["p1", "p2"]


@pytest.mark.asyncio
async def test_aging_maps_buckets_to_human_labels(monkeypatch):
    from datetime import datetime, timezone

    from app.repositories.profitability import ReceivablesRepository

    # mongo $bucket returns lower-edge ids (0/30/60) and the "90+" default
    _fake_mongo(monkeypatch, [
        {"_id": 0, "claimed": 100, "rx": 2},
        {"_id": 60, "claimed": 50, "rx": 1},
        {"_id": "90+", "claimed": 25, "rx": 1},
    ])
    out = await ReceivablesRepository(tenant_id="t").aging(
        now=datetime(2026, 6, 1, tzinfo=timezone.utc))
    labels = {b["bucket"]: b["claimed"] for b in out["buckets"]}
    assert labels == {"0-30": 100, "31-60": 0, "61-90": 50, "90+": 25}
    assert out["total_claimed"] == 175
    assert out["overdue_claimed"] == 75  # 61-90 + 90+


@pytest.mark.asyncio
async def test_unexecuted_matches_undispensed_lines(monkeypatch):
    from datetime import datetime

    from app.repositories.prescriptions import PrescriptionRepository

    cap = _fake_mongo(monkeypatch, [
        {"product_id": "x", "occurrences": 2, "qty": 2, "lost_value": 40, "category": "FYK"}])
    out = await PrescriptionRepository(tenant_id="t").unexecuted_substances(
        date_from=datetime(2026, 1, 1), date_to=datetime(2026, 2, 1))
    # aggregate() prepends the tenant-scope $match, so the user match is stage [1]
    match = cap["pipeline"][1]["$match"]
    assert match["is_executed"] is False
    assert out["total_lost_value"] == 40


# ── platform-admin identity (back-office gating) ───────────
def test_platform_token_has_padmin_and_no_tenant():
    from app.core.security import create_platform_token, decode_platform_token

    claims = decode_platform_token(create_platform_token(admin_id="a1", email="cloudon@rxvision.gr"))
    assert claims["padmin"] is True
    assert claims["scope"] == "access"
    assert claims["sub"] == "a1"
    assert "tid" not in claims  # platform admins belong to NO tenant


def test_tenant_and_platform_tokens_are_cryptographically_separate():
    """T-04: a token minted for one identity class cannot be decoded as the other —
    different signing key AND different audience."""
    from app.core.security import (
        create_access_token, create_platform_token, decode_platform_token, decode_token,
    )

    tenant_tok = create_access_token(user_id="u", tenant_id="t", roles=[],
                                     modules={}, permissions=[])
    platform_tok = create_platform_token(admin_id="a1", email="x@rxvision.gr")

    # each decodes under its own decoder
    assert decode_token(tenant_tok)["tid"] == "t"
    assert decode_platform_token(platform_tok)["padmin"] is True

    # cross-decoding is rejected (key + audience mismatch)
    with pytest.raises(ValueError):
        decode_platform_token(tenant_tok)
    with pytest.raises(ValueError):
        decode_token(platform_tok)


@pytest.mark.asyncio
async def test_get_platform_admin_rejects_tenant_token(monkeypatch):
    from fastapi import HTTPException
    from fastapi.security import HTTPAuthorizationCredentials

    from app.core.deps import get_platform_admin
    from app.core.security import create_access_token, create_platform_token

    def creds(tok):
        return HTTPAuthorizationCredentials(scheme="Bearer", credentials=tok)

    # a tenant OWNER token must NOT open the back-office (the old security hole).
    # With T-04 it is now rejected at the signature/audience layer (401), not 403.
    tenant_tok = create_access_token(user_id="u", tenant_id="t", roles=["owner"],
                                     modules={}, permissions=["*"])
    with pytest.raises(HTTPException) as ei:
        await get_platform_admin(creds=creds(tenant_tok))
    assert ei.value.status_code in (401, 403)

    # a real platform token passes and carries the admin identity
    ctx = await get_platform_admin(creds=creds(
        create_platform_token(admin_id="a1", email="cloudon@rxvision.gr")))
    assert ctx.admin_id == "a1" and ctx.email == "cloudon@rxvision.gr"


# ── tenant provisioning ────────────────────────────────────
def test_slugify_is_url_safe_and_unique_suffix():
    from app.services.provisioning import _slugify

    a = _slugify("Φαρμακείο Κέντρο Αθήνας!")
    b = _slugify("Φαρμακείο Κέντρο Αθήνας!")
    assert a != b  # uuid suffix → unique even for same name
    assert all(c.isalnum() or c == "-" for c in a)


@pytest.mark.asyncio
async def test_open_tenant_rejects_unknown_package(monkeypatch):
    import app.services.provisioning as prov

    class FakeColl:
        async def find_one(self, *_a, **_k):
            return None  # no package, no existing user/tenant

    class FakeDB:
        def __getitem__(self, _):
            return FakeColl()

    monkeypatch.setattr(prov, "shared_db", lambda: FakeDB())
    with pytest.raises(prov.ProvisioningError) as ei:
        await prov.TenantProvisioningService().open_tenant(
            name="X", owner_email="o@x.gr", package_code="ghost")
    assert "unknown_package" in str(ei.value)


# ── Noeton integration (HMAC webhook + inbound key) ────────
def test_noeton_webhook_hmac_roundtrip():
    import hashlib
    import hmac
    import time

    from app.services.noeton import verify_webhook

    secret = "whsec_test"
    body = b'{"event_type":"ping"}'
    ts = str(int(time.time()))
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert verify_webhook(body, secret, sig, ts) is True
    # tampered body → fail
    assert verify_webhook(b'{"event_type":"hacked"}', secret, sig, ts) is False
    # wrong secret → fail
    assert verify_webhook(body, "other", sig, ts) is False
    # stale timestamp (>5min) → fail
    old = str(int(time.time()) - 400)
    sig_old = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert verify_webhook(body, secret, sig_old, old) is False


def test_noeton_inbound_key_constant_time_match():
    from app.services.noeton import verify_inbound_key

    assert verify_inbound_key("noeton_abc", "noeton_abc") is True
    assert verify_inbound_key("noeton_abc", "noeton_xyz") is False
    assert verify_inbound_key(None, "noeton_abc") is False
    assert verify_inbound_key("x", "") is False  # not configured → reject


@pytest.mark.asyncio
async def test_login_blocked_for_suspended_or_expired_tenant(monkeypatch):
    import app.services.auth_service as a

    class FakeColl:
        def __init__(self, doc):
            self._doc = doc

        async def find_one(self, *a, **k):
            return self._doc

    class FakeDB:
        def __init__(self, tenant, sub):
            self._t, self._s = tenant, sub

        def __getitem__(self, name):
            return FakeColl(self._t if name == "tenants" else self._s)

    svc = a.AuthService()
    monkeypatch.setattr(a, "shared_db", lambda: FakeDB({"status": "suspended"}, None))
    assert await svc._tenant_access_ok("t") is False              # suspended tenant
    monkeypatch.setattr(a, "shared_db", lambda: FakeDB({"status": "active"}, {"status": "expired"}))
    assert await svc._tenant_access_ok("t") is False              # expired subscription
    monkeypatch.setattr(a, "shared_db", lambda: FakeDB({"status": "active"}, {"status": "active"}))
    assert await svc._tenant_access_ok("t") is True               # all good


# ── anonymization ──────────────────────────────────────────
def test_pseudonymize_is_stable_and_pepper_scoped():
    a = pseudonymize("01019012345", tenant_pepper="pep-A")
    a2 = pseudonymize("01019012345", tenant_pepper="pep-A")
    b = pseudonymize("01019012345", tenant_pepper="pep-B")
    assert a == a2                      # stable per tenant
    assert a != b                       # not correlatable across tenants
    assert "01019012345" not in a       # not reversible / no raw id leaked
    assert len(a) == 64                 # sha256 hex


def test_age_group_buckets():
    today = date(2026, 6, 5)
    assert age_group(2000, today=today) == "18-34"
    assert age_group(1945, today=today) == "75+"


# ── RBAC catalogue ─────────────────────────────────────────
def test_owner_has_wildcard_and_perms_are_well_formed():
    owner = next(r for r in DEFAULT_ROLES if r["key"] == "owner")
    assert owner["permissions"] == ["*"]
    for p in PERMISSIONS:
        assert p["_id"] == f'{p["resource"]}:{p["action"]}'
    assert "dashboard:read" in ALL_PERMISSION_KEYS


# ── auth token carries tenant + perms (RBAC wiring) ────────
def test_password_roundtrip():
    h = hash_password("s3cret")
    assert verify_password("s3cret", h)
    assert not verify_password("wrong", h)


def test_vault_is_mandatory_in_production(monkeypatch):
    """T-01/C2: in prod, an unavailable Vault must stop the app booting — never a
    silent in-memory fallback. In dev the fallback is allowed."""
    from app.core.config import settings as cfg
    from app.services.vault_service import VaultService

    monkeypatch.setattr(cfg, "VAULT_ADDR", "")
    monkeypatch.setattr(cfg, "VAULT_TOKEN", "")

    # production with no Vault → refuse to boot
    monkeypatch.setattr(cfg, "ENV", "prod")
    with pytest.raises(RuntimeError):
        VaultService().assert_ready()

    # dev with no Vault → fine (in-memory fallback)
    monkeypatch.setattr(cfg, "ENV", "local")
    VaultService().assert_ready()  # no raise


def test_verify_totp_accepts_valid_rejects_invalid():
    """T-05: TOTP verification actually works (the mfa_code was previously ignored)."""
    pyotp = pytest.importorskip("pyotp")
    from app.core.security import verify_totp

    secret = pyotp.random_base32()
    assert verify_totp(secret, pyotp.TOTP(secret).now()) is True
    assert verify_totp(secret, "000000") is False
    assert verify_totp("", pyotp.TOTP(secret).now()) is False
    assert verify_totp(secret, "") is False


def test_access_token_carries_tid_and_perms():
    tok = create_access_token(
        user_id="u1", tenant_id="t-1", roles=["owner"],
        modules={"dashboard": "enabled"}, permissions=["*"],
    )
    claims = decode_token(tok)
    assert claims["tid"] == "t-1"
    assert claims["perms"] == ["*"]
    assert claims["scope"] == "access"


# ── T-06: wholesale price resolution (profitability correctness) ───
@pytest.mark.asyncio
async def test_effective_wholesale_resolution_priority(monkeypatch):
    from app.core.config import settings as cfg
    from app.services.ingestion.canonical import CanonicalItem
    from app.services.ingestion.engine import IngestionEngine

    monkeypatch.setattr(cfg, "WHOLESALE_FALLBACK_MARGIN_PCT", 25.0)

    class _Coll:
        def __init__(self, doc):
            self._doc = doc
        async def find_one(self, *a, **k):
            return self._doc

    class _DB:
        def __init__(self, doc):
            self._coll = _Coll(doc)
        def __getitem__(self, _name):
            return self._coll

    eng = IngestionEngine.__new__(IngestionEngine)  # skip __init__ (no Vault/DB needed)
    eng.tenant_id = "t"

    def item(retail, wholesale):
        return CanonicalItem(barcode="b1", name="x", retail_price=retail, wholesale_price=wholesale)

    # 1) source-provided wholesale wins
    eng.db = _DB(None)
    assert await eng._effective_wholesale(item(1000, 700)) == (700, "source")
    # 2) known real masterdata used when the source omits it
    eng.db = _DB({"wholesale_price": 650, "wholesale_source": "source"})
    assert await eng._effective_wholesale(item(1000, 0)) == (650, "masterdata")
    # 3) a prior *estimate* is NOT treated as authoritative → re-estimate
    eng.db = _DB({"wholesale_price": 999, "wholesale_source": "estimated"})
    assert await eng._effective_wholesale(item(1000, 0)) == (750, "estimated")
    # 4) unknown → estimate from retail (1000 * (1 - 0.25) = 750); never 0/100%-margin
    eng.db = _DB(None)
    assert await eng._effective_wholesale(item(1000, 0)) == (750, "estimated")
