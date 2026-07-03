"""On-demand ΗΔΥΚΑ CDA lookup — the prescription-level γνωμάτευση (opinion) flag (CDA id 1.1.23)
is NOT in the execution-search response, only in the eDispensation CDA. We fetch it lazily when a
prescription is inspected and CACHE it on the execution (`has_opinion`), so each prescription costs
at most ONE CDA call ever — gentle on ΗΔΥΚΑ, human-paced.
"""

from __future__ import annotations

import asyncio

from app.services.ingestion.hdika_client import HdikaClient
from app.services.vault_service import vault


async def _creds(tenant_id: str, db) -> dict:
    # FULL effective creds (production ΚΛΗΡΟΝΟΜΕΙ platform api_key/integrator· test→sandbox). Το παλιό
    # inline building έλειπε το production api_key → νέα φαρμακεία (μόνο user/pass) → χωρίς key.
    from app.api.v1.routers.ingestion import _effective_hdika_creds
    return dict(await _effective_hdika_creds(tenant_id))


async def fetch_cda_info(tenant_id: str, db, barcode: str) -> dict:
    """From the ΗΔΥΚΑ CDA: {opinion: bool|None (prescription-level γνωμάτευση, id 1.1.23),
    qr_by_eof: {eofCode: bool}} — per-medicine QR-coupon flag (CDA id 2.10.14: 1=QR/HMVS,
    0=ΕΟΦ ταινία γνησιότητας). {} if creds incomplete or unreachable."""
    creds = await _creds(tenant_id, db)
    if not ((creds.get("base_url") or creds.get("live_endpoint"))
            and creds.get("api_key") and creds.get("username")):
        return {}

    def _do():
        cl = HdikaClient(creds)
        try:
            return cl.fetch_cda_full(barcode)
        except Exception:  # noqa: BLE001
            return {}
        finally:
            cl.close()

    cda = await asyncio.to_thread(_do)
    if not cda:
        return {}
    # The CDA lines ARE the coupons — each carries executed + QR + lot together (no eof-collision,
    # no executed/qr contradiction). An unexecuted line has no coupon (no QR, no strip).
    lines = [{"eof": str(ln.get("eof_code") or ""), "name": ln.get("name"),
              "executed": bool(ln.get("is_executed", True)),
              "qr": ln.get("qr"), "batch": ln.get("qr_batch"), "expiry": ln.get("qr_expiry"),
              "lot": ln.get("lot") or ln.get("strip")}
             for ln in cda.get("lines", []) if ln.get("eof_code")]
    return {"opinion": cda.get("details", {}).get("opinion"), "lines": lines}
