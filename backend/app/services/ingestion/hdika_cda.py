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

    # ── medicines (per substanceAdministration → captures executed vs not) ──
    # A dispensed substance's substanceAdministration statusCode is "completed"; one that
    # was NOT dispensed stays "active" → the prescription is partially executed (ΜΕΡΙΚΩΣ).
    any_unexec = False
    seen_codes = set()
    for sa in _iter(root, "substanceAdministration"):
        mm = _first(sa, "manufacturedMaterial")
        if mm is None:
            continue
        code = _first(mm, "code")
        name = _first(mm, "name")
        sc = _first(sa, "statusCode")
        executed = ((sc.get("code") if sc is not None else "completed") or "").lower() == "completed"
        if not executed:
            any_unexec = True
        out["medicines"].append({
            "code": (code.get("code") if code is not None else "") or "",
            "name": ((name.text or "").strip() if name is not None and name.text else
                     (code.get("displayName") if code is not None else "")) or "Φάρμακο",
            "is_executed": executed,
        })
        if code is not None and code.get("code"):
            seen_codes.add(code.get("code"))
    # fallback: if no substanceAdministration wrapped the materials, list them plainly
    if not out["medicines"]:
        for mm in _iter(root, "manufacturedMaterial"):
            code = _first(mm, "code")
            name = _first(mm, "name")
            out["medicines"].append({
                "code": (code.get("code") if code is not None else "") or "",
                "name": ((name.text or "").strip() if name is not None and name.text else
                         (code.get("displayName") if code is not None else "")) or "Φάρμακο",
                "is_executed": True,
            })
    out["has_unexecuted"] = any_unexec

    # ── repeat / recurrence metadata (ΗΔΙΚΑ CDA spec, prescription act) ──
    #   1.1.4   = επαναληψιμότητα: 1=απλή, 3/4/5/6 = 3/4/5/6-μηνη αλυσίδα → planned repeat count
    #   1.1.4.1 = Σειρά της Συνταγής → ποια επανάληψη της αλυσίδας είναι (repeat_current)
    #   1.1.4.2 = barcode της 1ης/αρχικής (repeat_root)· απών ⇒ αυτή ΕΙΝΑΙ η αρχική
    #   1.4.9 / 1.4.10 = Μηνιαία / Δίμηνη συνταγή (ρυθμός χορήγησης χρόνιας αγωγής)
    #   1.10.9 = Χρόνια Ασθένεια
    for idel in _iter(root, "id"):
        r, ext = idel.get("root"), idel.get("extension")
        if not ext:
            continue
        if r == "1.1.4.2" and "repeat_root" not in out:
            out["repeat_root"] = ext
        elif r == "1.1.4" and "repeat_type" not in out:
            out["repeat_type"] = ext            # 1 | 3 | 4 | 5 | 6
        elif r == "1.1.4.1" and "repeat_seq" not in out:
            out["repeat_seq"] = ext
        elif r == "1.4.9" and ext == "1":
            out["monthly"] = True
        elif r == "1.4.10" and ext == "1":
            out["bimonthly"] = True
        elif r == "1.10.9" and ext == "1":
            out["chronic"] = True

    # ── treatment window (effectiveTime low/high) → monthly repeat schedule + recurrence. ──
    highs, lows = [], []
    for et in _iter(root, "high"):
        v = (et.get("value") or "")[:8]
        if len(v) == 8 and v.isdigit():
            highs.append(v)
    for et in _iter(root, "low"):
        v = (et.get("value") or "")[:8]
        if len(v) == 8 and v.isdigit():
            lows.append(v)
    if highs:
        out["valid_until"] = max(highs)  # YYYYMMDD
    if lows:
        out["valid_from"] = min(lows)    # YYYYMMDD — schedule start
    return out


# ── full portal-style detail (on-demand) ─────────────────────────────────────
def _id_map(el) -> dict:
    """root → extension (first occurrence) for all <id> under `el`."""
    out: dict = {}
    for idel in _iter(el, "id"):
        r, ext = idel.get("root"), idel.get("extension")
        if r and ext is not None and r not in out:
            out[r] = ext
    return out


def _date(v):
    v = (v or "")[:8]
    return f"{v[6:8]}/{v[4:6]}/{v[0:4]}" if len(v) == 8 and v.isdigit() else None


def _dt(v):
    v = v or ""
    if len(v) >= 12 and v[:12].isdigit():
        return f"{v[6:8]}/{v[4:6]}/{v[0:4]} {v[8:10]}:{v[10:12]}"
    return _date(v)


def _flag(v) -> bool:
    return str(v).strip() in ("1", "true", "True")


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_cda_full(text: str) -> dict:
    """Rich, portal-equivalent view of one eDispensation CDA: issue/deadline dates,
    exemption/opinion/surcharge flags, and per-line lot/prices/dosage/participation.
    Builds on parse_cda() (patient/doctor/icd10) and never raises."""
    out: dict = {**parse_cda(text), "details": {}, "lines": []}
    try:
        root = ET.fromstring(text.encode("utf-8") if isinstance(text, str) else text)
    except ET.ParseError:
        return out

    # prescription-level act = first <act> whose effectiveTime <low> has a real value
    presc = None
    for act in _iter(root, "act"):
        et = _first(act, "effectiveTime")
        low = _first(et, "low") if et is not None else None
        if low is not None and low.get("value"):
            presc = act
            break
    if presc is not None:
        ids = _id_map(presc)
        et = _first(presc, "effectiveTime")
        low = _first(et, "low") if et is not None else None
        high = _first(et, "high") if et is not None else None
        out["details"] = {
            "issue_date": _date(low.get("value")) if low is not None else None,
            "deadline_date": _date(high.get("value")) if high is not None else None,
            "fund_surcharge": _flag(ids.get("1.1.22.1")),
            "fund_surcharge_amount": _num(ids.get("1.1.22")),
            "patient_share_total": _num(ids.get("1.1.2.4")),
            "fund_share_total": _num(ids.get("1.1.2.5")),
            "exemption": _flag(ids.get("1.1.26")),
            "opinion": _flag(ids.get("1.1.23")),
        }

    # per-line: each top-level <entry> that carries a product (medicine line)
    for sup in _iter(root, "entry"):
        mm = _first(sup, "manufacturedMaterial")
        if mm is None:
            continue
        ids = _id_map(sup)
        code = _first(mm, "code")
        name = _first(mm, "name")
        form = _first(mm, "formCode")
        # active substance (last ingredient code/name)
        sub_name = sub_atc = None
        for ing in _iter(mm, "ingredient"):
            c = _first(ing, "code")
            if c is not None and c.get("code"):
                sub_atc = c.get("code")
                nm = _first(ing, "name")
                sub_name = (nm.text.strip() if nm is not None and nm.text else c.get("displayName"))
        lot = _first(mm, "lotNumberText")
        sa = _first(sup, "substanceAdministration")
        executed = True
        dose = freq = duration = None
        if sa is not None:
            sc = _first(sa, "statusCode")
            executed = ((sc.get("code") if sc is not None else "completed") or "").lower() == "completed"
            dq = _first(sa, "doseQuantity")
            if dq is not None:
                lo = _first(dq, "low")
                if lo is not None:
                    dose = f"{lo.get('value')} {lo.get('unit') or ''}".strip()
            for et2 in _iter(sa, "effectiveTime"):
                if et2.get("{http://www.w3.org/2001/XMLSchema-instance}type") == "PIVL_TS" or _first(et2, "period") is not None:
                    per = _first(et2, "period")
                    if per is not None:
                        freq = f"{per.get('value')} {per.get('unit') or ''}".strip()
            rq = _first(sa, "rateQuantity")
            if rq is not None:
                lo = _first(rq, "low")
                if lo is not None:
                    duration = f"{lo.get('value')} {lo.get('unit') or ''}".strip()
        # dispensed pack count: <supply><quantity value="N"/> (first quantity with a numeric value)
        qty = None
        sp = _first(sup, "supply")
        if sp is not None:
            for q in _iter(sp, "quantity"):
                v = _num(q.get("value"))
                if v is not None:
                    qty = int(v) if v == int(v) else v
                    break
        out["lines"].append({
            "quantity": qty or 1,
            "name": (name.text.strip() if name is not None and name.text
                     else (code.get("displayName") if code is not None else "Φάρμακο")),
            "eof_code": code.get("code") if code is not None else None,
            "form": (form.get("displayName") if form is not None else None),
            "substance": sub_name,
            "atc": sub_atc,
            "is_executed": executed,
            "dose": dose, "frequency": freq, "duration": duration,
            "lot": (lot.text.strip() if lot is not None and lot.text else ids.get("2.10.12")),
            "execution_price": _num(ids.get("2.10.9")),
            "retail_price": _num(ids.get("2.10.11")),
            "reference_price": _num(ids.get("2.10.10")),
            "participation_pct": _num(ids.get("1.4.18")),
            "patient_share": _num(ids.get("1.4.20")),
            "difference": _num(ids.get("1.4.21")),
            "substitution_allowed": _flag(ids.get("1.4.23")),
            "generic": _flag(ids.get("1.9.6.2")),
            # Coupon type — a medicine has EITHER an ΕΟΦ authenticity strip OR a QR code, never both:
            #   QR (electronic, HMVS → auto-verified, no physical check): 2.10.14="1" OR any of the QR
            #     fields filled (2.10.15 product code / 2.10.16 batch / 2.10.17 expiry).
            #   Strip (physical, needs coupon check): 2.10.12 filled OR 2.10.14="0".
            "strip": ids.get("2.10.12"),
            "qr_product_code": ids.get("2.10.15"),
            "qr_batch": ids.get("2.10.16"),
            "qr_expiry": ids.get("2.10.17"),
            "qr": (True if (ids.get("2.10.14") == "1" or ids.get("2.10.15")
                            or ids.get("2.10.16") or ids.get("2.10.17"))
                   else False if (ids.get("2.10.14") == "0" or ids.get("2.10.12"))
                   else None),
        })
    return out
