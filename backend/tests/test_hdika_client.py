"""Real ΗΔΙΚΑ HTTP client (API ΦΑΡΜΑΚΟΠΟΙΩΝ v2) — auth headers, XML paging, mapping.

No live API needed: a MockTransport serves a sample XML page shaped like
prescription-execution/search, and we assert the canonical mapping.
"""

from __future__ import annotations

import httpx

from app.services.ingestion.hdika_client import HdikaClient, _map_treatment

_XML_PAGE = """<?xml version="1.0" encoding="UTF-8"?>
<PageResponse>
  <content>
    <barcode>RX-1</barcode>
    <executionDate>2026-06-01T10:00:00Z</executionDate>
    <participationValue>1.00</participationValue>
    <executions>1</executions>
    <prescriptionRepeatId>3</prescriptionRepeatId>
    <socialInsuranceDTO><id>1</id><name>ΕΟΠΥΥ</name><shortName>EOPYY</shortName></socialInsuranceDTO>
    <patient><amka>AMKA123</amka><sex><shortName>F</shortName></sex><birthDate>1960-05-01</birthDate><city>Αττική</city></patient>
    <doctor><firstName>Κ.</firstName><lastName>Παπαδόπουλος</lastName><specialtyName>Παθολόγος</specialtyName></doctor>
    <diagnoses><icd10Code>E11.9</icd10Code></diagnoses>
    <treatments>
      <medicineBarcode>529001</medicineBarcode>
      <medicineCommercialName>Glucophage</medicineCommercialName>
      <quantityPrescribed>2</quantityPrescribed>
      <quantityOutstanding>0</quantityOutstanding>
      <totalPrice>4.20</totalPrice>
      <medicine><medicineDrug>false</medicineDrug></medicine>
    </treatments>
  </content>
  <last>true</last>
</PageResponse>"""


def test_client_sets_basic_apikey_and_accept_headers():
    c = HdikaClient({"base_url": "https://testeps.e-prescription.gr/pharmapiv2",
                     "username": "u", "password": "p",
                     "api_key": "APPKEY123", "doctor_ip": "1.2.3.4"})
    assert c._client.headers.get("Api-Key") == "APPKEY123"
    assert c._client.headers.get("Accept") == "application/xml"
    assert c._client.headers.get("X-DOCTOR-IP") == "1.2.3.4"
    assert c._client.auth is not None  # Basic auth configured
    c.close()


def test_iter_executions_parses_xml_to_canonical():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, content=_XML_PAGE.encode(),
                              headers={"Content-Type": "application/xml"})

    c = HdikaClient({"base_url": "https://hdika.example/pharmapiv2",
                     "username": "u", "password": "p", "api_key": "k", "pharmacy_id": 7})
    c._client = httpx.Client(transport=httpx.MockTransport(handler))

    rows = list(c.iter_executions(since=None))
    assert captured["path"] == "/pharmapiv2/api/v1/prescription-execution/search"
    assert captured["params"]["pharmacyId"] == "7"
    assert len(rows) == 1
    e = rows[0]
    assert e.source == "HDIKA"
    assert e.external_id == "RX-1"
    assert e.executed_at.year == 2026 and e.executed_at.month == 6
    assert e.patient.national_id == "AMKA123"   # raw reaches engine → anonymised there
    assert e.patient.sex == "F"
    assert e.patient.birth_year == 1960
    assert e.doctor.full_name == "Κ. Παπαδόπουλος"
    assert e.doctor.specialty == "Παθολόγος"
    assert e.fund.code == "EOPYY" and e.fund.name == "ΕΟΠΥΥ"
    assert e.icd10 == ["E11.9"]
    assert e.repeat_total == 3
    assert e.patient_share == 100               # 1.00 € → cents
    assert len(e.items) == 1
    it = e.items[0]
    assert it.barcode == "529001" and it.name == "Glucophage"
    assert it.quantity == 2 and it.retail_price == 420
    assert it.is_executed is True               # quantityOutstanding 0 < 2
    c.close()


_USER_XML = """<?xml version="1.0"?>
<PharmUser><id>123</id>
  <pharmacy>
    <id>2818</id><name>ΦΑΡΜΑΚΕΙΟ ΔΕΛΗ</name>
    <taxRegistryNo>045900962</taxRegistryNo>
    <pharmacyIdentification>SHS-2818</pharmacyIdentification>
    <healthProviderId>7654</healthProviderId>
    <address>Κεντρική 1</address>
    <city><id>1</id><name>Αθήνα</name></city>
  </pharmacy>
</PharmUser>"""
_CONTRACTS_XML = """<?xml version="1.0"?>
<ListResponse>
  <contents><effectiveFrom>2023-05-01</effectiveFrom></contents>
  <contents><effectiveFrom>2022-01-15</effectiveFrom></contents>
</ListResponse>"""


def test_fetch_user_info_auto_discovers_pharmacy_fields():
    def handler(request: httpx.Request) -> httpx.Response:
        body = _USER_XML if request.url.path.endswith("/user/me") else _CONTRACTS_XML
        return httpx.Response(200, content=body.encode())

    c = HdikaClient({"base_url": "https://hdika.example/pharmapiv2",
                     "username": "u", "password": "p", "api_key": "k"})
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    info = c.fetch_user_info()
    assert info["pharmacy_id"] == "2818"          # → no manual typing of pharmacyId
    assert info["afm"] == "045900962"
    assert info["pharmacy_code"] == "SHS-2818"
    assert info["eopyy_registry"] == "7654"
    assert info["pharmacy_name"] == "ΦΑΡΜΑΚΕΙΟ ΔΕΛΗ"
    assert info["city"] == "Αθήνα"
    assert info["history_from"] == "2022-01-15"    # earliest contract effectiveFrom
    c.close()


def test_unexecuted_substance_flagged():
    """quantityOutstanding == quantityPrescribed → ανεκτέλεστη δραστική (§9)."""
    it = _map_treatment({"medicineBarcode": "x", "medicineCommercialName": "Y",
                         "quantityPrescribed": 2, "quantityOutstanding": 2,
                         "totalPrice": "3.00"})
    assert it.is_executed is False
    assert it.retail_price == 300
