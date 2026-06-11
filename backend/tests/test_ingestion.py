"""Ingestion unit tests — parsing, adapter, country rule (no DB needed)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.ingestion.gesy import parse_gesy_xml
from app.services.ingestion.hdika import HdikaAdapter
from app.services.ingestion.sources import assert_source_allowed, source_for_country
from app.services.ingestion.validate import validate_execution

FIXTURE = Path(__file__).parent / "fixtures" / "gesy_sample.xml"


# ── ΓΕΣΥ parsing ───────────────────────────────────────────
def test_parse_gesy_xml():
    execs = parse_gesy_xml(FIXTURE.read_bytes())
    assert len(execs) == 2
    e = execs[0]
    assert e.source == "GESY"
    assert e.external_id == "CY-RX-0001"
    assert e.patient.national_id == "0011223344"
    assert e.patient.sex == "F"
    assert e.icd10 == ["E11.9", "I10"]
    assert e.repeat_total == 3
    assert len(e.items) == 2
    assert e.items[0].quantity == 2 and e.items[0].retail_price == 420
    assert validate_execution(e) == []


# ── ΗΔΙΚΑ adapter (synthetic) ──────────────────────────────
def test_hdika_adapter_yields_stable_ids():
    # synthetic data is gated behind allow_synthetic (never injected into a real tenant)
    a = list(HdikaAdapter({"allow_synthetic": True}).fetch(count=10))
    b = list(HdikaAdapter({"allow_synthetic": True}).fetch(count=10))
    assert len(a) == 10
    assert [x.external_id for x in a] == [x.external_id for x in b]  # stable → dedup works
    assert all(x.source == "HDIKA" for x in a)
    assert validate_execution(a[0]) == []


# ── country ↔ source rule ──────────────────────────────────
def test_source_for_country():
    assert source_for_country("GR") == "HDIKA"
    assert source_for_country("CY") == "GESY"


def test_public_config_never_leaks_secrets():
    from app.api.v1.routers.ingestion import _public_config
    cfg = _public_config({
        "username": "pharma1", "password": "topsecret", "client_secret": "abc123",
        "api_key": "appkeysecret", "afm": "099999999",
        "base_url": "https://hdika/api", "client_id": "cid",
    })
    flat = str(cfg)
    # secrets (password/client_secret/api_key) must NEVER appear — only presence flags
    assert "topsecret" not in flat and "abc123" not in flat and "appkeysecret" not in flat
    assert cfg["has_client_secret"] is True and cfg["has_api_key"] is True
    assert cfg["username"] == "pharma1"                        # non-secret → returned for rehydration
    assert cfg["afm"] == "099999999"                           # non-secret kept


def test_assert_source_allowed_rejects_mismatch():
    assert_source_allowed("GR", "HDIKA")          # ok, no raise
    assert_source_allowed("CY", "GESY")           # ok
    with pytest.raises(Exception):
        assert_source_allowed("GR", "GESY")       # GR cannot use ΓΕΣΥ
    with pytest.raises(Exception):
        assert_source_allowed("CY", "HDIKA")      # CY cannot use ΗΔΙΚΑ
