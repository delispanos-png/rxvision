"""Ingestion router — ΗΔΥΚΑ credentials/sync (GR, primary), ΓΕΣΥ upload (CY, step 2).

Country rule (sources.py): a GR tenant ingests ONLY via ΗΔΥΚΑ, a CY tenant ONLY via ΓΕΣΥ.
Credentials are write-only: they go to Vault and only a `vault://...` reference is persisted.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status

from app.core.config import settings
from app.core.db import shared_db
from app.core.deps import TenantContext, require
from app.repositories.sync_jobs import SyncJobRepository
from app.repositories.tenants import TenantRepository
from app.schemas.ingestion import (
    HDIKA_SECRET_FIELDS,
    ConnectionTestOut,
    CredentialsStatusOut,
    HdikaConfigOut,
    HdikaCredentialsIn,
)
from app.services.ingestion.engine import IngestionEngine
from app.services.ingestion.gesy import parse_gesy_xml
from app.services.ingestion.hdika_client import HdikaClient
from app.services.ingestion.sources import assert_source_allowed
from app.services.vault_service import vault
from app.utils.net import UnsafeUrlError, assert_safe_outbound_url


def _assert_safe_idika_base_url(creds: dict) -> None:
    """Block SSRF via a tenant-supplied ΗΔΥΚΑ base_url (M2) — public hosts only."""
    if creds.get("base_url"):
        try:
            assert_safe_outbound_url(creds["base_url"],
                                     allowed_host_suffixes=settings.idika_allowed_host_suffixes)
        except UnsafeUrlError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Μη επιτρεπτό endpoint ΗΔΥΚΑ: {exc}")

router = APIRouter()

_MODULE = "ingestion"
_MAX_UPLOAD = 25 * 1024 * 1024  # 25 MB inline cap


async def _tenant_country(tenant_id: str) -> str:
    tenant = await TenantRepository(tenant_id=tenant_id).get()
    return (tenant or {}).get("country", "")


def _public_config(creds: dict) -> dict:
    """Non-secret subset of the ΗΔΥΚΑ config persisted on the tenant for display."""
    return {
        "configured": True,
        "username": creds.get("username"),   # non-secret → returned in full so the form rehydrates
        "afm": creds.get("afm"),
        "eopyy_registry": creds.get("eopyy_registry"),
        "pharmacy_code": creds.get("pharmacy_code"),
        "pharmacy_id": creds.get("pharmacy_id"),
        "pharmacy_name": creds.get("pharmacy_name"),
        "environment": creds.get("environment", "test"),
        "base_url": creds.get("base_url"),
        "has_api_key": bool(creds.get("api_key")),
        "doctor_ip": creds.get("doctor_ip"),
        "client_id": creds.get("client_id"),
        "has_client_secret": bool(creds.get("client_secret")),
        "sync_enabled": creds.get("sync_enabled", True),
        "sync_interval_minutes": creds.get("sync_interval_minutes", 15),
        "history_from": creds.get("history_from"),
        "updated_at": datetime.now(tz=timezone.utc).isoformat(),
    }


async def _effective_hdika_creds(tenant_id: str) -> dict:
    """Build the HdikaClient credentials for a pharmacy.

    Each pharmacy is an AUTONOMOUS ΗΔΥΚΑ identity: in PRODUCTION it uses its OWN
    username / password / api_key / pharmacy_id (stored per-tenant), calling ΗΔΥΚΑ
    directly. The platform only supplies the production endpoint (base_url).

    TEST is different: ΗΔΥΚΑ gives CloudOn ONE shared sandbox pharmacy account
    (foreignoffice_tst + a test key + a test pharmacy_id). In test mode every tenant
    is routed through that sandbox account so we can develop without real pharmacies.
    """
    creds = dict(vault.get_secret(f"tenants/{tenant_id}/hdika") or {})   # pharmacy's OWN creds
    plat = await shared_db()["platform_settings"].find_one({"_id": "idika"})
    if plat:
        env = plat.get("active_environment", "test")
        envcfg = plat.get(env) or {}
        if envcfg.get("base_url"):
            creds["base_url"] = envcfg["base_url"]
        if plat.get("doctor_ip"):
            creds["doctor_ip"] = plat["doctor_ip"]
        creds["environment"] = env
        if env == "test":
            # route through CloudOn's shared sandbox account (overrides tenant creds)
            if envcfg.get("integrator_username"):
                creds["username"] = envcfg["integrator_username"]
            if envcfg.get("integrator_password"):
                creds["password"] = envcfg["integrator_password"]
            if envcfg.get("api_key"):
                creds["api_key"] = envcfg["api_key"]
            if envcfg.get("pharmacy_id"):
                creds["pharmacy_id"] = envcfg["pharmacy_id"]
        else:
            # PRODUCTION: η εφαρμογή (integrator) έχει ΚΟΙΝΟ api_key & integrator creds — κληρονομούνται
            # από το platform ΟΤΑΝ το φαρμακείο δεν τα έχει δηλώσει, ώστε να δίνει ΜΟΝΟ username+password.
            for src, dst in (("api_key", "api_key"), ("integrator_username", "integrator_username"),
                             ("integrator_password", "integrator_password"),
                             ("client_id", "client_id"), ("client_secret", "client_secret")):
                if envcfg.get(src) and not creds.get(dst):
                    creds[dst] = envcfg[src]
    _assert_safe_idika_base_url(creds)   # SSRF guard before any outbound ΗΔΥΚΑ call (M2)
    return creds


def _history_floor(creds: dict) -> datetime | None:
    """Earliest date the operator allows syncing from (Άντληση ιστορικού από) — caps how
    far back we pull so a 20-year pharmacy doesn't download two decades of data."""
    s = (creds or {}).get("history_from")
    if not s:
        return None
    try:
        return datetime.strptime(str(s)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


async def _last_watermark(tenant_id: str, source: str) -> datetime:
    """Sync start = max(last ingested − 1d, configured history_from). Never before
    history_from, so the operator controls the period."""
    last = await shared_db()["prescription_executions"].find_one(
        {"tenant_id": tenant_id, "source": source}, sort=[("executed_at", -1)])
    floor = _history_floor(vault.get_secret(f"tenants/{tenant_id}/hdika") or {})
    if last and last.get("executed_at"):
        wm = last["executed_at"] - timedelta(days=1)
        return max(wm, floor) if floor else wm
    return floor or datetime(2024, 1, 1, tzinfo=timezone.utc)


# ── ΗΔΥΚΑ (Greece) — primary path ──────────────────────────
@router.put("/credentials/hdika", response_model=CredentialsStatusOut)
async def set_hdika_credentials(
    body: HdikaCredentialsIn,
    ctx: TenantContext = Depends(require("settings:write", module=_MODULE)),
):
    """Register/replace the ΗΔΥΚΑ connection. Full credentials → Vault (write-only);
    non-secret config/status → tenant for display in Settings."""
    assert_source_allowed(await _tenant_country(ctx.tenant_id), "HDIKA")
    # MERGE with stored creds: empty secrets/username keep their saved value, so
    # re-saving after editing one field never wipes the password/api_key.
    existing = vault.get_secret(f"tenants/{ctx.tenant_id}/hdika") or {}
    keep_if_empty = HDIKA_SECRET_FIELDS | {"username"}
    creds = dict(existing)
    for k, v in body.model_dump().items():
        if k in keep_if_empty and v in (None, ""):
            continue
        creds[k] = v
    _assert_safe_idika_base_url(creds)   # reject a malicious base_url at save time too (M2)
    repo = TenantRepository(tenant_id=ctx.tenant_id)
    ref = vault.set_tenant_credentials(ctx.tenant_id, "hdika", creds)
    await repo.set_credentials_ref("hdika", ref)
    await repo.set_ingestion_config("hdika", _public_config(creds))
    return CredentialsStatusOut(source="hdika", configured=True, credentials_ref=ref)


@router.get("/credentials/hdika", response_model=HdikaConfigOut)
async def get_hdika_config(
    ctx: TenantContext = Depends(require("settings:read", module=_MODULE)),
):
    """Non-secret ΗΔΥΚΑ connection status for the Settings page (never returns secrets)."""
    repo = TenantRepository(tenant_id=ctx.tenant_id)
    cfg = await repo.get_ingestion_config("hdika")
    last = await shared_db()["sync_jobs"].find_one(
        {"tenant_id": ctx.tenant_id, "source": "HDIKA"}, sort=[("started_at", -1)])
    if last:
        cfg = {**cfg, "last_sync": {"at": (last.get("finished_at") or last.get("started_at")),
                                    "status": last.get("status"), "stats": last.get("stats")}}
    return HdikaConfigOut(**cfg) if cfg else HdikaConfigOut()


@router.post("/hdika/test", response_model=ConnectionTestOut)
async def test_hdika_connection(
    ctx: TenantContext = Depends(require("ingestion:run", module=_MODULE)),
):
    """Test the ΗΔΥΚΑ connection. Live auth if a base_url is configured, else reports
    synthetic mode (awaiting official ΗΔΥΚΑ API access)."""
    assert_source_allowed(await _tenant_country(ctx.tenant_id), "HDIKA")
    repo = TenantRepository(tenant_id=ctx.tenant_id)
    creds = await _effective_hdika_creds(ctx.tenant_id)
    if not creds.get("username"):
        return ConnectionTestOut(ok=False, mode="synthetic",
                                 message="Δεν έχουν καταχωρηθεί credentials e-Συνταγογράφησης.")
    if creds.get("base_url"):
        try:
            client = HdikaClient(creds)
            client.authenticate()
            client.close()
            result = ConnectionTestOut(ok=True, mode="live", message="Επιτυχής σύνδεση με ΗΔΥΚΑ.")
        except Exception as exc:  # noqa: BLE001
            result = ConnectionTestOut(ok=False, mode="live", message=f"Αποτυχία σύνδεσης: {exc}")
    else:
        result = ConnectionTestOut(
            ok=True, mode="synthetic",
            message="Τα credentials αποθηκεύτηκαν. Αναμονή επίσημου endpoint ΗΔΥΚΑ "
                    "(αίτημα: pharm.api.support@idika.gr) — μέχρι τότε λειτουργεί σε demo δεδομένα.")
    await repo.patch_ingestion_config("hdika", {"last_test": {
        "at": datetime.now(tz=timezone.utc).isoformat(), "ok": result.ok, "message": result.message}})
    return result


@router.post("/hdika/discover")
async def discover_hdika_pharmacy(
    ctx: TenantContext = Depends(require("ingestion:run", module=_MODULE)),
):
    """Σύνδεση & άντληση στοιχείων: authenticate, then pull the pharmacy profile from
    ΗΔΥΚΑ (/user/me + /contracts) and auto-save it — so the operator never types
    pharmacy_id/ΑΦΜ/ΣΗΣ/ΑΜ ΕΟΠΥΥ/history_from by hand."""
    assert_source_allowed(await _tenant_country(ctx.tenant_id), "HDIKA")
    client_creds = await _effective_hdika_creds(ctx.tenant_id)   # + platform api-key/endpoint
    if not client_creds.get("base_url") or not client_creds.get("api_key"):
        raise HTTPException(400, "Λείπει endpoint/application key — ρύθμισέ τα στο adminpanel (Διασύνδεση ΗΔΥΚΑ).")
    try:
        client = HdikaClient(client_creds)
        client.authenticate()
        discovered = client.fetch_user_info()
        client.close()
    except Exception as exc:  # noqa: BLE001 — surface the ΗΔΥΚΑ error to the operator
        raise HTTPException(400, f"Αποτυχία άντλησης: {exc}")
    # save discovered into the TENANT's own creds (not the platform key)
    tenant_creds = vault.get_secret(f"tenants/{ctx.tenant_id}/hdika") or {}
    merged = {**tenant_creds, **discovered}
    repo = TenantRepository(tenant_id=ctx.tenant_id)
    vault.set_tenant_credentials(ctx.tenant_id, "hdika", merged)
    await repo.set_ingestion_config("hdika", _public_config(merged))
    return {"ok": True, "discovered": discovered}


@router.post("/hdika/sync", status_code=202)
async def trigger_hdika_sync(
    ctx: TenantContext = Depends(require("ingestion:run", module=_MODULE)),
):
    """Queue an ΗΔΥΚΑ incremental sync on the worker (non-blocking) so the UI can poll
    /ingestion/jobs for live progress. Idempotent via natural key + hash."""
    assert_source_allowed(await _tenant_country(ctx.tenant_id), "HDIKA")
    from app.workers.ingestion import hdika_incremental_sync
    hdika_incremental_sync.delay(ctx.tenant_id)
    return {"status": "queued"}


@router.post("/hdika/reconcile-cancellations")
async def reconcile_cancellations(
    dry_run: bool = Query(True),
    days: int = Query(10, ge=1, le=30),
    ctx: TenantContext = Depends(require("ingestion:run", module=_MODULE)),
):
    """Reconcile cancelled prescriptions against ΗΔΥΚΑ: list what ΗΔΥΚΑ currently has for the last
    `days`, diff vs what we hold, mark the missing ones `cancelled` (and restore any that reappear).
    `dry_run=true` (default) only REPORTS what would change — run it first to review."""
    from app.services.ingestion.cancellations import reconcile_tenant
    return await reconcile_tenant(ctx.tenant_id, db=shared_db(), days=days, dry_run=dry_run)


@router.post("/hdika/deep-reconcile")
async def deep_reconcile(
    days: int = Query(35, ge=1, le=120),
    dry_run: bool = Query(True),
    ctx: TenantContext = Depends(require("ingestion:run", module=_MODULE)),
):
    """Deep reconciliation: re-download the last `days` (corrects executions cancelled & re-executed
    with different medicine lines/quantities) + cancel ones ΗΔΥΚΑ no longer returns. dry_run skips
    the re-download and only previews the cancellations."""
    from app.services.ingestion.cancellations import deep_reconcile_tenant
    return await deep_reconcile_tenant(ctx.tenant_id, db=shared_db(), days=days, dry_run=dry_run)


@router.post("/influenza/sync")
async def influenza_sync(
    dry_run: bool = Query(False),
    ctx: TenantContext = Depends(require("ingestion:run", module=_MODULE)),
):
    """Sync seasonal-flu vaccinations from the ΗΔΥΚΑ Influenza Vaccination Registry into `vaccinations`."""
    from app.services.ingestion.influenza import sync_influenza
    return await sync_influenza(ctx.tenant_id, db=shared_db(), dry_run=dry_run)


@router.post("/hdika/backfill", status_code=202)
async def trigger_hdika_backfill(
    date_from: str = Query(..., description="YYYY-MM-DD"),
    date_to: str | None = Query(None, description="YYYY-MM-DD (default today)"),
    ctx: TenantContext = Depends(require("ingestion:run", module=_MODULE)),
):
    """Queue a historical ΗΔΥΚΑ download for a chosen date range; progress via /ingestion/jobs."""
    assert_source_allowed(await _tenant_country(ctx.tenant_id), "HDIKA")
    from app.workers.ingestion import hdika_backfill
    until_iso = f"{date_to}T23:59:59+00:00" if date_to else None
    hdika_backfill.delay(ctx.tenant_id, f"{date_from}T00:00:00+00:00", until_iso, 0.08)
    return {"status": "queued"}


@router.post("/hdika/continue", status_code=202)
async def continue_hdika_history(
    floor: str | None = Query(None, description="YYYY-MM-DD — μέχρι πού πίσω (default: history_from ή 2024-01-01)"),
    ctx: TenantContext = Depends(require("ingestion:run", module=_MODULE)),
):
    """Συνέχιση ιστορικής άντλησης από εκεί που σταμάτησε — κατεβάζει τα ΠΑΛΑΙΟΤΕΡΑ από όσα έχουμε,
    αυτόματα σε chunks μέχρι το floor. Resumable μετά από διακοπή (ξεκινά από το τρέχον min)."""
    assert_source_allowed(await _tenant_country(ctx.tenant_id), "HDIKA")
    from app.workers.ingestion import hdika_backfill_continue
    floor_iso = f"{floor}T00:00:00+00:00" if floor else None
    hdika_backfill_continue.delay(ctx.tenant_id, floor_iso)
    return {"status": "queued"}


@router.post("/hdika/sync/stop", status_code=202)
async def stop_hdika_sync(
    ctx: TenantContext = Depends(require("ingestion:run", module=_MODULE)),
):
    """Cooperative stop: flag every running ΗΔΥΚΑ job so the worker breaks at its next
    checkpoint (≈ every 20 records) and marks itself 'cancelled'."""
    res = await shared_db()["sync_jobs"].update_many(
        {"tenant_id": ctx.tenant_id, "status": "running"},
        {"$set": {"cancel_requested": True}})
    return {"status": "stopping", "jobs": res.modified_count}


@router.delete("/hdika/data")
async def delete_hdika_data(
    date_from: str = Query(..., description="YYYY-MM-DD"),
    date_to: str = Query(..., description="YYYY-MM-DD (inclusive)"),
    ctx: TenantContext = Depends(require("ingestion:run", module=_MODULE)),
):
    """Hard-delete executions + items + derived future-prescriptions in a date range so the
    operator can re-ingest that period cleanly. Destructive — the UI double-confirms."""
    from app.repositories.prescriptions import PrescriptionRepository
    df = datetime.fromisoformat(f"{date_from}T00:00:00+00:00")
    dt = datetime.fromisoformat(f"{date_to}T00:00:00+00:00") + timedelta(days=1)
    result = await PrescriptionRepository(tenant_id=ctx.tenant_id).delete_range(df, dt)
    return {"status": "deleted", **result}


# ── ΓΕΣΥ (Cyprus) — step 2, gated to CY tenants ────────────
@router.post("/gesy/upload", status_code=202)
async def upload_gesy(
    file: UploadFile = File(...),
    ctx: TenantContext = Depends(require("ingestion:run", module=_MODULE)),
):
    assert_source_allowed(await _tenant_country(ctx.tenant_id), "GESY")
    if not (file.filename and file.filename.lower().endswith(".xml")) and \
            file.content_type not in ("application/xml", "text/xml"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail={"error": "expected_xml_upload"})
    data = await file.read()
    if len(data) > _MAX_UPLOAD:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail={"error": "file_too_large", "max_bytes": _MAX_UPLOAD})
    try:
        records = parse_gesy_xml(data)
    except Exception as exc:  # noqa: BLE001 — malformed XML
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail={"error": "invalid_xml", "message": str(exc)})
    return await IngestionEngine(ctx.tenant_id).ingest(
        source="GESY", job_type="upload", records=records)


# ── job history ────────────────────────────────────────────
@router.get("/jobs")
async def list_jobs(
    source: str | None = None,
    page: int = 1,
    page_size: int = 50,
    ctx: TenantContext = Depends(require("ingestion:read", module=_MODULE)),
):
    repo = SyncJobRepository(tenant_id=ctx.tenant_id)
    items = await repo.list_jobs(source=source, skip=(page - 1) * page_size, limit=page_size)
    return {"page": page, "page_size": page_size, "items": items}


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    ctx: TenantContext = Depends(require("ingestion:read", module=_MODULE)),
):
    from bson import ObjectId
    repo = SyncJobRepository(tenant_id=ctx.tenant_id)
    try:
        job = await repo.get(ObjectId(job_id))
    except Exception:  # noqa: BLE001
        job = None
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "job_not_found")
    return job
