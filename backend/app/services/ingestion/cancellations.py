"""Cancelled-prescriptions reconciliation.

ΗΔΥΚΑ exposes NO 'cancelled' list, so we diff: for the last N days we ask ΗΔΥΚΑ what it CURRENTLY
has (the prescription-execution/search list, by executionDate) and compare with what we stored.
Executions we hold that ΗΔΥΚΑ no longer returns = cancelled → mark them `status='cancelled'`; any
that reappear are restored. Never deletes (audit + reversible).

Heavily guarded so a bad ΗΔΥΚΑ morning can't mass-cancel real data:
  • a day whose search FAILS is skipped (never cancel from a failed/empty fetch);
  • we act only if enough days were fetched OK;
  • if the number of would-be cancellations is implausibly high (ΗΔΥΚΑ glitch) we ABORT and report.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

_WINDOW_DAYS = 10
_MIN_DAYS_OK = 5          # need ≥ this many days fetched OK before acting
_MAX_CANCEL_RATIO = 0.30  # abort if >30% of the window's active execs would be cancelled…
_MAX_CANCEL_ABS = 5       # …unless the absolute count is small (a handful of real cancellations)


def _key(external_id: str) -> tuple[str, int]:
    bc, _, en = str(external_id).partition(":")
    return (bc, int(float(en or 1)))


async def reconcile_tenant(tenant_id: str, *, db, days: int = _WINDOW_DAYS,
                           dry_run: bool = False) -> dict:
    """Reconcile one tenant's last `days` against ΗΔΥΚΑ. Returns a stats dict (and, unless
    dry_run, applies cancel/restore). `db` = shared (non-tenant) Motor db handle."""
    from fastapi.concurrency import run_in_threadpool

    from app.api.v1.routers.ingestion import _effective_hdika_creds
    from app.services.ingestion.hdika_client import HdikaClient

    creds = await _effective_hdika_creds(tenant_id)
    if not creds or not creds.get("base_url") or not creds.get("api_key"):
        return {"ok": False, "reason": "no_credentials"}

    today = datetime.now(tz=timezone.utc).date()
    window = [today - timedelta(days=i) for i in range(1, days + 1)]  # yesterday … `days` back

    # ΗΔΥΚΑ client is sync httpx → run the per-day search calls off the event loop
    def _collect() -> tuple[set, list]:
        client = HdikaClient(creds)
        union: set = set()
        ok_days: list = []
        try:
            for d in window:
                try:
                    union |= client.search_keys(d)
                    ok_days.append(d)
                except Exception:  # noqa: BLE001 — skip a failed day, never cancel from it
                    continue
        finally:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass
        return union, ok_days

    hdika_union, ok_days = await run_in_threadpool(_collect)
    if len(ok_days) < min(_MIN_DAYS_OK, days):
        return {"ok": False, "reason": "too_few_days_fetched", "days_ok": len(ok_days)}

    okset = set(ok_days)
    lo = datetime(min(ok_days).year, min(ok_days).month, min(ok_days).day, tzinfo=timezone.utc)
    hi = datetime(max(ok_days).year, max(ok_days).month, max(ok_days).day, tzinfo=timezone.utc) + timedelta(days=1)
    ours = [doc async for doc in db["prescription_executions"].find(
        {"tenant_id": tenant_id, "source": "HDIKA", "executed_at": {"$gte": lo, "$lt": hi}},
        {"external_id": 1, "status": 1, "executed_at": 1})]
    ours = [d for d in ours if d.get("executed_at") and d["executed_at"].date() in okset and d.get("external_id")]

    to_cancel = [d for d in ours if d.get("status") != "cancelled" and _key(d["external_id"]) not in hdika_union]
    to_restore = [d for d in ours if d.get("status") == "cancelled" and _key(d["external_id"]) in hdika_union]
    active_n = sum(1 for d in ours if d.get("status") != "cancelled")

    result = {"ok": True, "dry_run": dry_run, "days_ok": len(ok_days), "hdika_count": len(hdika_union),
              "ours": len(ours), "cancel": len(to_cancel), "restore": len(to_restore),
              "cancel_ids": [d["external_id"] for d in to_cancel][:100],
              "restore_ids": [d["external_id"] for d in to_restore][:100]}

    # glitch guard: implausibly many cancellations ⇒ ΗΔΥΚΑ hiccup, not reality → abort, surface for review
    if len(to_cancel) > max(_MAX_CANCEL_ABS, int(active_n * _MAX_CANCEL_RATIO)):
        result.update(ok=False, reason="too_many_candidates", active=active_n)
        return result

    if dry_run or (not to_cancel and not to_restore):
        return result

    now = datetime.now(tz=timezone.utc)
    if to_cancel:
        ids = [d["_id"] for d in to_cancel]
        await db["prescription_executions"].update_many(
            {"_id": {"$in": ids}, "tenant_id": tenant_id},
            [{"$set": {"cancelled_prev_status": "$status", "status": "cancelled", "cancelled_at": now}}])
        await db["prescription_items"].update_many(
            {"execution_id": {"$in": ids}, "tenant_id": tenant_id}, {"$set": {"cancelled": True}})
    if to_restore:
        ids = [d["_id"] for d in to_restore]
        await db["prescription_executions"].update_many(
            {"_id": {"$in": ids}, "tenant_id": tenant_id},
            [{"$set": {"status": {"$ifNull": ["$cancelled_prev_status", "executed"]}, "cancelled_at": None}}])
        await db["prescription_items"].update_many(
            {"execution_id": {"$in": ids}, "tenant_id": tenant_id}, {"$set": {"cancelled": False}})
    return result


async def _reingest_window(tenant_id: str, db, days: int) -> dict:
    """RE-DOWNLOAD the window [now-days, now] through the engine. Because the engine's content hash
    covers executed_at + amounts + the medicine-line summary (barcode:qty:price) and it delete+
    reinserts prescription_items, this CORRECTS executions that were cancelled & re-executed with
    different lines/quantities (e.g. 5 meds → 3) — exactly what counting barcodes alone misses.
    (ΗΔΥΚΑ only gives execution DATE, not time, so time can't be compared — lines/amounts are the signal.)"""
    from app.api.v1.routers.ingestion import _effective_hdika_creds
    from app.services.ingestion.engine import IngestionEngine
    from app.services.ingestion.hdika import HdikaAdapter
    from app.services.ingestion.hdika_catalog import load_catalog_map

    creds = await _effective_hdika_creds(tenant_id)
    if not creds or not creds.get("base_url") or not creds.get("api_key"):
        return {"ok": False, "reason": "no_credentials"}
    creds = dict(creds)
    creds["throttle"] = creds.get("throttle") or 0.08
    cat = await load_catalog_map(db)
    until = datetime.now(tz=timezone.utc)
    since = until - timedelta(days=days)
    records = HdikaAdapter(creds, catalog=cat).fetch(since=since, until=until)
    job = await IngestionEngine(tenant_id, db=db).ingest(
        source="HDIKA", job_type="backfill", records=records, window=(since, until))
    return {"status": job.get("status"), "stats": job.get("stats")}


async def deep_reconcile_tenant(tenant_id: str, *, db, days: int, dry_run: bool = False) -> dict:
    """Robust reconciliation: (1) re-download the window so executions whose lines/quantities/amounts
    changed (cancelled-then-re-executed-differently) are corrected, then (2) cancel ours that ΗΔΥΚΑ no
    longer returns. Daily over a short window (same-day fixes) + weekly over 35 days (late returns)."""
    reingest = {"skipped": "dry_run"} if dry_run else await _reingest_window(tenant_id, db, days)
    recon = await reconcile_tenant(tenant_id, db=db, days=days, dry_run=dry_run)
    return {"ok": recon.get("ok"), "days": days, "dry_run": dry_run,
            "reingest": reingest, "reconcile": recon}
