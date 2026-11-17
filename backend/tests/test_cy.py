"""RxVision Κύπρος (ΓεΣΥ): parser, εισαγωγή, και ο ΦΡΑΓΜΟΣ που προστατεύει την Ελλάδα.

Τα XML εδώ είναι ΣΥΝΘΕΤΙΚΑ, με την ίδια ακριβώς δομή με τα πραγματικά της πύλης (Type 01 φάρμακα,
Type 02 αναλώσιμα). Πραγματικά XML (ονόματα/ταυτότητες ασθενών) δεν μπαίνουν ΠΟΤΕ στον κώδικα.

Η βάση είναι ΠΑΝΤΑ στη μνήμη (mongomock) — τα τεστ αυτά δεν αγγίζουν ποτέ πραγματική MongoDB.
"""

from __future__ import annotations

import pytest

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
    try:
        await require_cy(ctx)
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

    rx = await pr.cy_prescriptions(ctx)
    assert len(rx["history"]) == 1 and rx["history"][0]["lines"][0]["description"].startswith("JIVOLAR")
    assert rx["open"] == [], "6/6 → καμία ανοιχτή"
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
    try:
        await pr.cy_prescriptions(PatientContext(account_id=str(gr["_id"]), tenant_id=GR, patient_ref="x"))
        raise AssertionError("ελληνικός λογαριασμός είδε κυπριακές συνταγές")
    except HTTPException as exc:
        assert exc.status_code == 404


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
