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


def test_map_full_builds_canonical_from_execution_and_cda():
    """New ΗΔΙΚΑ flow (post CDA-enrichment rewrite): an execution row (amounts/fund) + the
    HL7 CDA (patient/doctor/ICD-10/medicines) + the repeat summary → a complete
    CanonicalExecution, with each medicine priced from the Δελτίο Τιμών catalog. This is the
    core mapping `iter_executions` yields, tested directly (no 3-endpoint HTTP mock)."""
    c = HdikaClient(
        {"base_url": "https://hdika.example/pharmapiv2", "username": "u", "password": "p", "api_key": "k"},
        catalog={"EOF123": {"barcode": "5290001", "name": "Glucophage 850", "atc": "A10BA02",
                            "retail_cents": 420, "wholesale_cents": 300, "narcotic": False}},
    )
    ex = {
        "prescription": {"barcode": "RX-1",
                         "socialInsuranceDTO": {"name": "ΕΟΠΥΥ", "shortName": "EOPYY"}},
        "executionDate": "2026-06-01T10:00:00Z", "executionNo": 1,
        "totalValue": 3.20, "totalDifference": 1.00, "sociTotalDifference": 0.40,
        "participationValue": 0.50, "socialInsuranceSurcharge": 1.00,
    }
    cda = {
        "patient": {"amka": "AMKA123", "sex": "F", "birth_year": 1960,
                    "city": "Αττική", "full_name": "Π. Παπαδόπουλος"},
        "doctor": {"name": "Κ. Παπαδόπουλος", "specialty": "Παθολόγος"},
        "medicines": [{"code": "EOF123", "quantity": 2, "name": "Glucophage"}],
        "icd10": [{"code": "E11.9"}],
        "valid_until": "20260901",
    }
    e = c._map_full(ex, cda, {"executions": 3})
    # external_id is the natural key barcode:executionNo (distinguishes repeat executions)
    assert e.source == "HDIKA" and e.external_id == "RX-1:1"
    assert e.executed_at.year == 2026 and e.executed_at.month == 6
    assert e.patient.national_id == "AMKA123" and e.patient.sex == "F" and e.patient.birth_year == 1960
    assert e.doctor.full_name == "Κ. Παπαδόπουλος" and e.doctor.specialty == "Παθολόγος"
    assert e.fund.code == "EOPYY" and e.fund.name == "ΕΟΠΥΥ"
    assert e.icd10 == ["E11.9"]
    # repeat_current = this row's executionNo; with no CDA repeat plan, repeat_total falls back to
    # the execution number (≥ repeat_current, so the validator passes) — the real chain comes from
    # repeat_root + actual executions, not this number.
    assert e.repeat_total == 1 and e.repeat_current == 1
    assert e.amount_total == 420          # totalValue 320 + totalDifference 100 (cents)
    assert e.patient_share == 210         # 50 + max(0,100−40) + 100
    assert e.valid_until is not None and e.valid_until.year == 2026 and e.valid_until.month == 9
    assert len(e.items) == 1
    it = e.items[0]
    assert it.barcode == "5290001" and it.name == "Glucophage 850" and it.substance == "A10BA02"
    assert it.quantity == 2 and it.retail_price == 420 and it.wholesale_price == 300
    c.close()


def test_etyap_contracted_pharmacy_shifts_participation_to_fund():
    """ΕΤΥΑΠ + συμβεβλημένος Φ.Σ.: το ΕΤΥΑΠ πληρώνει τη συμμετοχή (participationValue),
    ο ασθενής μένει με διαφορά + 1€ — όχι τη συμμετοχή. Καταγράφεται το etyap_covered."""
    ex = {
        "prescription": {"barcode": "RX-E", "socialInsuranceDTO": {"name": "ΕΤΥΑΠ", "shortName": "ETYAP"}},
        "executionDate": "2026-06-01T10:00:00Z", "executionNo": 1,
        "totalValue": 20.00, "totalDifference": 1.00, "sociTotalDifference": 0.40,
        "participationValue": 5.00, "socialInsuranceSurcharge": 1.00,
    }
    # μη-συμβεβλημένο → σαν ΕΟΠΥΥ: ο ασθενής πληρώνει τη συμμετοχή (5€) + διαφορά (0.60) + 1€ = 660
    base = HdikaClient({"base_url": "x", "username": "u", "password": "p", "api_key": "k"})
    e0 = base._map_full(ex, {}, {})
    assert e0.patient_share == 660 and (e0.details or {}).get("etyap_covered") is None
    base.close()
    # συμβεβλημένο → ΕΤΥΑΠ αναλαμβάνει τη συμμετοχή (5€): ασθενής 0.60 + 1€ = 160· etyap_covered=500
    contracted = HdikaClient({"base_url": "x", "username": "u", "password": "p",
                              "api_key": "k", "etyap_contracted": "true"})
    e1 = contracted._map_full(ex, {}, {})
    assert e1.patient_share == 160 and (e1.details or {}).get("etyap_covered") == 500
    contracted.close()


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
