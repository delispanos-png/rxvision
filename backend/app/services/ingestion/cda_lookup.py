"""On-demand ΗΔΙΚΑ CDA lookup — the prescription-level γνωμάτευση (opinion) flag (CDA id 1.1.23)
is NOT in the execution-search response, only in the eDispensation CDA. We fetch it lazily when a
prescription is inspected and CACHE it on the execution (`has_opinion`), so each prescription costs
at most ONE CDA call ever — gentle on ΗΔΙΚΑ, human-paced.
"""

from __future__ import annotations

import asyncio

from app.services.ingestion.hdika_client import HdikaClient
from app.services.vault_service import vault


async def _creds(tenant_id: str, db) -> dict:
    creds = dict(vault.get_secret(f"tenants/{tenant_id}/hdika") or {})
    plat = await db["platform_settings"].find_one({"_id": "idika"})  # tenant-ok: platform ΗΔΙΚΑ env
    if plat:
        env = plat.get("active_environment", "test")
        envcfg = plat.get(env) or {}
        if envcfg.get("base_url"):
            creds["base_url"] = envcfg["base_url"]
        creds["environment"] = env
        if env == "test":
            for src, dst in (("integrator_username", "username"), ("integrator_password", "password"),
                             ("api_key", "api_key"), ("pharmacy_id", "pharmacy_id")):
                if envcfg.get(src):
                    creds[dst] = envcfg[src]
    return creds


async def fetch_opinion(tenant_id: str, db, barcode: str) -> bool | None:
    """Prescription-level γνωμάτευση flag from the ΗΔΙΚΑ CDA. None if creds incomplete or unreachable."""
    creds = await _creds(tenant_id, db)
    if not ((creds.get("base_url") or creds.get("live_endpoint"))
            and creds.get("api_key") and creds.get("username")):
        return None

    def _do():
        cl = HdikaClient(creds)
        try:
            return cl.fetch_cda_full(barcode)
        except Exception:  # noqa: BLE001
            return {}
        finally:
            cl.close()

    cda = await asyncio.to_thread(_do)
    return (cda or {}).get("details", {}).get("opinion")
