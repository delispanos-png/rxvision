"""Country ↔ ingestion source rule.

A pharmacy (tenant) is bound to one e-prescription system by its country:
  - Greece (GR)  → ΗΔΙΚΑ   (ΓΕΣΥ is not applicable)
  - Cyprus (CY)  → ΓΕΣΥ    (ΗΔΙΚΑ is not applicable)

This guard is enforced at the API boundary so a GR tenant can never ingest ΓΕΣΥ
data and vice-versa.
"""

from __future__ import annotations

from fastapi import HTTPException, status

# country -> the single allowed source
COUNTRY_SOURCE: dict[str, str] = {"GR": "HDIKA", "CY": "GESY"}
SOURCE_COUNTRY: dict[str, str] = {v: k for k, v in COUNTRY_SOURCE.items()}


def source_for_country(country: str) -> str | None:
    return COUNTRY_SOURCE.get((country or "").upper())


def assert_source_allowed(country: str, source: str) -> None:
    """Raise 409 if `source` is not the one allowed for the tenant's country."""
    allowed = source_for_country(country)
    if allowed != source:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "error": "source_not_allowed_for_country",
                "country": country,
                "requested_source": source,
                "allowed_source": allowed,
                "message": (
                    f"Φαρμακείο χώρας {country}: επιτρέπεται μόνο {allowed}, όχι {source}."
                ),
            },
        )
