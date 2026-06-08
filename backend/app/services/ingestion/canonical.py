"""Source-agnostic canonical model.

Every adapter (ΓΕΣΥ XML, ΗΔΙΚΑ API, …) converts its raw payload into these shapes,
so the persist engine is identical regardless of source. Money is integer cents.
Patient `national_id` is RAW here and is pseudonymised by the engine before any write —
it is the only place raw PII exists, and only in memory.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class CanonicalPatient:
    national_id: str                 # AMKA / ΓΕΣΥ id
    sex: str = "U"                   # M | F | U
    birth_year: int | None = None
    area: str = "unknown"
    full_name: str | None = None     # pharmacy is the data controller → may store/show it


@dataclass
class CanonicalDoctor:
    full_name: str
    specialty: str | None = None


@dataclass
class CanonicalFund:
    code: str
    name: str | None = None


@dataclass
class CanonicalItem:
    barcode: str
    name: str
    substance: str | None = None
    quantity: int = 1
    retail_price: int = 0            # cents
    wholesale_price: int = 0         # cents
    category: str = "normal"         # normal | FYK | vaccine | narcotic | special
    is_executed: bool = True


@dataclass
class CanonicalExecution:
    source: str                      # HDIKA | GESY
    external_id: str                 # natural key within source
    executed_at: datetime
    patient: CanonicalPatient
    doctor: CanonicalDoctor
    fund: CanonicalFund
    items: list[CanonicalItem] = field(default_factory=list)
    icd10: list[str] = field(default_factory=list)
    repeat_current: int = 1
    repeat_total: int = 1
    patient_share: int = 0           # cents (0 => engine derives default 0)
    amount_total: int = 0            # cents — authoritative retail from source (0 => sum items)
    valid_until: datetime | None = None  # treatment end (CDA effectiveTime high) → recurrence
