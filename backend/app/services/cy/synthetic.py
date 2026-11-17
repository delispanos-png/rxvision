"""ΣΥΝΘΕΤΙΚΑ XML εκτελέσεων ΓεΣΥ — για το εσωτερικό demo φαρμακείο Κύπρου και για τα τεστ.

Ίδια ακριβώς δομή με την πύλη (`<Dispensing>`), αλλά ΦΑΝΤΑΣΤΙΚΑ πρόσωπα και ταυτότητες.
Πραγματικά XML (με ονόματα/ταυτότητες ασθενών) δεν μπαίνουν ΠΟΤΕ στον κώδικα.

Τι περιέχει για να «ζωντανέψουν» οι οθόνες: χρόνιες συνταγές 6 εκτελέσεων ανά 28 ημέρες,
ασθενείς που σταματούν να έρχονται (χαμένοι), είδη που δεν δίνονται (QtyDisp 0), απαλλαγές
συμμετοχής, διαφορά τιμής (PC2), διαβητικούς με αναλώσιμα (Type 02), ελληνική ΚΑΙ αγγλική δοσολογία.
"""

from __future__ import annotations

import io
import random
import zipfile
from datetime import date, datetime, timedelta
from xml.sax.saxutils import escape

PROVIDER = "C9999"  # φανταστικός κωδικός παρόχου του demo φαρμακείου

FIRST = ["ΑΝΔΡΕΑΣ", "ΜΑΡΙΑ", "ΓΙΩΡΓΟΣ", "ΕΛΕΝΗ", "ΧΡΙΣΤΟΣ", "ΑΝΝΑ", "ΚΩΣΤΑΣ", "ΣΟΦΙΑ", "ΝΙΚΟΣ",
         "ΧΡΥΣΤΑΛΛΑ", "ΜΙΧΑΛΗΣ", "ΕΥΤΥΧΙΑ", "ΠΑΝΙΚΟΣ", "ΔΕΣΠΩ", "ΣΑΒΒΑΣ", "ΘΕΚΛΑ"]
LAST = ["ΔΟΚΙΜΙΟΥ", "ΠΑΡΑΔΕΙΓΜΑΤΟΣ", "ΣΥΝΘΕΤΙΚΟΥ", "ΔΕΙΓΜΑΤΙΔΗ", "ΠΡΟΤΥΠΟΥ", "ΥΠΟΘΕΤΙΚΟΥ",
        "ΕΙΚΟΝΙΚΟΥ", "ΤΕΣΤΟΠΟΥΛΟΥ"]
DOCTORS = [("D9001", "ΑΝΤΡΗ", "ΙΑΤΡΟΥ"), ("D9002", "ΠΕΤΡΟΣ", "ΘΕΡΑΠΕΥΤΗ"),
           ("D9003", "STELLA", "MEDICA"), ("D9004", "ΛΟΥΚΑΣ", "ΚΛΙΝΙΚΟΥ")]
STAFF = [("demo.pharm1", "ΦΑΡΜΑΚΟΠΟΙΟΣ", "ΠΡΩΤΗ"), ("demo.pharm2", "ΒΟΗΘΟΣ", "ΔΕΥΤΕΡΟΣ")]

# (barcode, HIOcode, περιγραφή, συσκευασία, τεμ./συσκ., τιμή σε λεπτά, ποσότητα/λήψη, λήψεις/ημέρα)
DRUGS = [
    ("05290931041882", "41M0186/5", "JIVOLAR TABLET, FILM COATED 50MG/850MG", "PACK WITH 60 TABS IN BLISTER(S)", 60, 1654, 1.0, 2),
    ("05290931001985", "7900222/1", "LORANS TABLET 2MG", "PACK WITH 50 TABS IN BLISTER(S)", 50, 410, 1.0, 1),
    ("05290665004498", "2300316/2", "ASPIREM TABLET, GASTRO-RESISTANT 75MG", "PACK WITH 56 TABS IN BLISTER(S)", 56, 380, 1.0, 1),
    ("03838989637613", "29M0058/2", "ESOMEPRAZOLE TAD CAPSULE, GASTRO-RESISTANT 40MG", "PACK WITH 14 CAPS IN BLISTER(S)", 14, 599, 1.0, 1),
    ("04260108281183", "C555003/1", "CLOPIDOGREL TAD TABLET, FILM COATED 75MG", "PACK WITH 28 TABS IN BLISTER(S)", 28, 788, 1.0, 1),
    ("05290665005389", "2800078/3", "ZOVAR TABLET, FILM COATED 20MG", "PACK WITH 30 TABS IN BLISTER(S)", 30, 617, 1.0, 1),
    ("04054839363818", "34M0111/3", "EMCONCOR TABLET, FILM COATED 2.5MG", "PACK WITH 30 TABS IN B LISTER(S)", 30, 444, 1.0, 2),
    ("05290931004641", "7800460/2", "DIDRALIN TABLET 50MG", "PACK WITH 30 TABS IN BLISTER(S)", 30, 347, 1.0, 1),
    ("05290665005914", "2600182/10", "LOSAR TABLET, FILM COATED 50MG", "PACK WITH 30 TABS IN BLISTERS", 30, 550, 1.0, 1),
    ("05400835001954", "C447003/1", "ADENURIC TABLET, FILM COATED 120MG", "PACK WITH 28 TABS IN BLISTER(S)", 28, 1890, 0.5, 1),
]
CONSUMABLES = [("82224638", "82224638 Microlet Σκαρφιστήρες (lancets) ASCENSIA NOVAGEM", 102),
               ("90002453", "90002453 Contour Ταινίες για μέτρηση γλυκόζης/ glucometer test strips ASCENSIA NOVAGEM", 666)]

GREEK_DOSE = ("Δισκίο", "ΤΗΝ ΗΜΕΡΑ", "Στοματική χρήση")
ENGLISH_DOSE = ("Tablet", "PER DAY", "Oral use")


def _eur(c: int) -> str:
    return f"{c / 100:.2f}"


def _line_amounts(price: int, qty: int, exempt: bool, pc2: int) -> dict[str, int]:
    if qty == 0:
        return {"hio": 0, "copay": 0, "pc2": 0, "ben": 0, "total": 0}
    total = price * qty
    copay = 0 if exempt else 100
    pc2 = min(pc2, max(0, total - copay))
    ben = copay + pc2
    return {"hio": total - ben, "copay": copay, "pc2": pc2, "ben": ben, "total": total}


def _xml(*, typ: str, rx: int, disp: int, at: datetime, eff: date, patient: dict, doctor: tuple,
         staff: tuple, lines: list[str], tot: dict[str, int]) -> bytes:
    off = "+0300" if 4 <= at.month <= 10 else "+0200"
    items = "".join(lines)
    drugs = f"<DrugItems>{items}</DrugItems><ConsumableItems/>" if typ == "01" \
        else f"<DrugItems/><ConsumableItems>{items}</ConsumableItems>"
    return f"""<Dispensing><Header>
<UserDetails><Username>{staff[0]}</Username><UserLastName>{staff[2]}</UserLastName><UserFirstName>{staff[1]}</UserFirstName><UserDocType>NID</UserDocType><UserDocId>0000000000</UserDocId></UserDetails>
<PrescriptionId>{rx}</PrescriptionId><DispensingId>{disp}</DispensingId><DispensingProviderId>{PROVIDER}</DispensingProviderId>
<Timestamp>{at:%Y-%m-%d %H:%M:%S} {off}</Timestamp><PrescriptionVisitId>{rx + 1000000}</PrescriptionVisitId>
<PrescriptionEffectiveDate>{eff.isoformat()}</PrescriptionEffectiveDate>
<BeneficiaryDetails><BeneficiaryId>{patient['nid']}</BeneficiaryId><BeneficiaryDocType>NID</BeneficiaryDocType><BeneficiaryName>{patient['first']}</BeneficiaryName><BeneficiaryLastName>{patient['last']}</BeneficiaryLastName><BeneficiaryGender>{patient['g']}</BeneficiaryGender><BeneficiaryDOB>{patient['dob']}</BeneficiaryDOB><BeneficiaryHIOcode>{patient['hio']}</BeneficiaryHIOcode></BeneficiaryDetails>
<IssuingProviderDetails><IssuingProviderId>{doctor[0]}</IssuingProviderId><IssuingProviderName>{doctor[1]}</IssuingProviderName><IssuingProviderLastName>{doctor[2]}</IssuingProviderLastName><IssuingProviderWorkPhoneNumber>22000000</IssuingProviderWorkPhoneNumber></IssuingProviderDetails>
<Type>{typ}</Type></Header>{drugs}<Footer>
<TotalBeneficiaryCopaymentAmount>{_eur(tot['copay'])}</TotalBeneficiaryCopaymentAmount><TotalBeneficiaryPC2Amount>{_eur(tot['pc2'])}</TotalBeneficiaryPC2Amount>
<TotalBeneficiaryAmount>{_eur(tot['ben'])}</TotalBeneficiaryAmount><TotalHIOAmount>{_eur(tot['hio'])}</TotalHIOAmount><TotalDispensingAmount>{_eur(tot['total'])}</TotalDispensingAmount>
</Footer></Dispensing>""".encode()


def _amount_tags(a: dict[str, int]) -> str:
    return (f"<HIOAmount>{_eur(a['hio'])}</HIOAmount><BeneficiaryCopaymentAmount>{_eur(a['copay'])}</BeneficiaryCopaymentAmount>"
            f"<BeneficiaryPC2Amount>{_eur(a['pc2'])}</BeneficiaryPC2Amount><TotalBeneficiaryAmount>{_eur(a['ben'])}</TotalBeneficiaryAmount>"
            f"<TotalAmount>{_eur(a['total'])}</TotalAmount><HIOCoveredFlag>YES</HIOCoveredFlag>")


def generate(*, patients: int = 60, months: int = 7, today: date | None = None,
             seed: int = 2026) -> list[tuple[str, bytes]]:
    """→ [(όνομα αρχείου, XML bytes)] — ντετερμινιστικό για δεδομένο seed."""
    rnd = random.Random(seed)
    today = today or date.today()
    start = today - timedelta(days=30 * months)
    out: list[tuple[str, bytes]] = []
    rx_no, disp_no, line_no = 90000000, 150000000, 400000000

    for i in range(patients):
        p = {"nid": f"99{i:08d}", "first": rnd.choice(FIRST), "last": rnd.choice(LAST),
             "g": rnd.choice("MF"), "dob": date(rnd.randint(1935, 1995), rnd.randint(1, 12), rnd.randint(1, 28)).isoformat(),
             "hio": str(900000 + i)}
        exempt = rnd.random() < 0.3
        english = rnd.random() < 0.5
        doctor = rnd.choice(DOCTORS)
        lost_after = rnd.choice([None, None, None, 2, 3, 4])  # ~1 στους 2 χάνεται κάπου στη μέση
        diabetic = rnd.random() < 0.25
        meds = rnd.sample(DRUGS, rnd.randint(1, 4))
        eff = start + timedelta(days=rnd.randint(0, 25))
        # αλυσίδες 6 εκτελέσεων, μία νέα συνταγή όταν τελειώνει η προηγούμενη
        while eff < today:
            rx_no += 1
            for k in range(1, 7):
                at_day = eff + timedelta(days=28 * (k - 1) + rnd.randint(-2, 3))
                if at_day > today or (lost_after and k > lost_after):
                    break
                at = datetime(at_day.year, at_day.month, at_day.day, rnd.randint(8, 20), rnd.randint(0, 59), rnd.randint(0, 59))
                lines, tot = [], {"hio": 0, "copay": 0, "pc2": 0, "ben": 0, "total": 0}
                for bc, hio, desc, pkg, _units, price, amt, per_day in meds:
                    line_no += 1
                    need = 2 if per_day * amt * 28 > _units else 1
                    qty = 0 if rnd.random() < 0.12 else need
                    pc2 = rnd.choice([0, 0, 0, 77, 178, 368]) if not exempt else 0
                    a = _line_amounts(price, qty, exempt, pc2)
                    for key in tot:
                        tot[key] += a[key]
                    unit, per, route = ENGLISH_DOSE if english else GREEK_DOSE
                    exp = f"{(at.year + 2) % 100:02d}{rnd.randint(1, 12):02d}00"
                    emvs = "".join(f"<EMVOCode>01{bc}17{exp}10L{rnd.randint(1000, 9999)} 21SYN{rnd.randint(10**8, 10**9)}</EMVOCode>"
                                   for _ in range(qty))
                    lines.append(
                        f"<Drug><Id>{line_no}</Id><Barcode>{bc}</Barcode><Barcode2/><HIOcode>{hio}</HIOcode>"
                        f"<PotentialDispInstances>6</PotentialDispInstances><CurrentDispInstance>{k}</CurrentDispInstance>"
                        f"<QtyPresc>{need}</QtyPresc><QtyDisp>{qty}</QtyDisp>"
                        f"<EMVOCodes>{emvs}</EMVOCodes><Description>{escape(desc)}</Description>"
                        f"<PackageDescription>{escape(pkg)}</PackageDescription><DosageAmount>{amt} {unit}</DosageAmount>"
                        f"<DosageFrequency>{per_day} {per}</DosageFrequency><DosageTiming>na</DosageTiming>"
                        f"<DosageDurationDays>28</DosageDurationDays><RouteOfAdministration>{route}</RouteOfAdministration>"
                        f"<DoctorsInstructions/><PharmacistsComments/>{_amount_tags(a)}</Drug>")
                disp_no += 1
                out.append((f"Dispensing_{disp_no}.xml", _xml(
                    typ="01", rx=rx_no, disp=disp_no, at=at, eff=eff, patient=p, doctor=doctor,
                    staff=rnd.choice(STAFF), lines=lines, tot=tot)))
                # διαβητικός: αναλώσιμα ΚΑΘΕ μήνα μαζί με τα φάρμακα, σε δικές τους συνταγές (Type 02)
                # 3 φάσεων (φάσεις 1-3 και 4-6 = δύο συνταγές). Ίδιος ρυθμός (28 ημ.) με το προεπιλεγμένο
                # διάστημα αναλωσίμων (30), αλλιώς το demo θα έδειχνε κάθε διαβητικό ως «χαμένο».
                if diabetic:
                    rx_c = rx_no + (500000 if k <= 3 else 750000)
                    clines, ctot = [], {"hio": 0, "copay": 0, "pc2": 0, "ben": 0, "total": 0}
                    for code, desc, price in CONSUMABLES:
                        line_no += 1
                        a = _line_amounts(price, 1, exempt, rnd.choice([2, 457]))
                        for key in ctot:
                            ctot[key] += a[key]
                        clines.append(
                            f"<Consumable><Id>{line_no}</Id><Barcode/><Barcode2/><Code>{code}</Code>"
                            f"<PotentialDispInstances>3</PotentialDispInstances><CurrentDispInstance>{k if k <= 3 else k - 3}</CurrentDispInstance>"
                            f"<Description>{escape(desc)}</Description><QtyPresc>1</QtyPresc><QtyDisp>1</QtyDisp>"
                            f"<DoctorsInstructions/><PharmacistsComments/>{_amount_tags(a)}</Consumable>")
                    disp_no += 1
                    out.append((f"Dispensing_{disp_no}.xml", _xml(
                        typ="02", rx=rx_c, disp=disp_no, at=at + timedelta(minutes=3), eff=eff,
                        patient=p, doctor=doctor, staff=rnd.choice(STAFF), lines=clines, tot=ctot)))
            eff = eff + timedelta(days=28 * 6)
            if lost_after:
                break
    return out


def as_zip(files: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files:
            zf.writestr(name, data)
    return buf.getvalue()


async def seed_demo(tenant_id: str, **kw) -> dict:
    """Φόρτωση συνθετικών δεδομένων σε ΚΥΠΡΙΑΚΟ φαρμακείο (αρνείται ελληνικό)."""
    from app.services.cy.gate import tenant_country
    from app.services.cy.importer import import_files
    if await tenant_country(tenant_id) != "CY":
        raise ValueError("seed_demo: μόνο σε κυπριακό φαρμακείο")
    return await import_files(tenant_id, generate(**kw))
