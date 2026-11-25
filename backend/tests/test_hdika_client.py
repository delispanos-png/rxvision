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


def test_repeat_chain_and_recurrence_from_cda():
    """Repeat count/position + recurrence come straight from the ΗΔΙΚΑ CDA (1.1.4 / 1.1.4.1 /
    1.4.10 / 1.10.9). A 6-month chain at position 1 → repeat 1/6, δίμηνη, χρόνια."""
    c = HdikaClient({"base_url": "x", "username": "u", "password": "p", "api_key": "k"})
    ex = {"prescription": {"barcode": "RX-R"}, "executionDate": "2026-06-01T10:00:00Z", "executionNo": 1}
    cda = {"patient": {"amka": "X"}, "doctor": {"name": "Δ"}, "icd10": [], "medicines": [],
           "repeat_type": "6", "repeat_seq": "1", "bimonthly": True, "chronic": True}
    e = c._map_full(ex, cda, {})
    c.close()
    assert e.repeat_current == 1 and e.repeat_total == 6      # «1 από 6»
    assert (e.details or {}).get("interval_months") == 2      # δίμηνη
    assert (e.details or {}).get("chronic") is True


def test_kyyap_three_way_split_matches_idika_printout():
    """ΚΥΥΑΠ (Ι.Κ.Α. πρώην Ο.Π.Α.Δ.) σε συμβεβλημένο φαρμακείο: τριμερής επιμερισμός με τα ποσά ΚΥΥΑΠ
    ΤΗΣ ΗΔΥΚΑ (CDA 1.1.27.1 συμμετοχή που καλύπτει, 1.1.27.2 μέρος διαφοράς που καλύπτει) — όχι το παλιό
    χειροκίνητο «μισή διαφορά ανά γραμμή», που αγνοούσε τα caps. Επίσημο έντυπο ΗΔΙΚΑ (2606086725235):
    ΑΣΦ/ΝΟ 4,68 · ΚΥΥΑΠ 6,83 · ΤΑΜΕΙΟ 8,41 · ΣΥΝΟΛΟ 19,92. (Τεστ ενημερώθηκε 01/10/2026 στο μοντέλο ΗΔΥΚΑ.)"""
    c = HdikaClient({"base_url": "x", "username": "u", "password": "p",
                     "api_key": "k", "etyap_contracted": "true"})
    ex = {"prescription": {"barcode": "RX-K",
                           "socialInsuranceDTO": {"name": "Ι.Κ.Α. (πρώην Ο.Π.Α.Δ.) - Κ.Υ.Υ.Α.Π."}},
          "executionDate": "2026-06-09T10:00:00Z", "executionNo": 1,
          "totalValue": 12.56, "totalDifference": 7.36, "socialInsuranceSurcharge": 1.00}
    cda = {"patient": {"amka": "X"}, "doctor": {"name": "Δ"}, "icd10": [],
           "details": {"supplementary_amount": 3.15, "kyyap_difference": 3.68}, "lines": [
        {"eof_code": "E1", "quantity": 2, "retail_price": 5.66, "reference_price": 4.01,
         "participation_pct": 25, "patient_share": 2.01, "difference": 3.30, "is_executed": True,
         "name": "TRIATEC"},
        {"eof_code": "E2", "quantity": 2, "retail_price": 4.30, "reference_price": 2.27,
         "participation_pct": 25, "patient_share": 1.14, "difference": 4.06, "is_executed": True,
         "name": "NORVASC"}]}
    e = c._map_full(ex, cda, {})
    c.close()
    assert e.amount_total == 1992                       # ΣΥΝΟΛΟ 19,92
    assert e.patient_share == 468                       # ΠΛΗΡΩΤΕΟ ΑΠΟ ΑΣΦ/ΝΟ 4,68
    assert e.details["kyyap_covered"] == 683            # ΠΛΗΡΩΤΕΟ ΑΠΟ ΚΥΥΑΠ 6,83
    assert e.amount_total - e.patient_share - e.details["kyyap_covered"] == 841  # ΤΑΜΕΙΟ 8,41


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


def test_gateway_outage_pages_are_transient_not_auth():
    """23/10/2026: «Third-party server not responding» πάγωσε 5 φαρμακεία σαν να άλλαξε ο κωδικός."""
    from app.services.ingestion.hdika_client import _gateway_message
    page = ("<html><head><title>Third-party server not responding</title></head><body>"
            "<h1>Third-party server not responding</h1><p>The resource you have requested is located on a "
            "third-party server. The Application Gateway could not reach it.</p></body></html>")
    msg, is_auth = _gateway_message(page)
    assert is_auth is False
    login = "<html><body>Login required — you must login. Secured by an Application Gateway</body></html>"
    assert _gateway_message(login)[1] is True          # ο ληγμένος κωδικός ΣΥΝΕΧΙΖΕΙ να παγώνει


def _month_feed(monkeypatch, c, *, month_semantics: bool):
    """Ψεύτικη ΗΔΥΚΑ: `executionDate=Χ` → ΟΛΟΣ ο μήνας του Χ (μετρημένη συμπεριφορά 25/11/2026) ή
    μόνο η ημέρα Χ. Επιστρέφει τη λίστα των ημερών που ζητήθηκαν."""
    from datetime import date as _d

    asked: list = []

    def _get_xml(path, params):
        x = _d.fromisoformat(params["executionDate"])
        asked.append(x)
        days = [x.replace(day=k) for k in (1, 10, 20)] if month_semantics else [x]
        return {"content": [{"prescription": {"barcode": f"B{d.isoformat()}"}, "executionNo": 1,
                             "executionDate": f"{d.isoformat()}T10:00:00"} for d in days],
                "last": "true"}

    monkeypatch.setattr(c, "authenticate", lambda: None)
    monkeypatch.setattr(c, "_get_xml", _get_xml)
    monkeypatch.setattr(c, "_prescription_index", lambda a, b: {})
    monkeypatch.setattr(c, "_fetch_cda", lambda bc: {})
    monkeypatch.setattr(c, "_map_full", lambda raw, cda, s: raw["prescription"]["barcode"])
    monkeypatch.setattr("app.services.ingestion.hdika_client._to_dict", lambda d: d)
    return asked


def test_iter_executions_skips_days_already_covered_by_a_month_response(monkeypatch):
    """Η ΗΔΥΚΑ δίνει όλο τον μήνα σε κάθε ημέρα → ΜΙΑ αναζήτηση ανά μήνα (όχι ~30 ίδιες) — αλλιώς ο
    watchdog σκότωνε τα backfills ως «stalled» (pharmacy-295, 25/11/2026)."""
    from datetime import datetime as _dt, timezone as _tz

    c = HdikaClient({"base_url": "https://x", "username": "u", "password": "p", "api_key": "k",
                     "pharmacy_id": "1"})
    asked = _month_feed(monkeypatch, c, month_semantics=True)
    got = list(c.iter_executions(_dt(2025, 11, 5, tzinfo=_tz.utc), _dt(2026, 1, 15, tzinfo=_tz.utc)))
    assert [d.isoformat() for d in asked] == ["2026-01-15", "2025-12-31", "2025-11-30"]
    assert len(got) == 9 and len(set(got)) == 9                  # 3 μήνες × 3 ημέρες, τίποτα διπλό
    c.close()


def test_iter_executions_day_semantics_still_queries_every_day(monkeypatch):
    """Αν η ΗΔΥΚΑ γυρίσει σε «μόνο η ημέρα», δεν παραλείπεται ΚΑΜΙΑ ημέρα."""
    from datetime import datetime as _dt, timezone as _tz

    c = HdikaClient({"base_url": "https://x", "username": "u", "password": "p", "api_key": "k",
                     "pharmacy_id": "1"})
    asked = _month_feed(monkeypatch, c, month_semantics=False)
    got = list(c.iter_executions(_dt(2026, 1, 1, tzinfo=_tz.utc), _dt(2026, 1, 10, tzinfo=_tz.utc)))
    assert len(asked) == 10 and len(got) == 10
    c.close()
