"""Real ΗΔΙΚΑ HTTP client — API ΦΑΡΜΑΚΟΠΟΙΩΝ v2 (e-prescription).

Built against the OFFICIAL test spec (see docs/IDIKA_API.md):
  base   <base_url>            e.g. https://testeps.e-prescription.gr/pharmapiv2
  auth   HTTP Basic (username/password) + header `Api-Key` (APPLICATION key, μοναδικό
         ανά εφαρμογή) + header `Accept: application/xml`. Optional `X-DOCTOR-IP`.
  list   GET /api/v1/prescription-execution/search?page&size&executionDate&pharmacyId
  money  GET /api/v1/me/clearance/prescriptions?claimsHeaderId&...
  Responses are XML (application/xml).

Verified live error ladder (test env): no Api-Key → 604· no Accept → 3· wrong key →
911 "Application key is not valid". So a VALID per-application Api-Key is required;
it (and base_url/username/password/pharmacy_id/doctor_ip) all come from credentials.

The per-record XML element names are finalized against a REAL response once a valid
key is in place — mapping below reads the documented PharmPrescriptionDTO fields
defensively so flipping to live is a localized change.

Transient failures raise ConnectionError/TimeoutError so the Celery task retries.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections.abc import Iterator
from datetime import datetime, timezone

import httpx

from app.services.ingestion.canonical import (
    CanonicalDoctor,
    CanonicalExecution,
    CanonicalFund,
    CanonicalItem,
    CanonicalPatient,
)
from app.services.ingestion.hdika_cda import parse_cda

_PAGE_SIZE = 100                  # ΗΔΙΚΑ rejects size>~150 with HTTP 400; 100 is safe
_MAX_BACKFILL_DAYS = 400          # cap day-by-day backfill (search is per-day)
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


def _strip_ns(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]  # "{ns}Foo" → "Foo"


import re as _re


def _gateway_message(text: str) -> str | None:
    """If the body is an IBM gateway HTML page (not app XML), return a clear Greek
    message. Detects the ISAM account-lockout (HPDIA0306W) explicitly so the operator
    knows to WAIT rather than retry (retries extend the lockout)."""
    head = (text or "")[:400].lower()
    if not (head.lstrip().startswith(("<!doctype", "<html")) or "<html" in head):
        return None
    visible = _re.sub(r"<[^>]*>", " ", text or "")
    visible = _re.sub(r"\s+", " ", visible).strip()
    if "hpdia0306w" in visible.lower() or "locked out" in visible.lower() or "κλειδ" in visible.lower():
        return ("Ο λογαριασμός ΗΔΙΚΑ κλειδώθηκε προσωρινά από την πύλη λόγω πολλών "
                "αποτυχημένων προσπαθειών σύνδεσης. Περιμένετε ~15–30 λεπτά και "
                "δοκιμάστε ΜΙΑ φορά (μην επαναλαμβάνετε — οι προσπάθειες παρατείνουν το κλείδωμα).")
    # generic gateway page → surface its visible text (helps diagnose)
    return f"Η πύλη ΗΔΙΚΑ επέστρεψε σελίδα σφάλματος: {visible[:180]}" if visible else None


def _to_dict(el: ET.Element) -> dict:
    """Namespace-agnostic XML element → nested dict/list. Repeated children become
    lists; leaf text is kept. Robust to the JAXB-style XML ΗΔΙΚΑ returns."""
    out: dict = {}
    for child in el:
        key = _strip_ns(child.tag)
        val = _to_dict(child) if len(child) else (child.text or "").strip()
        if key in out:
            if not isinstance(out[key], list):
                out[key] = [out[key]]
            out[key].append(val)
        else:
            out[key] = val
    return out


def _first(d: dict, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d[k]
    return default


def _as_list(v) -> list:
    return v if isinstance(v, list) else ([] if v in (None, "") else [v])


class HdikaClient:
    def __init__(self, credentials: dict) -> None:
        c = credentials or {}
        self.c = c
        self.base = (c.get("base_url") or c.get("live_endpoint") or "").rstrip("/")
        self.username = c.get("username", "")
        self.password = c.get("password", "")
        self.api_key = c.get("api_key", "")                       # APPLICATION key
        self.pharmacy_id = c.get("pharmacy_id") or c.get("pharmacy_code")
        self.skipped_days = 0           # days skipped due to transient gateway errors
        headers = {"Accept": "application/xml"}
        if self.api_key:
            headers["Api-Key"] = self.api_key
        if c.get("doctor_ip"):
            headers["X-DOCTOR-IP"] = c["doctor_ip"]
        # Basic auth + Api-Key + Accept on every request (no token/login step in v2).
        self._client = httpx.Client(
            timeout=_TIMEOUT,
            auth=(self.username, self.password) if self.username else None,
            headers=headers,
        )

    def _url(self, path: str) -> str:
        return f"{self.base}{path}"

    def authenticate(self) -> None:
        """v2 has no login step — creds ride every request. Validate them cheaply so
        bad/missing keys fail fast with the ΗΔΙΚΑ error (604 no key / 911 invalid key)."""
        try:
            r = self._client.get(self._url("/api/v1/user/me"))
        except httpx.TimeoutException as exc:
            raise TimeoutError(f"ΗΔΙΚΑ auth timeout: {exc}") from exc
        except httpx.TransportError as exc:
            raise ConnectionError(f"ΗΔΙΚΑ auth transport error: {exc}") from exc
        text = r.text or ""
        gw = _gateway_message(text)
        if gw:                       # IBM gateway HTML (lockout / error page)
            raise PermissionError(gw)
        if r.status_code in (401, 403, 404):
            raise PermissionError(
                f"Η πύλη ΗΔΙΚΑ απέρριψε το αίτημα (HTTP {r.status_code}). Συνήθως σημαίνει "
                "λάθος περιβάλλον (test/production) ή μη έγκυρα credentials/endpoint γι' αυτό το περιβάλλον.")
        # app-level XML ApiError (π.χ. 911 invalid key) → ανέδειξε το <description>
        if r.status_code >= 400:
            if "<description>" in text:
                text = text.split("<description>", 1)[1].split("</description>", 1)[0]
            raise PermissionError(f"ΗΔΙΚΑ: {text[:200]}")

    # ── auto-discovery: pharmacy profile from ΗΔΙΚΑ ────────
    def fetch_user_info(self) -> dict:
        """GET /api/v1/user/me (+ /contracts) → the pharmacy fields we should NOT ask
        the operator to type: pharmacy_id, ΑΦΜ, ΣΗΣ code, ΑΜ ΕΟΠΥΥ, name, history_from.
        Only credentials stay manual; everything else is discovered → fewer errors."""
        d = _to_dict(self._get_xml("/api/v1/user/me", {}))
        ph = d.get("pharmacy") if isinstance(d.get("pharmacy"), dict) else {}
        city = ph.get("city")
        info = {
            "pharmacy_id": _first(ph, "id"),
            "pharmacy_name": _first(ph, "name"),
            "afm": _first(ph, "taxRegistryNo") or _first(d, "taxRegistryNo"),
            "pharmacy_code": _first(ph, "pharmacyIdentification"),
            "eopyy_registry": _first(ph, "healthProviderId"),
            "address": _first(ph, "address"),
            "city": city.get("name") if isinstance(city, dict) else city,
        }
        try:  # contract start → history_from (earliest effectiveFrom)
            cr = _to_dict(self._get_xml("/api/v1/user/me/contracts", {}))
            contracts = _as_list(cr.get("contents"))
            froms = [c.get("effectiveFrom") for c in contracts
                     if isinstance(c, dict) and c.get("effectiveFrom")]
            if froms:
                info["history_from"] = min(froms)
        except Exception:  # noqa: BLE001 — contracts is non-critical (ΗΔΙΚΑ test 500s it)
            pass  # operator can set history_from manually
        return {k: str(v) for k, v in info.items() if v not in (None, "")}

    # ── paging: executed prescriptions ─────────────────────
    @staticmethod
    def _rows(data: dict) -> list:
        """Spring Page rows: <contents><item>…</item></contents> → flat list."""
        contents = _first(data, "contents", "content", "items", default=[])
        if isinstance(contents, dict) and "item" in contents:
            contents = contents["item"]
        return _as_list(contents)

    @staticmethod
    def _is_last(data: dict, n: int) -> bool:
        last = str(data.get("lastPage", data.get("last", ""))).lower() == "true"
        return last or n < _PAGE_SIZE

    def _fetch_cda(self, barcode: str) -> dict:
        """Full prescription (doctor / ICD-10 / medicines / patient) as HL7 CDA from
        /prescriptions/get/{barcode} (Accept: application/x-hl7). Best-effort: returns {}
        on any error so a missing detail never aborts the run."""
        if not barcode:
            return {}
        try:
            params = {"pharmacyId": self.pharmacy_id} if self.pharmacy_id else {}
            r = self._client.get(self._url(f"/api/v1/prescriptions/get/{barcode}"),
                                 params=params, headers={"Accept": "application/x-hl7"})
            if r.status_code == 200 and r.text.lstrip().startswith("<?xml"):
                return parse_cda(r.text)
        except Exception:  # noqa: BLE001
            pass
        return {}

    def iter_executions(self, since: datetime | None) -> Iterator[CanonicalExecution]:
        """Yield canonical executions from `since`→today. Driver = prescription-execution
        /search (per executionDate, paged) for amounts/fund; each row is enriched by its
        barcode via the full HL7 CDA (doctor, ICD-10, medicines, patient)."""
        from datetime import timedelta
        end = datetime.now(tz=timezone.utc).date()
        start = since.date() if since else end
        if (end - start).days > _MAX_BACKFILL_DAYS:        # safety cap for huge backfills
            start = end - timedelta(days=_MAX_BACKFILL_DAYS)
        day = start
        while day <= end:
            page = 0
            while True:
                params = {"size": _PAGE_SIZE, "page": page,
                          "executionDate": day.isoformat()}
                if self.pharmacy_id:
                    params["pharmacyId"] = self.pharmacy_id
                try:
                    data = _to_dict(self._get_xml("/api/v1/prescription-execution/search", params))
                except Exception:  # noqa: BLE001 — one bad day must not abort the backfill
                    self.skipped_days += 1
                    break
                records = self._rows(data)
                for raw in records:
                    if isinstance(raw, dict):
                        presc = raw.get("prescription") if isinstance(raw.get("prescription"), dict) else {}
                        bc = str(_first(presc, "barcode") or _first(raw, "barcode", default=""))
                        yield self._map_full(raw, self._fetch_cda(bc))
                if self._is_last(data, len(records)):
                    break
                page += 1
            day += timedelta(days=1)

    @staticmethod
    def _map_full(ex: dict, cda: dict) -> CanonicalExecution:
        """Combine an execution row (amounts/fund, from execution-search) with the full
        CDA (patient/doctor/ICD-10/medicines) → a complete CanonicalExecution.

        Per-medicine prices are not in the CDA (they need getExecutionWithCalcs), so the
        prescription total rides the first medicine line — prescription-level revenue is
        exact; the per-line revenue split is approximate (a documented v1 limitation)."""
        presc = ex.get("prescription") if isinstance(ex.get("prescription"), dict) else {}
        barcode = str(_first(presc, "barcode") or _first(ex, "barcode", default=""))
        fund_d = presc.get("socialInsuranceDTO") if isinstance(presc.get("socialInsuranceDTO"), dict) else {}
        total = _eur_cents(_first(ex, "totalValue", "payableAmount", default=0))
        share = _eur_cents(_first(ex, "participationValue", default=0))

        cda_pat = cda.get("patient") or {}
        cda_doc = cda.get("doctor") or {}
        meds = cda.get("medicines") or []
        sex = (cda_pat.get("sex") or "U")
        sex = "M" if sex.startswith("M") else "F" if sex.startswith("F") else "U"

        # one item per real medicine; first line carries the prescription total
        items: list[CanonicalItem] = []
        for n, m in enumerate(meds):
            items.append(CanonicalItem(
                barcode=str(m.get("code") or f"{barcode}-{n}"),
                name=m.get("name") or "Φάρμακο",
                quantity=1,
                retail_price=total if n == 0 else 0,
                is_executed=True,
            ))
        if not items:  # CDA unavailable → keep a prescription-level line so revenue/validation hold
            items = [CanonicalItem(barcode=barcode or "rx", name="Συνταγή (ΗΔΙΚΑ)",
                                   quantity=1, retail_price=total, is_executed=True)]

        fund_name = _first(fund_d, "name") or cda_pat.get("fund_name") or "ΕΟΠΥΥ"
        fund_code = str(_first(fund_d, "shortName", "id", default="") or cda_pat.get("fund_code") or "EOPYY")
        return CanonicalExecution(
            source="HDIKA",
            external_id=barcode,
            executed_at=_parse_dt(_first(ex, "executionDate", "executed_at")),
            patient=CanonicalPatient(
                national_id=str(cda_pat.get("amka") or barcode),  # never empty (validator)
                sex=sex,
                birth_year=cda_pat.get("birth_year"),
                area=cda_pat.get("city") or "unknown"),
            doctor=CanonicalDoctor(full_name=cda_doc.get("name") or "Άγνωστος",
                                   specialty=cda_doc.get("specialty")),
            fund=CanonicalFund(code=fund_code, name=fund_name),
            items=items,
            icd10=[d["code"] for d in cda.get("icd10", []) if d.get("code")],
            repeat_current=1,
            repeat_total=1,
            patient_share=share,
        )

    def _get_xml(self, path: str, params: dict) -> ET.Element:
        try:
            r = self._client.get(self._url(path), params=params)
            gw = _gateway_message(r.text)
            if gw:                   # gateway HTML (e.g. lockout) even with HTTP 200
                raise PermissionError(gw)
            r.raise_for_status()
            return ET.fromstring(r.content)
        except PermissionError:
            raise
        except httpx.TimeoutException as exc:
            raise TimeoutError(f"ΗΔΙΚΑ list timeout: {exc}") from exc
        except httpx.TransportError as exc:
            raise ConnectionError(f"ΗΔΙΚΑ list transport error: {exc}") from exc
        except ET.ParseError as exc:
            raise ValueError(f"ΗΔΙΚΑ list: invalid XML: {exc}") from exc

    # ── mapping (ΗΔΙΚΑ XML record → canonical) ──────────────
    @staticmethod
    def map_raw(raw: dict) -> CanonicalExecution:
        """Map one ΗΔΙΚΑ prescription record (PharmPrescriptionDTO field names) to a
        CanonicalExecution. Defensive: tolerates missing nodes from the lighter
        execution-search view until detail-enrichment is wired to a confirmed payload."""
        patient = raw.get("patient") if isinstance(raw.get("patient"), dict) else {}
        doctor = raw.get("doctor") if isinstance(raw.get("doctor"), dict) else {}
        fund = raw.get("socialInsuranceDTO") or raw.get("socialInsurance") or {}
        if not isinstance(fund, dict):
            fund = {}
        diagnoses = _as_list(raw.get("diagnoses"))
        treatments = _as_list(raw.get("treatments"))
        birth = str(_first(patient, "birthDate", "birthdate", default=""))
        birth_year = int(birth[:4]) if birth[:4].isdigit() else None

        return CanonicalExecution(
            source="HDIKA",
            external_id=str(_first(raw, "barcode", "prescriptionId", default="")),
            executed_at=_parse_dt(_first(raw, "executionDate", "executed_at")),
            patient=CanonicalPatient(
                national_id=str(_first(patient, "amka", "identificationNo", default="")),
                sex=_sex(patient),
                birth_year=birth_year,
                area=_first(patient, "city", "countryName", default="unknown"),
            ),
            doctor=CanonicalDoctor(
                full_name=(f"{doctor.get('firstName','')} {doctor.get('lastName','')}".strip()
                           or "Άγνωστος"),
                specialty=doctor.get("specialtyName")),
            fund=CanonicalFund(code=str(_first(fund, "shortName", "id", default="EOPYY")),
                               name=_first(fund, "name", default="ΕΟΠΥΥ")),
            items=[_map_treatment(t) for t in treatments if isinstance(t, dict)],
            icd10=[_first(dg, "icd10Code", default="") for dg in diagnoses
                   if isinstance(dg, dict) and _first(dg, "icd10Code")],
            repeat_current=int(_first(raw, "executions", default=1) or 1),
            repeat_total=int(_first(raw, "prescriptionRepeatId", default=1) or 1),
            patient_share=_eur_cents(_first(raw, "participationValue", default=0)),
        )

    def close(self) -> None:
        self._client.close()


def _map_treatment(t: dict) -> CanonicalItem:
    med = t.get("medicine") if isinstance(t.get("medicine"), dict) else {}
    qty = int(float(_first(t, "quantityPrescribed", default=1) or 1))
    outstanding = int(float(_first(t, "quantityOutstanding", default=0) or 0))
    return CanonicalItem(
        barcode=str(_first(t, "medicineBarcode", default="")),
        name=_first(t, "medicineCommercialName", default=""),
        substance=_first(med, "activeSubstance", "substanceName"),
        quantity=qty,
        retail_price=_eur_cents(_first(t, "totalPrice", default=0)),
        wholesale_price=0,  # χονδρική: από masterdata/prices ή PharmacyOne (TODO)
        category=_category(med),
        is_executed=outstanding < qty,  # ανεκτέλεστη δραστική (§9)
    )


def _category(med: dict) -> str:
    # χαρακτηριστικά ειδών (§8) — narcotic flag on the medicine
    if str(med.get("medicineDrug", "")).lower() == "true":
        return "narcotic"
    return "normal"


def _sex(patient: dict) -> str:
    s = patient.get("sex")
    if isinstance(s, dict):
        s = _first(s, "shortName", "name", "id", default="U")
    s = str(s or "U").upper()
    return "M" if s.startswith(("M", "Α")) else "F" if s.startswith(("F", "Θ", "Γ")) else "U"


def _eur_cents(v) -> int:
    try:
        return round(float(v) * 100)
    except (TypeError, ValueError):
        return 0


def _parse_dt(v) -> datetime:
    if not v:
        return datetime.now(tz=timezone.utc)
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(tz=timezone.utc)
