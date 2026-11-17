"""Parser του πραγματικού XML εκτέλεσης ΓεΣΥ (`<Dispensing>`).

Ένα αρχείο = ΜΙΑ εκτέλεση (DispensingId) ΜΙΑΣ συνταγής (PrescriptionId).
- `<Type>01</Type>` → φάρμακα (`DrugItems/Drug`)
- `<Type>02</Type>` → αναλώσιμα (`ConsumableItems/Consumable`: `Code` αντί HIOcode, χωρίς EMVS/δοσολογία)

Κάθε γραμμή έχει δική της θέση στην αλυσίδα: `CurrentDispInstance` / `PotentialDispInstances`.
`QtyDisp = 0` σημαίνει ότι το είδος ΔΕΝ δόθηκε σε αυτή την εκτέλεση.

Ο parser είναι ΚΑΘΑΡΗ συνάρτηση (χωρίς βάση). Επιστρέφει τον ΑΡΙΘΜΟ ΤΑΥΤΟΤΗΤΑΣ του δικαιούχου
ΜΟΝΟ για να ψευδωνυμοποιηθεί αμέσως από τον importer — δεν αποθηκεύεται ποτέ.
Τα σειριακά EMVS ΔΕΝ κρατιούνται· μόνο GTIN, λήξη και παρτίδα (χρήσιμα σε ανάκληση).
"""

from __future__ import annotations

import calendar
import re
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from defusedxml import ElementTree as SafeET

PARSE_VERSION = 2  # 2: κλειδί πελάτη HIOcode-πρώτα, EMVS <25 χαρ. εκτός
MAX_XML_BYTES = 512 * 1024  # μία εκτέλεση είναι λίγα KB· οτιδήποτε τεράστιο είναι λάθος αρχείο

TYPE_KIND = {"01": "drug", "02": "consumable"}


class CyParseError(ValueError):
    """Το αρχείο δεν είναι έγκυρη εκτέλεση ΓεΣΥ. Το μήνυμα εμφανίζεται στον φαρμακοποιό."""


# ── βοηθητικά ────────────────────────────────────────────────────────────────

def _t(el, path: str) -> str:
    node = el.find(path) if el is not None else None
    return (node.text or "").strip() if node is not None and node.text else ""


def _int(el, path: str, *, required: bool = False) -> int | None:
    v = _t(el, path)
    if not v:
        if required:
            raise CyParseError(f"λείπει το πεδίο {path}")
        return None
    try:
        return int(v)
    except ValueError as exc:
        raise CyParseError(f"μη αριθμητικό {path}: {v!r}") from exc


def _cents(el, path: str) -> int:
    v = _t(el, path)
    if not v:
        return 0
    try:
        return int((Decimal(v) * 100).quantize(Decimal("1")))
    except InvalidOperation as exc:
        raise CyParseError(f"μη έγκυρο ποσό {path}: {v!r}") from exc


def _timestamp(v: str) -> datetime:
    """«2026-11-17 09:05:18 +0200» → UTC (χειμερινή +0200 / θερινή +0300)."""
    try:
        return datetime.strptime(v, "%Y-%m-%d %H:%M:%S %z").astimezone(timezone.utc)
    except ValueError as exc:
        raise CyParseError(f"μη έγκυρη ώρα εκτέλεσης: {v!r}") from exc


def _na(v: str) -> str | None:
    """Η πύλη γράφει «na» για «δεν ορίστηκε»."""
    return None if not v or v.strip().lower() == "na" else v


def _date(v: str) -> str | None:
    if not v:
        return None
    try:
        return date.fromisoformat(v).isoformat()
    except ValueError:
        return None


# ── δοσολογία (άλλοτε ελληνικά, άλλοτε αγγλικά) ─────────────────────────────

_UNITS = {
    "tablet": "tablet", "tablets": "tablet", "δισκίο": "tablet", "δισκία": "tablet",
    "capsule": "capsule", "capsules": "capsule", "καψάκιο": "capsule", "καψάκια": "capsule",
}
_PER = [  # (μοτίβο, πολλαπλασιαστής σε «ανά ημέρα»)
    (re.compile(r"per\s*day|την\s*ημερα|ημερησ", re.I), 1.0),
    (re.compile(r"per\s*week|την\s*εβδομαδα", re.I), 1 / 7),
    (re.compile(r"per\s*month|τον\s*μηνα", re.I), 1 / 30),
]
_NUM = re.compile(r"(\d+(?:[.,]\d+)?)")
_PACK = re.compile(r"WITH\s+(\d+)", re.I)


def _strip_accents(s: str) -> str:
    return s.translate(str.maketrans("άέήίόύώϊϋΐΰΆΈΉΊΌΎΏ", "αεηιουωιυιυΑΕΗΙΟΥΩ"))


def _num(s: str) -> float | None:
    m = _NUM.search(s or "")
    return float(m.group(1).replace(",", ".")) if m else None


def parse_dosage(amount: str, frequency: str) -> dict[str, Any]:
    """«1.0 Tablet» + «2 PER DAY» → {amount: 1.0, unit: tablet, per_day: 2.0}.
    Ό,τι δεν αναγνωρίζεται μένει None — ΠΟΤΕ μαντεψιά (το raw κρατιέται δίπλα)."""
    qty = _num(amount)
    unit_raw = _NUM.sub("", amount or "").strip().lower()
    unit = _UNITS.get(_strip_accents(unit_raw), _UNITS.get(unit_raw)) or (unit_raw or None)
    freq_n = _num(frequency)
    per_day = None
    norm = _strip_accents(frequency or "").lower()
    for rx, mult in _PER:
        if freq_n is not None and rx.search(norm):
            per_day = round(freq_n * mult, 4)
            break
    return {"amount": qty, "unit": unit, "per_day": per_day}


def pack_size(description: str) -> int | None:
    """«PACK WITH 60 TABS IN BLISTER(S)» → 60."""
    m = _PACK.search(description or "")
    return int(m.group(1)) if m else None


# ── EMVS / GS1 ───────────────────────────────────────────────────────────────

_GS = "\x1d"


def parse_emvs(code: str) -> dict[str, Any] | None:
    """GS1 DataMatrix: 01=GTIN(14) · 17=λήξη ΕΕΜΜΗΗ · 10=παρτίδα · 21=σειριακό (ΑΠΟΡΡΙΠΤΕΤΑΙ).
    Οι μεταβλητού μήκους (10, 21) τελειώνουν σε κενό ή GS."""
    s = (code or "").strip()
    out: dict[str, Any] = {}
    i = 0
    while i < len(s):
        if s[i] in (" ", _GS):
            i += 1
            continue
        ai = s[i:i + 2]
        i += 2
        if ai == "01":
            out["gtin"] = s[i:i + 14]
            i += 14
        elif ai in ("17", "11"):
            v = s[i:i + 6]
            i += 6
            if ai == "17":
                out["expiry"] = _gs1_date(v)
        elif ai in ("10", "21"):
            j = i
            while j < len(s) and s[j] not in (" ", _GS):
                j += 1
            if ai == "10":
                out["lot"] = s[i:j]
            i = j  # το σειριακό (21) διαβάζεται και ΠΕΤΙΕΤΑΙ
        else:
            break  # άγνωστο AI → σταματάμε· κρατάμε ό,τι διαβάστηκε
    return out or None


def _real_emvs(code: str | None) -> bool:
    """Κάτω από 25 χαρακτήρες (χωρίς κενά/GS) δεν είναι πραγματικό EMVS — όπως ορίζει και το
    PharmacyOne Κύπρου (τιμές-κράτησης θέσης που βγάζει η πύλη)."""
    return len((code or "").replace(" ", "").replace(_GS, "")) >= 25


def patient_key(hio_code: str, doc_type: str, doc_id: str) -> str:
    """ΣΤΑΘΕΡΟ κλειδί δικαιούχου πριν την ψευδωνυμοποίηση — ίδιος κανόνας με το PharmacyOne Κύπρου:
    πρώτα ο κωδικός ΟΑΥ του δικαιούχου (χωρίς αρχικά μηδενικά)· αλλιώς τύπος εγγράφου + αριθμός
    (NID ≠ ARC — ο ίδιος αριθμός σε άλλο έγγραφο είναι άλλος άνθρωπος)."""
    hio = (hio_code or "").strip().lstrip("0")
    if hio:
        return f"HIO:{hio}"
    return f"{(doc_type or 'NID').strip().upper()}:{(doc_id or '').strip().lstrip('0')}"


def _gs1_date(v: str) -> str | None:
    if len(v) != 6 or not v.isdigit():
        return None
    y, m, d = 2000 + int(v[:2]), int(v[2:4]), int(v[4:6])
    if not 1 <= m <= 12:
        return None
    if d == 0:  # «00» = τέλος του μήνα (κανόνας GS1)
        d = calendar.monthrange(y, m)[1]
    try:
        return date(y, m, d).isoformat()
    except ValueError:
        return None


# ── γραμμές ──────────────────────────────────────────────────────────────────

def _amounts(el) -> dict[str, int]:
    return {
        "hio": _cents(el, "HIOAmount"),
        "copay": _cents(el, "BeneficiaryCopaymentAmount"),
        "pc2": _cents(el, "BeneficiaryPC2Amount"),
        "beneficiary": _cents(el, "TotalBeneficiaryAmount"),
        "total": _cents(el, "TotalAmount"),
    }


def _line(el, kind: str) -> dict[str, Any]:
    line: dict[str, Any] = {
        "line_id": _t(el, "Id"),
        "kind": kind,
        "barcode": _t(el, "Barcode") or None,
        "barcode2": _t(el, "Barcode2") or None,
        "code": _t(el, "HIOcode" if kind == "drug" else "Code") or None,
        "description": _t(el, "Description"),
        "instance": _int(el, "CurrentDispInstance", required=True),
        "instances": _int(el, "PotentialDispInstances", required=True),
        "qty_presc": _int(el, "QtyPresc") or 0,
        "qty_disp": _int(el, "QtyDisp") or 0,
        "covered": _t(el, "HIOCoveredFlag").upper() == "YES",
        "doctor_instructions": _t(el, "DoctorsInstructions") or None,
        "amounts": _amounts(el),
    }
    if kind == "drug":
        pkg = _t(el, "PackageDescription")
        dose = parse_dosage(_t(el, "DosageAmount"), _t(el, "DosageFrequency"))
        line.update({
            "package": pkg or None,
            "pack_size": pack_size(pkg),
            "dosage": {**dose,
                       "raw_amount": _t(el, "DosageAmount") or None,
                       "raw_frequency": _t(el, "DosageFrequency") or None,
                       "timing": _na(_t(el, "DosageTiming")),
                       "duration_days": _int(el, "DosageDurationDays"),
                       "route": _t(el, "RouteOfAdministration") or None},
            "emvs": [e for e in (parse_emvs(c.text or "") for c in el.findall("EMVOCodes/EMVOCode")
                                 if _real_emvs(c.text)) if e],
        })
        # Ημέρες που καλύπτει ό,τι δόθηκε — μόνο όταν ΟΛΑ είναι γνωστά (αλλιώς None, ποτέ μαντεψιά)
        per_unit = (dose["amount"] or 0) * (dose["per_day"] or 0)
        line["days_covered"] = (round(line["qty_disp"] * line["pack_size"] / per_unit)
                                if line["qty_disp"] and line["pack_size"] and per_unit else None)
    return line


# ── εκτέλεση ─────────────────────────────────────────────────────────────────

def parse_dispensing(data: bytes) -> dict[str, Any]:
    """bytes XML → dict εκτέλεσης. Σηκώνει CyParseError με κατανοητό μήνυμα."""
    if not data or not data.strip():
        raise CyParseError("κενό αρχείο")
    if len(data) > MAX_XML_BYTES:
        raise CyParseError("πολύ μεγάλο αρχείο για μία εκτέλεση")
    try:
        root = SafeET.fromstring(data)
    except Exception as exc:  # noqa: BLE001 — κάθε σφάλμα XML/ασφάλειας → ένα μήνυμα
        raise CyParseError("δεν είναι έγκυρο XML") from exc
    if root.tag != "Dispensing":
        raise CyParseError("δεν είναι αρχείο εκτέλεσης ΓεΣΥ (<Dispensing>)")

    h = root.find("Header")
    if h is None:
        raise CyParseError("λείπει η κεφαλίδα")
    typ = _t(h, "Type")
    kind = TYPE_KIND.get(typ)
    if not kind:
        raise CyParseError(f"άγνωστος τύπος εκτέλεσης {typ!r}")

    dispensing_id = _t(h, "DispensingId")
    prescription_id = _t(h, "PrescriptionId")
    if not dispensing_id or not prescription_id:
        raise CyParseError("λείπει ο αριθμός εκτέλεσης ή συνταγής")

    b = h.find("BeneficiaryDetails")
    national_id = _t(b, "BeneficiaryId")
    if not national_id:
        raise CyParseError("λείπει η ταυτότητα δικαιούχου")
    doc = h.find("IssuingProviderDetails")
    user = h.find("UserDetails")

    if kind == "drug":
        lines = [_line(el, "drug") for el in root.findall("DrugItems/Drug")]
    else:
        lines = [_line(el, "consumable") for el in root.findall("ConsumableItems/Consumable")]
    if not lines:
        raise CyParseError("η εκτέλεση δεν έχει είδη")

    f = root.find("Footer")
    totals = {
        "hio": _cents(f, "TotalHIOAmount"),
        "copay": _cents(f, "TotalBeneficiaryCopaymentAmount"),
        "pc2": _cents(f, "TotalBeneficiaryPC2Amount"),
        "beneficiary": _cents(f, "TotalBeneficiaryAmount"),
        "total": _cents(f, "TotalDispensingAmount"),
    }
    # ΑΚΕΡΑΙΟΤΗΤΑ: τα σύνολα του Footer πρέπει να βγαίνουν από τις γραμμές — αλλιώς απόρριψη
    for k, v in totals.items():
        s = sum(ln["amounts"][k] for ln in lines)
        if s != v:
            raise CyParseError(f"τα σύνολα δεν συμφωνούν με τις γραμμές ({k}: {s} ≠ {v} λεπτά)")

    instance = max(ln["instance"] for ln in lines)
    instances = max(ln["instances"] for ln in lines)
    return {
        "dispensing_id": dispensing_id,
        "prescription_id": prescription_id,
        "visit_id": _t(h, "PrescriptionVisitId") or None,
        "kind": kind,
        "provider_id": _t(h, "DispensingProviderId"),
        "dispensed_at": _timestamp(_t(h, "Timestamp")),
        "effective_date": _date(_t(h, "PrescriptionEffectiveDate")),
        # ⚠ μόνο για ψευδωνυμοποίηση — ΔΕΝ αποθηκεύεται (ο importer τα αφαιρεί)
        "national_id": national_id,
        "patient_key": patient_key(_t(b, "BeneficiaryHIOcode"), _t(b, "BeneficiaryDocType"), national_id),
        # ταυτότητα/ARC ΠΑΝΤΑ (ακόμη κι όταν υπάρχει κωδικός ΟΑΥ): με αυτήν ταυτοποιεί ο φαρμακοποιός
        # τον πελάτη όταν τον προσκαλεί στην πύλη — ο πελάτης ξέρει την ταυτότητά του, όχι τον κωδικό ΟΑΥ
        "id_key": patient_key("", _t(b, "BeneficiaryDocType"), national_id),
        "patient": {
            "first_name": _t(b, "BeneficiaryName"),
            "last_name": _t(b, "BeneficiaryLastName"),
            "gender": _t(b, "BeneficiaryGender") or None,
            "dob": _date(_t(b, "BeneficiaryDOB")),
            "hio_code": _t(b, "BeneficiaryHIOcode") or None,
        },
        "doctor": {
            "id": _t(doc, "IssuingProviderId") or None,
            "first_name": _t(doc, "IssuingProviderName"),
            "last_name": _t(doc, "IssuingProviderLastName"),
            "phones": list(dict.fromkeys(_t(doc, "IssuingProviderWorkPhoneNumber").split())),
        },
        "user": {
            "username": _t(user, "Username") or None,
            "name": f"{_t(user, 'UserFirstName')} {_t(user, 'UserLastName')}".strip() or None,
        },
        "instance": instance,
        "instances": instances,
        "closes_prescription": all(ln["instance"] >= ln["instances"] for ln in lines),
        "lines": lines,
        "totals": totals,
        "parse_version": PARSE_VERSION,
    }
