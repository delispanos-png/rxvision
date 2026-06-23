"""On-demand single-prescription lookup against ΗΔΥΚΑ using a tenant's own stored connection.

Powers the patient-portal «Ανάθεση συνταγής» live check: the patient types a barcode, we verify it
exists in ΗΔΥΚΑ via the PHARMACY's credentials and pull the real prescription (medicines, doctor,
dates, άυλη, πλήθος εκτελέσεων) so the pharmacist gets a verified, ready-to-prepare assignment —
not just a number. Best-effort and never raises: a portal submit must succeed even if ΗΔΥΚΑ is down.
"""
from __future__ import annotations

import asyncio

from app.core.db import shared_db
from app.services.ingestion.hdika_client import HdikaClient
from app.services.vault_service import vault


async def _creds_for(tenant_id) -> dict | None:
    """Same credential assembly the ingestion worker uses (vault secret + platform ΗΔΥΚΑ env)."""
    creds = dict(vault.get_secret(f"tenants/{tenant_id}/hdika") or {})
    if not creds:
        return None
    plat = await shared_db()["platform_settings"].find_one({"_id": "idika"})
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
    creds.setdefault("throttle", 0.0)
    return creds


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def _lookup_sync(creds: dict, barcode: str) -> dict:
    client = HdikaClient(creds)
    try:
        cda = client.fetch_cda_full(barcode)
    finally:
        try:
            client._client.close()
        except Exception:  # noqa: BLE001
            pass
    if not cda:
        return {"found": False}
    details = cda.get("details") or {}
    meds = [m.get("name") for m in (cda.get("medicines") or []) if m.get("name")]
    if not meds:
        meds = [ln.get("name") for ln in (cda.get("lines") or []) if ln.get("name")]
    doctor = (cda.get("doctor") or {}).get("name")
    found = bool(meds or doctor or details.get("issue_date"))
    return {
        "found": found,
        "doctor": doctor,
        "medicines": meds[:20],
        "issue_date": _iso(details.get("issue_date")),
        "deadline_date": _iso(details.get("deadline_date")),
        "intangible": bool(details.get("intangible")),
        "exec_count": details.get("exec_count"),
        "is_fyk": bool(details.get("n3816")),
        "has_vaccine": bool(details.get("vaccines")),
    }


async def lookup_prescription(tenant_id, barcode: str) -> dict:
    """Returns {available: False} when the tenant has no ΗΔΥΚΑ connection, else
    {available: True, found, doctor, medicines, issue_date, deadline_date, intangible, ...}."""
    bc = (barcode or "").strip().split(":")[0]
    if not bc:
        return {"available": False}
    try:
        creds = await _creds_for(tenant_id)
        if not creds or not creds.get("base_url"):
            return {"available": False}
        res = await asyncio.to_thread(_lookup_sync, creds, bc)
        return {"available": True, **res}
    except Exception:  # noqa: BLE001 — never block the portal submit
        return {"available": True, "found": False, "error": True}
