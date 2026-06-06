"""GDPR anonymization — runs at the ingestion entry point.

AMKA (or any national patient id) is turned into a non-reversible, per-tenant
pseudonym BEFORE anything is persisted. Raw PII never reaches the analytics store.
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import date


def pseudonymize(national_id: str, *, tenant_pepper: str) -> str:
    """Stable per tenant, non-reversible, non-correlatable across tenants."""
    return hmac.new(
        key=tenant_pepper.encode(),
        msg=national_id.strip().encode(),
        digestmod=hashlib.sha256,
    ).hexdigest()


_AGE_BUCKETS = [(0, 17), (18, 34), (35, 49), (50, 64), (65, 74), (75, 200)]


def age_group(birth_year: int, *, today: date) -> str:
    age = today.year - birth_year
    for lo, hi in _AGE_BUCKETS:
        if lo <= age <= hi:
            return f"{lo}-{hi}" if hi < 200 else "75+"
    return "unknown"


def region_of(address_or_postal: str) -> str:
    """Collapse a precise address to region level (placeholder mapping)."""
    # TODO: map postal code -> περιφέρεια via reference table.
    return (address_or_postal or "unknown").split(",")[-1].strip() or "unknown"
