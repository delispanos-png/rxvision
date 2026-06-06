"""Business-level validation of canonical executions (INGESTION.md §5).

Schema-level validation already happened in the adapter (types/required). Here we
enforce cross-field rules. Invalid records are reported, not fatal to the batch.
"""

from __future__ import annotations

from app.services.ingestion.canonical import CanonicalExecution


def validate_execution(ex: CanonicalExecution) -> list[str]:
    """Return a list of error strings; empty list == valid."""
    errors: list[str] = []
    if not ex.external_id:
        errors.append("missing external_id")
    if not ex.items:
        errors.append("no items")
    if ex.repeat_current < 1 or ex.repeat_current > max(ex.repeat_total, 1):
        errors.append(f"repeat_current {ex.repeat_current} out of range 1..{ex.repeat_total}")
    if not ex.patient.national_id:
        errors.append("missing patient national_id")
    for it in ex.items:
        if it.quantity <= 0:
            errors.append(f"item {it.barcode}: quantity <= 0")
        if it.retail_price < 0 or it.wholesale_price < 0:
            errors.append(f"item {it.barcode}: negative price")
    return errors
