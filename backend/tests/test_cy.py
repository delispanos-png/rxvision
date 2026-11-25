"""RxVision Κύπρος (ΓεΣΥ): parser, εισαγωγή, και ο ΦΡΑΓΜΟΣ που προστατεύει την Ελλάδα.

Τα XML εδώ είναι ΣΥΝΘΕΤΙΚΑ, με την ίδια ακριβώς δομή με τα πραγματικά της πύλης (Type 01 φάρμακα,
Type 02 αναλώσιμα). Πραγματικά XML (ονόματα/ταυτότητες ασθενών) δεν μπαίνουν ΠΟΤΕ στον κώδικα.

Η βάση είναι ΠΑΝΤΑ στη μνήμη (mongomock) — τα τεστ αυτά δεν αγγίζουν ποτέ πραγματική MongoDB.
"""

from __future__ import annotations

import pytest
from fastapi import Request

from app.services.cy.parser import CyParseError, parse_dispensing, parse_dosage, parse_emvs

DRUG_XML = """<Dispensing><Header>
<UserDetails><Username>demo.user</Username><UserLastName>ΔΟΚΙΜΗΣ</UserLastName><UserFirstName>ΧΡΗΣΤΗΣ</UserFirstName><UserDocType>NID</UserDocType><UserDocId>0000000001</UserDocId></UserDetails>
<PrescriptionId>11111111</PrescriptionId><DispensingId>22222222</DispensingId><DispensingProviderId>C9999</DispensingProviderId>
<Timestamp>2026-11-17 09:05:18 +0200</Timestamp><PrescriptionVisitId>33333333</PrescriptionVisitId>
<PrescriptionEffectiveDate>2026-07-06</PrescriptionEffectiveDate>
<BeneficiaryDetails><BeneficiaryId>0000999001</BeneficiaryId><BeneficiaryDocType>NID</BeneficiaryDocType><BeneficiaryName>ΑΝΔΡΕΑΣ</BeneficiaryName><BeneficiaryLastName>ΣΥΝΘΕΤΙΚΟΥ</BeneficiaryLastName><BeneficiaryGender>M</BeneficiaryGender><BeneficiaryDOB>1959-12-31</BeneficiaryDOB><BeneficiaryHIOcode>900001</BeneficiaryHIOcode></BeneficiaryDetails>
<IssuingProviderDetails><IssuingProviderId>D9001</IssuingProviderId><IssuingProviderName>ΑΝΤΡΗ</IssuingProviderName><IssuingProviderLastName>ΙΑΤΡΟΥ</IssuingProviderLastName><IssuingProviderWorkPhoneNumber>22000000 99000000 22000000</IssuingProviderWorkPhoneNumber></IssuingProviderDetails>
<Type>01</Type></Header>
<DrugItems>
<Drug><Id>1</Id><Barcode>05290931041882</Barcode><Barcode2>05290931041998</Barcode2><HIOcode>41M0186/5</HIOcode>
<PotentialDispInstances>6</PotentialDispInstances><CurrentDispInstance>6</CurrentDispInstance><QtyPresc>1</QtyPresc><QtyDisp>1</QtyDisp>
<EMVOCodes><EMVOCode>01052909310418821728033110A0C140 21420803995078</EMVOCode></EMVOCodes>
<Description>JIVOLAR TABLET, FILM COATED 50MG/850MG</Description><PackageDescription>PACK WITH 60 TABS IN BLISTER(S)</PackageDescription>
<DosageAmount>1.0 Tablet</DosageAmount><DosageFrequency>2 PER DAY</DosageFrequency><DosageTiming>na</DosageTiming><DosageDurationDays>28</DosageDurationDays><RouteOfAdministration>Oral use</RouteOfAdministration>
<DoctorsInstructions/><PharmacistsComments/>
<HIOAmount>16.54</HIOAmount><BeneficiaryCopaymentAmount>0.00</BeneficiaryCopaymentAmount><BeneficiaryPC2Amount>0.00</BeneficiaryPC2Amount><TotalBeneficiaryAmount>0.00</TotalBeneficiaryAmount><TotalAmount>16.54</TotalAmount><HIOCoveredFlag>YES</HIOCoveredFlag></Drug>
<Drug><Id>2</Id><Barcode>05290931001985</Barcode><Barcode2/><HIOcode>7900222/1</HIOcode>
<PotentialDispInstances>6</PotentialDispInstances><CurrentDispInstance>6</CurrentDispInstance><QtyPresc>1</QtyPresc><QtyDisp>0</QtyDisp>
<EMVOCodes/><Description>LORANS TABLET 2MG</Description><PackageDescription>PACK WITH 50 TABS IN BLISTER(S)</PackageDescription>
<DosageAmount>0.5 Δισκίο</DosageAmount><DosageFrequency>1 ΤΗΝ ΗΜΕΡΑ</DosageFrequency><DosageTiming>AFTER DINNER</DosageTiming><DosageDurationDays>28</DosageDurationDays><RouteOfAdministration>Στοματική χρήση</RouteOfAdministration>
<DoctorsInstructions/><PharmacistsComments/>
<HIOAmount>0.00</HIOAmount><BeneficiaryCopaymentAmount>0.00</BeneficiaryCopaymentAmount><BeneficiaryPC2Amount>0.00</BeneficiaryPC2Amount><TotalBeneficiaryAmount>0.00</TotalBeneficiaryAmount><TotalAmount>0.00</TotalAmount><HIOCoveredFlag>YES</HIOCoveredFlag></Drug>
<Drug><Id>3</Id><Barcode>04260108281183</Barcode><Barcode2/><HIOcode>C555003/1</HIOcode>
<PotentialDispInstances>6</PotentialDispInstances><CurrentDispInstance>6</CurrentDispInstance><QtyPresc>1</QtyPresc><QtyDisp>1</QtyDisp>
<EMVOCodes><EMVOCode>01042601082811831727123110NN6957 2188EZGIEPU</EMVOCode></EMVOCodes>
<Description>CLOPIDOGREL TAD TABLET, FILM COATED 75MG</Description><PackageDescription>PACK WITH 28 TABS IN BLISTER(S)</PackageDescription>
<DosageAmount>1.0 Tablet</DosageAmount><DosageFrequency>1 PER DAY</DosageFrequency><DosageTiming>AFTER BREAKFAST</DosageTiming><DosageDurationDays>28</DosageDurationDays><RouteOfAdministration>Oral use</RouteOfAdministration>
<DoctorsInstructions/><PharmacistsComments/>
<HIOAmount>4.20</HIOAmount><BeneficiaryCopaymentAmount>0.00</BeneficiaryCopaymentAmount><BeneficiaryPC2Amount>3.68</BeneficiaryPC2Amount><TotalBeneficiaryAmount>3.68</TotalBeneficiaryAmount><TotalAmount>7.88</TotalAmount><HIOCoveredFlag>YES</HIOCoveredFlag></Drug>
</DrugItems><ConsumableItems/>
<Footer><TotalBeneficiaryCopaymentAmount>0.00</TotalBeneficiaryCopaymentAmount><TotalBeneficiaryPC2Amount>3.68</TotalBeneficiaryPC2Amount><TotalBeneficiaryAmount>3.68</TotalBeneficiaryAmount><TotalHIOAmount>20.74</TotalHIOAmount><TotalDispensingAmount>24.42</TotalDispensingAmount></Footer>
</Dispensing>"""

CONS_XML = """<Dispensing><Header>
<UserDetails><Username>demo.user</Username><UserLastName>ΔΟΚΙΜΗΣ</UserLastName><UserFirstName>ΧΡΗΣΤΗΣ</UserFirstName><UserDocType>NID</UserDocType><UserDocId>0000000001</UserDocId></UserDetails>
<PrescriptionId>44444444</PrescriptionId><DispensingId>55555555</DispensingId><DispensingProviderId>C9999</DispensingProviderId>
<Timestamp>2026-07-17 08:36:19 +0300</Timestamp><PrescriptionVisitId>66666666</PrescriptionVisitId>
<PrescriptionEffectiveDate>2026-07-16</PrescriptionEffectiveDate>
<BeneficiaryDetails><BeneficiaryId>0000999002</BeneficiaryId><BeneficiaryDocType>NID</BeneficiaryDocType><BeneficiaryName>ΜΑΡΙΑ</BeneficiaryName><BeneficiaryLastName>ΔΟΚΙΜΙΟΥ</BeneficiaryLastName><BeneficiaryGender>F</BeneficiaryGender><BeneficiaryDOB>1977-03-12</BeneficiaryDOB><BeneficiaryHIOcode>900002</BeneficiaryHIOcode></BeneficiaryDetails>
<IssuingProviderDetails><IssuingProviderId>D9003</IssuingProviderId><IssuingProviderName>STELLA</IssuingProviderName><IssuingProviderLastName>MEDICA</IssuingProviderLastName><IssuingProviderWorkPhoneNumber>22000001</IssuingProviderWorkPhoneNumber></IssuingProviderDetails>
<Type>02</Type></Header><DrugItems/>
<ConsumableItems>
<Consumable><Id>7</Id><Barcode/><Barcode2/><Code>82224638</Code><PotentialDispInstances>3</PotentialDispInstances><CurrentDispInstance>1</CurrentDispInstance>
<Description>82224638 Microlet Σκαρφιστήρες (lancets)</Description><QtyPresc>1</QtyPresc><QtyDisp>1</QtyDisp><DoctorsInstructions/><PharmacistsComments/>
<HIOAmount>0.00</HIOAmount><BeneficiaryCopaymentAmount>1.00</BeneficiaryCopaymentAmount><BeneficiaryPC2Amount>0.02</BeneficiaryPC2Amount><TotalBeneficiaryAmount>1.02</TotalBeneficiaryAmount><TotalAmount>1.02</TotalAmount><HIOCoveredFlag>YES</HIOCoveredFlag></Consumable>
<Consumable><Id>8</Id><Barcode/><Barcode2/><Code>90002453</Code><PotentialDispInstances>3</PotentialDispInstances><CurrentDispInstance>1</CurrentDispInstance>
<Description>90002453 Contour test strips</Description><QtyPresc>1</QtyPresc><QtyDisp>1</QtyDisp><DoctorsInstructions/><PharmacistsComments/>
<HIOAmount>1.09</HIOAmount><BeneficiaryCopaymentAmount>1.00</BeneficiaryCopaymentAmount><BeneficiaryPC2Amount>4.57</BeneficiaryPC2Amount><TotalBeneficiaryAmount>5.57</TotalBeneficiaryAmount><TotalAmount>6.66</TotalAmount><HIOCoveredFlag>YES</HIOCoveredFlag></Consumable>
</ConsumableItems>
<Footer><TotalBeneficiaryCopaymentAmount>2.00</TotalBeneficiaryCopaymentAmount><TotalBeneficiaryPC2Amount>4.59</TotalBeneficiaryPC2Amount><TotalBeneficiaryAmount>6.59</TotalBeneficiaryAmount><TotalHIOAmount>1.09</TotalHIOAmount><TotalDispensingAmount>7.68</TotalDispensingAmount></Footer>
</Dispensing>"""


# ── parser ───────────────────────────────────────────────────────────────────

def test_drug_dispensing_parses_and_closes_prescription():
    d = parse_dispensing(DRUG_XML.encode())
    assert d["kind"] == "drug" and d["provider_id"] == "C9999"
    assert d["dispensed_at"].isoformat() == "2026-11-17T07:05:18+00:00", "+0200 → UTC"
    assert d["instance"] == 6 and d["instances"] == 6 and d["closes_prescription"] is True
    assert d["totals"] == {"hio": 2074, "copay": 0, "pc2": 368, "beneficiary": 368, "total": 2442}
    assert d["doctor"]["phones"] == ["22000000", "99000000"], "διπλά τηλέφωνα αφαιρούνται"
    lor = d["lines"][1]
    assert lor["qty_disp"] == 0 and lor["amounts"]["total"] == 0, "είδος που δεν δόθηκε"
    assert lor["dosage"]["unit"] == "tablet" and lor["dosage"]["per_day"] == 1.0, "ελληνική δοσολογία"
    assert lor["dosage"]["timing"] == "AFTER DINNER"
    jiv = d["lines"][0]
    assert jiv["dosage"]["timing"] is None, "«na» = δεν ορίστηκε"
    assert jiv["pack_size"] == 60 and jiv["days_covered"] == 30, "60 δισκία / 2 την ημέρα"
    assert jiv["barcode2"] == "05290931041998"


def test_emvs_keeps_expiry_and_lot_but_drops_serial():
    e = parse_emvs("01052909310418821728033110A0C140 21420803995078")
    assert e == {"gtin": "05290931041882", "expiry": "2028-03-31", "lot": "A0C140"}
    d = parse_dispensing(DRUG_XML.encode())
    assert "420803995078" not in repr(d), "το σειριακό δεν κρατιέται πουθενά"


def test_emvs_day_00_means_end_of_month():
    assert parse_emvs("0105290931041882172802001012345")["expiry"] == "2028-02-29"


def test_dosage_english_and_greek():
    assert parse_dosage("1.0 Tablet", "2 PER DAY") == {"amount": 1.0, "unit": "tablet", "per_day": 2.0}
    assert parse_dosage("1.0 Καψάκιο", "1 ΤΗΝ ΗΜΕΡΑ")["unit"] == "capsule"
    assert parse_dosage("", "κάτι άγνωστο")["per_day"] is None, "ποτέ μαντεψιά"


def test_consumable_dispensing():
    d = parse_dispensing(CONS_XML.encode())
    assert d["kind"] == "consumable" and d["closes_prescription"] is False
    assert d["dispensed_at"].isoformat() == "2026-07-17T05:36:19+00:00", "+0300 (θερινή) → UTC"
    assert [ln["code"] for ln in d["lines"]] == ["82224638", "90002453"]
    assert "dosage" not in d["lines"][0] and d["totals"]["total"] == 768


@pytest.mark.parametrize("bad,msg", [
    (DRUG_XML.replace("<TotalHIOAmount>20.74", "<TotalHIOAmount>20.75"), "σύνολα"),
    (DRUG_XML.replace("<Type>01</Type>", "<Type>09</Type>"), "τύπος"),
    ("όχι xml", "XML"),
    ("<Other/>", "ΓεΣΥ"),
    (DRUG_XML.replace("<BeneficiaryId>0000999001</BeneficiaryId>", "<BeneficiaryId/>"), "δικαιούχου"),
])
def test_invalid_files_are_rejected_with_reason(bad, msg):
    with pytest.raises(CyParseError, match=msg):
        parse_dispensing(bad.encode())


def test_entity_expansion_is_refused():
    bomb = ('<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa">'
            '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><Dispensing>&b;</Dispensing>')
    with pytest.raises(CyParseError):
        parse_dispensing(bomb.encode())


def test_synthetic_generator_produces_valid_files():
    from datetime import date

    from app.services.cy.synthetic import generate
    files = generate(patients=15, months=7, today=date(2026, 11, 17))
    parsed = [parse_dispensing(x) for _, x in files]
    assert len(parsed) > 30
    assert {p["kind"] for p in parsed} == {"drug", "consumable"}
    assert any(ln["qty_disp"] == 0 for p in parsed for ln in p["lines"])
    assert any(p["closes_prescription"] for p in parsed)
    # αναλώσιμα κάθε μήνα (φάσεις 1-3 ανά συνταγή): όχι «χαμένοι» διαβητικοί από λάθος ρυθμό του demo
    cons = [p for p in parsed if p["kind"] == "consumable"]
    assert cons and all(1 <= p["instance"] <= p["instances"] == 3 for p in cons)


# ── εισαγωγή + φραγμός (βάση στη μνήμη) ─────────────────────────────────────

GR, CY = "T-ZZTEST-GR", "T-ZZTEST-CY"


@pytest.fixture
async def mem(monkeypatch):
    from mongomock_motor import AsyncMongoMockClient

    from app.core import db as core_db
    mock = AsyncMongoMockClient(tz_aware=True)
    monkeypatch.setattr(core_db, "get_client", lambda: mock)
    db = core_db.shared_db()
    await db["tenants"].insert_many([{"_id": GR, "country": "GR", "settings": {}},
                                     {"_id": CY, "country": "CY", "settings": {}}])
    return db


async def test_import_dedupes_and_never_stores_national_id(mem):
    from app.services.cy.importer import import_files
    r = await import_files(CY, [("a.xml", DRUG_XML.encode()), ("b.xml", CONS_XML.encode())], pepper="p")
    assert (r["imported"], r["duplicates"], r["failed"]) == (2, 0, 0)
    again = await import_files(CY, [("a.xml", DRUG_XML.encode())], pepper="p")
    assert (again["imported"], again["duplicates"]) == (0, 1), "το ίδιο XML μετράει μία φορά"
    for coll in ("cy_dispensings", "cy_patients"):
        async for doc in mem[coll].find({}):
            assert doc["tenant_id"] == CY
            assert "0000999001" not in repr(doc) and "0000999002" not in repr(doc), \
                "η ταυτότητα δικαιούχου δεν αποθηκεύεται ποτέ"
    assert await mem["cy_patients"].count_documents({}) == 2


async def test_file_of_another_pharmacy_is_rejected(mem):
    from app.services.cy.importer import import_files
    await import_files(CY, [("a.xml", DRUG_XML.encode())], pepper="p")  # δένει το C9999
    other = CONS_XML.replace("<DispensingProviderId>C9999", "<DispensingProviderId>C1234")
    r = await import_files(CY, [("x.xml", other.encode())], pepper="p")
    assert r["imported"] == 0 and r["failed"] == 1 and "άλλο φαρμακείο" in r["errors"][0]["error"]


async def test_zip_upload(mem):
    from app.services.cy.importer import import_files
    from app.services.cy.synthetic import as_zip
    z = as_zip([("a.xml", DRUG_XML.encode()), ("b.xml", CONS_XML.encode()), ("readme.txt", b"x")])
    r = await import_files(CY, [("batch.zip", z)], pepper="p")
    assert r["files"] == 2 and r["imported"] == 2


async def test_overview_counts(mem):
    from datetime import date

    from app.repositories.cy import CyDispensingRepository
    from app.services.cy import chains
    from app.services.cy.importer import import_files
    await import_files(CY, [("a.xml", DRUG_XML.encode()), ("b.xml", CONS_XML.encode())], pepper="p")
    o = await chains.overview(CY, today=date(2026, 11, 17))
    assert o["dispensings"] == 2 and o["patients"] == 2 and o["prescriptions"] == 2
    assert o["open_prescriptions"] == 1, "τα αναλώσιμα (1/3) μένουν ανοιχτά, τα φάρμακα (6/6) έκλεισαν"
    assert o["lines_not_dispensed"] == 1 and o["amounts"]["total"] == 2442 + 768
    assert (await CyDispensingRepository(tenant_id=GR).overview())["dispensings"] == 0


# ── ΦΡΑΓΜΟΣ: η Ελλάδα δεν βλέπει τίποτα κυπριακό ────────────────────────────

async def _gate(tenant_id):
    from fastapi import HTTPException

    from app.services.cy.gate import require_cy

    class Ctx:
        pass
    ctx = Ctx()
    ctx.tenant_id = tenant_id
    req = type("Req", (), {"state": type("State", (), {})()})()
    try:
        await require_cy(req, ctx)
        return 200
    except HTTPException as exc:
        return exc.status_code


async def test_gate_greek_pharmacy_never_sees_cyprus(mem):
    from app.services.cy.gate import set_cy_enabled
    assert await _gate(GR) == 404 and await _gate(CY) == 404, "κλειστός διακόπτης → 404 για όλους"
    await set_cy_enabled(True)
    assert await _gate(CY) == 200
    assert await _gate(GR) == 404, "ελληνικό φαρμακείο → 404 ακόμη και με ανοιχτό διακόπτη"
    await mem["tenants"].insert_one({"_id": "T-ZZTEST-NOCOUNTRY"})
    assert await _gate("T-ZZTEST-NOCOUNTRY") == 404, "χωρίς χώρα = ελληνικό"


async def test_seed_demo_refuses_greek_pharmacy(mem):
    from app.services.cy.synthetic import seed_demo
    with pytest.raises(ValueError):
        await seed_demo(GR, patients=2)
    assert await mem["cy_dispensings"].count_documents({}) == 0


def test_every_cy_endpoint_is_gated():
    from app.api.v1.routers import cy
    from app.services.cy.gate import require_cy
    for route in cy.router.routes:
        deps = [d.call for d in route.dependant.dependencies]
        assert require_cy in deps, f"{route.path} χωρίς require_cy"


def test_cy_code_never_touches_greek_collections():
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[1] / "app"
    greek = [f'{w}"{c}"' for c in ("executions", "prescriptions", "patients_anonymized", "products")
             for w in ("[", "collection_name = ")]
    for f in [*(root / "services" / "cy").glob("*.py"), root / "repositories" / "cy.py",
              root / "api" / "v1" / "routers" / "cy.py"]:
        src = f.read_text(encoding="utf-8")
        for name in greek:
            assert name not in src, f"{f.name} αναφέρει ελληνική συλλογή {name}"


def test_provisioning_defaults_to_greece():
    import inspect

    from app.services.provisioning import COUNTRY_SETTINGS, TenantProvisioningService
    sig = inspect.signature(TenantProvisioningService.open_tenant)
    assert sig.parameters["country"].default == "GR"
    assert COUNTRY_SETTINGS["GR"]["timezone"] == "Europe/Athens"


# ── αλυσίδες συνταγών: ΕΝΑΣ ορισμός για όλες τις οθόνες ─────────────────────

def test_classify_thresholds():
    from datetime import date

    from app.services.cy.chains import LOST_AFTER_DAYS, classify
    d = date(2026, 11, 17)
    assert classify(instance=6, instances=6, due=d, today=d) == "closed"
    assert classify(instance=2, instances=6, due=d.replace(day=20), today=d) == "soon"
    assert classify(instance=2, instances=6, due=date(2026, 12, 30), today=d) == "upcoming"
    assert classify(instance=2, instances=6, due=date(2026, 11, 10), today=d) == "late"
    from datetime import timedelta
    assert classify(instance=2, instances=6, due=d - timedelta(days=LOST_AFTER_DAYS + 1), today=d) == "lost"


def _rx(rx: str, disp: str, nid: str, ts: str, k: int, n: int = 6) -> bytes:
    """Μικρή εκτέλεση φαρμάκου με ρυθμιζόμενη συνταγή/ασθενή/ώρα/φάση (συνθετική)."""
    x = DRUG_XML.replace("<PrescriptionId>11111111", f"<PrescriptionId>{rx}")
    x = x.replace("<DispensingId>22222222", f"<DispensingId>{disp}")
    x = x.replace("<BeneficiaryId>0000999001", f"<BeneficiaryId>{nid}")
    # ο πελάτης αναγνωρίζεται ΠΡΩΤΑ από τον κωδικό ΟΑΥ → μοναδικός ανά πελάτη στο τεστ
    x = x.replace("<BeneficiaryHIOcode>900001", f"<BeneficiaryHIOcode>{nid}")
    x = x.replace("2026-11-17 09:05:18 +0200", ts)
    x = x.replace("<CurrentDispInstance>6<", f"<CurrentDispInstance>{k}<")
    return x.replace("<PotentialDispInstances>6<", f"<PotentialDispInstances>{n}<").encode()


async def test_open_and_lost_customers(mem):
    from datetime import date

    from app.services.cy import chains
    from app.services.cy.importer import import_files
    files = [
        # Α: έρχεται κανονικά — 2/6 πριν 20 ημέρες → αναμένεται σε ~8 ημέρες
        ("1", _rx("R1", "D1", "N-A", "2026-10-28 10:00:00 +0200", 2)),
        # Β: 3/6 πριν 3 μήνες και ΤΙΠΟΤΑ μετά → χαμένος πελάτης
        ("2", _rx("R2", "D2", "N-B", "2026-08-10 10:00:00 +0300", 3)),
        # Γ: η R3 «χάθηκε», αλλά έρχεται ακόμη για τη R4 → διαρροή, όχι χαμένος
        ("3", _rx("R3", "D3", "N-C", "2026-08-01 10:00:00 +0300", 1)),
        ("4", _rx("R4", "D4", "N-C", "2026-11-10 10:00:00 +0200", 1)),
        # Δ: ολοκληρωμένη 6/6 → κλειστή, ποτέ «χαμένη»
        ("5", _rx("R5", "D5", "N-D", "2026-06-01 10:00:00 +0300", 6)),
    ]
    await import_files(CY, files, pepper="p")
    today = date(2026, 11, 17)
    op = await chains.open_prescriptions(CY, today=today)
    by = {c["prescription_id"]: c for c in op["items"]}
    assert "R5" not in by, "κλειστή συνταγή δεν είναι ανοιχτή"
    assert by["R1"]["status"] in ("soon", "upcoming") and by["R1"]["next_due"] == "2026-11-25"
    assert by["R2"]["status"] == "lost" and by["R3"]["status"] == "lost"
    assert by["R1"]["patient_name"] == "ΑΝΔΡΕΑΣ ΣΥΝΘΕΤΙΚΟΥ"
    assert by["R2"]["value_at_stake_cents"] == 2442 * 3, "3 φάσεις που απομένουν × μέση αξία"

    lc = await chains.lost_customers(CY, today=today)
    kinds = sorted(i["kind"] for i in lc["items"])
    assert kinds == ["leak", "lost"], "Β = χαμένος, Γ = διαρροή, Α/Δ = κανένα"
    assert lc["summary"] == {"lost": 1, "leak": 1, "monthly_value_cents": 2442 * 2,
                             "value_at_stake_cents": 2442 * 3 + 2442 * 5}

    o = await chains.overview(CY, today=today)
    assert o["open_prescriptions"] == len(op["items"]) == op["total"], "ίδιος αριθμός σε κάθε οθόνη"
    assert o["lost_customers"] == lc["summary"]
    assert (await chains.open_prescriptions(GR, today=today))["total"] == 0


# ── εκδόσεις της ίδιας εκτέλεσης (διόρθωση / ακύρωση γραμμής από την πύλη) ──

async def test_same_dispensing_resent_with_changes_replaces_and_keeps_history(mem):
    from app.services.cy.importer import import_files
    await import_files(CY, [("a.xml", DRUG_XML.encode())], pepper="p")
    # η πύλη ξαναβγάζει την ΙΔΙΑ εκτέλεση: το CLOPIDOGREL ακυρώθηκε (QtyDisp 0, ποσά 0)
    fixed = (DRUG_XML
             .replace("<Id>3</Id><Barcode>04260108281183</Barcode><Barcode2/><HIOcode>C555003/1</HIOcode>\n<PotentialDispInstances>6</PotentialDispInstances><CurrentDispInstance>6</CurrentDispInstance><QtyPresc>1</QtyPresc><QtyDisp>1</QtyDisp>",
                      "<Id>3</Id><Barcode>04260108281183</Barcode><Barcode2/><HIOcode>C555003/1</HIOcode>\n<PotentialDispInstances>6</PotentialDispInstances><CurrentDispInstance>6</CurrentDispInstance><QtyPresc>1</QtyPresc><QtyDisp>0</QtyDisp>")
             .replace("<HIOAmount>4.20</HIOAmount><BeneficiaryCopaymentAmount>0.00</BeneficiaryCopaymentAmount><BeneficiaryPC2Amount>3.68</BeneficiaryPC2Amount><TotalBeneficiaryAmount>3.68</TotalBeneficiaryAmount><TotalAmount>7.88</TotalAmount>",
                      "<HIOAmount>0.00</HIOAmount><BeneficiaryCopaymentAmount>0.00</BeneficiaryCopaymentAmount><BeneficiaryPC2Amount>0.00</BeneficiaryPC2Amount><TotalBeneficiaryAmount>0.00</TotalBeneficiaryAmount><TotalAmount>0.00</TotalAmount>")
             .replace("<TotalBeneficiaryPC2Amount>3.68</TotalBeneficiaryPC2Amount><TotalBeneficiaryAmount>3.68</TotalBeneficiaryAmount><TotalHIOAmount>20.74</TotalHIOAmount><TotalDispensingAmount>24.42</TotalDispensingAmount>",
                      "<TotalBeneficiaryPC2Amount>0.00</TotalBeneficiaryPC2Amount><TotalBeneficiaryAmount>0.00</TotalBeneficiaryAmount><TotalHIOAmount>16.54</TotalHIOAmount><TotalDispensingAmount>16.54</TotalDispensingAmount>"))
    assert fixed != DRUG_XML
    r = await import_files(CY, [("a-v2.xml", fixed.encode())], pepper="p")
    assert (r["imported"], r["updated"], r["failed"]) == (0, 1, 0), r
    doc = await mem["cy_dispensings"].find_one({"dispensing_id": "22222222"})
    assert doc["totals"]["total"] == 1654 and doc["versions"] == 2
    assert doc["history"][0]["totals"]["total"] == 2442, "η προηγούμενη έκδοση μένει στο ιστορικό"
    assert await mem["cy_dispensings"].count_documents({}) == 1, "μία εκτέλεση, όχι δύο"
    again = await import_files(CY, [("a-v2.xml", fixed.encode())], pepper="p")
    assert (again["updated"], again["duplicates"]) == (0, 1)


def test_patient_key_prefers_hio_code_and_separates_document_types():
    from app.services.cy.parser import patient_key
    assert patient_key("000245047", "NID", "0000601780") == "HIO:245047"
    assert patient_key("", "NID", "0000601780") == "NID:601780"
    assert patient_key("", "ARC", "0000601780") == "ARC:601780", "ίδιος αριθμός, άλλο έγγραφο = άλλος άνθρωπος"


def test_short_emvs_tokens_are_ignored():
    x = DRUG_XML.replace("<EMVOCode>01052909310418821728033110A0C140 21420803995078</EMVOCode>",
                         "<EMVOCode>12345</EMVOCode>")
    d = parse_dispensing(x.encode())
    assert d["lines"][0]["emvs"] == []


# ── Βήμα 3: καρτέλα πελάτη, μη εκτελεσμένα, PC2 ─────────────────────────────

async def test_patient_card_not_dispensed_and_pc2(mem):
    from datetime import date

    from app.services.cy import insights
    from app.services.cy.importer import import_files
    await import_files(CY, [("a.xml", DRUG_XML.encode()), ("b.xml", CONS_XML.encode())], pepper="p")
    today = date(2026, 11, 20)
    refs = [d["patient_ref"] async for d in mem["cy_dispensings"].find({}, {"patient_ref": 1, "kind": 1})]

    cons_ref = (await mem["cy_dispensings"].find_one({"kind": "consumable"}))["patient_ref"]
    card = await insights.patient_card(CY, cons_ref, today=today)
    assert card["flags"]["diabetic"] is True and card["flags"]["exemption"] == "pays"
    drug_ref = (await mem["cy_dispensings"].find_one({"kind": "drug"}))["patient_ref"]
    card2 = await insights.patient_card(CY, drug_ref, today=today)
    assert card2["flags"]["exemption"] == "exempt", "συμμετοχή 0 € σε ό,τι δόθηκε"
    assert card2["totals"]["visits"] == 1 and len(card2["history"][0]["lines"]) == 3
    assert await insights.patient_card(CY, "δεν-υπάρχει", today=today) is None
    assert await insights.patient_card(GR, refs[0], today=today) is None, "άλλο φαρμακείο δεν βλέπει τον πελάτη"

    nd = await insights.not_dispensed(CY)
    assert nd["summary"]["last"] == 1 and nd["summary"]["mid"] == 0, "LORANS: τελευταία φάση 6/6"
    assert nd["items"][0]["description"] == "LORANS TABLET 2MG"
    assert nd["items"][0]["unit_price_cents"] is None, "δεν δόθηκε ποτέ εδώ → χωρίς τιμή, όχι μαντεψιά"

    pc = await insights.pc2(CY, days=200, today=today)  # τα αναλώσιμα είναι από τον Ιούλιο
    assert pc["total_cents"] == 368 + 2 + 457 and pc["patients"] == 2
    assert pc["by_product"][0]["description"].startswith("90002453"), "μεγαλύτερη διαφορά πρώτη"
    assert (await insights.pc2(GR, today=today))["total_cents"] == 0


# ── GDPR: δικαιώματα και για τους Κύπριους πελάτες ───────────────────────────

async def test_gdpr_search_export_erase_cover_cyprus(mem, monkeypatch):
    from app.services import gdpr_service
    from app.services.cy.importer import import_files

    async def _no_audit(*a, **k):
        return None
    monkeypatch.setattr(gdpr_service, "audit", _no_audit)
    await import_files(CY, [("a.xml", DRUG_XML.encode())], pepper="p")
    hits = await gdpr_service.search_subjects(CY, "ΣΥΝΘΕΤΙΚΟΥ")
    cy_hit = [h for h in hits if str(h["id"]).startswith("cy:")]
    assert len(cy_hit) == 1 and cy_hit[0]["name"] == "ΑΝΔΡΕΑΣ ΣΥΝΘΕΤΙΚΟΥ"
    assert await gdpr_service.search_subjects(GR, "ΣΥΝΘΕΤΙΚΟΥ") == [], "άλλο φαρμακείο δεν βρίσκει τίποτα"

    bundle = await gdpr_service.export_subject(CY, cy_hit[0]["id"])
    assert bundle["counts"]["dispensings"] == 1 and bundle["identity"]["full_name"] == "ΑΝΔΡΕΑΣ ΣΥΝΘΕΤΙΚΟΥ"

    res = await gdpr_service.erase_subject(CY, cy_hit[0]["id"], reason="test")
    assert res["legal_hold_kept"] == ["cy_dispensings"]
    p = await mem["cy_patients"].find_one({})
    assert p["erased"] is True and "full_name" not in p and "dob" not in p
    assert await mem["cy_dispensings"].count_documents({}) == 1, "οι εκτελέσεις μένουν (νόμιμη διατήρηση)"


def test_cypriot_mobile_is_normalized():
    from app.services.comms import _normalize
    assert _normalize("99123456") == "35799123456"
    assert _normalize("6912345678") == "306912345678", "η ελληνική κανονικοποίηση δεν αλλάζει"
    assert _normalize("22123456") == "22123456", "σταθερό Κύπρου: ανέγγιχτο"


# ── Βήμα 4: γιατροί, υπάλληλοι, αναλώσιμα, ανάκληση παρτίδας ─────────────────

async def test_doctors_staff_consumables_recall(mem):
    from datetime import date

    from app.services.cy import insights
    from app.services.cy.importer import import_files
    await import_files(CY, [("a.xml", DRUG_XML.encode()), ("b.xml", CONS_XML.encode())], pepper="p")
    today = date(2026, 11, 20)

    d = await insights.doctors(CY, days=365, today=today)
    by = {x["doctor_id"]: x for x in d["items"]}
    assert by["D9001"]["name"] == "ΑΝΤΡΗ ΙΑΤΡΟΥ" and by["D9001"]["total_cents"] == 2442
    assert by["D9003"]["patients"] == 1 and round(sum(x["share_pct"] for x in d["items"])) == 100
    assert d["items"][0]["doctor_id"] == "D9001", "ταξινόμηση κατά αξία"

    s = await insights.staff(CY, days=365, today=today)
    assert s["items"][0]["username"] == "demo.user" and s["items"][0]["dispensings"] == 2
    assert s["items"][0]["lines"] == 5

    c = await insights.consumables(CY, today=today)
    assert c["summary"] == {"patients": 1, "diabetic": 1, "late": 1}, "αναλώσιμα από τον Ιούλιο, 1/3 → χάθηκε"
    assert {i["code"] for i in c["items"]} == {"82224638", "90002453"}

    r = await insights.recall(CY, lot="A0C140")
    assert r["patients"] == 1 and r["packs"] == 1 and r["items"][0]["expiry"] == "2028-03-31"
    assert r["items"][0]["patient_name"] == "ΑΝΔΡΕΑΣ ΣΥΝΘΕΤΙΚΟΥ"
    assert (await insights.recall(CY, lot="A0C140", gtin="00000000000000"))["items"] == []
    assert (await insights.recall(GR, lot="A0C140"))["items"] == [], "άλλο φαρμακείο δεν βλέπει τίποτα"
    assert (await insights.recall(CY, lot=""))["items"] == []


# ── Η ελληνική πύλη πελατών δεν βλέπει ΠΟΤΕ κυπριακό φαρμακείο ─────────────────

async def test_greek_portal_never_lists_or_links_cyprus(mem, monkeypatch):
    from app.repositories import patient_portal as pp
    from app.services import auth_service

    async def _mods(tid):
        return {"patient_portal": "enabled"}
    monkeypatch.setattr(auth_service, "resolve_tenant_modules", _mods)
    monkeypatch.setattr(auth_service, "tenant_has", lambda mods, m: mods.get(m) == "enabled")
    await mem["tenants"].update_many({}, {"$set": {"status": "active"}})
    repo = pp.PatientAccountRepository()
    ids = {p["tenant_id"] for p in await repo.directory()}
    assert GR in ids and CY not in ids, "κυπριακό φαρμακείο στον κατάλογο της ελληνικής πύλης"
    assert await repo.pharmacy_has_portal(GR) is True
    assert await repo.pharmacy_has_portal(CY) is False
    for flt in (pp.GREEK_PORTAL,):
        assert await mem["tenants"].count_documents(flt) == 1


# ── Βήμα 5: κυπριακοί λογαριασμοί πύλης (πρόσκληση από φαρμακείο) ─────────────

async def _portal_setup(mem, monkeypatch):
    from app.services import auth_service, patient_auth_service
    from app.services.cy import gate
    from app.services.cy.importer import import_files
    from app.services.vault_service import vault

    async def _mods(tid):
        return {"patient_portal": "enabled"}

    async def _sent(self, email, phone, pw, invite_from=None):
        return [{"channel": "email"}]
    monkeypatch.setattr(auth_service, "resolve_tenant_modules", _mods)
    monkeypatch.setattr(auth_service, "tenant_has", lambda mods, m: mods.get(m) == "enabled")
    monkeypatch.setattr(patient_auth_service.PatientAuthService, "_send_credentials", _sent)
    monkeypatch.setattr(vault, "tenant_pepper", lambda tid: "p")
    await gate.set_cy_enabled(True)
    await import_files(CY, [("a.xml", DRUG_XML.encode())], pepper="p")
    return (await mem["cy_patients"].find_one({}))["pseudo_id"]


class _Ctx:
    def __init__(self, tenant_id, perms=("*",)):
        self.tenant_id, self.permissions, self.user_id = tenant_id, list(perms), "u1"


async def test_cy_portal_invite_verifies_identity_and_links(mem, monkeypatch):
    from app.api.v1.routers import cy as cy_router
    from app.repositories.patient_portal import PatientAccountRepository
    ref = await _portal_setup(mem, monkeypatch)
    p = await mem["cy_patients"].find_one({"pseudo_id": ref})
    assert p.get("id_ref") and p["id_ref"] != ref, "ψευδώνυμο ταυτότητας ΧΩΡΙΣΤΟ από το κλειδί ΟΑΥ"
    assert "0000999001" not in repr(p), "η ταυτότητα δεν αποθηκεύεται"

    Inv = cy_router.PortalInviteIn
    bad = await cy_router.portal_invite(ref, Inv(doc_type="NID", doc_number="12345", email="a@b.cy"), _Ctx(CY))
    assert bad == {"ok": False, "error": "id_mismatch"}, "λάθος ταυτότητα → καμία πρόσκληση"
    arc = await cy_router.portal_invite(ref, Inv(doc_type="ARC", doc_number="0000999001", email="a@b.cy"), _Ctx(CY))
    assert arc["error"] == "id_mismatch", "ίδιος αριθμός σε άλλο έγγραφο = άλλος άνθρωπος"
    ok = await cy_router.portal_invite(ref, Inv(doc_type="NID", doc_number="0000 999001", email="A@B.cy"), _Ctx(CY))
    assert ok["ok"] is True, ok
    acc = await mem["patient_accounts"].find_one({"email": "a@b.cy"})
    assert acc["country"] == "CY" and acc["amka"] == "" and acc["first_name"] == "ΑΝΔΡΕΑΣ"
    repo = PatientAccountRepository()
    assert (await repo.cy_account_for(CY, ref))["_id"] == acc["_id"]
    link = await mem["patient_links"].find_one({"account_id": acc["_id"]})
    assert link["tenant_id"] == CY
    assert await repo.cy_pseudo_of(CY, link["patient_ref"]) == ref
    again = await cy_router.portal_invite(ref, Inv(doc_type="NID", doc_number="999001", email="x@y.cy"), _Ctx(CY))
    assert again["error"] == "already_invited"
    # η ελληνική ροή: κενό ΑΜΚΑ δεν «βρίσκει» λογαριασμό
    assert await repo.get_by_amka("") is None
    # χωρίς δικαίωμα πύλης → 403
    import pytest as _pt
    from fastapi import HTTPException
    with _pt.raises(HTTPException):
        await cy_router.portal_invite(ref, Inv(doc_type="NID", doc_number="999001", email="z@y.cy"), _Ctx(CY, perms=()))


async def test_cy_portal_customer_side(mem, monkeypatch):
    from fastapi import HTTPException

    from app.api.v1.routers import cy as cy_router
    from app.api.v1.routers import patient as pr
    from app.core.deps import PatientContext
    ref = await _portal_setup(mem, monkeypatch)
    await cy_router.portal_invite(ref, cy_router.PortalInviteIn(doc_type="NID", doc_number="999001", email="c@d.cy"), _Ctx(CY))
    acc = await mem["patient_accounts"].find_one({"email": "c@d.cy"})
    link = await mem["patient_links"].find_one({"account_id": acc["_id"]})
    ctx = PatientContext(account_id=str(acc["_id"]), tenant_id=CY, patient_ref=str(link["patient_ref"]))

    # ΙΔΙΑ endpoints & σχήματα με την ελληνική πύλη (Αρχική/Συνταγές/Επαναλήψεις/Ανεκτέλεστα)
    rx = (await pr.my_prescriptions(ctx=ctx))["items"]
    assert len(rx) == 1 and rx[0]["barcode"] == "22222222" and rx[0]["medicines"][0].startswith("JIVOLAR")
    assert rx[0]["repeat_current"] == 6 and rx[0]["next_open_date"] is None, "6/6 → καμία επόμενη"
    assert {"patient_share", "partial", "pending", "tenant_id", "pharmacy_name"} <= set(rx[0])
    assert (await pr.my_repeats(for_ref=None, ctx=ctx))["items"] == []
    assert (await pr.my_renewals(for_ref=None, tenant_id=None, ctx=ctx))["items"] == []
    # ίδια συνταγή, νέα (2/6) εκτέλεση πριν 25 ημέρες → αναμένεται σε 3 → Επαναλήψεις + Ανεκτέλεστα
    from datetime import datetime, timedelta

    from app.services.cy.importer import import_files
    ts = (datetime.now() - timedelta(days=25)).strftime("%Y-%m-%d 10:00:00 +0200")
    x = (DRUG_XML.replace("<PrescriptionId>11111111", "<PrescriptionId>R77").replace("<DispensingId>22222222", "<DispensingId>D77")
         .replace("2026-11-17 09:05:18 +0200", ts).replace("<CurrentDispInstance>6<", "<CurrentDispInstance>2<"))
    await import_files(CY, [("b.xml", x.encode())], pepper="p")
    rx = (await pr.my_prescriptions(ctx=ctx))["items"]
    assert [r["barcode"] for r in rx] == ["22222222", "D77"], "νεότερη πρώτη (17/11 πριν από πριν-25-ημέρες)"
    assert rx[1]["next_open_date"] and rx[1]["repeat_root"] == "R77"
    rep = (await pr.my_repeats(for_ref=None, ctx=ctx))["items"]
    assert [r["barcode"] for r in rep] == ["R77"] and rep[0]["medicines"][0]["dosage"]
    ren = (await pr.my_renewals(for_ref=None, tenant_id=None, ctx=ctx))["items"]
    assert [r["key"] for r in ren] == ["R77"] and ren[0]["intent"] is None
    await pr.respond_renewal(pr.RenewalRespondIn(key="R77", decision="take", visit_date="2026-12-01"), ctx=ctx)
    ren = (await pr.my_renewals(for_ref=None, tenant_id=None, ctx=ctx))["items"]
    assert ren[0]["intent"]["decision"] == "take", "«θα το πάρω» φαίνεται ξανά"
    # βίντεο οδηγιών: ο κατάλογος έχει EAN-13, το ΓεΣΥ GTIN-14 με «0» μπροστά → ίδιο είδος
    await mem["pharmacy_products"].insert_one({"tenant_id": CY, "barcode": "5290931041882",
                                               "usage_video_url": "https://youtu.be/abc"})
    det = await pr.prescription_detail("D77", tenant_id=None, for_ref=None, ctx=ctx)
    assert det["amount_total"] > 0 and det["items"][0]["is_executed"] and det["icd10"] == []
    assert det["items"][0]["barcode"] == "05290931041882"
    assert det["items"][0]["usage_video_url"] == "https://youtu.be/abc", "βίντεο παρά τη διαφορετική μορφή barcode"
    assert (await pr.prescription_detail("R77", tenant_id=None, for_ref=None, ctx=ctx))["barcode"] == "D77", \
        "από τις Επαναλήψεις (αρ. συνταγής) → η τελευταία εκτέλεση"
    s = await pr.my_summary(for_ref=None, ctx=ctx)
    assert s["rx_count"] == 2 and s["repeats_active"] == 1 and s["covered_cents"] + s["paid_cents"] <= s["total_cents"]
    # αιτήματα (ραντεβού/διαθεσιμότητα) ΜΟΝΟ στο δικό του φαρμακείο
    try:
        await pr._target(ctx, GR)
        raise AssertionError("κυπριακός λογαριασμός έστειλε αίτημα σε ελληνικό φαρμακείο")
    except HTTPException as exc:
        assert exc.status_code == 404
    assert (await pr._target(ctx, None))[0] == CY
    assert (await pr.nearby(37.9, 23.7, ctx))["items"] == []
    d = await pr.pharmacies_directory(ctx)
    assert [i["tenant_id"] for i in d["items"]] == [CY]
    # ελληνικός λογαριασμός → το κυπριακό endpoint δεν υπάρχει (404, ποτέ 403)
    await mem["patient_accounts"].insert_one({"email": "gr@x.gr", "amka": "12345678901"})
    gr = await mem["patient_accounts"].find_one({"email": "gr@x.gr"})
    gctx = PatientContext(account_id=str(gr["_id"]), tenant_id=GR, patient_ref="x")
    assert await pr._cy_pseudo(gctx, GR, "x") is None, "ελληνικός λογαριασμός → ελληνικός δρόμος, ανέγγιχτος"


# ── Ομοιότητα με την Ελλάδα: Dashboard, εκτελέσεις, πελάτες, γιατρός, Εικόνα Πελάτη ─────────

async def _parity_seed():
    from app.services.cy.importer import import_files
    files = [
        ("1", _rx("P1", "E1", "N-A", "2026-09-01 10:00:00 +0300", 1)),
        ("2", _rx("P1", "E2", "N-A", "2026-09-29 11:00:00 +0300", 2)),
        ("3", _rx("P1", "E3", "N-A", "2026-10-27 12:00:00 +0200", 3)),
        ("4", _rx("P2", "E4", "N-B", "2026-11-02 09:00:00 +0200", 1)),
    ]
    await import_files(CY, files, pepper="p")


async def test_dashboard_summary_lists_and_doctor(mem):
    from datetime import date

    from app.services.cy import analytics
    await _parity_seed()
    s = await analytics.summary(CY, date(2026, 9, 1), date(2026, 11, 18))
    assert s["executions"] == 4 and s["patient_count"] == 2 and s["prescriptions"] == 2
    assert s["value"] > 0 and s["hio"] + s["beneficiary"] == s["value"]
    # το «έως» ΔΕΝ περιλαμβάνεται (σύμβαση κοινού φίλτρου)
    assert (await analytics.summary(CY, date(2026, 9, 1), date(2026, 11, 2)))["executions"] == 3

    lst = await analytics.dispensings(CY, q="", page_size=2)
    assert lst["total"] == 4 and len(lst["items"]) == 2
    assert lst["items"][0]["dispensed_at"] >= lst["items"][1]["dispensed_at"], "νεότερη πρώτα"
    one = await analytics.dispensing(CY, "E2")
    assert [p["dispensing_id"] for p in one["phases"]] == ["E1", "E2", "E3"]
    assert one["chain"]["status"] in ("soon", "upcoming", "late", "lost")
    assert "national_id" not in repr(one) and "0000999001" not in repr(one)

    pats = await analytics.patients(CY)
    assert pats["total"] == 2 and pats["items"][0]["value"] >= pats["items"][1]["value"]
    name = pats["items"][0]["full_name"]
    assert (await analytics.patients(CY, q=name.split()[0][:3]))["total"] >= 1

    did = one["doctor"]["id"]
    d = await analytics.doctor(CY, did, today=date(2026, 11, 17))
    assert d["totals"]["executions"] == 4 and len(d["patients"]) == 2
    assert len(d["monthly"]) == 12 and sum(m["executions"] for m in d["monthly"]) == 4
    assert await analytics.doctor(CY, "NOPE") is None


async def test_patient_card_has_greek_style_profile(mem):
    from datetime import date

    from app.services.cy import insights
    await _parity_seed()
    pats = await mem["cy_patients"].find({}).to_list(None)
    card = None
    for p in pats:
        c = await insights.patient_card(CY, p["pseudo_id"], today=date(2026, 11, 17))
        if c["kpis"]["visits"] == 3:
            card = c
    assert card, "ο πελάτης με τις 3 εκτελέσεις"
    k = card["kpis"]
    assert k["ltv"] == card["totals"]["total"] and k["gap_days"] == 21 and k["rank"]["of"] == 2
    assert len(card["monthly"]) == 12 and card["monthly"][-1]["month"] == "2026-11"
    assert sum(m["visits"] for m in card["monthly"]) == 3
    # 3 φάσεις στην ώρα τους → πλήρης συμμόρφωση
    assert card["adherence"]["compliance"] == 100 and card["adherence"]["missed"] == 0
    assert card["medicines"][0]["times"] == 3


def test_adherence_counts_missed_phases_only_after_lost_margin():
    from datetime import date, datetime

    from app.services.cy import chains
    tz = chains.TZ
    c = {"instances": 6, "first_instance": 1, "instance": 1, "visits": 1, "interval_days": 28,
         "first_at": datetime(2026, 8, 1, 10, tzinfo=tz), "status": "lost", "value_at_stake_cents": 500,
         "next_due": "2026-08-29"}
    # 1/8 → σήμερα 17/11: πέρασαν 108 ημέρες· οι φάσεις 2,3,4 έπρεπε να έχουν γίνει (με περιθώριο 14)
    a = chains.adherence([c], date(2026, 11, 17))
    assert a["missed"] == 3 and a["compliance"] == 25 and a["lost_value_cents"] == 500
    # μόλις έληξε η 2η φάση, χωρίς να περάσει το περιθώριο → τίποτα δεν χάθηκε ακόμη
    assert chains.adherence([c], date(2026, 9, 10))["missed"] == 0


# ── Φάση Α: επικοινωνία, συγκατάθεση, καμπάνιες, ειδοποιήσεις, πιστότητα ─────────────────────

async def test_contact_validation_and_consent_rules(mem):
    from app.services.cy import contacts
    await _parity_seed()
    ref = (await mem["cy_patients"].find_one({}))["pseudo_id"]
    import pytest as _pt
    with _pt.raises(ValueError):
        await contacts.set_contact(CY, ref, {"mobile": "12345"}, source="pharmacist")
    with _pt.raises(ValueError):
        await contacts.set_contact(CY, ref, {"email": "όχι-email"}, source="pharmacist")
    c = await contacts.set_contact(CY, ref, {"mobile": "99 123456", "email": "A@B.cy"}, source="pharmacist")
    assert c["mobile"] == "35799123456" and c["email"] == "a@b.cy"
    assert not c.get("marketing_consent"), "η συγκατάθεση ΔΕΝ δίνεται σιωπηρά"
    c = await contacts.set_contact(CY, ref, {"marketing_consent": True}, source="pharmacist")
    assert c["marketing_consent"] and c["consent_at"] and c["mobile"] == "35799123456", "μερική αλλαγή κρατά τα υπόλοιπα"
    assert await contacts.set_contact(CY, "nope", {"email": "x@y.cy"}, source="pharmacist") is None


async def test_audience_respects_consent_unsubscribe_and_prefs(mem):
    from app.services import notify_prefs, unsubscribe
    from app.services.cy import contacts
    from app.services.vault_service import vault
    await _parity_seed()
    refs = [p["pseudo_id"] for p in await mem["cy_patients"].find({}).to_list(None)]
    a, b = refs
    await contacts.set_contact(CY, a, {"mobile": "99111111", "email": "a@x.cy", "marketing_consent": True}, source="pharmacist")
    await contacts.set_contact(CY, b, {"mobile": "99222222"}, source="pharmacist")   # χωρίς συγκατάθεση
    aud = await contacts.audience(CY, "sms", "all")
    assert [r["patient_id"] for r in aud["recipients"]] == [f"cy:{a}"] and aud["excluded"]["no_consent"] == 1
    assert aud["recipients"][0]["mobile"] == "35799111111"
    assert (await contacts.audience(CY, "viber", "all"))["recipients"], "ίδιο κινητό για Viber"
    # ο πελάτης έκλεισε τα SMS από την πύλη → εξαιρείται ΚΑΙ μπλοκάρεται στην αποστολή
    await mem["cy_patients"].update_one({"pseudo_id": a}, {"$set": {"notify_prefs": {"sms": False}}})
    assert (await contacts.audience(CY, "sms", "all"))["excluded"]["channel_off"] == 1
    assert await notify_prefs.allows_patient(CY, f"cy:{a}", "sms", "campaign") is False
    assert await notify_prefs.allows_patient(CY, f"cy:{a}", "email", "campaign") is True
    assert await notify_prefs.allows_patient(CY, f"cy:{a}", "sms", "order") is True, "τα απαραίτητα φεύγουν πάντα"
    # «δεν θέλω άλλα» από τον σύνδεσμο του email
    import types
    vault_pepper = vault.tenant_pepper
    try:
        vault.tenant_pepper = types.MethodType(lambda self, tid: "p", vault)
        tok = unsubscribe.make_token(CY, f"cy:{a}")
        assert (await unsubscribe.describe(tok))["already"] is False
        assert (await unsubscribe.apply(tok, scope="all"))["ok"]
        assert (await unsubscribe.describe(tok))["already"] is True
    finally:
        vault.tenant_pepper = vault_pepper
    assert (await contacts.audience(CY, "email", "all"))["recipients"] == []
    # κοινά από συνταγές = δεδομένα υγείας
    assert contacts.clinical("late") and contacts.clinical("diabetic") and not contacts.clinical("all")


async def test_campaign_engine_uses_cyprus_audience(mem, monkeypatch):
    from app.services import campaign_engine
    from app.services.cy import contacts
    await _parity_seed()
    ref = (await mem["cy_patients"].find_one({}))["pseudo_id"]
    await contacts.set_contact(CY, ref, {"email": "a@x.cy", "marketing_consent": True}, source="pharmacist")
    res = await campaign_engine.create(CY, channel="email", message="Γεια {first}", subject="Θέμα",
                                       segment="all", value=None, by="u1")
    assert res["recipients"] == 1
    r = await mem["comm_recipients"].find_one({})
    assert r["patient_ref"] == f"cy:{ref}" and r["to"] == "a@x.cy"
    import pytest as _pt
    with _pt.raises(ValueError):   # ελληνικό segment σε κυπριακό φαρμακείο → καμία αποστολή
        await campaign_engine.create(CY, channel="sms", message="x", subject=None, segment="icd", value="E11", by="u1")


async def test_router_campaign_blocks_offer_to_clinical_audience(mem, monkeypatch):
    from fastapi import HTTPException

    from app.api.v1.routers import cy as cy_router
    await _parity_seed()
    import pytest as _pt
    with _pt.raises(HTTPException) as e:
        await cy_router.campaign_send(cy_router.CyCampaignIn(channel="sms", segment="late", message="Προσφορά -20%"), _Ctx(CY))
    assert e.value.detail == "clinical_segment_requires_care_purpose"
    with _pt.raises(HTTPException):
        await cy_router.campaign_send(cy_router.CyCampaignIn(channel="sms", segment="all", message="abc"), _Ctx(CY, perms=()))


async def test_portal_profile_syncs_to_cyprus_card_and_prefs(mem, monkeypatch):
    from app.api.v1.routers import cy as cy_router
    from app.services import notify_prefs
    from app.services.patient_contact_sync import sync_from_account
    ref = await _portal_setup(mem, monkeypatch)
    await cy_router.portal_invite(ref, cy_router.PortalInviteIn(doc_type="NID", doc_number="999001", email="c@d.cy", phone="99887766"), _Ctx(CY))
    p = await mem["cy_patients"].find_one({"pseudo_id": ref})
    assert p["contact"]["email"] == "c@d.cy" and p["contact"]["mobile"] == "35799887766"
    assert not p["contact"].get("marketing_consent"), "η πρόσκληση δεν δίνει συγκατάθεση"
    acc = await mem["patient_accounts"].find_one({"email": "c@d.cy"})
    await mem["patient_accounts"].update_one({"_id": acc["_id"]}, {"$set": {"phone": "99000111"}})
    assert (await sync_from_account(acc["_id"]))["synced"] == 1
    assert (await mem["cy_patients"].find_one({"pseudo_id": ref}))["contact"]["mobile"] == "35799000111"
    await notify_prefs.set_for_account(acc["_id"], {"push": False})
    assert (await mem["cy_patients"].find_one({"pseudo_id": ref}))["notify_prefs"]["push"] is False
    assert await mem["patient_contacts"].count_documents({}) == 0, "τίποτα στις ελληνικές καρτέλες"


async def test_next_step_push_once_per_phase(mem, monkeypatch):
    from datetime import date

    from app.api.v1.routers import cy as cy_router
    from app.services import push_service
    from app.services.cy import reminders
    from app.services.cy.importer import import_files
    ref = await _portal_setup(mem, monkeypatch)
    await import_files(CY, [("b.xml", _rx("RX9", "DX9", "0000999001", "2026-10-20 10:00:00 +0300", 2))], pepper="p")
    await mem["cy_dispensings"].update_many({"prescription_id": "RX9"}, {"$set": {"patient_ref": ref}})
    await cy_router.portal_invite(ref, cy_router.PortalInviteIn(doc_type="NID", doc_number="999001", email="c@d.cy"), _Ctx(CY))
    sent = []

    async def _push(account_id, *, title, body, url="/portal", kind="update"):
        sent.append((title, body, kind))
        return 1
    monkeypatch.setattr(push_service, "send_to_account", _push)
    # 20/10 + 28 = 17/11 → στις 16/11 είναι 1 ημέρα πριν
    r = await reminders.next_step_pushes(today=date(2026, 11, 16))
    assert r["sent"] == 1 and "3/6" in sent[0][1] and "17/11" in sent[0][1] and sent[0][2] == "reminder"
    again = await reminders.next_step_pushes(today=date(2026, 11, 17))
    assert again["sent"] == 0, "μία φορά ανά φάση"


async def test_loyalty_points_from_cyprus_dispensings(mem, monkeypatch):
    from app.api.v1.routers import cy as cy_router
    from app.repositories.loyalty import LoyaltyRepository
    from app.repositories.patient_portal import PatientAccountRepository
    from app.services import auth_service
    from app.services.cy.importer import import_files
    await _parity_seed()

    async def _mods(tid):
        return {"loyalty": "enabled"}
    monkeypatch.setattr(auth_service, "resolve_tenant_modules", _mods)
    monkeypatch.setattr(auth_service, "tenant_has", lambda mods, m: mods.get(m) == "enabled")
    ref = None
    for p in await mem["cy_patients"].find({}).to_list(None):
        if await mem["cy_dispensings"].count_documents({"patient_ref": p["pseudo_id"]}) == 3:
            ref = p["pseudo_id"]
    res = await cy_router.patient_loyalty(ref, cy_router.LoyaltyIn(enroll=True), _Ctx(CY))
    assert res["loyalty"]["enrolled"] and res["loyalty"]["points"] == 0, "οι παλιές εκτελέσεις δεν μετράνε"
    # νέα εκτέλεση ΜΕΤΑ την εγγραφή → πόντοι
    from datetime import datetime, timedelta, timezone
    now = (datetime.now(timezone.utc) + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S +0000")
    await import_files(CY, [("n.xml", _rx("P1", "E9", "N-A", now, 4))], pepper="p")
    shell = await PatientAccountRepository().cy_shell_id(CY, ref)
    m = await LoyaltyRepository(tenant_id=CY).member(str(shell))
    cfg = await LoyaltyRepository(tenant_id=CY).config()
    assert m["refills"] == 1 and m["points"] == cfg["points_per_refill"]
    assert m["compliance"] is not None
    assert await mem["executions"].count_documents({}) == 0
    # η αποσύνδεση από την πύλη ΔΕΝ σβήνει καρτέλα που κρατά πόντους
    assert await PatientAccountRepository()._loyalty_member(CY, shell)


async def test_gdpr_erase_removes_contact(mem):
    from app.services.cy import contacts, gdpr
    await _parity_seed()
    ref = (await mem["cy_patients"].find_one({}))["pseudo_id"]
    await contacts.set_contact(CY, ref, {"email": "a@x.cy", "marketing_consent": True}, source="pharmacist")
    await gdpr.erase(CY, f"cy:{ref}")
    p = await mem["cy_patients"].find_one({"pseudo_id": ref})
    assert "contact" not in p and p["erased"]
    aud = await contacts.audience(CY, "email", "all")
    assert aud["recipients"] == [] and aud["candidates"] == 1, "ο διαγραμμένος δεν είναι καν υποψήφιος"


# ── Φάση Β: αυτόματη λήψη XML από την υπηρεσία των Windows (Partner API) ─────────────────────

def _req(body: bytes, ctype: str = "application/xml"):
    from starlette.requests import Request

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}
    return Request({"type": "http", "method": "POST", "path": "/v1/cy/dispensings",
                    "headers": [(b"content-type", ctype.encode())]}, receive)


async def test_partner_cy_dispensings_imports_and_is_idempotent(mem, monkeypatch):
    from fastapi import HTTPException

    from app.api.partner import v1
    from app.api.partner.deps import PartnerContext
    from app.services.cy import gate
    from app.services.vault_service import vault
    monkeypatch.setattr(vault, "tenant_pepper", lambda tid: "p")
    await gate.set_cy_enabled(True)
    ctx = PartnerContext(tenant_id=CY, key_id="k", key_name="win", scopes=["gesy_xml:write"])
    r = await v1.cy_dispensings(_req(DRUG_XML.encode()), ctx)
    assert r["imported"] == 1 and r["failed"] == 0
    again = await v1.cy_dispensings(_req(DRUG_XML.encode()), ctx)
    assert again["imported"] == 0 and again["duplicates"] == 1, "η επανάληψη είναι ασφαλής"
    bad = await v1.cy_dispensings(_req(b"<Dispensing>"), ctx)
    assert bad["failed"] == 1 and bad["errors"]
    import pytest as _pt
    with _pt.raises(HTTPException) as e:   # ελληνικό φαρμακείο → 404, τίποτα δεν γράφεται
        await v1.cy_dispensings(_req(DRUG_XML.encode()), PartnerContext(tenant_id=GR, key_id="k", key_name="x"))
    assert e.value.status_code == 404
    with _pt.raises(HTTPException) as e:
        await v1.cy_dispensings(_req(b"  "), ctx)
    assert e.value.status_code == 400
    assert await mem["cy_dispensings"].count_documents({"tenant_id": GR}) == 0


def test_api_key_scopes_are_per_country():
    from app.services import api_keys
    assert "gesy_xml:write" in api_keys.scopes_for("CY") and "gesy_xml:write" not in api_keys.scopes_for("GR")
    assert "patients:read" not in api_keys.scopes_for("CY"), "χωρίς ΑΜΚΑ δεν υπάρχει σύνδεση πελάτη"
    assert set(api_keys.scopes_for("GR")) | {"gesy_xml:write"} == set(api_keys.SCOPES)


# ── Φάση Γ: κανόνες αλυσίδων από το adminpanel (χωρίς νέα έκδοση) ──────────────────────────

async def test_chain_rules_are_configurable_and_bounded(mem):
    from datetime import date

    from app.services.cy import chains, gate
    from app.services.cy.importer import import_files
    await import_files(CY, [("a", _rx("RZ", "DZ", "N-Z", "2026-09-01 10:00:00 +0300", 2))], pepper="p")
    today = date(2026, 10, 20)   # αναμενόταν 29/09 → 21 ημέρες καθυστέρηση
    assert (await chains.chains(CY, today=today))[0]["status"] == "lost"
    await gate.set_cy_rules({"lost_after_days": 30})
    c = (await chains.chains(CY, today=today))[0]
    assert c["status"] == "late" and c["lost_after_days"] == 30
    assert chains.adherence([c], today)["missed"] == 0, "η συμμόρφωση ακολουθεί το ίδιο όριο"
    import pytest as _pt
    with _pt.raises(ValueError):
        await gate.set_cy_rules({"lost_after_days": 500})
    with _pt.raises(ValueError):
        await gate.set_cy_rules({"bogus": 3})
    assert (await gate.cy_rules())["lost_after_days"] == 30, "λάθος τιμή → τίποτα δεν αποθηκεύεται"


# ── Φάση Δ: Προχορηγήσεις (δανεικά) Κύπρου ─────────────────────────────────────────────────

def test_gtin13_equivalence():
    from app.services.cy.loans import gtin13
    assert gtin13("05290000000001") == gtin13("5290000000001") == "5290000000001"
    assert gtin13("") is None and gtin13("abc") is None


async def test_cy_loans_suggest_but_never_auto_clear(mem):
    from datetime import datetime, timedelta, timezone

    from app.services.cy import loans
    from app.services.cy.importer import import_files
    await _parity_seed()
    pats = await mem["cy_patients"].find({}).to_list(None)
    a, b = pats[0]["pseudo_id"], pats[1]["pseudo_id"]
    line = (await mem["cy_dispensings"].find_one({"patient_ref": a}))["lines"][0]
    g = loans.gtin13(line.get("barcode") or (line.get("emvs") or [{}])[0].get("gtin"))
    import pytest as _pt
    with _pt.raises(ValueError):    # πελάτης ΠΑΝΤΑ από τη λίστα
        await loans.create(CY, patient_ref="nobody", items=[{"gtin": g}])
    r = await loans.create(CY, patient_ref=a, items=[{"gtin": g, "qty": 1}], by="u1")
    assert (await loans.listing(CY))[0]["items"][0]["name"], "όνομα από τα XML"
    assert await loans.suggestions(CY) == [], "καμία εκτέλεση μετά το δανεικό"
    # εκτέλεση του ΙΔΙΟΥ πελάτη μετά → πρόταση· ΑΛΛΟΥ πελάτη → τίποτα
    who = (await mem["cy_patients"].find_one({"pseudo_id": a}))
    nid = "N-A" if (await mem["cy_dispensings"].count_documents({"patient_ref": a})) == 3 else "N-B"
    later = (datetime.now(timezone.utc) + timedelta(minutes=5)).strftime("%Y-%m-%d %H:%M:%S +0000")
    await import_files(CY, [("x", _rx("PX", "EX", nid, later, 1))], pepper="p")
    s = await loans.suggestions(CY)
    assert len(s) == 1 and s[0]["loan_id"] == r["id"] and s[0]["dispensing_id"] == "EX", (who, s)
    ln = (await loans.listing(CY))[0]
    assert ln["items"][0]["status"] == "open", "ΠΟΤΕ αυτόματη ξεχρέωση"
    assert (await loans.set_item(CY, r["id"], 0, cleared=True, dispensing_id="EX", by="u1"))["status"] == "closed"
    assert await loans.suggestions(CY) == []
    assert (await loans.listing(CY, status="closed"))[0]["open_items"] == 0
    assert b != a


async def test_reorder_expected_missed_and_stock(mem):
    from datetime import date

    from app.services.cy import insights
    from app.services.cy.importer import import_files
    await import_files(CY, [("a", _rx("RR", "DR", "N-R", "2026-11-01 10:00:00 +0200", 2))], pepper="p")
    line = (await mem["cy_dispensings"].find_one({"dispensing_id": "DR"}))["lines"][0]
    r = await insights.reorder(CY, horizon=14, today=date(2026, 11, 20))   # αναμένεται 29/11 → μέσα
    it = next(i for i in r["items"] if i["key"] == (line.get("barcode") or line.get("code")))
    assert it["expected"] == line["qty_presc"] and it["patients"] == 1 and it["stock"] is None
    await mem["pharmacy_products"].insert_one({"tenant_id": CY, "barcode": line["barcode"], "stock_qty": 50})
    it = next(i for i in (await insights.reorder(CY, today=date(2026, 11, 20)))["items"] if i["barcode"] == line["barcode"])
    assert it["stock"] == 50 and it["suggested"] == 0
    short = await insights.reorder(CY, horizon=3, today=date(2026, 11, 20))   # 29/11 είναι σε 9 ημέρες → εκτός
    assert all(i["expected"] == 0 for i in short["items"])


async def test_profitability_net_of_vat_and_coverage(mem):
    from datetime import date

    from app.services.cy import analytics
    await _parity_seed()
    r = await analytics.profitability(CY, date(2026, 1, 1), date(2027, 1, 1))
    assert r["totals"]["coverage_pct"] == 0 and r["totals"]["profit"] == 0 and r["missing_cost"] == len(r["items"])
    it = r["items"][0]
    assert it["revenue_net"] == round(it["revenue"] / 1.05), "φάρμακα: ΦΠΑ Κύπρου 5%"
    await mem["pharmacy_products"].insert_one({"tenant_id": CY, "barcode": it["barcode"], "wholesale_cents": 100})
    r2 = await analytics.profitability(CY, date(2026, 1, 1), date(2027, 1, 1))
    it2 = next(i for i in r2["items"] if i["barcode"] == it["barcode"])
    assert it2["cost"] == 100 * it2["units"] and it2["profit"] == it2["revenue_net"] - it2["cost"]
    assert 0 < r2["totals"]["coverage_pct"] <= 100


async def test_release_notes_are_per_country(mem):
    from app.services import release_notes as rn
    await mem["release_notes"].insert_one({"_id": "1.70.0", "vsort": "0001.0070.0000", "published": True,
                                            "items": [{"title": "Από την ΗΔΥΚΑ"}]})   # παλιά, χωρίς χώρα
    await rn.upsert("1.72.0", title="ΓεΣΥ", items=[{"title": "Καμπάνιες"}], published=True, country="CY")
    await rn.upsert("1.73.0", title="Όλοι", items=[{"title": "Connect"}], published=True, country="ALL")
    gr = [i["version"] for i in (await rn.for_tenant(GR))["items"]]
    cy = [i["version"] for i in (await rn.for_tenant(CY))["items"]]
    assert gr == ["1.73.0", "1.70.0"], "ο Έλληνας δεν βλέπει κυπριακές σημειώσεις"
    assert cy == ["1.73.0", "1.72.0"], "ο Κύπριος δεν βλέπει τις παλιές ελληνικές (ΗΔΥΚΑ)"
    assert (await rn.mark_seen(CY))["last_version"] == "1.73.0"


# ── Πρόγραμμα λήψης (πύλη) & Patient Intelligence ─────────────────────────────────────────────

def test_cy_dosage_becomes_intake_plan():
    from app.services.cy.meds import plan_for
    assert plan_for(2.0)["slots"] == ["morning", "evening"]
    assert plan_for(1.0, "AFTER DINNER")["slots"] == ["evening"], "«μετά το δείπνο» = βραδινή δόση"
    assert plan_for(1.0, "AFTER BREAKFAST")["slots"] == ["morning"]
    assert plan_for(3.0)["per_day"] == 3
    assert plan_for(None)["kind"] == "unknown", "χωρίς συχνότητα: καμία μαντεψιά"
    assert plan_for(2 / 7)["kind"] == "weekly" and plan_for(2 / 7)["times_per_week"] == 2


async def test_cy_portal_medication_schedule_and_reminder_account(mem, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from app.api.v1.routers import cy as cy_router
    from app.repositories.patient_portal import PatientAccountRepository, PatientRxRepository
    from app.workers.reminders import _account_for
    ref = await _portal_setup(mem, monkeypatch)
    await mem["cy_dispensings"].update_many(
        {}, {"$set": {"dispensed_at": datetime.now(timezone.utc) - timedelta(days=3)}})
    await cy_router.portal_invite(ref, cy_router.PortalInviteIn(doc_type="NID", doc_number="999001", email="c@d.cy"), _Ctx(CY))
    accrepo = PatientAccountRepository()
    shell = await accrepo.cy_shell_id(CY, ref)
    rx = PatientRxRepository(tenant_id=CY)
    s = await rx.medication_schedule(str(shell))
    assert s["country"] == "CY"
    names = {t["name"]: t for t in s["therapies"]}
    assert "JIVOLAR TABLET, FILM COATED 50MG/850MG" in names
    jiv = names["JIVOLAR TABLET, FILM COATED 50MG/850MG"]
    assert jiv["med_key"].startswith("cy:") and jiv["per_day"] == 2 and jiv["days_left"] is not None
    assert all(t["name"] and "lancet" not in t["name"].lower() for t in s["therapies"]), "όχι αναλώσιμα"
    # ο ασθενής ανάβει υπενθύμιση → το ημερολόγιο γεμίζει, και ο worker βρίσκει τον λογαριασμό χωρίς ΑΜΚΑ
    await rx.set_reminder(str(shell), jiv["med_key"], True)
    s = await rx.medication_schedule(str(shell))
    assert any(d["slots"] for d in s["week"])
    acc = await _account_for(mem, accrepo, shell, CY)
    assert acc and acc.get("email") == "c@d.cy"
    # παλιά εκτέλεση (πέρασε η διάρκεια) → δεν είναι ενεργή αγωγή
    await mem["cy_dispensings"].update_many(
        {}, {"$set": {"dispensed_at": datetime.now(timezone.utc) - timedelta(days=120)}})
    assert (await rx.medication_schedule(str(shell)))["therapies"] == []



# ── Patient Intelligence: ΙΔΙΕΣ οθόνες με την Ελλάδα, δεδομένα ΓεΣΥ ─────────────────────────────

async def _pi_seed(mem):
    from datetime import datetime, timedelta, timezone

    from app.services.cy.importer import import_files
    now = datetime.now(timezone.utc)
    ts = lambda d: (now - timedelta(days=d)).strftime("%Y-%m-%d %H:%M:%S +0000")  # noqa: E731
    # Α: φάση 2/6 πριν 25 ημ. → η 3η έρχεται σύντομα (διαθέσιμη)· Β: φάση 1/6 πριν 120 ημ. → χάθηκε
    await import_files(CY, [("a1", _rx("PA", "DA1", "N-A", ts(53), 1)), ("a2", _rx("PA", "DA2", "N-A", ts(25), 2)),
                            ("b1", _rx("PB", "DB1", "N-B", ts(120), 1))], pepper="p")
    a = (await mem["cy_dispensings"].find_one({"dispensing_id": "DA2"}))["patient_ref"]
    b = (await mem["cy_dispensings"].find_one({"dispensing_id": "DB1"}))["patient_ref"]
    return a, b


async def test_cy_patient_intelligence_reuses_greek_views(mem):
    from app.repositories.cy_intelligence import CyPatientIntelligenceRepository
    a, b = await _pi_seed(mem)
    repo = CyPatientIntelligenceRepository(tenant_id=CY)
    ov = await repo.overview()
    assert ov["total_patients"] == 2 and ov["kpis"]["recall_patients"]["value"] == 2
    assert ov["trend"]["monthly"] and sum(x["rx"] for x in ov["trend"]["monthly"]) == 3
    comp = await repo.compliance()
    by = {x["patient_id"]: x for x in comp["items"]}
    assert by[a]["compliance"] == 100 and by[b]["missed"] >= 1 and by[b]["compliance"] < 50
    rec = await repo.recall()
    assert {x["patient_id"] for x in rec["items"]} == {a, b}
    assert next(x for x in rec["items"] if x["patient_id"] == a)["available"] == 1
    det = await repo.recall_detail(b)
    assert det["found"] and det["chains"][0]["missed"] >= 1 and det["chains"][0]["windows"]
    risk = await repo.risk()
    assert any(x["patient_id"] == b for x in risk["items"])
    vip = await repo.vip()
    assert vip["total"] == 2 and {x["patient_id"] for x in vip["items"]} == {a, b}
    wb = await repo.winback()
    assert any(x["patient_id"] == b for x in wb["items"]), "λείπει 120 ημέρες → Win-Back"
    pt = await repo.patients_table()
    assert pt["total"] == 2 and all(x["amka"] for x in pt["items"]), "ο κωδικός ΟΑΥ στη θέση του ΑΜΚΑ"
    td = await repo.today()
    assert td["rx"] == 0 and td["expected_absent"] == 2
    seg = await repo.segments()
    assert seg["segments"][0]["key"] == "diabetes"


async def test_cy_patient_360_found_by_id_or_prescription(mem, monkeypatch):
    from app.repositories.cy_intelligence import CyPatientIntelligenceRepository
    from app.services.vault_service import vault
    monkeypatch.setattr(vault, "tenant_pepper", lambda tid: "p")
    from app.services.cy.importer import import_files
    await import_files(CY, [("a.xml", DRUG_XML.encode())], pepper="p")
    ref = (await mem["cy_patients"].find_one({}))["pseudo_id"]
    repo = CyPatientIntelligenceRepository(tenant_id=CY)
    assert await repo.find_patient(amka="999 001") == ref, "αριθμός ταυτότητας (ψευδωνυμοποιείται, δεν αποθηκεύεται)"
    assert await repo.find_patient(amka="900001") == ref, "κωδικός ΟΑΥ"
    rx = (await mem["cy_dispensings"].find_one({}))["prescription_id"]
    assert await repo.find_patient(barcode=rx) == ref and await repo.find_patient(amka=rx) == ref
    assert await repo.find_patient(amka="123456") is None
    prof = await repo.patient_profile(amka="999001")
    assert prof["found"] and prof["country"] == "CY" and prof["patient"]["amka"] == "900001"
    assert prof["financials"]["rx_count"] == 1 and prof["medicines"] and prof["executions"][0]["cy_id"]
    assert prof["conditions"] == [], "το XML ΓεΣΥ δεν έχει διαγνώσεις — καμία επινόηση"
    assert (await repo.patient_profile(amka="nobody"))["found"] is False


async def test_greek_only_profile_endpoints_404_for_cyprus(mem):
    from fastapi import HTTPException

    from app.api.v1.routers import patient_intelligence as pi
    from app.services.cy import gate
    await gate.set_cy_enabled(True)
    with pytest.raises(HTTPException) as e:
        await pi._greek_only(_Ctx(CY))
    assert e.value.status_code == 404
    await pi._greek_only(_Ctx(GR))   # ελληνικό φαρμακείο: περνά


async def test_cyprus_release_notes_have_their_own_numbering(mem):
    from app.services import release_notes as rn
    await rn.upsert("1.0.0", title="GR", items=[{"title": "ελληνικό"}], published=True, country="GR")
    await rn.upsert("1.0.0", title="CY", items=[{"title": "κυπριακό"}], published=True, country="CY")
    gr = await rn.for_tenant(GR)
    cy = await rn.for_tenant(CY)
    assert [n["title"] for n in gr["items"]] == ["GR"] and [n["title"] for n in cy["items"]] == ["CY"]
    assert cy["items"][0]["version"] == "1.0.0", "ο Κύπριος βλέπει σκέτο «1.0.0», όχι «CY:1.0.0»"
    assert {(n["country"], n["version"]) for n in await rn.admin_list()} >= {("GR", "1.0.0"), ("CY", "1.0.0")}
    await rn.delete("1.0.0", "CY")
    assert (await rn.for_tenant(CY))["items"] == [] and (await rn.for_tenant(GR))["items"]


# ── PharmacyOne: εκτελέσεις + κατάλογος ειδών (ψεύτικος server — καμία πραγματική κλήση) ────────

def _p1_client(handler):
    import httpx
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_pharmacyone_executions_paged_into_importer(mem, monkeypatch):
    import httpx

    from app.services.cy import pharmacyone as p1
    from app.services.vault_service import vault
    monkeypatch.setattr(vault, "tenant_pepper", lambda tid: "p")
    p1.set_client_id(CY, "6a3e3d2c6b5b700aa9af18e7")
    seen = []

    def handler(req: httpx.Request):
        assert req.headers["X-Client-Id"] == "6a3e3d2c6b5b700aa9af18e7"
        seen.append(dict(req.url.params))
        if "cursor" not in req.url.params:
            return httpx.Response(200, json={"executions": [{"id": "e1", "xml": DRUG_XML, "filename": "a.xml"},
                                                            {"id": "e2", "xml": None}],
                                             "count": 2, "has_more": True, "next_cursor": "C2", "total": 3})
        return httpx.Response(200, json={"executions": [{"id": "e3", "xml": CONS_XML}], "count": 1,
                                         "has_more": False, "next_cursor": None})
    async with _p1_client(handler) as c:
        r = await p1.sync_executions(CY, client=c)
    assert r["ok"] and r["fetched"] == 3 and r["imported"] == 2 and r["no_xml"] == 1 and r["full"]
    assert seen[0]["status"] == "Sent,Resent" and seen[0]["order"] == "asc" and seen[0]["include_xml"] == "true"
    assert "date_from" not in seen[0], "πρώτη φορά: όλο το ιστορικό"
    assert await mem["cy_dispensings"].count_documents({"tenant_id": CY}) == 2
    seen.clear()
    async with _p1_client(handler) as c:
        r2 = await p1.sync_executions(CY, client=c)
    assert "date_from" in seen[0], "μετά: μόνο το πρόσφατο παράθυρο"
    assert r2["imported"] == 0 and r2["duplicates"] == 2, "καμία διπλή μέτρηση"


async def test_pharmacyone_401_is_not_retried(mem):
    import httpx

    from app.services.cy import pharmacyone as p1
    p1.set_client_id(CY, "6a3e3d2c6b5b700aa9af18e7")
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(401, json={"detail": "unknown client"})
    async with _p1_client(handler) as c:
        with pytest.raises(p1.PharmacyOneError) as e:
            await p1.sync_executions(CY, client=c)
    assert e.value.code == "unauthorized" and len(calls) == 1
    assert (await p1.state(CY))["last_result"]["ok"] is False
    assert not p1.valid_client_id("not-an-id") and p1.hint("6a3e3d2c6b5b700aa9af18e7") == "••••18e7"


async def test_pharmacyone_items_master_and_cyprus_catalog(mem):
    import httpx

    from app.services import catalog_sync
    from app.services.cy import pharmacyone as p1
    p1.set_client_id(CY, "6a3e3d2c6b5b700aa9af18e7")
    items = [{"id": "i1", "name": "PANADOL 500MG", "barcodes": ["5290000000011"], "drug_code": "D1",
              "retail_price": "4.20", "wh_price": "3.10", "vat": "5", "update_date": "2026-11-01 10:00:00"},
             {"id": "i2", "name": "SUN CREAM 50", "barcodes": ["5290000000028"], "retail_price": 12.5,
              "vat": 0.19, "update_date": "2026-11-01 10:00:00"},
             {"id": "i3", "name": "NO BARCODE", "barcodes": []}]

    def handler(req):
        return httpx.Response(200, json={"items": items, "count": len(items), "has_more": False, "next_cursor": None})
    async with _p1_client(handler) as c:
        r = await p1.sync_items(full=True, client=c)
    assert r["upserted"] == 3 and r["total_active"] == 3
    rx = p1.to_product(items[0])
    assert rx["type"] == "rx_medicine" and rx["price_cents"] == 420 and rx["wholesale_cents"] == 310 and rx["vat_rate"] == 5
    para = p1.to_product(items[1])
    assert para["type"] == "parapharmacy" and para["price_cents"] == 1250 and para["vat_rate"] == 19
    assert p1.to_product(items[2]) is None
    # ελληνικός «κύριος» κατάλογος με ΠΕΡΙΣΣΟΤΕΡΑ είδη: ΠΟΤΕ δεν περνά σε κυπριακό φαρμακείο
    await mem["pharmacy_products"].insert_many([{"tenant_id": GR, "barcode": f"280{i}", "name": f"GR {i}",
                                                 "type": "parapharmacy", "price_cents": 100} for i in range(5)])
    await mem["tenants"].update_one({"_id": CY}, {"$set": {"catalog_sync.types": ["rx_medicine", "parapharmacy"]}})
    res = await catalog_sync.run_for_tenant(CY)
    names = {p["name"] async for p in mem["pharmacy_products"].find({"tenant_id": CY})}
    assert res["added"] == 2 and names == {"PANADOL 500MG", "SUN CREAM 50"}
    assert await catalog_sync.master_tenant(mem) == GR
    # το είδος χάθηκε από την πηγή (συγχωνεύτηκε) → το πλήρες πέρασμα το απενεργοποιεί
    items.pop(1)
    async with _p1_client(handler) as c:
        r = await p1.sync_items(full=True, client=c)
    assert r["deactivated"] == 1


# ── Ελλάδα ↔ Κύπρος: ΚΑΜΙΑ ανταλλαγή ειδών, τιμών ή μελών δικτύου (μόνιμοι φρουροί) ─────────────

async def test_no_catalog_or_network_crosses_greece_cyprus(mem):
    from fastapi import HTTPException

    from app.api.v1.routers import admin
    from app.services import catalog_sync, parapharmacy_classifier, pharmacy_directory
    from app.services.ingestion.hdika_catalog import apply_rx_prices
    # το κυπριακό φαρμακείο έχει τα ΠΕΡΙΣΣΟΤΕΡΑ είδη — και πάλι δεν γίνεται ποτέ «κύριος» κατάλογος
    await mem["pharmacy_products"].insert_many(
        [{"tenant_id": CY, "barcode": f"529{i}", "name": f"CY {i}", "type": "rx_medicine", "price_cents": 500}
         for i in range(5)] + [{"tenant_id": GR, "barcode": "2801", "name": "GR", "type": "rx_medicine", "price_cents": 100}])
    assert await catalog_sync.master_tenant(mem) == GR
    assert await admin._master_catalog(mem) == GR
    # κρατικές τιμές ΗΔΥΚΑ: ΠΟΤΕ σε κυπριακή αποθήκη (ακόμη κι αν ταιριάζει barcode)
    await mem["medicine_catalog"].insert_one({"barcode": "5290", "retail_cents": 999, "wholesale_cents": 800})
    await apply_rx_prices(mem)
    assert (await mem["pharmacy_products"].find_one({"tenant_id": CY, "barcode": "5290"}))["price_cents"] == 500
    # ο ελληνικός έτοιμος κατάλογος δεν φορτώνεται σε κυπριακό φαρμακείο
    with pytest.raises(HTTPException) as e:
        await admin._not_cyprus_target(CY)
    assert e.value.detail == "cyprus_uses_pharmacyone"
    await admin._not_cyprus_target(GR)
    assert CY not in await parapharmacy_classifier._tenant_ids()
    # δίκτυα Connect / συνομιλία: μόνο μέσα στην ίδια χώρα
    assert (await pharmacy_directory.country_block(GR, CY))["error"] == "other_country"
    assert await pharmacy_directory.country_block(CY, CY) is None


async def test_catalog_settings_show_cyprus_source_not_greek(mem):
    from app.api.v1.routers import pharmacy_catalog as pc
    await mem["cy_catalog_items"].insert_one({"_id": "i1", "active": True, "raw": {"id": "i1"}})
    cy = await pc.catalog_sync_settings(_Ctx(CY))
    assert cy["country"] == "CY" and cy["source"]["name"] == "PharmacyOne" and cy["source"]["items"] == 1
    assert [a["label"] for a in cy["available"]] == ["Φάρμακα", "Παραφάρμακα"]
    gr = await pc.catalog_sync_settings(_Ctx(GR))
    assert gr["country"] == "GR" and "source" not in gr and len(gr["available"]) == 3


async def test_cy_catalog_real_item_shape_and_platform_id(mem):
    from app.services.cy import pharmacyone as p1
    # σχήμα όπως ήρθε από την PharmacyOne (18/11/2026)
    med = {"id": "m1", "drug_code": "1000005", "barcodes": [], "name": "TRIMETHOPRIM ORAL SUSPENSION",
           "supergroup": "MEDICINE", "vat": 5.0, "retail_price": 0.0, "wh_price": 0.0,
           "atc_layers": {"atc_category1": "Φάρμακα Κατά Των Λοιμώξεων"},
           "gesy": {"ATC": "J01EA01-1"}, "moh": {"retail_price": 34.01, "wholesale_price": 23.99}}
    non = {"id": "n1", "drug_code": "", "barcodes": ["4008600411574", "04008600411574"], "name": "Nuk Soother",
           "supergroup": "NON-MEDICINE", "vat": 19.0, "retail_price": 6.5, "wh_price": 3.9,
           "bus_category1": "Μητέρα & Παιδί", "brand": "NUK"}
    a = p1.to_product(med)
    assert a["type"] == "rx_medicine" and a["atc"] == "J01EA01" and a["barcode"] == "1000005"
    assert a["price_cents"] == 3401 and a["wholesale_cents"] == 2399, "τιμή μητρώου όταν η κύρια είναι 0"
    assert a["category"] == "Φάρμακα Κατά Των Λοιμώξεων"
    b = p1.to_product(non)
    assert b["type"] == "parapharmacy" and b["barcode"] == "4008600411574" and b["brand"] == "NUK" and b["atc"] is None
    assert b["category"] == "Μητέρα & Παιδί" and b["vat_rate"] == 19
    # Κλειδί εφαρμογής: κρυπτογραφημένο στη βάση, ποτέ σε καθαρό κείμενο· σβήνει το παλιό Client Id καταλόγου
    await mem["platform_settings"].update_one({"_id": "cy"}, {"$set": {"pharmacyone_client_id": "legacy"}}, upsert=True)
    await p1.set_api_key("APPKEY-12345-abcde-18e7")
    doc = await mem["platform_settings"].find_one({"_id": "cy"})
    assert doc["pharmacyone_api_key"].startswith("enc:") and "APPKEY" not in doc["pharmacyone_api_key"]
    assert await p1.api_key() == "APPKEY-12345-abcde-18e7" and doc["pharmacyone_client_id"] is None
    await mem["cy_catalog_items"].insert_many([{"_id": "m1", "active": True, "raw": med},
                                               {"_id": "n1", "active": True, "raw": non}])
    st = await p1.catalog_stats()
    assert st["configured"] and st["hint"] == "••••18e7" and st["medicine"] == 1 and st["non_medicine"] == 1 and st["with_atc"] == 1
    assert [i["name"] for i in await p1.search_items("nuk")] == ["Nuk Soother"]
    assert (await p1.search_items("1000005"))[0]["atc"] == "J01EA01"
    phs = await p1.pharmacies()
    assert [p["id"] for p in phs] == [CY], "μόνο κυπριακά φαρμακεία"


async def test_cy_catalog_photos_suppliers_and_category_tree(mem):
    from app.services import catalog_sync
    from app.services.cy import pharmacyone as p1
    raw = {"id": "n1", "barcodes": ["4008600411574"], "name": "Nuk Soother", "supergroup": "NON-MEDICINE",
           "source": "mefal", "vat": 19.0, "retail_price": 9.95, "wh_price": 6.43,
           "bus_category1": "Γονείς & Παιδί", "bus_category2": "Βρεφικά", "bus_category3": "Πιπίλες",
           "extra": {"image_url": "https://image.cloudon.gr/cy_images/4008600411574.jpg"},
           "mefal": {"code": "10023422", "wh_price": 6.43, "retail_price": 9.95, "stock": 0.0, "active": True},
           "blue": {"code": "77", "wh_price": 6.1, "retail_price": 9.5, "stock": 3.0, "active": True}}
    p = p1.to_product(raw)
    assert p["photo_url"].endswith("4008600411574.jpg") and p["supplier"] == "Mefal"
    assert {s["name"] for s in p["suppliers"]} == {"Mefal", "Blue"}
    assert next(s for s in p["suppliers"] if s["name"] == "Blue")["stock"] == 3
    assert p["cat_path"] == ["Γονείς & Παιδί", "Βρεφικά", "Πιπίλες"] and p["category"] == "Γονείς & Παιδί"
    await mem["cy_catalog_items"].insert_one({"_id": "n1", "active": True, "raw": raw})
    await mem["tenants"].update_one({"_id": CY}, {"$set": {"catalog_sync.types": ["parapharmacy"]}})
    r = await catalog_sync.run_for_tenant(CY)
    assert r["added"] == 1 and r["categories"]["assigned"] == 1
    prod = await mem["pharmacy_products"].find_one({"tenant_id": CY, "barcode": "4008600411574"})
    cats = {c["_id"]: c async for c in mem["pharmacy_categories"].find({"tenant_id": CY})}
    from bson import ObjectId
    names = [cats[ObjectId(prod[k])]["name"] for k in ("cat1_id", "cat2_id", "cat3_id")]
    assert names == ["Γονείς & Παιδί", "Βρεφικά", "Πιπίλες"] and prod["supplier"] == "Mefal"
    # ο φαρμακοποιός άλλαξε κατηγορία → η επόμενη ενημέρωση ΔΕΝ την πατά
    await mem["pharmacy_products"].update_one({"_id": prod["_id"]}, {"$set": {"cat1_id": "mine"}})
    await catalog_sync.run_for_tenant(CY, full=True)
    assert (await mem["pharmacy_products"].find_one({"_id": prod["_id"]}))["cat1_id"] == "mine"
    assert await catalog_sync.run_for_tenant(GR) != {}   # ελληνικό: άλλη πηγή, κανένα κυπριακό είδος
    assert await mem["pharmacy_products"].count_documents({"tenant_id": GR, "barcode": "4008600411574"}) == 0


async def test_catalog_sync_writes_only_differences(mem):
    from app.services import catalog_sync
    raw = {"id": "d1", "barcodes": ["5290000000035"], "name": "SOAP", "supergroup": "NON-MEDICINE",
           "retail_price": 2.0, "vat": 19.0, "bus_category1": "Σώμα"}
    await mem["cy_catalog_items"].insert_one({"_id": "d1", "active": True, "raw": raw})
    await mem["tenants"].update_one({"_id": CY}, {"$set": {"catalog_sync.types": ["parapharmacy"]}})
    assert (await catalog_sync.run_for_tenant(CY))["added"] == 1
    again = await catalog_sync.run_for_tenant(CY, full=True)
    assert again["updated"] == 0, "τίποτα δεν άλλαξε → καμία εγγραφή"
    assert await mem["catalog_sync_events"].count_documents({"tenant_id": CY, "kind": {"$ne": "added"}}) == 0
    # αλλάζει ΜΟΝΟ η φωτογραφία στην πηγή → γράφεται ΜΟΝΟ αυτό το είδος
    raw2 = {**raw, "extra": {"image_url": "https://image.cloudon.gr/cy_images/5290000000035.jpg"}}
    await mem["cy_catalog_items"].update_one({"_id": "d1"}, {"$set": {"raw": raw2}})
    r = await catalog_sync.run_for_tenant(CY, full=True)
    assert r["updated"] == 1
    p = await mem["pharmacy_products"].find_one({"tenant_id": CY, "barcode": "5290000000035"})
    assert p["photo_url"].endswith(".jpg")



async def test_pharmacyone_sends_app_key_and_client_id_only_for_executions(mem, monkeypatch):
    import httpx

    from app.services.cy import pharmacyone as p1
    from app.services.vault_service import vault
    monkeypatch.setattr(vault, "tenant_pepper", lambda tid: "p")
    await p1.set_api_key("APPKEY-12345-abcde")
    p1.set_client_id(CY, "000000000000000000c1d001")
    seen = {}

    def handler(req: httpx.Request):
        seen[req.url.path] = (req.headers.get("X-API-Key"), req.headers.get("X-Client-Id"))
        key = "executions" if req.url.path.endswith("/executions") else "items"
        return httpx.Response(200, json={key: [], "count": 0, "has_more": False, "next_cursor": None})
    async with _p1_client(handler) as c:
        await p1.sync_items(full=True, client=c)
        await p1.sync_executions(CY, client=c)
    assert seen["/external/v1/items"] == ("APPKEY-12345-abcde", None), "κατάλογος: μόνο κλειδί"
    assert seen["/external/v1/executions"] == ("APPKEY-12345-abcde", "000000000000000000c1d001")

    def h404(req):
        return httpx.Response(404, json={"detail": "unknown client"})
    async with _p1_client(h404) as c:
        with pytest.raises(p1.PharmacyOneError) as e:
            await p1.sync_executions(CY, client=c)
    assert e.value.code == "unknown_client_id"


def test_brand_is_always_text():
    from app.services.cy.pharmacyone import brand_of, to_product
    assert brand_of({"brand": {"brand_id": 7, "brand": "NUK"}}) == "NUK", "αντικείμενο → κείμενο (έριχνε την Αποθήκη)"
    assert brand_of({"brand": "Vichy "}) == "Vichy" and brand_of({"brand": None}) is None and brand_of({}) is None
    p = to_product({"id": "x", "barcodes": ["5290000000042"], "name": "X", "supergroup": "NON-MEDICINE",
                    "brand": {"brand_id": 1, "brand": "A-DERMA"}})
    assert p["brand"] == "A-DERMA"


async def test_cy_atc_matching_uses_only_product_catalogues(mem):
    from app.services.cy import atc_match
    from app.services.cy.pharmacyone import product_from_doc
    # ελληνικός ΔΗΜΟΣΙΟΣ κατάλογος (σκευάσματα)
    await mem["medicine_catalog"].insert_many([
        {"name": "DAONIL TAB 5MG", "substance_name": "GLIBENCLAMIDE", "atc": "A10BB01", "barcode": "2800000000011"},
        {"name": "LIPITOR TAB 20MG", "substance_name": "ATORVASTATIN", "atc": "C10AA05", "barcode": "2800000000028"},
        {"name": "AMBI A", "substance_name": "PARACETAMOL", "atc": "N02BE01"},
        {"name": "AMBI B", "substance_name": "PARACETAMOL,CAFFEINE", "atc": "N02BE51"}])
    gesy = {"_id": "g1", "active": True, "raw": {"id": "g1", "supergroup": "MEDICINE", "name": "PYRIDOSTIGMINE 60MG",
            "gesy": {"ATC": "N07AA02-1"}, "moh": {"ingredient": "PYRIDOSTIGMINE"},
            "atc_layers": {"atc_category1": "Νευρικό σύστημα", "atc_category2": "Παρασυμπαθομιμητικά"}}}
    items = [
        {"_id": "a", "raw": {"id": "a", "supergroup": "MEDICINE", "name": "MESTINON 60MG", "barcodes": ["5290000000101"],
                            "moh": {"ingredient": "PYRIDOSTIGMINE"}}},                        # ίδια δραστική (CY)
        {"_id": "b", "raw": {"id": "b", "supergroup": "MEDICINE", "name": "TORVA 20MG", "barcodes": ["5290000000102"],
                            "moh": {"ingredient": "ATORVASTATIN"}}},                          # δραστική (GR)
        {"_id": "c", "raw": {"id": "c", "supergroup": "MEDICINE", "name": "DAONIL TABLET 5MG", "barcodes": ["5290000000103"]}},  # μάρκα (GR)
        {"_id": "d", "raw": {"id": "d", "supergroup": "MEDICINE", "name": "XYZQ TABLET", "barcodes": ["5290000000104"]}},  # τίποτα
    ]
    await mem["cy_catalog_items"].insert_many([gesy] + [{**x, "active": True} for x in items])
    r = await atc_match.run(mem)
    assert r["gesy"] == 1 and r["cy_substance"] == 1 and r["gr_substance"] == 1 and r["gr_brand"] == 1 and r["unmatched"] == 1
    a = product_from_doc(await mem["cy_catalog_items"].find_one({"_id": "a"}))
    assert a["atc"] == "N07AA02" and a["atc_source"] == "cy_substance"
    assert a["cat_path"] == ["Νευρικό σύστημα", "Παρασυμπαθομιμητικά"], "ονομασία κατηγορίας της PharmacyOne"
    b = product_from_doc(await mem["cy_catalog_items"].find_one({"_id": "b"}))
    assert b["atc"] == "C10AA05" and b["atc_source"] == "gr_substance"
    assert product_from_doc(await mem["cy_catalog_items"].find_one({"_id": "d"}))["atc"] is None, "καμία μαντεψιά"
    assert (await atc_match.run(mem)).get("written", 0) == 0, "δεύτερο πέρασμα χωρίς αλλαγή → καμία εγγραφή"
    # παρακετομόλη: δύο ATC για «PARACETAMOL»+συνδυασμό → η μονή ουσία έχει ΕΝΑΝ → ταυτίζεται· ο συνδυασμός ξεχωριστά
    assert atc_match._one({"N02BE01"}) == "N02BE01" and atc_match._one({"A10BB01", "C10AA05"}) is None
    assert atc_match._one({"C09AA", "C09AA05"}) == "C09AA"


def test_atc_name_match_never_gives_one_substance_of_a_combination():
    from app.services.cy import atc_match
    idx = {"gr_bc": {}, "gr_brand": {}, "cy_sub": {}, "layers": {},
           "gr_sub": {"AMLODIPINE+HYDROCHLOROTHIAZIDE+VALSARTAN": {"C09DX01"}},
           "single": {"HYDROCHLOROTHIAZIDE": {"C03AA03"}, "VALSARTAN": {"C09CA03"}, "AMLODIPINE": {"C08CA01"}}}
    combo = {"name": "AMLODIPINE/VALSARTAN/HYDROCHLOROTHIAZIDE ELPEN TABLET", "barcodes": []}
    assert atc_match.match(combo, idx) == ("C09DX01", "name_substance"), "ο συνδυασμός, όχι το διουρητικό"
    del idx["gr_sub"]["AMLODIPINE+HYDROCHLOROTHIAZIDE+VALSARTAN"]
    assert atc_match.match(combo, idx) is None, "χωρίς γνωστό συνδυασμό → κανένας ATC (όχι λάθος)"
    assert atc_match.norm_substance("NIVOLUMAB\nRELATLIMAB") == atc_match.norm_substance("RELATLIMAB | NIVOLUMAB")


# ── Φάση 1: ATC στις εκτελέσεις · θεραπευτικό προφίλ · πρόγραμμα/συνέπεια · διατροφή ─────────────

async def _phase1_seed(mem, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from app.services.cy import atc_link
    from app.services.cy.importer import import_files
    from app.services.vault_service import vault
    monkeypatch.setattr(vault, "tenant_pepper", lambda tid: "p")
    atc_link.reset()
    await mem["cy_catalog_items"].insert_many([
        {"_id": "jiv", "active": True, "raw": {"id": "jiv", "supergroup": "MEDICINE", "drug_code": "41M0186",
         "name": "JIVOLAR", "barcodes": [], "gesy": {"ATC": "A10BD07-1"},
         "atc_layers": {"atc_category1": "Πεπτική Οδός και Μεταβολισμός", "atc_category2": "Αντιδιαβητικά"}}},
        {"_id": "clo", "active": True, "raw": {"id": "clo", "supergroup": "MEDICINE", "drug_code": "C555003",
         "name": "CLOPIDOGREL", "barcodes": [], "gesy": {"ATC": "B01AC04-1"}}}])
    now = datetime.now(timezone.utc)
    ts = lambda d: (now - timedelta(days=d)).strftime("%Y-%m-%d %H:%M:%S +0000")  # noqa: E731
    x1 = DRUG_XML.replace("2026-11-17 09:05:18 +0200", ts(30)).replace("<CurrentDispInstance>6<", "<CurrentDispInstance>1<")
    x1 = x1.replace("<DispensingId>22222222", "<DispensingId>P1A")
    x2 = DRUG_XML.replace("2026-11-17 09:05:18 +0200", ts(2)).replace("<CurrentDispInstance>6<", "<CurrentDispInstance>2<")
    x2 = x2.replace("<DispensingId>22222222", "<DispensingId>P1B")
    await import_files(CY, [("a.xml", x1.encode()), ("b.xml", x2.encode())], pepper="p")
    return (await mem["cy_patients"].find_one({}))["pseudo_id"]


async def test_atc_link_line_codes_with_pack_suffix(mem, monkeypatch):
    from app.services.cy.atc_link import lookup
    await _phase1_seed(mem, monkeypatch)
    lk = await lookup()
    assert lk.for_line({"code": "41M0186/5"})["atc"] == "A10BD07", "η κατάληξη συσκευασίας «/5» αγνοείται"
    assert lk.for_line({"code": "ZZZ/1"}) is None


async def test_cy_patient_360_therapy_groups_and_segments(mem, monkeypatch):
    from app.repositories.cy_intelligence import CyPatientIntelligenceRepository
    await _phase1_seed(mem, monkeypatch)
    repo = CyPatientIntelligenceRepository(tenant_id=CY)
    prof = await repo.patient_profile(amka="999001")
    meds = {m["name"]: m for m in prof["medicines"]}
    assert meds["JIVOLAR TABLET, FILM COATED 50MG/850MG"]["atc"] == "A10BD07"
    assert {"diabetes", "cardio"} <= {s["key"] for s in prof["segments"]}
    groups = {c["code"]: c for c in prof["conditions"]}
    assert groups["A10B"]["title"] == "Αντιδιαβητικά" and prof["conditions_kind"] == "therapy_groups"
    seg = {s["key"]: s["patients"] for s in (await repo.segments())["segments"]}
    assert seg["diabetes"] == 1 and seg["cardio"] == 1 and seg["thyroid"] == 0


async def test_cy_med_schedule_adherence_and_nutrition_via_shell(mem, monkeypatch):
    from app.repositories.advisor import AdvisorRepository
    from app.repositories.patient_portal import PatientAccountRepository, PatientRxRepository
    ref = await _phase1_seed(mem, monkeypatch)
    shell = await PatientAccountRepository().cy_shell(CY, ref, "ΑΝΔΡΕΑΣ ΣΥΝΘΕΤΙΚΟΥ")
    rx = PatientRxRepository(tenant_id=CY)
    sched = await rx.medication_schedule(str(shell))
    jiv = next(t for t in sched["therapies"] if t["med_key"] == "cy:41M0186")
    assert jiv["atc"] == "A10BD07"
    adh = await rx.adherence(str(shell))
    assert adh["meds"]["cy:41M0186"]["status"] == "rated" and adh["meds"]["cy:41M0186"]["fills"] == 2
    assert adh["summary"] and adh["summary"]["rated"] >= 1
    await mem["cy_patients"].update_one({"pseudo_id": ref}, {"$set": {"contact": {"email": "a@b.cy"}}})
    plan = await AdvisorRepository(tenant_id=CY).nutrition_plan(str(shell))
    titles = {s["title"] for s in plan["sections"]}
    assert "Αντιδιαβητικά / Σακχαρώδης διαβήτης" in titles and plan["email"] == "a@b.cy"


# ── Φάση 2: PharmaCat · αλληλεπιδράσεις · αναζήτηση φαρμάκων Κύπρου · AI συμβουλή ──────────────────

def test_cy_substance_of_strips_strength_and_joins_combos():
    from app.services.cy.atc_link import substance_of
    assert substance_of({"moh": {"ingredient": "METFORMIN | SITAGLIPTIN"}}) == "METFORMIN + SITAGLIPTIN"
    assert substance_of({"gesy": {"ActiveIngedientsStrength": "TRIMETHOPRIM 10mg/ml"}}) == "TRIMETHOPRIM"
    assert substance_of({"gesy": {"ActiveIngedientsStrength": "HYDROCORTISONE 5.00 mg"}}) == "HYDROCORTISONE"
    assert substance_of({}) is None


async def test_cy_medicine_search_and_products_use_cyprus_catalogue_only(mem, monkeypatch):
    from app.repositories.pharmacat import PharmaCatRepository
    await _phase1_seed(mem, monkeypatch)
    await mem["cy_catalog_items"].update_one({"_id": "clo"}, {"$set": {"raw.moh": {"ingredient": "CLOPIDOGREL"}}})
    await mem["medicine_catalog"].insert_one({"_id": "gr1", "name": "PLAVIX", "substance_name": "CLOPIDOGREL",
                                              "atc": "B01AC04"})
    cy = PharmaCatRepository(tenant_id=CY)
    hits = (await cy.medicine_search("clopi"))["items"]
    assert [h["name"] for h in hits] == ["CLOPIDOGREL"] and hits[0]["atc"] == "B01AC04"
    prods = await cy.products_for([{"name": "Clopidogrel", "atc": "B01AC04"}])
    names = [p["name"] for g in prods for p in g["products"]]
    assert names == ["CLOPIDOGREL"], "ΠΟΤΕ ελληνικά εμπορικά (PLAVIX) σε κυπριακό φαρμακείο"
    info = await cy.medicine(prods[0]["products"][0]["eof"])
    assert info["ok"] and info["substance"] == "CLOPIDOGREL" and info["atc"] == "B01AC04"
    # το ελληνικό φαρμακείο ψάχνει ΜΟΝΟ στον ελληνικό κατάλογο
    gr_hits = (await PharmaCatRepository(tenant_id=GR).medicine_search("clopi"))["items"]
    assert "CLOPIDOGREL" not in [h["name"] for h in gr_hits]


async def test_pharmacat_knowledge_is_shared_unless_country_specific(mem, monkeypatch):
    """Οδηγία ιδιοκτήτη 18/11/2026: η κλινική βάση γνώσεων είναι ΚΟΙΝΗ (καμία πληροφορία ασθενή ή
    φαρμακείου)· τα σκευάσματα βγαίνουν πάντα από τον κατάλογο της χώρας. Χωριστή απάντηση μόνο όταν η
    αποθηκευμένη μιλά για φορείς της άλλης χώρας."""
    from app.repositories.pharmacat import PharmaCatRepository
    from app.services import ai_quota, pharmacat_service
    seen: list = []
    answer = {"reply": "Μέλι και ζεστά υγρά.", "substances": []}

    async def fake_ask(messages, context, tenant_id=None, **_):
        seen.append(dict(context or {}))
        return {"ok": True, **answer}

    async def ok(*a, **k):
        return True, 0, 99, None
    monkeypatch.setattr(pharmacat_service, "ask", fake_ask)
    monkeypatch.setattr(ai_quota, "check_and_consume", ok)
    msgs = [{"role": "user", "content": "Βήχας"}]
    gr = await PharmaCatRepository(tenant_id=GR)._cached_ask("u", msgs, None, kind="chat")
    cy = await PharmaCatRepository(tenant_id=CY)._cached_ask("u", msgs, None, kind="chat")
    assert gr["source"] == "llm" and cy["source"] == "cache", "η Κύπρος παίρνει την ΚΟΙΝΗ απάντηση"
    assert gr["sig"] == cy["sig"] and len(seen) == 1

    # απάντηση με ελληνικό φορέα → η Κύπρος ΔΕΝ την παίρνει· νέα, κυπριακή, σε δική της θέση
    msgs2 = [{"role": "user", "content": "Πυρετός"}]
    answer["reply"] = "Δες το Δελτίο του ΕΟΦ."
    await PharmaCatRepository(tenant_id=GR)._cached_ask("u", msgs2, None, kind="chat")
    answer["reply"] = "Παρακεταμόλη."
    cy2 = await PharmaCatRepository(tenant_id=CY)._cached_ask("u", msgs2, None, kind="chat")
    assert cy2["source"] == "llm" and seen[-1].get("_country") == "CY"
    gr_again = await PharmaCatRepository(tenant_id=GR)._cached_ask("u", msgs2, None, kind="chat")
    assert gr_again["source"] == "cache" and "ΕΟΦ" in gr_again["reply"], "η ελληνική δεν πατήθηκε"
    cy_again = await PharmaCatRepository(tenant_id=CY)._cached_ask("u", msgs2, None, kind="chat")
    assert cy_again["source"] == "cache" and "ΕΟΦ" not in cy_again["reply"]


def test_cy_prompts_speak_of_cyprus_not_greece():
    from app.services import patient_advice, pharmacat_service
    assert "Κύπρο" in patient_advice.SYSTEM_CY and "στην Ελλάδα" not in patient_advice.SYSTEM_CY
    assert "ΚΥΠΡΟΥ" in pharmacat_service.CY_NOTE and "ΕΟΦ" in pharmacat_service.CY_NOTE   # «ΜΗΝ αναφέρεις ΕΟΦ»


async def test_cy_interactions_use_active_regimen_substances(mem, monkeypatch):
    from app.repositories.pharmacat import PharmaCatRepository
    ref = await _phase1_seed(mem, monkeypatch)
    await mem["cy_catalog_items"].update_one({"_id": "jiv"},
                                             {"$set": {"raw.moh": {"ingredient": "VILDAGLIPTIN,METFORMIN"}}})
    from app.services.cy import atc_link
    atc_link.reset()
    got: list = []

    async def fake_ddi(self, user, drugs, ctx):
        got.append(drugs)
        return {"ok": True, "interactions": [{"a": "METFORMIN", "b": "IBUPROFEN"}]}
    monkeypatch.setattr(PharmaCatRepository, "_ddi", fake_ddi)
    res = await PharmaCatRepository(tenant_id=CY).interactions_for_patient("u", patient_id=ref,
                                                                            added=["IBUPROFEN"])
    assert got and "VILDAGLIPTIN + METFORMIN" in got[0] and "IBUPROFEN" in got[0]
    assert res["interactions"][0]["involves_new"] is True


async def test_cy_ai_advice_signature_is_per_pharmacy(mem, monkeypatch):
    from app.repositories.cy_intelligence import CyPatientIntelligenceRepository
    ref = await _phase1_seed(mem, monkeypatch)
    pid, amka, sig = await CyPatientIntelligenceRepository(tenant_id=CY).advice_signature(patient_id=ref)
    assert pid == ref and amka is None, "ΚΑΝΕΝΑ καθολικό κλειδί → η συμβουλή μένει στο φαρμακείο"
    assert "A10B" in sig["conditions"] and sig["g6pd"] is False
    assert await CyPatientIntelligenceRepository(tenant_id=CY).advice_signature(patient_id="nope") == (None, None, None)


# ── Φάση 3: Marketing · θεραπευτικά κοινά · αυτοματισμοί ──────────────────────────────────────────

async def _phase3_seed(mem, monkeypatch):
    from app.services.cy import marketing as cy_marketing
    cy_marketing.reset()
    ref = await _phase1_seed(mem, monkeypatch)
    await mem["cy_patients"].update_one({"pseudo_id": ref}, {"$set": {"contact": {
        "mobile": "+35799123456", "email": "a@b.cy", "marketing_consent": True}}})
    return ref


async def test_cy_therapy_categories_from_gesy_dispensings(mem, monkeypatch):
    from app.services.cy import marketing as cy_marketing
    ref = await _phase3_seed(mem, monkeypatch)
    br = await cy_marketing.therapy_breakdown(CY)
    assert br["diabetes"]["patients"] == {ref} and br["cardio"]["patients"] == {ref}
    assert br["diabetes"]["value"] > 0 and br["thyroid"]["patients"] == set()
    sizes = {c["key"]: c for c in await cy_marketing.category_sizes(CY)}
    assert sizes["diabetes"]["patients"] == 1 and sizes["diabetes"]["reachable"] == 1
    assert await cy_marketing.therapy_breakdown(GR) == {k: {"patients": set(), "value": 0} for k in br}


async def test_cy_therapy_segment_is_care_only_and_reaches_consented(mem, monkeypatch):
    from app.services.cy import contacts as cy_contacts
    ref = await _phase3_seed(mem, monkeypatch)
    assert cy_contacts.clinical("therapy:diabetes") is True, "δεδομένα υγείας → μόνο φροντίδα"
    a = await cy_contacts.audience(CY, "sms", "therapy:diabetes")
    assert [r["patient_id"] for r in a["recipients"]] == ["cy:" + ref]
    assert (await cy_contacts.audience(CY, "sms", "therapy:thyroid"))["recipients"] == []
    with pytest.raises(ValueError):
        await cy_contacts.segment_refs(CY, "therapy:nope")


async def test_cy_marketing_dashboard_cards_open_cyprus_segments(mem, monkeypatch):
    from app.services.cy import marketing as cy_marketing
    await _phase3_seed(mem, monkeypatch)
    d = await cy_marketing.dashboard(CY)
    assert d["country"] == "CY" and {"performance", "categories", "suggestions", "campaigns", "totals"} <= set(d)
    from app.services.cy.contacts import SEGMENTS
    assert all(c["segment"] in SEGMENTS for c in d["suggestions"]), "κάθε κάρτα ανοίγει υπαρκτό κοινό Κύπρου"


async def test_campaign_only_ids_never_widens_to_all(mem, monkeypatch):
    """Αυτοματισμός = ένας άνθρωπος, ένα μήνυμα. Πριν (18/11/2026) η καμπάνια του αυτοματισμού
    κλείδωνε ΟΛΟΥΣ με συγκατάθεση (segment «all»)."""
    from app.services import campaign_engine, comms
    ref = await _phase3_seed(mem, monkeypatch)
    await mem["cy_patients"].insert_one({"tenant_id": CY, "pseudo_id": "other", "contact": {
        "mobile": "+35799000000", "marketing_consent": True}})
    res = await campaign_engine.create(CY, channel="sms", message="γεια", subject=None, segment="all",
                                       value=None, by="t", only_ids={"cy:" + ref})
    assert res["recipients"] == 1
    seen = {}

    async def fake_aud(tenant_id, channel, segment, value=None, only_ids=None):
        seen["only"] = only_ids
        return []
    monkeypatch.setattr(comms, "campaign_audience", fake_aud)
    await campaign_engine.create(GR, channel="sms", message="x", subject=None, segment="all", value=None,
                                 by="t", only_ids={"p1"})
    assert seen["only"] == {"p1"}, "και στην Ελλάδα περνά ο περιορισμός"


async def test_cy_automations_triggers_and_candidates(mem, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from app.services import automations
    from app.services.cy import marketing as cy_marketing
    ref = await _phase3_seed(mem, monkeypatch)
    bad = await automations.save(CY, {"trigger": "loyalty_points_over", "message": "x"})
    assert bad == {"ok": False, "error": "bad_trigger"}, "trigger χωρίς δεδομένα Κύπρου → απορρίπτεται"
    assert (await automations.save(CY, {"trigger": "inactive_days", "message": "x"}))["ok"]
    now = datetime.now(timezone.utc)
    await mem["cy_patients"].update_one({"pseudo_id": ref}, {"$set": {"last_seen": now - timedelta(days=90, hours=5)}})
    assert await cy_marketing.automation_candidates(CY, "inactive_days", 90) == {"cy:" + ref}
    assert await cy_marketing.automation_candidates(CY, "inactive_days", 30) == set(), "παράθυρο ΜΙΑΣ ημέρας"
    assert await cy_marketing.automation_candidates(CY, "first_visit", 7) == set(), "2 επισκέψεις ≠ πρώτη"


# ── Φάση 4α: Copilot & Ρουτίνες με δεδομένα ΓεΣΥ ──────────────────────────────────────────────────

async def test_cy_copilot_reads_gesy_data_only(mem, monkeypatch):
    from app.services import copilot_service as cs
    await _phase1_seed(mem, monkeypatch)
    k = await cs._read_tool("get_kpis", {"months_back": 2}, CY)
    assert k["kpis"]["executions"] == 2 and k["kpis"]["patient_count"] == 1
    top = await cs._read_tool("get_top", {"dim": "patients", "months_back": 2}, CY)
    assert top["items"][0]["name"] and top["items"][0]["rx"] == 2
    lst = await cs._read_tool("list_dispensings", {"months_back": 2}, CY)
    assert lst["total"] == 2 and {"εκτέλεση", "ΟΑΥ_€", "φάση"} <= set(lst["items"][0])
    op = await cs._read_tool("get_open_prescriptions", {}, CY)
    assert "counts" in op
    assert (await cs._read_tool("get_reimbursement", {}, CY)) == {"error": "unknown_tool"}, "ΕΟΠΥΥ ≠ Κύπρος"


def test_cy_copilot_tools_and_actions_are_cyprus_only():
    from app.services import copilot_service as cs
    from app.services.cy import copilot as cyc
    names = {t["name"] for t in cs._tools({"*"}, cy=True)}
    assert {"list_dispensings", "get_lost_customers", "get_import_status"} <= names
    assert not names & {"get_reimbursement", "get_reimbursement_risk", "list_prescriptions", "get_unexecuted"}
    assert set(cyc.server_actions()) == {"sync_pharmacyone", "answer_availability", "mark_pickup_ready"}
    for w in ("ΗΔΥΚΑ", "ΕΟΠΥΥ", "ICD"):
        assert "ΜΗΝ τα αναφέρεις" in cyc.SYSTEM and w in cyc.SYSTEM.split("ΜΗΝ τα αναφέρεις")[0]
    assert set(cyc.MESSAGE_SEGMENTS) == {"all", "recent", "inactive"}, "ρουτίνες: ΟΧΙ κλινικά κοινά"


def test_cy_routine_lists_match_frontend():
    import pathlib
    import re
    from app.services.cy import copilot as cyc
    src = (pathlib.Path(__file__).resolve().parents[2] / "frontend" / "src" / "app" / "(app)" / "copilot"
           / "routines" / "page.tsx").read_text(encoding="utf-8")
    block = src.split("const CY_REPORT_TOOLS")[1].split("];")[0]
    assert re.findall(r'\["(get_\w+|list_\w+)"', block) == list(cyc.REPORT_TOOLS)
    seg = src.split("const CY_SEGMENTS")[1].split("];")[0]
    assert re.findall(r'\["(\w+)"', seg) == list(cyc.MESSAGE_SEGMENTS)


async def test_cy_routines_validate_against_cyprus_catalog(mem, monkeypatch):
    from app.repositories.copilot_routines import CopilotRoutineRepository
    await _phase1_seed(mem, monkeypatch)
    repo = CopilotRoutineRepository(tenant_id=CY)
    sched = {"kind": "daily", "time": "09:00"}
    assert (await repo.create(user="u", name="r", schedule=sched, report_tool="get_lost_customers"))["ok"]
    assert (await repo.create(user="u", name="r", schedule=sched, report_tool="get_reimbursement"))["error"] == "unknown_report_tool"
    bad = await repo.create(user="u", name="m", schedule=sched, action="message", channel="sms",
                            message="x", segment="therapy:diabetes")
    assert bad["error"] == "bad_segment", "κλινικό κοινό ΔΕΝ μπαίνει σε ρουτίνα"
    gr = CopilotRoutineRepository(tenant_id=GR)
    assert (await gr.create(user="u", name="r", schedule=sched, report_tool="get_lost_customers"))["error"] == "unknown_report_tool"


async def test_cy_copilot_action_plan_shape(mem, monkeypatch):
    from app.services import copilot_service as cs
    await _phase1_seed(mem, monkeypatch)
    plan = await cs.build_action_plan(tenant_id=CY, perms={"*"})
    assert set(plan) == {"cards", "generated_at", "count"}
    assert all(c["action"]["kind"] == "navigate" for c in plan["cards"])


async def test_pharmacat_kb_stats_and_scope(mem, monkeypatch):
    from app.api.v1.routers.admin import _kb_scope, pharmacat_kb_stats
    from app.repositories.pharmacat import PharmaCatRepository, _sig
    from app.services import ai_quota, pharmacat_service

    async def fake_ask(messages, context, tenant_id=None, **_):
        return {"ok": True, "reply": "Ζεστά υγρά.", "substances": []}

    async def ok(*a, **k):
        return True, 0, 99, None
    monkeypatch.setattr(pharmacat_service, "ask", fake_ask)
    monkeypatch.setattr(ai_quota, "check_and_consume", ok)
    msgs = [{"role": "user", "content": "Βήχας"}]
    await PharmaCatRepository(tenant_id=GR)._cached_ask("u", msgs, None, kind="chat")
    await PharmaCatRepository(tenant_id=CY)._cached_ask("u", msgs, None, kind="chat")
    st = await pharmacat_kb_stats(days=30, _=None)
    assert st["questions"]["total"] == 2 and st["questions"]["cache"] == 1 and st["questions"]["hit_rate"] == 50
    assert st["questions"]["GR"] == 1 and st["questions"]["CY"] == 1
    assert st["entries"]["total"] == 1 and st["entries"]["scope"]["shared"] == 1
    assert st["top_period"][0]["n"] == 2 and st["top_period"][0]["query"] == "Βήχας"
    old_cy = {"sig": _sig(msgs, {"_country": "CY"}), "query": "Βήχας"}       # εγγραφή πριν το `scope`
    assert _kb_scope(old_cy) == "CY"


async def test_copilot_keeps_answer_written_before_tool_call(mem, monkeypatch):
    """18/11/2026: η λίστα γράφτηκε μαζί με το open_screen και το επόμενο βήμα έλεγε μόνο «Θέλεις
    λεπτομέρειες;» — κρατούσαμε μόνο το τελευταίο κείμενο και η απάντηση χανόταν (ΚΑΙ στην Ελλάδα)."""
    import types

    import anthropic

    from app.services import ai_cost, ai_quota, copilot_service as cs, pharmacat_service

    def blk(**kw):
        return types.SimpleNamespace(**kw)
    turns = [
        types.SimpleNamespace(stop_reason="tool_use", usage=None, content=[
            blk(type="text", text="1. ΓΙΑΤΡΟΣ Α — 3.693,94 €"),
            blk(type="tool_use", id="t1", name="open_screen", input={"href": "/cy/doctors", "label": "Γιατροί"})]),
        types.SimpleNamespace(stop_reason="end_turn", usage=None, content=[
            blk(type="text", text="Θέλεις λεπτομέρειες;")]),
    ]

    class FakeClient:
        def __init__(self, **_):
            self.messages = self

        async def create(self, **_):
            return turns.pop(0)

    async def cfg():
        return {"api_key": "k", "enabled": True, "model": "m"}

    async def ok(*a, **k):
        return True, 0, 99, None

    async def nop(*a, **k):
        return None
    monkeypatch.setattr(anthropic, "AsyncAnthropic", FakeClient)
    monkeypatch.setattr(pharmacat_service, "_config", cfg)
    monkeypatch.setattr(ai_quota, "check_and_consume", ok)
    monkeypatch.setattr(ai_cost, "record", nop)
    r = await cs.ask(tenant_id=GR, perms={"*"}, messages=[{"role": "user", "content": "top γιατροί"}])
    assert "ΓΙΑΤΡΟΣ Α" in r["reply"] and "Θέλεις λεπτομέρειες" in r["reply"]
    assert r["actions"][0]["href"] == "/cy/doctors"


# ── Φάση 4β: «Ο Σύμβουλός σου» με σήματα ΓεΣΥ ────────────────────────────────────────────────────

async def test_cy_coach_signals_links_and_voice(mem, monkeypatch):
    from app.repositories.cy_daily_coach import CyDailyCoachRepository, coach_for
    from app.repositories.daily_coach import DailyCoachRepository
    ref = await _phase1_seed(mem, monkeypatch)
    assert type(await coach_for(GR)) is DailyCoachRepository
    assert isinstance(await coach_for(CY), CyDailyCoachRepository)
    # η τελευταία εκτέλεση άφησε ένα είδος που δεν δόθηκε
    d = await mem["cy_dispensings"].find_one({"dispensing_id": "P1B"})
    lines = d["lines"]
    lines[0]["qty_disp"] = 0
    lines[0]["qty_presc"] = lines[0].get("qty_presc") or 1
    await mem["cy_dispensings"].update_one({"_id": d["_id"]}, {"$set": {"lines": lines}})
    repo = CyDailyCoachRepository(tenant_id=CY)
    today = await repo.build(user_name="Ανδρέας", persist=False)
    sigs = {i["signal"]: i for i in today["items"]}
    assert {"unexecuted", "no_contact"} <= set(sigs)
    un = sigs["unexecuted"]
    assert {"href": "/cy/dispensings/P1B", "kind": "rx", "label": "Η εκτέλεση"} in un["links"]
    assert any(lk["href"] == f"/intelligence/profile?patient_id={ref}" for lk in un["links"])
    assert "κλειδωμ" not in un["body"] and "ΗΔΥΚΑ" not in un["body"], "ΟΧΙ ελληνική νομοθεσία στην Κύπρο"
    assert sigs["no_contact"]["links"][-1]["href"] == "/cy/patients"
    cfg = await repo.settings()
    assert "vaccine_missed" not in cfg["labels"] and "advance_due" in cfg["labels"]
    assert set(cfg["signals"]) >= set(cfg["labels"]), "η αποθήκευση ρυθμίσεων δουλεύει"
    await repo.save_settings({"signals": {**cfg["signals"], "no_contact": False}})
    brief = await repo.patient_brief(ref)
    assert brief["found"] and {n["kind"] for n in brief["notes"]} >= {"unexecuted", "no_contact"}
    leak = await repo.leakage(6)
    assert leak["profit_known"] is False and leak["total"]["items_n"] >= 1


async def test_cy_coach_school_and_verify(mem, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from app.repositories.cy_daily_coach import CyDailyCoachRepository, school_for
    ref = await _phase1_seed(mem, monkeypatch)
    res = await (await school_for(CY)).build()
    assert {"items", "total", "patients", "money_cents"} <= set(res)
    assert all(c["id"] not in ("therapies", "vaccines") for c in res["items"])
    repo = CyDailyCoachRepository(tenant_id=CY)
    old = datetime.now(timezone.utc) - timedelta(days=40)
    assert await repo._verify({"signal": "lapsed_chronic", "subject": ref, "first_seen_at": old}) == "recovered"
    assert await repo._verify({"signal": "lapsed_chronic", "subject": ref,
                               "first_seen_at": datetime.now(timezone.utc)}) == "lost"


async def test_pharmacat_kb_sort_by_hits_ignores_closed_flags(mem):
    from app.api.v1.routers.admin import pharmacat_kb_list
    await mem["pharmacat_knowledge"].insert_many([
        {"sig": "a", "query": "παλιά σήμανση", "hits": 0, "flag_open": False, "result": {}},
        {"sig": "b", "query": "Βήχας", "hits": 63, "result": {}},
        {"sig": "c", "query": "Πονόλαιμος", "hits": 7, "result": {}}])
    r = await pharmacat_kb_list(q=None, flagged=False, page=1, page_size=10, sort="hits", _=None)
    assert [i["hits"] for i in r["items"]] == [63, 7, 0]


# ── Φάση 5: απαίτηση ΟΑΥ · σύγκριση προμηθευτών · «απεβίωσε» ─────────────────────────────────────

async def test_cy_hio_claim_month_totals_without_patient_data(mem, monkeypatch):
    from app.services.cy import insights
    await _phase1_seed(mem, monkeypatch)
    res = await insights.hio_claim(CY)
    total_hio = sum(m["hio"] for m in res["months"])
    assert sum(m["dispensings"] for m in res["months"]) == 2 and total_hio >= 0
    assert res["months"][0]["month"] >= res["months"][-1]["month"], "νεότερος μήνας πρώτα"
    for d in res["dispensings"]:
        assert not {"patient_ref", "patient_name", "hio_code"} & set(d), "ΚΑΝΕΝΑ στοιχείο πελάτη"


def test_cy_supplier_compare_cheapest_available_first():
    from app.services.cy.insights import compare_suppliers
    out = compare_suppliers([
        {"name": "A", "wholesale_cents": 900, "stock": 0},
        {"name": "B", "wholesale_cents": 1000, "stock": None},
        {"name": "C", "wholesale_cents": 950, "stock": 5},
        {"name": "D", "wholesale_cents": None, "stock": 9}])
    assert [x["name"] for x in out] == ["C", "B", "A"], "διαθέσιμος φθηνότερος πρώτα· χωρίς τιμή εκτός"
    assert out[-1]["available"] is False


async def test_cy_reorder_matches_warehouse_by_gesy_code_and_compares(mem, monkeypatch):
    from app.services.cy import insights
    await _phase1_seed(mem, monkeypatch)
    await mem["pharmacy_products"].insert_one({
        "tenant_id": CY, "name": "JIVOLAR", "drug_code": "41M0186", "stock_qty": 0,
        "suppliers": [{"name": "Mefal", "wholesale_cents": 2000, "stock": 3},
                      {"name": "Blue", "wholesale_cents": 1800, "stock": None}]})
    res = await insights.reorder(CY, horizon=60)
    jiv = next((i for i in res["items"] if (i.get("code") or "").startswith("41M0186")), None)
    assert jiv and jiv["suggested"] > 0, "το είδος βρέθηκε στην Αποθήκη με τον κωδικό ΓεΣΥ"
    assert jiv["best_supplier"] == "Blue" and jiv["saving_cents"] == 200 * jiv["suggested"]
    assert res["baskets"] and res["summary"]["with_suppliers"] >= 1


async def test_cy_deceased_is_excluded_everywhere_but_the_card(mem, monkeypatch):
    from app.services.cy import chains as ch
    from app.services.cy import contacts as cy_contacts
    from app.services.cy import marketing as cy_marketing
    ref = await _phase3_seed(mem, monkeypatch)
    assert (await cy_contacts.audience(CY, "sms", "all"))["recipients"]
    await mem["cy_patients"].update_one({"pseudo_id": ref}, {"$set": {"deceased": {"at": "2026-11-18"}}})
    cy_marketing.reset()
    assert (await cy_contacts.audience(CY, "sms", "all"))["recipients"] == [], "ΠΟΤΕ μήνυμα σε θανόντα"
    assert [c for c in await ch.chains(CY) if c["patient_ref"] == ref] == []
    assert await ch.chains(CY, match={"patient_ref": ref}), "η καρτέλα του τον δείχνει κανονικά"
    assert (await cy_marketing.therapy_breakdown(CY))["diabetes"]["patients"] == set()


async def test_cy_repeat_therapy_programs_from_gesy(mem, monkeypatch):
    from app.repositories.cy_programs import CyTherapyProgramRepository, programs_repo
    from app.repositories.vaccine_programs import VaccineProgramRepository
    ref = await _phase1_seed(mem, monkeypatch)
    assert type(await programs_repo(GR)) is VaccineProgramRepository
    repo = await programs_repo(CY)
    assert isinstance(repo, CyTherapyProgramRepository)
    prods = await repo.products(search="jivo")
    assert prods and prods[0]["eof_code"] == "41M0186" and prods[0]["atc"] == "A10BD07"
    prog = await repo.save({"name": "Jivolar", "eof_codes": ["41M0186"], "repeat_months": 1,
                            "repeat_from": "last", "doses_required": 1})
    res = await repo.patients_for(prog)
    assert res["total"] == 1 and res["items"][0]["patient_id"] == ref and res["items"][0]["doses"] == 2
    assert "amka" in res["items"][0] and await repo.list("therapy") and await repo.list("vaccine") == []
    cov = await repo.coverage_for_patient(prog, ref)
    assert cov and cov["doses"] == 2
    await mem["cy_patients"].update_one({"pseudo_id": ref}, {"$set": {"deceased": {"at": "x"}}})
    assert (await repo.patients_for(prog))["total"] == 0, "ΠΟΤΕ θανόντες"


def test_program_routes_open_with_either_addon():
    from app.api.v1.routers import vaccine_programs as vp
    assert set(vp._MODULE) == {"vaccination_programs", "therapy_programs"}


async def test_cy_families_and_care_on_gesy_data(mem, monkeypatch):
    from app.repositories.cy_groups import CyCareAccountRepository, CyPatientGroupRepository, search_patients
    from app.services.cy import group_lists as gl
    ref = await _phase1_seed(mem, monkeypatch)
    p = await mem["cy_patients"].find_one({"pseudo_id": ref})
    hits = await search_patients(CY, (p.get("full_name") or "Α")[:3])
    assert hits and hits[0]["patient_id"] == ref and "amka" in hits[0]
    fam = CyPatientGroupRepository(tenant_id=CY)
    g = await fam.create(kind="family", name="Οικογένεια Δοκιμή", by="u")
    gid = str(g.get("_id") or g.get("id"))
    assert (await fam.add_member(gid, patient_id=ref))["ok"]
    assert (await fam.add_member(gid, patient_id=ref))["error"] == "already_member"
    assert (await fam.add_member(gid, amka="000000"))["error"] == "no_patient", "όχι εγγραφή χωρίς εκτέλεση ΓεΣΥ"
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    d = await fam.detail(gid, date_from=now - timedelta(days=365), date_to=now + timedelta(days=1))
    row = d["members"][0]
    assert row["patient_id"] == ref and row["executions"] == 2 and not row["pending"]
    assert await fam.groups_for_patient(ref) and (await fam.list_groups(q=(p.get("full_name") or "")[:4]))["total"] == 1
    lists = await gl.everything(CY, [ref], {ref: "Χ"})
    assert set(lists) == {"recent", "opening", "order", "pending", "loans"} and len(lists["recent"]) == 2
    care = CyPatientGroupRepository(tenant_id=CY)
    c = await care.create(kind="care", name="Γηροκομείο", by="u")
    cid = str(c.get("_id") or c.get("id"))
    await care.add_member(cid, patient_id=ref)
    # το μέλος μπήκε «τώρα» → δεν χρεώνεται για τα παλιά· ορίζουμε ρητή αφετηρία χρεώσεων
    await mem["patient_groups"].update_one({"_id": __import__("bson").ObjectId(cid)},
                                          {"$set": {"charges_from": datetime(2000, 1, 1),
                                                    "members.0.charges_from": datetime(2000, 1, 1)}})
    acc = CyCareAccountRepository(tenant_id=CY)
    total_ben = sum([(x.get("totals") or {}).get("beneficiary", 0) async for x in mem["cy_dispensings"].find({})])
    assert await acc.balance(cid) == total_ben, "η δομή χρωστά ΜΟΝΟ τη συμμετοχή"
    cyc = await acc.cycle(cid, days=60)
    assert cyc["group"]["name"] == "Γηροκομείο" and "opening" in cyc
    assert await gl.instructions(CY, [ref], {ref: "Χ"})


async def test_campaign_coupon_is_linked_to_real_campaign_for_roi(mem, monkeypatch):
    """Πριν (έως 18/11/2026) το κουπόνι έμενε με προσωρινό αριθμό καμπάνιας → ROI πάντα 0."""
    from bson import ObjectId

    from app.services import campaign_engine, marketing
    ref = await _phase3_seed(mem, monkeypatch)
    cp = await marketing.create_coupon(CY, campaign_id=str(ObjectId()), discount_type="pct", discount_value=10)
    res = await campaign_engine.create(CY, channel="sms", message="Κωδικός {coupon}", subject=None, segment="all",
                                       value=None, by="t", coupon_code=cp["code"])
    assert (await mem["campaign_coupons"].find_one({"_id": cp["code"]}))["campaign_id"] == res["campaign_id"]
    await marketing.redeem_coupon(CY, cp["code"], amount_cents=2000)
    roi = {r["id"]: r for r in await marketing.campaigns_with_roi(CY)}
    assert roi[res["campaign_id"]]["redemptions"] == 1 and roi[res["campaign_id"]]["coupon"] == cp["code"]
    assert ref


async def test_cy_warehouse_match_handles_leading_zero_and_pack_suffix(mem):
    """18/11/2026: XML ΓεΣΥ «03582910071631» vs Αποθήκη «3582910071631»· κωδικός «2100081/1» —
    το απλό barcode==barcode έκανε «άγνωστο» απόθεμα και κερδοφορία χωρίς κάλυψη."""
    from app.services.cy import warehouse
    await mem["pharmacy_products"].insert_many([
        {"tenant_id": CY, "name": "Clexane 40", "barcode": "3582910071631",
         "barcodes": ["2100081/1", "3582910071631", "03582910071631"], "drug_code": "2100081/1", "stock_qty": 4},
        {"tenant_id": CY, "name": "Other", "barcode": "5290000000001", "drug_code": "77/1"}])
    wh = await warehouse.lookup(CY, [{"barcode": "03582910071631"}, {"code": "2100081/2"}], fields=("stock_qty", "name"))
    assert wh.get("03582910071631")["name"] == "Clexane 40"
    assert wh.get(None, "2100081/2")["name"] == "Clexane 40", "μία μόνο συσκευασία στην Αποθήκη → αυτή"
    assert wh.get("0000") is None
    assert (await warehouse.lookup(GR, [{"barcode": "03582910071631"}])).get("03582910071631") is None, "ανά φαρμακείο"



async def test_cy_warehouse_never_mixes_pack_sizes(mem):
    """«3900185/1» = 10 δισκία, «3900185/7» = 100 — ΠΟΤΕ τιμή άλλης συσκευασίας (18/11/2026)."""
    from app.services.cy import warehouse
    await mem["pharmacy_products"].insert_many([
        {"tenant_id": CY, "name": "Naxat 100", "barcode": "3900185/7", "drug_code": "3900185/7", "wholesale_cents": 9682},
        {"tenant_id": CY, "name": "Naxat 10", "barcode": "5291171003623", "drug_code": "3900185/1", "wholesale_cents": 621},
        {"tenant_id": CY, "name": "Naxat 30", "barcode": "5291171003647", "drug_code": "3900185/4", "wholesale_cents": 1749}])
    wh = await warehouse.lookup(CY, [{"barcode": "05291171003623", "code": "3900185/1"}, {"code": "3900185/9"}],
                                fields=("name", "wholesale_cents"))
    assert wh.get("05291171003623", "3900185/1")["name"] == "Naxat 10"
    assert wh.get(None, "3900185/9") is None, "άγνωστη συσκευασία με πολλές στην Αποθήκη → καμία εικασία"


def test_cy_demo_masks_people_not_medicines():
    """«Λειτουργία παρουσίασης» Κύπρου (20/11/2026): πρόσωπα κρυμμένα, φάρμακα/προσωπικό ορατά.
    ΓεΣΥ = «ΟΝΟΜΑ ΕΠΙΘΕΤΟ» → κρύβεται το ΕΠΙΘΕΤΟ (τελευταίες λέξεις), όχι το μικρό όνομα."""
    from app.services.cy.masking import mask_tree
    from app.utils.masking import set_given_name_first
    set_given_name_first(True)
    try:
        out = mask_tree({
            "patient": {"ref": "p1", "full_name": "ΜΑΡΙΑ ΙΩΑΝΝΟΥ", "hio_code": "123456", "dob": "1950-01-01"},
            "contact": {"mobile": "+35799000000", "email": "a@b.cy", "marketing_consent": True},
            "items": [{"patient_ref": "p1", "patient_name": "ΜΑΡΙΑ ΙΩΑΝΝΟΥ", "doctor": "ΑΝΔΡΕΑΣ ΓΕΩΡΓΙΟΥ",
                       "lines": [{"description": "NAXAT 100MG", "name": "NAXAT"}]}],
            "doctor": {"id": "d1", "name": "ΑΝΔΡΕΑΣ ΓΕΩΡΓΙΟΥ", "phones": ["22000000"]},
            "doctors": ["ΑΝΔΡΕΑΣ ΓΕΩΡΓΙΟΥ"],
            "rows": [{"doctor_id": "d1", "name": "ΑΝΔΡΕΑΣ ΓΕΩΡΓΙΟΥ"}, {"patient_id": "p1", "name": "ΜΑΡΙΑ ΙΩΑΝΝΟΥ"},
                     {"key": "x", "name": "CLEXANE 40"}],
            "staff": [{"username": "u1", "name": "Υπάλληλος"}]})
    finally:
        set_given_name_first(False)
    assert out["patient"]["full_name"] == "ΜΑΡΙΑ Ι****" and out["patient"]["hio_code"] == "****"
    assert out["contact"] == {"mobile": "****", "email": "****", "marketing_consent": True}
    it = out["items"][0]
    assert it["patient_name"] == "ΜΑΡΙΑ Ι****" and it["doctor"] == "ΑΝΔΡΕΑΣ Γ****"
    assert it["lines"][0]["name"] == "NAXAT", "όνομα φαρμάκου ΠΟΤΕ κρυμμένο"
    assert out["doctor"]["name"] == "ΑΝΔΡΕΑΣ Γ****" and out["doctor"]["phones"] == ["****"]
    assert out["doctors"] == ["ΑΝΔΡΕΑΣ Γ****"]
    assert [r["name"] for r in out["rows"]] == ["ΑΝΔΡΕΑΣ Γ****", "ΜΑΡΙΑ Ι****", "CLEXANE 40"]
    assert out["staff"][0]["name"] == "Υπάλληλος"


def test_mask_name_order_greek_vs_cyprus():
    """Ο κανόνας είναι ΠΑΝΤΑ «κρύψε το επίθετο»· αλλάζει μόνο η θέση του (ΗΔΥΚΑ πρώτο, ΓεΣΥ τελευταίο)."""
    from app.utils.masking import mask_name, set_given_name_first
    assert mask_name("ΠΑΠΑΔΟΠΟΥΛΟΥ ΜΑΡΙΑ", True) == "Π**** ΜΑΡΙΑ"
    set_given_name_first(True)
    try:
        assert mask_name("MARIA ANNA IOANNOU", True) == "MARIA A**** I****"
        assert mask_name("IOANNOU", True) == "I****"
        assert mask_name("MARIA IOANNOU", False) == "MARIA IOANNOU"
    finally:
        set_given_name_first(False)
    assert mask_name("ΠΑΠΑΔΟΠΟΥΛΟΥ ΜΑΡΙΑ", True) == "Π**** ΜΑΡΙΑ"


def test_cy_router_masks_every_response_in_demo_only():
    """Η απόκρυψη είναι ΣΤΟΝ ROUTER (route_class): ένα νέο endpoint δεν μπορεί να την ξεχάσει."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.v1.routers import cy as cy_router
    from app.services.cy.masking import CyMaskedRoute
    assert cy_router.router.route_class is CyMaskedRoute

    from fastapi import APIRouter
    r = APIRouter(route_class=CyMaskedRoute)

    @r.get("/x")
    async def x(request: Request, demo: bool = False):
        request.state.cy_demo = demo
        return {"full_name": "ΙΩΑΝΝΟΥ ΜΑΡΙΑ", "name": "NAXAT"}   # χωρίς σειρά ΓεΣΥ → ελληνική

    app = FastAPI()
    app.include_router(r)
    c = TestClient(app)
    assert c.get("/x").json()["full_name"] == "ΙΩΑΝΝΟΥ ΜΑΡΙΑ"
    assert c.get("/x?demo=true").json() == {"full_name": "Ι**** ΜΑΡΙΑ", "name": "NAXAT"}


def test_cy_demo_never_saves_masked_contact():
    from app.services.cy.masking import has_mask
    assert has_mask("****") and not has_mask("+35799000000") and not has_mask(None)


# ── Εκκαθάριση ΟΑΥ & Κερδοφορία ΓεΣΥ (20/11/2026) ────────────────────────────

UNIT_TXT = """Αμοιβή Φαρμακοποιού
Μήνας: 10
Έτος: 2026
Κωδικός Παροχέα Χρέωσης: C0000
ID Τιμολογίου Τύπος Πληρωμένο Ημερομηνία Παροχέας Υγείας Τιμή Μονάδας Συσκευασίες που Αμοιβή από ΟΑΥ
EBS Τιμολογίου Τιμολογίου εκτελέστηκαν
6000001 STANDARD Yes 30/10/2026 C0000 ΦΑΡΜΑΚΕΙΟ ΔΟΚΙΜΗ 1.60 € 2451 3,921.60 €
ΛΙΜΙΤΕΔ
Σελίδα 1"""

REM_TXT = """ΚΑΤΑΣΤΑΣΗ ΠΛΗΡΩΜΗΣ
REMITTANCE ADVICE
PHARMACY TEST LTD-C0000 Payment Date: 13/11/2026
Total paid in this batch: 4,112.27
31/10/2026 CRN-Packages CORRECTION-PackagesSubdivision -.70 EUR -.70
Sub.
31/10/2026 PH-EFIM-Oct-26 PH - EFIMERIES-10/2026 (excluding 177.59 EUR 177.59
VAT)
01/10/2026 6000000 PH-HCPSERVICES 13.78 EUR 13.78
31/10/2026 6000001 PH-HCPSERVICES 3,921.60 EUR 3,921.60
Σύνολο / Total 4,112.27"""


def test_settlement_pdf_texts_are_read_exactly():
    from app.services.cy.settlement import parse_remittance_pdf, parse_unit_pdf
    u = parse_unit_pdf(UNIT_TXT)
    assert u["month"] == "2026-10" and u["unit"]["price_cents"] == 160 and u["unit"]["packages"] == 2451
    assert u["unit"]["fee_cents"] == 392160 and u["unit"]["consistent"] and u["unit"]["invoice_id"] == "6000001"
    r = parse_remittance_pdf(REM_TXT)["remittance"]
    assert r["payment_date"] == "2026-11-13" and r["total_cents"] == 411227
    kinds = {ln["kind"]: ln["cents"] for ln in r["lines"] if ln["kind"] != "services"}
    assert kinds == {"correction": -70, "duty": 17759}
    assert sum(ln["cents"] for ln in r["lines"]) == r["total_cents"], "γραμμές = σύνολο πληρωμής"


def _xlsx(rows: list[list]) -> bytes:
    import io

    import openpyxl
    wb = openpyxl.Workbook()
    for r in rows:
        wb.active.append(r)
    b = io.BytesIO()
    wb.save(b)
    return b.getvalue()


PAID_HEAD = ["DISPENS. ID", "PRESCRIPTION ID", "STATUS", "TYPE", "CLAIM DATE", "PRESCRIBING DOCTOR NAME", "EXECUTED BY",
             "CO-PAYMENT", "PC II", "HIO REIMB.", "TOTAL AMT", "VAT *", "NO. OF PACKAGES", "BENEFICIARY NAME",
             "BENEFICIARY ID", "NO. OF REPETITIONS"]
PEND_HEAD = ["Αρ. Εκτελ. Συνταγής", "Αρ. Συνταγής", "Κατάσταση", "Όνομα Γιατρού", "Τύπος", "Ημερομηνία Εκτέλεσης",
             "Εκτέλεση απο", "Συμπλ. & Συνεισφ. ΙΙ", "Ενδ. Αμοιβη ΟΑΥ", "Όνομα Δικαιούχου",
             "Τύπος Εγγράφου Ταυτοποίησης", "Έγγραφο Ταυτοποίησης", "Αρ. Επανάλ."]


async def _settle_seed(mem):
    from app.services.cy.importer import import_files
    await import_files(CY, [("1", _rx("8001", "9001", "N-A", "2026-09-29 11:00:00 +0300", 1)),
                            ("2", _rx("8001", "9002", "N-A", "2026-10-27 12:00:00 +0200", 2)),
                            ("3", _rx("8002", "9003", "N-B", "2026-10-28 09:00:00 +0200", 1)),
                            ("4", _rx("8003", "9004", "N-C", "2026-10-30 09:00:00 +0200", 1))], pepper="p")
    return {d["dispensing_id"]: d async for d in mem["cy_dispensings"].find({})}


def _paid_row(d, *, hio_delta=0, name="ΟΝΟΜΑ ΠΕΛΑΤΗ"):
    from app.services.cy.settlement import packages_of
    t = d["totals"]
    return [int(d["dispensing_id"]), 8000, "Paid", "Drugs", "2026-10-28", "ΓΙΑΤΡΟΣ", "ΧΡΗΣΤΗΣ",
            t["copay"] / 100, t["pc2"] / 100, (t["hio"] + hio_delta) / 100, t["total"] / 100, 0.5,
            packages_of(d), name, "NID 0000000001", "1 of 6"]


async def test_settlement_import_reconcile_and_no_pii(mem, monkeypatch):
    from app.services.cy import settlement
    ds = await _settle_seed(mem)
    paid = _xlsx([PAID_HEAD, _paid_row(ds["9001"]), _paid_row(ds["9002"], hio_delta=5),
                  [9999, 1, "Paid", "Drugs", "2026-10-20", "", "", 1, 0, 2, 3, 0.1, 1, "X", "Y", ""],
                  ["Totals", None, None], ["* VAT is included in the Total amount"]])
    pend = _xlsx([PEND_HEAD, [9003, 8002, "Μερικώς Εκτελεσμένη", "ΓΙΑΤΡΟΣ", "Φάρμακα", "28/10/2026", "Χ", "1.00", "2.00",
                              "ΟΝΟΜΑ ΠΕΛΑΤΗ", "NID", "0000000002", "1 από 6"]])
    monkeypatch.setattr(settlement, "_pdf_text", lambda data: UNIT_TXT)
    res = await settlement.import_files(CY, [("paid.xlsx", paid), ("pend.xlsx", pend), ("unit.pdf", b"%PDF-1.4 x"),
                                             ("junk.txt", b"hello")])
    assert sorted(i["kind"] for i in res["imported"]) == ["paid", "pending", "unit"]
    assert all(i["month"] == "2026-10" for i in res["imported"]) and res["errors"][0]["file"] == "junk.txt"
    doc = await mem["cy_settlements"].find_one({"tenant_id": CY, "month": "2026-10"})
    assert "ΟΝΟΜΑ ΠΕΛΑΤΗ" not in repr(doc) and "0000000001" not in repr(doc), "ΠΟΤΕ ονόματα/ταυτότητες"
    d = await settlement.detail(CY, "2026-10")
    rc = d["reconcile"]
    assert rc["ok"] == 1 and [x["id"] for x in rc["diffs"]] == ["9002"] and "hio" in rc["diffs"][0]["fields"]
    assert [x["id"] for x in rc["missing"]] == ["9999"], "πληρώθηκε αλλά λείπει από το RxVision"
    assert rc["pending"][0]["id"] == "9003" and rc["pending"][0]["found"] and rc["pending"][0]["status"] == "partial"
    assert [x["id"] for x in rc["unseen"]] == ["9004"], "του μήνα, πουθενά στα αρχεία του ΟΑΥ"
    # ξανά-ανέβασμα = αντικατάσταση, όχι διπλό
    await settlement.import_files(CY, [("paid.xlsx", paid)])
    assert await mem["cy_settlements"].count_documents({"tenant_id": CY}) == 1
    assert len((await mem["cy_settlements"].find_one({"tenant_id": CY}))["paid"]) == 3
    assert await settlement.detail(GR, "2026-10") is None, "ανά φαρμακείο"


async def test_profitability_fee_exact_then_provisional(mem, monkeypatch):
    from datetime import date

    from app.services.cy import analytics, settlement
    ds = await _settle_seed(mem)
    r0 = await analytics.profitability(CY, date(2026, 9, 1), date(2026, 11, 1))
    assert r0["fee"]["available"] is False and r0["totals"]["total_profit"] is None, "χωρίς εκκαθάριση: καμία εικασία"
    monkeypatch.setattr(settlement, "_pdf_text", lambda data: REM_TXT if data.startswith(b"%PDF-R") else UNIT_TXT)
    await settlement.import_files(CY, [("u.pdf", b"%PDF-U"), ("r.pdf", b"%PDF-R"),
                                       ("p.xlsx", _xlsx([PAID_HEAD, _paid_row(ds["9001"]), _paid_row(ds["9002"])]))])
    r = await analytics.profitability(CY, date(2026, 9, 1), date(2026, 11, 1))
    f = r["fee"]
    pk = {k: settlement.packages_of(v) for k, v in ds.items()}
    assert f["exact_packages"] == pk["9001"] + pk["9002"] and f["exact_cents"] == 160 * f["exact_packages"]
    assert f["provisional_packages"] == pk["9003"] + pk["9004"] and f["price_month"] == "2026-10"
    assert r["duty_cents"] == 17759 and r["corrections_cents"] == -70
    assert r["totals"]["total_profit"] == f["total_cents"] + 17759 - 70 + r["totals"]["profit"]
    # εφημερίες/διορθώσεις μόνο όταν ο μήνας πληρωμής είναι μέσα στην περίοδο
    assert (await analytics.profitability(CY, date(2026, 9, 1), date(2026, 10, 1)))["duty_cents"] == 0


def test_opened_pack_is_never_costed():
    from app.services.cy.analytics import _opened_pack
    assert _opened_pack({"package": "ΠΡΟΣΟΧΗ-ΑΡΙΘΜΟΣ ΤΕΜΑΧΙΩΝ 1. ΣΥΣΚΕΥΑΣΙΑ ΠΟΥ ΑΝΟΙΓΕΙ"})
    assert not _opened_pack({"package": "PACK WITH 30 TABS IN BLISTER(S)"}) and not _opened_pack({})


async def test_no_silent_500_cap_in_reconcile_and_names(mem):
    """20/11/2026: το `find` κόβει σιωπηλά στα 500 — η Εκκαθάριση έδειχνε «500 ταιριάζουν / 200 λείπουν»
    για 1.126 σωστές. Συμφωνία, ονόματα, ανάκληση, GDPR περνούν από `find_all` (χωρίς όριο σελίδας)."""
    from datetime import datetime, timezone

    from app.services.cy import chains, settlement
    n = 620
    at = datetime(2026, 10, 10, 9, tzinfo=timezone.utc)
    await mem["cy_dispensings"].insert_many([
        {"tenant_id": CY, "dispensing_id": str(700000 + i), "dispensed_at": at, "patient_ref": f"p{i}",
         "lines": [{"qty_disp": 1, "amounts": {"total": 100}}],
         "totals": {"total": 100, "hio": 90, "copay": 10, "pc2": 0}} for i in range(n)])
    await mem["cy_patients"].insert_many([{"tenant_id": CY, "pseudo_id": f"p{i}", "full_name": f"A B{i}"} for i in range(n)])
    rows = [PAID_HEAD] + [[700000 + i, 1, "Paid", "Drugs", "2026-10-20", "", "", 0.10, 0, 0.90, 1.00, 0.05, 1, "X", "Y", ""]
                          for i in range(n)]
    await settlement.import_files(CY, [("p.xlsx", _xlsx(rows))])
    d = await settlement.detail(CY, "2026-10")
    assert d["reconcile"]["ok"] == n and d["reconcile"]["missing"] == [] and d["reconcile"]["unseen_count"] == 0
    assert len(await chains.names_of(CY, {f"p{i}" for i in range(n)})) == n


async def test_base_find_all_has_no_page_cap_and_stays_in_tenant(mem):
    """Ο ΕΝΑΣ ορισμός (BaseRepository.find_all): 790 κατηγορίες στο demo Κύπρου έχαναν 290 στο δέντρο."""
    from app.repositories.pharmacy_categories import PharmacyCategoryRepository
    await mem["pharmacy_categories"].insert_many(
        [{"tenant_id": CY, "name": f"c{i}", "level": 1, "order": i} for i in range(790)]
        + [{"tenant_id": GR, "name": "ξένη", "level": 1, "order": 0}])
    tree = await PharmacyCategoryRepository(tenant_id=CY).tree()
    assert len(tree) == 790 and "ξένη" not in {t["name"] for t in tree}


# ── Πύλη Κύπρου: πελάτες πύλης, εγγραφή χωρίς συνταγές, πρόσκληση (23/11/2026) ─────────────

async def _portal_env(mem, monkeypatch):
    from app.services.vault_service import vault
    monkeypatch.setattr(vault, "tenant_pepper", lambda tid: "p")      # ίδιο pepper με το import των τεστ
    mails: list = []

    async def send_email(to, subject, body, **k):
        mails.append((to, subject))
    import app.services.mailer as mailer
    monkeypatch.setattr(mailer, "send_email", send_email)
    return mails


async def test_register_without_dispensings_merges_with_later_xml(mem, monkeypatch):
    """Εγγραφή με κωδικό ΟΑΥ ΠΡΙΝ από κάθε συνταγή → η πρώτη εκτέλεση κουμπώνει στην ΙΔΙΑ καρτέλα."""
    from app.services.cy import analytics, portal
    from app.services.cy.importer import import_files
    await _portal_env(mem, monkeypatch)
    r = await portal.register(CY, first_name="Ανδρέας", last_name="Συνθετικου", hio_code="900001", by="u1")
    assert r["ok"] and not r["existed"]
    lst = await analytics.patients(CY)
    assert any(i["patient_ref"] == r["patient_id"] and i.get("no_dispensings") for i in lst["items"]), \
        "πελάτης χωρίς εκτελέσεις φαίνεται στη λίστα"
    assert (await portal.register(CY, first_name="Α", last_name="Β", hio_code="0900001"))["existed"], "ποτέ διπλός"
    await import_files(CY, [("a.xml", DRUG_XML.encode())], pepper="p")
    assert await mem["cy_patients"].count_documents({"tenant_id": CY}) == 1
    d = await mem["cy_dispensings"].find_one({"tenant_id": CY})
    assert d["patient_ref"] == r["patient_id"]
    p = await mem["cy_patients"].find_one({"tenant_id": CY})
    assert "0000999001" not in repr(p), "ο αριθμός ταυτότητας δεν αποθηκεύεται ποτέ"
    # με ΜΟΝΟ ταυτότητα, ενώ υπάρχει ήδη από το XML → ο ίδιος (μέσω id_ref), όχι νέος
    assert (await portal.register(CY, first_name="Α", last_name="Β", doc_type="NID",
                                  doc_number="0000999001"))["patient_id"] == r["patient_id"]
    assert (await portal.register(CY, first_name="Α", last_name="Β"))["error"] == "id_required"
    assert await portal.register(GR, first_name="Α", last_name="Β", hio_code="900001") is not None
    assert await mem["cy_patients"].count_documents({"tenant_id": CY}) == 1, "ανά φαρμακείο"


async def test_cy_portal_customers_invite_resend_and_remove(mem, monkeypatch):
    from app.services.cy import portal
    from app.services.cy.importer import import_files
    mails = await _portal_env(mem, monkeypatch)
    await import_files(CY, [("a.xml", DRUG_XML.encode()), ("b.xml", CONS_XML.encode())], pepper="p")
    c0 = await portal.customers(CY)
    assert (c0["registered"], c0["total"], c0["to_invite"], c0["country"]) == (0, 2, 2, "CY")
    # 1) νέος άνθρωπος ΧΩΡΙΣ συνταγές, μόνο με όνομα + κωδικό ΟΑΥ
    r = await portal.invite(CY, email="new@mail.cy", hio_code="955555", first_name="Νίκος", last_name="Νέος", by="u1")
    assert r["ok"] and mails[-1][0] == "new@mail.cy"
    # 2) υπάρχων πελάτης ΓεΣΥ με κωδικό ΟΑΥ — λάθος ταυτότητα → άρνηση, σωστή → ok
    bad = await portal.invite(CY, email="a@mail.cy", hio_code="900001", doc_type="NID", doc_number="123")
    assert bad["error"] == "id_mismatch"
    ok = await portal.invite(CY, email="a@mail.cy", hio_code="900001", doc_type="NID", doc_number="0000999001")
    assert ok["ok"]
    assert (await portal.invite(CY, email="b@mail.cy", hio_code="900001"))["error"] == "already_invited"
    assert (await portal.invite(CY, email="c@mail.cy", hio_code="977777"))["error"] == "name_required"
    c1 = await portal.customers(CY)
    assert (c1["registered"], c1["total"], c1["to_invite"]) == (2, 3, 1)
    by_name = {x["name"]: x for x in c1["registered_list"]}
    assert by_name["ΝΙΚΟΣ ΝΕΟΣ"]["no_dispensings"] and not by_name["ΑΝΔΡΕΑΣ ΣΥΝΘΕΤΙΚΟΥ"]["no_dispensings"]
    # ξεκλείδωμα με κωδικό ΟΑΥ ή email
    assert (await portal.resend(CY, "900001"))["ok"]
    assert (await portal.resend(CY, "new@mail.cy"))["ok"]
    assert (await portal.resend(CY, "nobody@x.cy"))["error"] == "not_found"
    # διαγραφή από την πύλη (ίδια με την Ελλάδα)
    from app.repositories.patient_portal import PatientAccountRepository
    rm = await PatientAccountRepository().remove_by_pharmacy(by_name["ΝΙΚΟΣ ΝΕΟΣ"]["account_id"], CY, by="u1")
    assert rm["ok"] and (await portal.customers(CY))["registered"] == 1
    assert await mem["cy_patients"].count_documents({"tenant_id": CY, "hio_code": "955555"}) == 1, \
        "η καρτέλα του φαρμακείου μένει"


async def test_portal_rx_number_checked_only_in_own_prescriptions(mem, monkeypatch):
    """Ανάθεση συνταγής από την πύλη (Κύπρος): ο αριθμός ελέγχεται ΜΟΝΟ στις συνταγές ΤΟΥ ΙΔΙΟΥ του πελάτη."""
    from app.repositories.patient_portal import PatientAccountRepository
    from app.services.cy import portal
    from app.services.cy.importer import import_files
    await _portal_env(mem, monkeypatch)
    await import_files(CY, [("1", _rx("8101", "9101", "N-A", "2026-10-01 10:00:00 +0300", 1)),
                            ("2", _rx("8202", "9202", "N-B", "2026-10-02 10:00:00 +0300", 1))], pepper="p")
    a = await mem["cy_dispensings"].find_one({"dispensing_id": "9101"})
    shell = await PatientAccountRepository().cy_shell(CY, a["patient_ref"], "A")
    own = await portal.rx_snapshot(CY, str(shell), "8101")
    assert own["found"] and own["repeat"] == "1/6" and own["open_date"]
    assert not (await portal.rx_snapshot(CY, str(shell), "8202"))["found"], "ποτέ συνταγή άλλου πελάτη"
    assert not (await portal.rx_snapshot(CY, None, "8101"))["found"]


async def test_cy_loyalty_candidates_and_enroll(mem, monkeypatch):
    """Πιστότητα → Εγγραφή μέλους (Κύπρος): υποψήφιοι = πελάτες ΓεΣΥ που δεν είναι μέλη· εγγραφή μέσω γέφυρας."""
    from app.services.cy import portal
    from app.services.cy.importer import import_files
    await _portal_env(mem, monkeypatch)
    await import_files(CY, [("a.xml", DRUG_XML.encode()), ("b.xml", CONS_XML.encode())], pepper="p")
    await portal.register(CY, first_name="Νίκος", last_name="Νέος", hio_code="955555")
    c = await portal.loyalty_candidates(CY, "νικ")
    assert [x["name"] for x in c] == ["ΝΙΚΟΣ ΝΕΟΣ"], "και πελάτης χωρίς συνταγές, αναζήτηση χωρίς τόνους"
    r = await portal.loyalty_enroll(CY, c[0]["patient_ref"])
    assert r.get("ok", True) is not False
    assert await portal.loyalty_candidates(CY, "νικ") == [], "ήδη μέλος → όχι υποψήφιος"
    assert len(await portal.loyalty_candidates(CY, "900")) == 2, "αναζήτηση με κωδικό ΟΑΥ"
    assert await portal.loyalty_candidates(GR, "νικ") == []


async def test_cy_portal_access_parental_and_authorization(mem, monkeypatch):
    """«Ποιος βλέπει ποιον» στην Κύπρο: ίδιοι κανόνες με την Ελλάδα, ταυτότητα ΓεΣΥ.
    Γονική μέριμνα ΜΟΝΟ για ανήλικο (ακριβής ημ. γέννησης ΓεΣΥ)· εξουσιοδότηση ΜΟΝΟ από ενήλικο."""
    from app.repositories.patient_portal import PatientAccountRepository
    from app.services import portal_access as pa
    from app.services.cy import portal
    from app.services.cy.importer import import_files
    await _portal_env(mem, monkeypatch)
    await import_files(CY, [("a.xml", DRUG_XML.encode()), ("b.xml", CONS_XML.encode())], pepper="p")
    pats = {p["full_name"]: p["pseudo_id"] async for p in mem["cy_patients"].find({"tenant_id": CY})}
    dad, mum = pats["ΑΝΔΡΕΑΣ ΣΥΝΘΕΤΙΚΟΥ"], pats["ΜΑΡΙΑ ΔΟΚΙΜΙΟΥ"]
    kid = (await portal.register(CY, first_name="Παιδί", last_name="Συνθετικού", hio_code="966666",
                                 dob="2015-05-05"))["patient_id"]
    await mem["patient_groups"].insert_one({"tenant_id": CY, "kind": "family", "name": "Οικ.", "active": True,
        "members": [{"pseudo_id": dad, "role": "Γονέας"}, {"pseudo_id": kid, "role": "Παιδί"},
                    {"pseudo_id": mum, "role": "Σύζυγος"}]})
    dad_shell = await PatientAccountRepository().cy_shell(CY, dad, "ΑΝΔΡΕΑΣ ΣΥΝΘΕΤΙΚΟΥ")
    v = await pa.viewable_in_tenant(CY, str(dad_shell))
    assert [x["pseudo_id"] for x in v] == [kid], "ο γονιός βλέπει ΜΟΝΟ το ανήλικο — όχι την ενήλικη σύζυγο"
    assert await pa.can_view(CY, str(dad_shell), v[0]["patient_ref"]) is not None
    mum_shell = await PatientAccountRepository().cy_shell(CY, mum, "ΜΑΡΙΑ ΔΟΚΙΜΙΟΥ")
    assert await pa.can_view(CY, str(dad_shell), str(mum_shell)) is None
    # εξουσιοδότηση: η ενήλικη μητέρα δίνει πρόσβαση στον πατέρα (από την οθόνη, με ψευδώνυμα ΓεΣΥ)
    assert await pa._pseudo_of(CY, mum) == mum and await pa._pseudo_of(CY, str(mum_shell)) == mum
    assert (await pa.grant(CY, grantor_pseudo=mum, grantee_pseudo=dad))["ok"]
    assert await pa.can_view(CY, str(dad_shell), str(mum_shell)) is not None
    assert (await pa.grant(CY, grantor_pseudo=kid, grantee_pseudo=mum))["error"] == "grantor_minor"
    rows = await pa.list_all(CY)
    assert rows[0]["grantor"]["patient_id"] == mum and rows[0]["grantee"]["name"] == "ΑΝΔΡΕΑΣ ΣΥΝΘΕΤΙΚΟΥ"
    assert await pa._pseudo_of(GR, mum) is None, "ψευδώνυμο ΓεΣΥ δεν λύνεται σε ελληνικό φαρμακείο"


async def test_cy_business_and_order_advisor_shape(mem):
    """Επιχειρησιακά & Παραγγελία βάσει πρόβλεψης (Κύπρος): ΙΔΙΟ σχήμα με την Ελλάδα, τιμές από τους
    κυπριακούς ορισμούς (Dashboard, Κερδοφορία, αλυσίδες, Πρόταση παραγγελίας) — κανένας νέος υπολογισμός."""
    from datetime import date

    from app.services.cy import advisor, analytics
    await _parity_seed()
    b = await advisor.business(CY, date(2026, 9, 1), date(2026, 11, 18))
    s = await analytics.summary(CY, date(2026, 9, 1), date(2026, 11, 18))
    assert set(b["kpis"]) == {"revenue", "gross_profit", "margin_pct", "rx", "claimed", "patients"}
    assert b["kpis"]["revenue"]["value"] == s["value"] and b["kpis"]["claimed"]["value"] == s["hio"]
    assert b["kpis"]["gross_profit"]["value"] is None, "χωρίς εκκαθάριση: κέρδος άγνωστο, όχι εικασία"
    assert any(i["cta"] and i["cta"]["href"] == "/cy/settlement" for i in b["insights"])
    assert all(i["cta"] is None or i["cta"]["href"].startswith("/cy/") for i in b["insights"]), "ποτέ ελληνική οθόνη"
    o = await advisor.orders(CY, lead_days=60)
    assert set(o) >= {"kpis", "insights", "suggestions", "upcoming", "cross_sell"}
    assert all(u["expected_open_date"] for u in o["upcoming"])


async def test_cy_audience_rules_and_campaign_only_matching(mem, monkeypatch):
    """Ομάδες πελατών (Κύπρος): ίδιοι κανόνες, πελάτες ΓεΣΥ· άγνωστο/ελληνικό πεδίο → άρνηση (ποτέ «όλοι»)·
    κλινικό μόνο σε φροντίδα· η καμπάνια πάει ΜΟΝΟ σε όσους ταιριάζουν."""
    import pytest as _pt

    from app.services import audience, campaign_engine
    from app.services.cy import audience as cy_audience
    from app.services.cy import contacts, portal
    from app.services.cy.importer import import_files
    await _portal_env(mem, monkeypatch)
    await import_files(CY, [("a.xml", DRUG_XML.encode()), ("b.xml", CONS_XML.encode())], pepper="p")
    await portal.register(CY, first_name="Νίκος", last_name="Νέος", hio_code="955555")
    every = await audience.resolve(CY, {"match": "all", "conditions": [{"field": "rx_count", "op": "gte", "value": 0}]})
    assert len(every) == 3
    with_rx = await audience.resolve(CY, {"match": "all", "conditions": [{"field": "rx_count", "op": "gte", "value": 1}]})
    assert len(with_rx) == 2, "ο πελάτης χωρίς συνταγές δεν έχει εκτελέσεις"
    with _pt.raises(ValueError):
        await audience.resolve(CY, {"match": "all", "conditions": [{"field": "icd10", "op": "contains", "value": "E11"}]},
                               purpose="care")
    with _pt.raises(PermissionError):
        await audience.resolve(CY, {"match": "all", "conditions": [{"field": "therapy_atc", "op": "contains", "value": "A"}]})
    assert "icd10" not in cy_audience.fields() and "therapy_atc" in cy_audience.fields()
    smart = await audience.smart_counts(CY)
    assert {s["key"] for s in smart} >= {"active", "vip", "loyalty"}
    # καμπάνια με κανόνες: ΜΟΝΟ όσοι ταιριάζουν (και έχουν συγκατάθεση)
    for ps in with_rx | (every - with_rx):
        await contacts.set_contact(CY, ps, {"mobile": "99123456", "marketing_consent": True}, source="pharmacist")
    r = await campaign_engine.create(CY, channel="sms", message="Γεια", subject=None, segment="all", value=None,
                                     by="u1", audience_rules={"match": "all", "conditions": [
                                         {"field": "rx_count", "op": "gte", "value": 1}]})
    assert r["recipients"] == 2


async def test_greek_loyalty_audience_counts_members(mem):
    """23/11/2026: η ομάδα «Μέλη πιστότητας» μετρούσε ΠΑΝΤΑ 0 (ObjectId vs κείμενο). Τώρα μετρά τα μέλη."""
    from bson import ObjectId

    from app.services import audience
    a, b = ObjectId(), ObjectId()
    await mem["patients_anonymized"].insert_many([{"_id": a, "tenant_id": GR, "rx_count": 3},
                                                  {"_id": b, "tenant_id": GR, "rx_count": 1}])
    await mem["loyalty_members"].insert_one({"tenant_id": GR, "patient_ref": str(a)})
    ids = await audience.resolve(GR, {"match": "all", "conditions": [{"field": "is_loyalty", "op": "is", "value": True}]})
    assert ids == {a}


def test_every_cy_route_has_an_addon_like_greece():
    """Πρόσθετα ίδια με την Ελλάδα (23/11/2026): ΚΑΘΕ κυπριακό endpoint αντιστοιχεί σε πρόσθετο (ή ρητά
    στην τροφοδοσία δεδομένων). Νέο endpoint χωρίς αντιστοίχιση → αποτυγχάνει εδώ, όχι σιωπηλά ανοιχτό."""
    from app.api.v1.routers import cy
    from app.services.cy.gate import CY_ROUTE_FREE, CY_ROUTE_MODULES, route_key
    for r in cy.router.routes:
        k = route_key("/api/v1/cy" + r.path)
        assert k in CY_ROUTE_MODULES or k in CY_ROUTE_FREE, f"/cy{r.path}: χωρίς πρόσθετο"


def test_locked_addon_blocks_cy_screen():
    from types import SimpleNamespace

    from fastapi import HTTPException

    from app.services.cy.gate import _check_modules

    def ctx(**mods):
        return SimpleNamespace(modules=mods, module_trials={})
    with _pt_raises(HTTPException):
        _check_modules(ctx(doctor_analytics="locked"), "/api/v1/cy/doctors")
    _check_modules(ctx(doctor_analytics="enabled"), "/api/v1/cy/doctors/D1")
    with _pt_raises(HTTPException):
        _check_modules(ctx(), "/api/v1/cy/claim")                      # κλειστό Κλείσιμο μήνα
    _check_modules(ctx(family_groups="enabled"), "/api/v1/cy/patients/x")   # Πελάτες: αρκεί ΕΝΑ
    _check_modules(ctx(), "/api/v1/cy/import")                         # τροφοδοσία: πάντα
    with _pt_raises(HTTPException):
        _check_modules(ctx(dashboard="enabled"), "/api/v1/cy/new-thing")   # άγνωστο → κλειστό


def _pt_raises(exc):
    import pytest as _p
    return _p.raises(exc)


async def test_cy_portal_qr_checks_id_without_storing_it(mem, monkeypatch):
    """QR για το φαρμακείο (24/11/2026): [ταυτότητα]+Tab+[ΗΗ/ΜΜ/ΕΕΕΕ]. Ο αριθμός ελέγχεται με ψευδώνυμα και
    ΔΕΝ αποθηκεύεται ποτέ· επιστρέφεται μόνο η ημ. γέννησης του ίδιου."""
    from fastapi import HTTPException

    from app.api.v1.routers import cy as cy_router
    from app.api.v1.routers import patient as pr
    from app.core.deps import PatientContext
    ref = await _portal_setup(mem, monkeypatch)
    await cy_router.portal_invite(ref, cy_router.PortalInviteIn(doc_type="NID", doc_number="999001", email="q@r.cy"), _Ctx(CY))
    acc = await mem["patient_accounts"].find_one({"email": "q@r.cy"})
    link = await mem["patient_links"].find_one({"account_id": acc["_id"]})
    ctx = PatientContext(account_id=str(acc["_id"]), tenant_id=CY, patient_ref=str(link["patient_ref"]))
    ok = await pr.cy_qr_check(pr.CyQrIn(doc_type="NID", doc_number="0000999001"), ctx)
    assert ok == {"ok": True, "dob": "31/12/1959", "verified": True}
    assert (await pr.cy_qr_check(pr.CyQrIn(doc_type="NID", doc_number="123456"), ctx))["error"] == "id_mismatch"
    assert (await pr.cy_qr_check(pr.CyQrIn(doc_type="ARC", doc_number="0000999001"), ctx))["error"] == "id_mismatch"
    for coll in ("cy_patients", "patient_accounts", "patient_links"):
        async for d in mem[coll].find({}):
            assert "0000999001" not in repr(d) and "999001" not in repr(d).replace("0000999001", ""), coll
    await mem["patient_accounts"].insert_one({"email": "gr2@x.gr", "amka": "12345678902"})
    gr = await mem["patient_accounts"].find_one({"email": "gr2@x.gr"})
    try:
        await pr.cy_qr_check(pr.CyQrIn(doc_number="999001"), PatientContext(account_id=str(gr["_id"]), tenant_id=GR, patient_ref="x"))
        raise AssertionError("ελληνικός λογαριασμός")
    except HTTPException as exc:
        assert exc.status_code == 404
