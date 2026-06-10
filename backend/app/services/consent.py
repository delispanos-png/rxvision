"""Consent-ledger helpers shared by the communications send path and the GDPR module.
Thin wrapper over PatientConsentRepository so callers never touch the collection directly."""

from __future__ import annotations

from app.repositories.consents import PatientConsentRepository


async def withdrawn_patient_ids(tenant_id: str, channel: str) -> set:
    """Patient _ids to EXCLUDE from a `channel` campaign because their latest ledger
    event is a withdrawal (authoritative over a stale contact flag)."""
    return await PatientConsentRepository(tenant_id=tenant_id).withdrawn_patient_ids(channel)
