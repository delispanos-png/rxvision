"""ΗΔΙΚΑ (Greece) adapter → canonical executions.

The real adapter authenticates with the pharmacy's ΗΔΙΚΑ credentials and pages the
e-prescription API. Until we have API access, `fetch()` yields SYNTHETIC demo records
so the full automated path (sync_jobs, dedup, post-process, analytics) is exercisable
end-to-end. External ids are stable across runs so re-running demonstrates dedup.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.services.ingestion.canonical import (
    CanonicalDoctor,
    CanonicalExecution,
    CanonicalFund,
    CanonicalItem,
    CanonicalPatient,
)

_DOCTORS = [("Δρ. Κ. Παπαδόπουλος", "Παθολόγος"), ("Δρ. Μ. Ιωάννου", "Καρδιολόγος"),
            ("Δρ. Σ. Νικολάου", "Ενδοκρινολόγος")]
_PRODUCTS = [("5290000000010", "Glucophage 850mg", "Metformin", 420, 310, "normal"),
             ("5290000000027", "Concor 5mg", "Bisoprolol", 510, 360, "normal"),
             ("5290000000034", "Atoris 20mg", "Atorvastatin", 760, 540, "normal"),
             ("5290000000041", "Ventolin", "Salbutamol", 340, 250, "normal")]
_ICD = ["E11.9", "I10", "E78.5", "J45.9"]
_ANCHOR = datetime(2026, 5, 1, 8, 0, tzinfo=timezone.utc)  # fixed → reproducible demo


class HdikaAdapter:
    """Pluggable adapter. Real impl: HTTP client against creds.endpoint."""

    def __init__(self, credentials: dict | None = None) -> None:
        self.credentials = credentials or {}

    def fetch(self, *, since: datetime | None = None, count: int = 20):
        """Yield canonical executions newer than `since`.

        Real ΗΔΙΚΑ access flips on when credentials carry a `live_endpoint`; until
        then we yield deterministic synthetic data so the whole pipeline runs.
        """
        c = self.credentials
        # Go live only with a COMPLETE real config: endpoint + application api-key
        # (platform-level) + the pharmacy's username. Otherwise synthetic demo data.
        if (c.get("base_url") or c.get("live_endpoint")) and c.get("api_key") and c.get("username"):
            yield from self._fetch_real(since)
            return
        yield from self._fetch_synthetic(since=since, count=count)

    def _fetch_real(self, since: datetime | None):
        """REAL ΗΔΙΚΑ path: authenticate, page executions since the watermark, map
        each raw record → canonical. Active when credentials carry `live_endpoint`.
        Transient failures raise Connection/TimeoutError so the task auto-retries.
        Field/endpoint mapping lives in hdika_client.py (ASSUMED contract until the
        official ΗΔΙΚΑ spec lands)."""
        from app.services.ingestion.hdika_client import HdikaClient

        client = HdikaClient(self.credentials)
        try:
            yield from client.iter_executions(since)
        finally:
            client.close()

    def _fetch_synthetic(self, *, since: datetime | None = None, count: int = 20):
        """Deterministic demo data. The anchor is FIXED so re-running yields
        byte-identical records → the engine dedups them (idempotency).
        """
        base = _ANCHOR
        for i in range(count):
            doc_name, spec = _DOCTORS[i % len(_DOCTORS)]
            prod = _PRODUCTS[i % len(_PRODUCTS)]
            executed_at = base + timedelta(hours=i * 7)
            repeat_total = 3 if i % 3 == 0 else 1
            yield CanonicalExecution(
                source="HDIKA",
                external_id=f"HDIKA-SYNTH-{i:05d}",          # stable → dedup on re-run
                executed_at=executed_at,
                patient=CanonicalPatient(
                    national_id=f"AMKA{i % 7:09d}",          # 7 distinct demo patients
                    sex="F" if i % 2 else "M",
                    birth_year=1950 + (i % 40),
                    area="Αττική" if i % 2 else "Θεσσαλονίκη",
                ),
                doctor=CanonicalDoctor(full_name=doc_name, specialty=spec),
                fund=CanonicalFund(code="EOPYY", name="ΕΟΠΥΥ"),
                items=[CanonicalItem(barcode=prod[0], name=prod[1], substance=prod[2],
                                     quantity=1, retail_price=prod[3],
                                     wholesale_price=prod[4], category=prod[5])],
                icd10=[_ICD[i % len(_ICD)]],
                repeat_current=1,
                repeat_total=repeat_total,
                patient_share=0,
            )
