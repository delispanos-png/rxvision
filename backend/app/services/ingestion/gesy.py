"""ΓΕΣΥ (Cyprus) XML adapter → canonical executions.

The real ΓΕΣΥ XSD is not yet available; this parses a documented interim schema
(see tests/fixtures/gesy_sample.xml). Swap the field mapping when the official
schema lands — the rest of the pipeline is unaffected.

Expected shape:
  <gesy_executions>
    <execution external_id="CY-RX-0001" executed_at="2026-06-01T10:30:00Z">
      <fund code="GESY" name="ΓΕΣΥ"/>
      <patient national_id="0011223344" sex="F" birth_year="1959" area="Λευκωσία"/>
      <doctor name="Dr A. Georgiou" specialty="Παθολόγος"/>
      <diagnoses><icd10>E11.9</icd10></diagnoses>
      <repeat current="1" total="3"/>
      <items>
        <item barcode="5290000000001" name="Glucophage 850mg" substance="Metformin"
              quantity="1" retail_price="420" wholesale_price="310"
              category="normal" executed="true"/>
      </items>
    </execution>
  </gesy_executions>
"""

from __future__ import annotations

from datetime import datetime

from lxml import etree

from app.services.ingestion.canonical import (
    CanonicalDoctor,
    CanonicalExecution,
    CanonicalFund,
    CanonicalItem,
    CanonicalPatient,
)


def _dt(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _int(value: str | None, default: int = 0) -> int:
    try:
        return int(value) if value is not None else default
    except (TypeError, ValueError):
        return default


# Hardened parser: the upload is user-controlled, so disable DTD/entity/network
# resolution to prevent XXE, SSRF and billion-laughs expansion (M1).
_SAFE_PARSER = etree.XMLParser(
    resolve_entities=False,
    no_network=True,
    load_dtd=False,
    dtd_validation=False,
    huge_tree=False,
)


def parse_gesy_xml(data: bytes) -> list[CanonicalExecution]:
    """Parse ΓΕΣΥ XML bytes into canonical executions. Raises on malformed XML."""
    root = etree.fromstring(data, parser=_SAFE_PARSER)
    out: list[CanonicalExecution] = []
    for ex_el in root.findall("execution"):
        fund_el = ex_el.find("fund")
        pat_el = ex_el.find("patient")
        doc_el = ex_el.find("doctor")
        rep_el = ex_el.find("repeat")
        icd10 = [e.text.strip() for e in ex_el.findall("diagnoses/icd10") if e.text]
        items = [
            CanonicalItem(
                barcode=(it.get("barcode") or "").strip(),
                name=(it.get("name") or "").strip(),
                substance=it.get("substance"),
                quantity=_int(it.get("quantity"), 1),
                retail_price=_int(it.get("retail_price")),
                wholesale_price=_int(it.get("wholesale_price")),
                category=(it.get("category") or "normal"),
                is_executed=(it.get("executed", "true").lower() != "false"),
            )
            for it in ex_el.findall("items/item")
        ]
        out.append(CanonicalExecution(
            source="GESY",
            external_id=(ex_el.get("external_id") or "").strip(),
            executed_at=_dt(ex_el.get("executed_at")),
            patient=CanonicalPatient(
                national_id=(pat_el.get("national_id") if pat_el is not None else "") or "",
                sex=(pat_el.get("sex", "U") if pat_el is not None else "U"),
                birth_year=_int(pat_el.get("birth_year")) or None if pat_el is not None else None,
                area=(pat_el.get("area", "unknown") if pat_el is not None else "unknown"),
            ),
            doctor=CanonicalDoctor(
                full_name=(doc_el.get("name") if doc_el is not None else "Άγνωστος") or "Άγνωστος",
                specialty=doc_el.get("specialty") if doc_el is not None else None,
            ),
            fund=CanonicalFund(
                code=(fund_el.get("code", "GESY") if fund_el is not None else "GESY"),
                name=(fund_el.get("name") if fund_el is not None else "ΓΕΣΥ"),
            ),
            items=items,
            icd10=icd10,
            repeat_current=_int(rep_el.get("current"), 1) if rep_el is not None else 1,
            repeat_total=_int(rep_el.get("total"), 1) if rep_el is not None else 1,
            patient_share=_int(ex_el.get("patient_share")),
        ))
    return out
