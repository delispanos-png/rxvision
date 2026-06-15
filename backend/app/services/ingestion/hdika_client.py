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

import re as _re
import time
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
from app.services.ingestion.hdika_cda import parse_cda, parse_cda_full

_PAGE_SIZE = 100                  # ΗΔΙΚΑ rejects size>~150 with HTTP 400; 100 is safe
_MAX_BACKFILL_DAYS = 400          # cap day-by-day backfill (search is per-day)
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


def _strip_ns(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]  # "{ns}Foo" → "Foo"


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
    def __init__(self, credentials: dict, catalog: dict | None = None) -> None:
        c = credentials or {}
        self.c = c
        self.base = (c.get("base_url") or c.get("live_endpoint") or "").rstrip("/")
        self.username = c.get("username", "")
        self.password = c.get("password", "")
        self.api_key = c.get("api_key", "")                       # APPLICATION key
        self.pharmacy_id = c.get("pharmacy_id") or c.get("pharmacy_code")
        # whether THIS pharmacy's association is contracted with ΕΤΥΑΠ — discovered from
        # /user/me/contracts (getMyContracts) and saved to settings. When true, ΕΤΥΑΠ (not the
        # patient) pays the insured's participation on ΕΤΥΑΠ scripts (see share calc in _map_full).
        self.etyap_contracted = str(c.get("etyap_contracted", "")).strip().lower() in ("1", "true", "yes")
        self.catalog = catalog or {}     # eofCode → price/cost (Δελτίο Τιμών) for per-med analysis
        self.throttle = float(c.get("throttle") or 0)   # seconds to pause after each call (be gentle on ΗΔΙΚΑ)
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
        try:  # getMyContracts → contracted funds, history_from, county, ΕΤΥΑΠ flag
            cr = _to_dict(self._get_xml("/api/v1/user/me/contracts", {}))
            # the list is nested Spring-style as contents/item[] — _rows unwraps it (plain
            # `contents` gave a single {item:[…]} blob, so froms/funds came out empty).
            contracts = [c for c in self._rows(cr) if isinstance(c, dict)]
            froms, fund_names, county = [], [], None
            for c in contracts:
                if c.get("effectiveFrom"):
                    froms.append(c["effectiveFrom"])
                si = c.get("socialInsurance") if isinstance(c.get("socialInsurance"), dict) else {}
                nm = si.get("shortName") or si.get("name")
                if nm:
                    fund_names.append(str(nm))
                hp = c.get("healthProvider") if isinstance(c.get("healthProvider"), dict) else {}
                if hp.get("county") and not county:
                    county = str(hp["county"]).strip()
            if froms:
                info["history_from"] = min(froms)
            if county:
                info["county"] = county
            if fund_names:
                info["contracted_funds"] = ", ".join(sorted(set(fund_names)))
            # ΕΤΥΑΠ (επικουρικό σωμάτων ασφαλείας) is a Φ.Σ.-level arrangement — it is NOT a fund
            # in getMyContracts. ΗΔΙΚΑ ties it to the pharmacy's prefecture: whole Φαρμακευτικοί
            # Σύλλογοι are (or aren't) contracted. Known contracted prefectures below (expandable);
            # plus an explicit ΕΤΥΑΠ contract if one ever appears in the funds list.
            etyap_counties = {"ΑΤΤΙΚΗΣ", "ΘΕΣΣΑΛΟΝΙΚΗΣ"}
            if any("ΕΤΥΑΠ" in n.upper() for n in fund_names) or (
                    county and county.upper() in etyap_counties):
                info["etyap_contracted"] = "true"
        except Exception:  # noqa: BLE001 — contracts is non-critical (ΗΔΙΚΑ test 500s it)
            pass  # operator can set history_from / etyap_contracted manually
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
        params = {"pharmacyId": self.pharmacy_id} if self.pharmacy_id else {}
        # retry transient failures — otherwise a hiccup leaves the execution with no
        # doctor/patient/ICD (it shows up as the «Άγνωστος» doctor).
        for attempt in range(3):
            try:
                r = self._client.get(self._url(f"/api/v1/prescriptions/get/{barcode}"),
                                     params=params, headers={"Accept": "application/x-hl7"})
                if self.throttle:
                    time.sleep(self.throttle)
                if r.status_code == 200 and r.text.lstrip().startswith("<?xml"):
                    # rich parse → per-line execution/retail price + quantity + generic
                    # (superset of parse_cda, so all existing keys are still present)
                    return parse_cda_full(r.text)
                if r.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(0.4 * (attempt + 1))
                    continue
            except Exception:  # noqa: BLE001
                if attempt < 2:
                    time.sleep(0.4 * (attempt + 1))
                    continue
            break
        return {}

    def fetch_cda_full(self, barcode: str) -> dict:
        """Like _fetch_cda but returns the RICH portal-style detail (parse_cda_full):
        issue/deadline dates, flags, per-line lot/prices/dosage. For on-demand viewing."""
        from app.services.ingestion.hdika_cda import parse_cda_full
        if not barcode:
            return {}
        params = {"pharmacyId": self.pharmacy_id} if self.pharmacy_id else {}
        for attempt in range(3):
            try:
                r = self._client.get(self._url(f"/api/v1/prescriptions/get/{barcode}"),
                                     params=params, headers={"Accept": "application/x-hl7"})
                if r.status_code == 200 and r.text.lstrip().startswith("<?xml"):
                    return parse_cda_full(r.text)
                if r.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(0.4 * (attempt + 1))
                    continue
            except Exception:  # noqa: BLE001
                if attempt < 2:
                    time.sleep(0.4 * (attempt + 1))
                    continue
            break
        return {}

    def _prescription_index(self, start, end) -> dict:
        """barcode → prescription summary (executions=total repeats, expiryDate) from
        /prescriptions/search over the range. Cheap (one paged sweep) and gives the
        repeat structure (single vs 3-/6-month recurring)."""
        idx: dict = {}
        page = 0
        while True:
            params = {"size": _PAGE_SIZE, "page": page,
                      "from": start.isoformat(), "to": end.isoformat()}
            if self.pharmacy_id:
                params["pharmacyId"] = self.pharmacy_id
            try:
                data = _to_dict(self._get_xml("/api/v1/prescriptions/search", params))
            except Exception:  # noqa: BLE001 — repeat enrichment is best-effort
                break
            rows = self._rows(data)
            for r in rows:
                if isinstance(r, dict) and _first(r, "barcode"):
                    idx[str(_first(r, "barcode"))] = r
            if self._is_last(data, len(rows)):
                break
            page += 1
        return idx

    def iter_executions(self, since: datetime | None,
                        until: datetime | None = None) -> Iterator[CanonicalExecution]:
        """Yield canonical executions from `since`→`until` (default today). Driver =
        prescription-execution /search (amounts/fund, executionNo); enriched per barcode by
        the full HL7 CDA (doctor, ICD-10, medicines, patient) and /prescriptions/search."""
        from datetime import timedelta
        end = (until.date() if until else datetime.now(tz=timezone.utc).date())
        start = since.date() if since else end
        if (end - start).days > _MAX_BACKFILL_DAYS:        # safety cap for huge backfills
            start = end - timedelta(days=_MAX_BACKFILL_DAYS)
        # executionDate search returns a multi-day window, so day-by-day stepping re-sees the
        # same executions; dedup on (barcode, executionNo) so each repeat is fetched once, and
        # cache each barcode's CDA (shared by all its repeats) → one CDA fetch per prescription.
        seen: set = set()
        cda_cache: dict = {}
        day = end                       # most-recent day first → recent analytics/forecast fill fast
        while day >= start:
            # repeat info for THIS day only — interleaved so a big backfill streams
            # results immediately instead of waiting on one huge upfront sweep.
            summaries = self._prescription_index(day, day)
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
                    if not isinstance(raw, dict):
                        continue
                    presc = raw.get("prescription") if isinstance(raw.get("prescription"), dict) else {}
                    bc = str(_first(presc, "barcode") or _first(raw, "barcode", default=""))
                    execno = int(float(_first(raw, "executionNo", default=1) or 1))
                    key = (bc, execno)
                    if not bc or key in seen:        # overlapping day-windows → skip re-seen executions
                        continue
                    seen.add(key)
                    if bc not in cda_cache:          # a prescription's CDA is shared by all its repeats
                        cda_cache[bc] = self._fetch_cda(bc)
                    yield self._map_full(raw, cda_cache[bc], summaries.get(bc, {}))
                if self._is_last(data, len(records)):
                    break
                page += 1
            day -= timedelta(days=1)

    def _map_full(self, ex: dict, cda: dict, summary: dict | None = None) -> CanonicalExecution:
        """Execution row (amounts/fund/executionNo) + full CDA (patient/doctor/ICD-10/
        medicines) + repeat summary → a complete CanonicalExecution. Each medicine is a
        real line priced from the catalog (retail + wholesale → margin)."""
        summary = summary or {}
        presc = ex.get("prescription") if isinstance(ex.get("prescription"), dict) else {}
        barcode = str(_first(presc, "barcode") or _first(ex, "barcode", default=""))
        fund_d = presc.get("socialInsuranceDTO") if isinstance(presc.get("socialInsuranceDTO"), dict) else {}
        # ΗΔΙΚΑ amounts (verified against official printouts):
        #   totalValue        = reimbursed base (Αποζ.Ασφ), NOT retail
        #   totalDifference   = full retail−reference difference; sociTotalDifference = fund's part
        #   socialInsuranceSurcharge = the 1€ per-prescription fee the patient pays
        # retail            = totalValue + totalDifference
        # ΠΛΗΡΩΤΕΟ ΑΠΟ ΑΣΦ/ΝΟ = participation + (difference − fund's part) + 1€ fee + supplemental
        # ΠΛΗΡΩΤΕΟ ΑΠΟ ΤΑΜΕΙΟ = retail − ΠΛΗΡΩΤΕΟ ΑΠΟ ΑΣΦ/ΝΟ (engine: amount_total − share)
        total_value = _eur_cents(_first(ex, "totalValue", default=0))
        total_diff = _eur_cents(_first(ex, "totalDifference", default=0))
        soci_diff = _eur_cents(_first(ex, "sociTotalDifference", default=0))
        total = total_value + total_diff
        participation = _eur_cents(_first(ex, "participationValue", default=0))
        share = (participation
                 + max(0, total_diff - soci_diff)
                 + _eur_cents(_first(ex, "socialInsuranceSurcharge", default=0))
                 + _eur_cents(_first(ex, "supplementalDifferenceAmt", default=0)))
        # ── ΕΤΥΑΠ (επικουρικό σωμάτων ασφαλείας) ───────────────────────────────────────────
        # ΕΤΥΑΠ ασφαλισμένοι ανήκουν στον ΕΟΠΥΥ αλλά καλύπτονται επιπλέον από το ΕΤΥΑΠ. ΑΝ ο Φ.Σ.
        # του φαρμακείου είναι ΣΥΜΒΕΒΛΗΜΕΝΟΣ με ΕΤΥΑΠ (getMyContracts → /user/me/contracts), τότε
        # το ΕΤΥΑΠ — όχι ο ασθενής — πληρώνει τη ΣΥΜΜΕΤΟΧΗ (participationValue)· ο ασθενής μένει με
        # επιβάρυνση (διαφορά) + 1€ ΕΟΠΥΥ. Εξαίρεση: συνταγές ΕΤΥΑΠ με 100% συμμετοχή βαραίνουν
        # εξολοκλήρου τον ασθενή (ξεχωριστό τιμολόγιο/κατάσταση) → δεν μετακινούμε τη συμμετοχή.
        # Μη-συμβεβλημένα φαρμακεία: η συνταγή ΕΤΥΑΠ αντιμετωπίζεται σαν κάθε ΕΟΠΥΥ (καμία αλλαγή).
        etyap_covered = 0
        is_etyap = "ΕΤΥΑΠ" in str(_first(fund_d, "name") or "").upper()
        if self.etyap_contracted and is_etyap and 0 < participation < total_value:
            etyap_covered = participation          # ΕΤΥΑΠ αναλαμβάνει τη συμμετοχή
            share -= participation                 # ο ασθενής δεν την πληρώνει
        exec_no = int(float(_first(ex, "executionNo", default=1) or 1))
        # ΗΔΙΚΑ `executions` = πόσες φορές εκτελέστηκε ΜΕΧΡΙ ΤΩΡΑ — ΟΧΙ το πλάνο επαναλήψεων. Το
        # πραγματικό πλάνο ("3 από 4", "1 από 6") ζει στο CDA repeat schedule (parse_cda →
        # `repeat_planned`). Όταν λείπει, κρατάμε repeat_total=0 (άγνωστο) αντί να το φαμπρικάρουμε
        # = executions (που έβγαζε παραπλανητικά "N/N" badges)· το display παράγει την αλυσίδα από
        # τις εκτελέσεις + τον εξαγόμενο ρυθμό. repeat_current = ο executionNo αυτής της γραμμής.
        repeat_planned = int(cda.get("repeat_planned") or 0)
        repeat_total = repeat_planned if repeat_planned > 1 else 0

        cda_pat = cda.get("patient") or {}
        cda_doc = cda.get("doctor") or {}
        # rich per-line data (parse_cda_full): real EOF code, executed flag, per-line price (€),
        # dispensed quantity. Falls back to the light "medicines" list if rich lines are absent.
        meds = cda.get("lines") or cda.get("medicines") or []
        sex = (cda_pat.get("sex") or "U")
        sex = "M" if sex.startswith("M") else "F" if sex.startswith("F") else "U"

        # one priced line per medicine: price + quantity come from the CDA itself (authoritative);
        # the Δελτίο Τιμών catalogue only fills the wholesale cost (and a retail fallback on a miss).
        items: list[CanonicalItem] = []
        for n, m in enumerate(meds):
            eof = str(m.get("eof_code") or m.get("code") or "")
            cat = self.catalog.get(eof) or {}
            qty = int(m.get("quantity") or 1)
            # per-line retail (€→cents) STRICTLY from the CDA (authoritative for what ΗΔΥΚΑ billed):
            # retail price → execution price → 0. We do NOT fall back to the catalogue here — a line
            # with no CDA price (non-dispensed / non-reimbursed) must stay 0 so the line sum reconciles
            # with the prescription's amount_total. (Catalogue is used only for wholesale cost below.)
            price_eur = m.get("retail_price") or m.get("execution_price")
            retail_cents = int(round(price_eur * 100)) if price_eur else 0
            # Persist the FULL per-line ΗΔΥΚΑ/CDA detail so the page shows it without a live fetch
            # and KPIs can be derived (generic mix, reference-price gaps, dosage, coupon type…).
            mc = lambda x: _eur_cents(x) if x is not None else None  # noqa: E731 — €→cents, keep None
            details = {
                "eof_code": m.get("eof_code"),
                "form": m.get("form"),
                "execution_price": mc(m.get("execution_price")),
                "retail_price": mc(m.get("retail_price")),
                "reference_price": mc(m.get("reference_price")),
                "patient_share": mc(m.get("patient_share")),
                "difference": mc(m.get("difference")),
                "participation_pct": m.get("participation_pct"),
                "generic": m.get("generic"),
                "substitution_allowed": m.get("substitution_allowed"),
                "lot": m.get("lot"),
                "dose": m.get("dose"), "frequency": m.get("frequency"), "duration": m.get("duration"),
                "qr": m.get("qr"), "strip": m.get("strip"),
                "qr_batch": m.get("qr_batch"), "qr_expiry": m.get("qr_expiry"),
                "qr_product_code": m.get("qr_product_code"),
            }
            items.append(CanonicalItem(
                barcode=str(cat.get("barcode") or eof or f"{barcode}-{n}"),
                # FULL pharmacist-facing name (brand + strength/pack) so LOSEC 20 vs LOSEC 40 are
                # never confused — fall back to the brand-only commercialName, then the CDA name.
                name=cat.get("full_name") or cat.get("name") or m.get("name") or "Φάρμακο",
                substance=cat.get("atc") or m.get("atc"),
                quantity=qty,
                retail_price=retail_cents,
                wholesale_price=int(cat.get("wholesale_cents") or 0),
                category="narcotic" if cat.get("narcotic") else "normal",
                is_executed=bool(m.get("is_executed", True)),
                details={k: v for k, v in details.items() if v is not None},
            ))
        if not items:                                   # CDA missing → prescription-level line
            items = [CanonicalItem(barcode=barcode or "rx", name="Συνταγή (ΗΔΙΚΑ)",
                                   quantity=1, retail_price=total, is_executed=True)]
        elif sum(i.retail_price * i.quantity for i in items) == 0 and total > 0:
            items[0].retail_price = total               # catalog miss → keep revenue on line 1

        def _ymd(v):
            if isinstance(v, str) and len(v) == 8 and v.isdigit():
                try:
                    return datetime(int(v[:4]), int(v[4:6]), int(v[6:8]), tzinfo=timezone.utc)
                except ValueError:
                    return None
            return None
        valid_until = _ymd(cda.get("valid_until"))
        valid_from = _ymd(cda.get("valid_from"))
        # repeat chain key: the FIRST prescription's barcode (id root 1.1.4.2), else self = root
        repeat_root = cda.get("repeat_root") or barcode

        fund_name = _first(fund_d, "name") or cda_pat.get("fund_name") or "ΕΟΠΥΥ"
        fund_code = str(_first(fund_d, "shortName", "id", default="") or cda_pat.get("fund_code") or "EOPYY")
        # prescription-level ΗΔΥΚΑ/CDA detail (issue/deadline, exemption/opinion, surcharge, totals)
        _cd = cda.get("details") or {}
        _mc = lambda x: _eur_cents(x) if x is not None else None  # noqa: E731
        presc_details = {k: v for k, v in {
            "issue_date": _cd.get("issue_date"), "deadline_date": _cd.get("deadline_date"),
            "exemption": _cd.get("exemption"), "opinion": _cd.get("opinion"),
            "fund_surcharge": _cd.get("fund_surcharge"),
            "fund_surcharge_amount": _mc(_cd.get("fund_surcharge_amount")),
            "patient_share_total": _mc(_cd.get("patient_share_total")),
            "fund_share_total": _mc(_cd.get("fund_share_total")),
            # συμμετοχή που ανέλαβε το ΕΤΥΑΠ αντί του ασθενή (για ξεχωριστή κατάσταση/τιμολόγιο ΕΤΥΑΠ)
            "etyap_covered": etyap_covered or None,
        }.items() if v is not None}
        return CanonicalExecution(
            source="HDIKA",
            # barcode alone collapses repeats (same barcode, one row per monthly execution) →
            # the execution number makes each repeat a distinct execution.
            external_id=f"{barcode}:{exec_no}",
            executed_at=_parse_dt(_first(ex, "executionDate", "executed_at")),
            patient=CanonicalPatient(
                national_id=str(cda_pat.get("amka") or barcode),  # never empty (validator)
                sex=sex,
                birth_year=cda_pat.get("birth_year"),
                area=cda_pat.get("city") or "unknown",
                full_name=cda_pat.get("full_name")),
            doctor=CanonicalDoctor(full_name=cda_doc.get("name") or "Άγνωστος",
                                   specialty=cda_doc.get("specialty")),
            fund=CanonicalFund(code=fund_code, name=fund_name),
            items=items,
            icd10=[d["code"] for d in cda.get("icd10", []) if d.get("code")],
            repeat_current=exec_no,
            repeat_total=repeat_total,
            patient_share=share,
            amount_total=total,        # ΗΔΙΚΑ retail (totalValue+totalDifference) — authoritative
            valid_until=valid_until,
            valid_from=valid_from,
            repeat_root=repeat_root,
            details=presc_details,
        )

    def _get_xml(self, path: str, params: dict) -> ET.Element:
        try:
            r = self._client.get(self._url(path), params=params)
            if self.throttle:
                time.sleep(self.throttle)
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
        # ΗΔΙΚΑ doesn't return wholesale price; the engine resolves it from product
        # masterdata, else estimates from retail (WHOLESALE_FALLBACK_MARGIN_PCT). See
        # IngestionEngine._effective_wholesale (T-06).
        wholesale_price=0,
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
