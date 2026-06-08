"""Parse the ΗΔΙΚΑ full-prescription document (HL7 v3 CDA, `application/x-hl7`)
returned by GET /api/v1/prescriptions/get/{barcode}.

The execution-search/prescriptions-search views are summaries; the rich data
(doctor, ICD-10 diagnoses, individual medicines, patient demographics) lives only
in this CDA ClinicalDocument. We navigate it namespace-agnostically and pull fields
by their HL7 `root` OIDs / codeSystem names.

Key locations (verified against the ΗΔΙΚΑ test environment):
  patient   recordTarget/patientRole : id[root=1.10.1]=AMKA · patient/administrativeGenderCode ·
            patient/birthTime · addr/city · id[root=1.10.30.2]=fund name
  doctor    author/assignedAuthor : id[root=1.19.2]=specialty · assignedPerson/name (given+family)
  ICD-10    observation/value[codeSystemName=ICD10] : @code + @displayName
  medicine  substanceAdministration/consumable/manufacturedProduct/manufacturedMaterial :
            code/@code (EOF product code) + name
"""
from __future__ import annotations

import xml.etree.ElementTree as ET


def _ln(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]  # "{ns}Foo" → "Foo"


def _iter(el, name: str) -> list:
    return [e for e in el.iter() if _ln(e.tag) == name]


def _first(el, name):
    for e in el.iter():
        if _ln(e.tag) == name:
            return e
    return None


def parse_cda(text: str) -> dict:
    """HL7 CDA text → {patient, doctor, icd10[], medicines[]}. Defensive: any missing
    node just yields empty/partial data rather than raising."""
    out: dict = {"patient": {}, "doctor": {}, "icd10": [], "medicines": []}
    try:
        root = ET.fromstring(text.encode("utf-8") if isinstance(text, str) else text)
    except ET.ParseError:
        return out

    # ── patient ──
    rt = _first(root, "recordTarget")
    if rt is not None:
        for idel in _iter(rt, "id"):
            r = idel.get("root")
            if r == "1.10.1":
                out["patient"]["amka"] = idel.get("extension")
            elif r == "1.10.30.2":
                out["patient"]["fund_name"] = idel.get("extension")
            elif r == "1.10.30.1":
                out["patient"]["fund_code"] = idel.get("extension")
        g = _first(rt, "administrativeGenderCode")
        if g is not None:
            out["patient"]["sex"] = (g.get("code") or "").upper()[:1]
        b = _first(rt, "birthTime")
        if b is not None and (b.get("value") or "")[:4].isdigit():
            out["patient"]["birth_year"] = int(b.get("value")[:4])
        city = _first(rt, "city")
        if city is not None and city.text:
            out["patient"]["city"] = city.text.strip()
        pp = _first(rt, "patient")          # <patient> holds the name
        if pp is not None:
            nm = _first(pp, "name")
            if nm is not None:
                given = _first(nm, "given")
                family = _first(nm, "family")
                parts = [(family.text if family is not None else ""), (given.text if given is not None else "")]
                name = " ".join(p.strip() for p in parts if p and p.strip())
                if name:
                    out["patient"]["full_name"] = name

    # ── doctor (first author) ──
    au = _first(root, "author")
    if au is not None:
        for idel in _iter(au, "id"):
            r = idel.get("root")
            if r == "1.19.2":
                out["doctor"]["specialty"] = idel.get("extension")
            elif r == "1.18":
                out["doctor"]["id"] = idel.get("extension")
            elif r == "1.19" and not out["doctor"].get("id"):
                out["doctor"]["id"] = idel.get("extension")
        nm = _first(au, "name")
        if nm is not None:
            given = _first(nm, "given")
            family = _first(nm, "family")
            parts = [(family.text if family is not None else ""), (given.text if given is not None else "")]
            name = " ".join(p.strip() for p in parts if p and p.strip())
            if name:
                out["doctor"]["name"] = name

    # ── ICD-10 diagnoses ──
    seen = set()
    for v in _iter(root, "value"):
        if (v.get("codeSystemName") or "").upper() == "ICD10" and v.get("code"):
            code = v.get("code")
            if code not in seen:
                seen.add(code)
                out["icd10"].append({"code": code, "name": v.get("displayName")})

    # ── medicines ──
    for mm in _iter(root, "manufacturedMaterial"):
        code = _first(mm, "code")
        name = _first(mm, "name")
        out["medicines"].append({
            "code": (code.get("code") if code is not None else "") or "",
            "name": ((name.text or "").strip() if name is not None and name.text else
                     (code.get("displayName") if code is not None else "")) or "Φάρμακο",
        })
    return out
