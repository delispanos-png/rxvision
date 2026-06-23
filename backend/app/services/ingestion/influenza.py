"""Seasonal-flu vaccination ingestion (ΗΔΥΚΑ Influenza Vaccination Registry).

Fetches vaccination executions via InfluenzaClient and upserts them into the `vaccinations`
collection (tenant-scoped). AMKA is pseudonymised with the SAME tenant pepper as prescriptions, so a
patient's flu vaccination links to their prescription history (shared `patient_ref`). Raw name/AMKA
is never stored. Cancellation status is read DIRECTLY from ΗΔΥΚΑ here (status/cancelDate).
"""

from __future__ import annotations

from datetime import date, datetime, timezone


def _dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s)[:19]).replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _cents(v):
    if v in (None, ""):
        return None
    try:
        return int(round(float(v) * 100))
    except (ValueError, TypeError):
        return None


def _map(rec: dict, tenant_id: str, pepper: str, now: datetime) -> dict:
    from app.utils.anonymization import age_group, pseudonymize, region_of
    pat = rec.get("patient") or {}
    amka = str(pat.get("amka") or "").strip()
    birth = _dt(pat.get("birthDate"))
    med = rec.get("medicine") or {}
    st = rec.get("status") or {}
    hrg = rec.get("highRiskGroups") or {}
    cancel_date = _dt(rec.get("cancelDate"))
    cancelled = bool(cancel_date) or (
        st.get("id") != 6 and "ΕΚΤΕΛΕΣ" not in str(st.get("name") or "").upper())
    icd = rec.get("icd10") if isinstance(rec.get("icd10"), dict) else {}
    return {
        "tenant_id": tenant_id, "source": "INFLUENZA", "external_id": str(rec.get("id")),
        "barcode": rec.get("barcode"),                # the vaccination/prescription barcode (e.g. 9260…)
        "executed_at": _dt(rec.get("executionDate")),  # NB: vaccinations DO carry a time (hh:mm:ss)
        "issue_date": _dt(rec.get("issueDate")),
        "status_name": st.get("name"), "status_id": st.get("id"),
        "cancelled": cancelled, "cancel_date": cancel_date,
        "icd10_code": icd.get("code"), "icd10_title": icd.get("title"),
        "product_code": rec.get("productCode"), "serial_number": rec.get("serialNumber"),
        "vaccine_id": med.get("id"), "vaccine_barcode": med.get("barcode"),
        "vaccine_name": med.get("commercialNameOnly"), "lot": rec.get("medicineLot"),
        "high_risk_group": hrg.get("description"), "high_risk_group_id": hrg.get("id"),
        "patient_ref": pseudonymize(amka, tenant_pepper=pepper) if amka else None,
        # the pharmacy is the data controller of its own patients (same as prescriptions) → store
        # the real name/AMKA so the authorised pharmacist sees who they are. Tenant-isolated.
        "patient_name": (f"{pat.get('lastName', '')} {pat.get('firstName', '')}".strip() or None),
        "amka": amka or None,
        "patient_age_group": age_group(birth.year, today=date.today()) if birth else None,
        "patient_birth_year": birth.year if birth else None,
        "patient_sex": (pat.get("sex") or {}).get("name"),
        "region": region_of(str(pat.get("postalCode") or pat.get("city") or "")),
        "pharmacy_id": rec.get("pharmacyId"),
        "payable": _cents(rec.get("payableAmt")), "total_price": _cents(rec.get("totalPrice")),
        "insurance_part": _cents(rec.get("insurancePartAmt")),
        "patient_part": _cents(rec.get("patientPartAmt")),
        "icd10": rec.get("icd10"), "quantity": rec.get("quantity"),
        "updated_at": now,
    }


async def sync_influenza(tenant_id: str, *, db, dry_run: bool = False) -> dict:
    """Fetch all flu vaccinations for the tenant and upsert into `vaccinations`."""
    from fastapi.concurrency import run_in_threadpool

    from app.api.v1.routers.ingestion import _effective_hdika_creds
    from app.services.ingestion.influenza_client import InfluenzaClient
    from app.services.vault_service import vault

    creds = await _effective_hdika_creds(tenant_id)
    if not creds or not creds.get("base_url") or not creds.get("api_key"):
        return {"ok": False, "reason": "no_credentials"}

    def _fetch() -> list:
        cl = InfluenzaClient(creds)
        try:
            return list(cl.iter_vaccinations())
        finally:
            cl.close()

    rows = await run_in_threadpool(_fetch)
    pepper = vault.tenant_pepper(tenant_id)
    now = datetime.now(tz=timezone.utc)
    mapped = [_map(r, tenant_id, pepper, now) for r in rows if r.get("id") is not None]
    cancelled = sum(1 for m in mapped if m["cancelled"])

    if dry_run:
        return {"ok": True, "dry_run": True, "fetched": len(rows), "mapped": len(mapped),
                "cancelled": cancelled, "sample": mapped[:2]}

    inserted = updated = 0
    for m in mapped:
        res = await db["vaccinations"].update_one(
            {"tenant_id": tenant_id, "source": "INFLUENZA", "external_id": m["external_id"]},
            {"$set": m, "$setOnInsert": {"ingested_at": now}}, upsert=True)
        if res.upserted_id:
            inserted += 1
        elif res.modified_count:
            updated += 1
    return {"ok": True, "fetched": len(rows), "inserted": inserted, "updated": updated,
            "cancelled": cancelled}
