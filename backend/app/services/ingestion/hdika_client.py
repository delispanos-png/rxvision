"""Real ΗΔΥΚΑ HTTP client — API ΦΑΡΜΑΚΟΠΟΙΩΝ v2 (e-prescription).

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
from app.core.config import settings
from app.services.ingestion.hdika_cda import parse_cda, parse_cda_full

_PAGE_SIZE = 100                  # ΗΔΥΚΑ rejects size>~150 with HTTP 400; 100 is safe
_MAX_BACKFILL_DAYS = 400          # cap day-by-day backfill (search is per-day)
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)

# ── ΚΑΘΟΛΙΚΟ rate limiter προς ΗΔΥΚΑ (Redis sliding 1-sec window) ─────────────────────────
# Cap συνολικών calls/sec σε ΟΛΟΥΣ τους workers/tenants ώστε να μη «χτυπάμε» την ΗΔΥΚΑ (429/block).
# Fail-open: αν το Redis δεν είναι διαθέσιμο, δεν μπλοκάρει τον συγχρονισμό.
_RL = None


def _rl_redis():
    global _RL
    if _RL is None:
        try:
            import redis
            _RL = redis.from_url(settings.REDIS_URL)
        except Exception:  # noqa: BLE001
            _RL = False
    return _RL


def _hdika_rate_gate(max_per_sec: int) -> None:
    r = _rl_redis()
    if not r or max_per_sec <= 0:
        return
    for _ in range(400):                 # ~ έως 20s αναμονή σε ακραίο φόρτο
        try:
            slot = int(time.time())
            n = r.incr(f"hdika:rl:{slot}")
            if n == 1:
                r.expire(f"hdika:rl:{slot}", 2)
            if n <= max_per_sec:
                return
        except Exception:  # noqa: BLE001
            return                        # Redis πρόβλημα → μην μπλοκάρεις
        time.sleep(0.05)


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
        return ("Ο λογαριασμός ΗΔΥΚΑ κλειδώθηκε προσωρινά από την πύλη λόγω πολλών "
                "αποτυχημένων προσπαθειών σύνδεσης. Περιμένετε ~15–30 λεπτά και "
                "δοκιμάστε ΜΙΑ φορά (μην επαναλαμβάνετε — οι προσπάθειες παρατείνουν το κλείδωμα).")
    # generic gateway page → surface its visible text (helps diagnose)
    return f"Η πύλη ΗΔΥΚΑ επέστρεψε σελίδα σφάλματος: {visible[:180]}" if visible else None


def _to_dict(el: ET.Element) -> dict:
    """Namespace-agnostic XML element → nested dict/list. Repeated children become
    lists; leaf text is kept. Robust to the JAXB-style XML ΗΔΥΚΑ returns."""
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


def _round_half_up(x: float) -> int:
    """Round to the nearest integer cent, halves UP (ΗΔΥΚΑ/PharmacyOne CustomRound) — NOT Python's
    banker's rounding (which gave 200 instead of 201 on a .5 participation)."""
    import math
    return int(math.floor(x + 0.5))


def _round_half_down(x: float) -> int:
    """Round to the nearest integer cent, halves DOWN (PharmacyOne CustomRoundDown) — the patient's
    half of a ΚΥΥΑΠ price difference rounds in the patient's favour."""
    import math
    return int(math.ceil(x - 0.5))


class PatientDeceased(Exception):
    """Η ΗΔΥΚΑ αναγγέλλει θάνατο για το ΑΜΚΑ (getpatient) → ο caller σημαίνει τον ασθενή
    ως θανόντα (services.patient_lifecycle.mark_deceased) αντί να το χειριστεί ως σφάλμα."""

    def __init__(self, amka: str) -> None:
        self.amka = amka
        super().__init__(f"ΗΔΥΚΑ: αναγγελθείς θάνατος για ΑΜΚΑ {amka}")


def _is_deceased_announcement(text: str) -> bool:
    """True αν το σώμα (JSON/XML) της ΗΔΥΚΑ είναι αναγγελία θανάτου — μήνυμα τύπου
    «έχει αναγγελθεί Θάνατος στο Εθνικό Μητρώο ΑΜΚΑ-ΕΜΑΕΣ»."""
    t = (text or "").lower()
    return "θάνατος" in t and ("μητρώο αμκα" in t or "εμαες" in t or "αναγγελθεί" in t)


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
        self.throttle = float(c.get("throttle") or 0)   # seconds to pause after each call (be gentle on ΗΔΥΚΑ)
        self.max_rps = int(c.get("max_rps") or settings.HDIKA_MAX_CALLS_PER_SEC)  # global rate cap
        self.skipped_days = 0           # days skipped due to transient gateway errors
        headers = {"Accept": "application/xml"}
        if self.api_key:
            headers["Api-Key"] = self.api_key
        if c.get("doctor_ip"):
            headers["X-DOCTOR-IP"] = c["doctor_ip"]
        # Basic auth + Api-Key + Accept on every request (no token/login step in v2).
        self._client = httpx.Client(
            timeout=_TIMEOUT,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            auth=(self.username, self.password) if self.username else None,
            headers=headers,
        )

    def _gate(self) -> None:
        """Καθολικό throttle προς ΗΔΥΚΑ πριν από κάθε κλήση (cross-worker)."""
        _hdika_rate_gate(self.max_rps)

    def _url(self, path: str) -> str:
        return f"{self.base}{path}"

    def authenticate(self) -> None:
        """v2 has no login step — creds ride every request. Validate them cheaply so
        bad/missing keys fail fast with the ΗΔΥΚΑ error (604 no key / 911 invalid key)."""
        try:
            r = self._client.get(self._url("/api/v1/user/me"))
        except httpx.TimeoutException as exc:
            raise TimeoutError(f"ΗΔΥΚΑ auth timeout: {exc}") from exc
        except httpx.TransportError as exc:
            raise ConnectionError(f"ΗΔΥΚΑ auth transport error: {exc}") from exc
        text = r.text or ""
        gw = _gateway_message(text)
        if gw:                       # IBM gateway HTML (lockout / error page)
            raise PermissionError(gw)
        if r.status_code in (401, 403, 404):
            raise PermissionError(
                f"Η πύλη ΗΔΥΚΑ απέρριψε το αίτημα (HTTP {r.status_code}). Συνήθως σημαίνει "
                "λάθος περιβάλλον (test/production) ή μη έγκυρα credentials/endpoint γι' αυτό το περιβάλλον.")
        # app-level XML ApiError (π.χ. 911 invalid key) → ανέδειξε το <description>
        if r.status_code >= 400:
            if "<description>" in text:
                text = text.split("<description>", 1)[1].split("</description>", 1)[0]
            raise PermissionError(f"ΗΔΥΚΑ: {text[:200]}")

    def get_patient(self, amka: str) -> dict:
        """GET ΗΔΥΚΑ getpatient για έναν ΑΜΚΑ. Αν η πύλη αναγγείλει θάνατο, σηκώνει
        PatientDeceased ώστε ο caller να σημάνει τον ασθενή (mark_deceased) αντί να
        χειριστεί 400 ως απλό σφάλμα.

        DORMANT μέχρι να ξεμπλοκάρει η live ΗΔΥΚΑ: το ακριβές path/params/μορφή
        απάντησης οριστικοποιούνται με έγκυρο Api-Key — το error-ladder (θάνατος/gateway/
        ApiError) είναι ήδη σωστό βάσει του παρατηρημένου JSON ApiError 400."""
        try:
            r = self._client.get(self._url("/api/v1/common/getpatient"), params={"patientamka": amka})
        except httpx.TimeoutException as exc:
            raise TimeoutError(f"ΗΔΥΚΑ getpatient timeout: {exc}") from exc
        except httpx.TransportError as exc:
            raise ConnectionError(f"ΗΔΥΚΑ getpatient transport error: {exc}") from exc
        text = r.text or ""
        if _is_deceased_announcement(text):       # «έχει αναγγελθεί Θάνατος…»
            raise PatientDeceased(amka)
        gw = _gateway_message(text)
        if gw:
            raise PermissionError(gw)
        if r.status_code >= 400:
            desc = text
            if "<description>" in text:
                desc = text.split("<description>", 1)[1].split("</description>", 1)[0]
            raise PermissionError(f"ΗΔΥΚΑ getpatient: {desc[:200]}")
        try:
            return _to_dict(ET.fromstring(text.encode("utf-8")))
        except ET.ParseError:
            return {}

    # ── auto-discovery: pharmacy profile from ΗΔΥΚΑ ────────
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
            # in getMyContracts. ΗΔΥΚΑ ties it to the pharmacy's prefecture: whole Φαρμακευτικοί
            # Σύλλογοι are (or aren't) contracted. Known contracted prefectures below (expandable);
            # plus an explicit ΕΤΥΑΠ contract if one ever appears in the funds list.
            etyap_counties = {"ΑΤΤΙΚΗΣ", "ΘΕΣΣΑΛΟΝΙΚΗΣ"}
            if any("ΕΤΥΑΠ" in n.upper() for n in fund_names) or (
                    county and county.upper() in etyap_counties):
                info["etyap_contracted"] = "true"
        except Exception:  # noqa: BLE001 — contracts is non-critical (ΗΔΥΚΑ test 500s it)
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
                self._gate()
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
                todo: list = []
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
                    todo.append((raw, bc))
                # ΠΑΡΑΛΛΗΛΗ άντληση CDA για τα νέα barcodes (bounded pool· global rate-limit μέσα στο
                # _fetch_cda) — διώχνει το N+1 bottleneck χωρίς να φορτώνει την ΗΔΥΚΑ.
                missing = list(dict.fromkeys(bc for _, bc in todo if bc not in cda_cache))
                conc = max(1, min(settings.HDIKA_CDA_CONCURRENCY, len(missing)))
                if conc <= 1:
                    for bc in missing:
                        cda_cache[bc] = self._fetch_cda(bc)
                elif missing:
                    from concurrent.futures import ThreadPoolExecutor
                    with ThreadPoolExecutor(max_workers=conc) as pool:
                        for bc, cda in zip(missing, pool.map(self._fetch_cda, missing)):
                            cda_cache[bc] = cda
                for raw, bc in todo:
                    yield self._map_full(raw, cda_cache.get(bc, {}), summaries.get(bc, {}))
                if self._is_last(data, len(records)):
                    break
                page += 1
            day -= timedelta(days=1)

    def search_keys(self, day) -> set:
        """Reconciliation helper — the set of (barcode, executionNo) ΗΔΥΚΑ CURRENTLY returns for
        `day` (a date), WITHOUT fetching any CDA (light: 1 search request per page). RAISES on a
        failed fetch so the caller skips that day (we must never cancel from a bad/empty fetch)."""
        keys: set = set()
        page = 0
        while True:
            params = {"size": _PAGE_SIZE, "page": page, "executionDate": day.isoformat()}
            if self.pharmacy_id:
                params["pharmacyId"] = self.pharmacy_id
            data = _to_dict(self._get_xml("/api/v1/prescription-execution/search", params))
            records = self._rows(data)
            for raw in records:
                if not isinstance(raw, dict):
                    continue
                presc = raw.get("prescription") if isinstance(raw.get("prescription"), dict) else {}
                bc = str(_first(presc, "barcode") or _first(raw, "barcode", default=""))
                if not bc:
                    continue
                keys.add((bc, int(float(_first(raw, "executionNo", default=1) or 1))))
            if self.throttle:
                time.sleep(self.throttle)
            if self._is_last(data, len(records)):
                break
            page += 1
        return keys

    def _map_full(self, ex: dict, cda: dict, summary: dict | None = None) -> CanonicalExecution:
        """Execution row (amounts/fund/executionNo) + full CDA (patient/doctor/ICD-10/
        medicines) + repeat summary → a complete CanonicalExecution. Each medicine is a
        real line priced from the catalog (retail + wholesale → margin)."""
        summary = summary or {}
        presc = ex.get("prescription") if isinstance(ex.get("prescription"), dict) else {}
        barcode = str(_first(presc, "barcode") or _first(ex, "barcode", default=""))
        fund_d = presc.get("socialInsuranceDTO") if isinstance(presc.get("socialInsuranceDTO"), dict) else {}
        # ΗΔΥΚΑ amounts (verified against official printouts):
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
        surcharge = _eur_cents(_first(ex, "socialInsuranceSurcharge", default=0))
        share = (participation
                 + max(0, total_diff - soci_diff)
                 + surcharge
                 + _eur_cents(_first(ex, "supplementalDifferenceAmt", default=0)))
        # ΚΥΥΑΠ split is computed AFTER the priced lines are built (needs per-line ref/diff). See below.
        exec_no = int(float(_first(ex, "executionNo", default=1) or 1))
        # ΗΔΥΚΑ `executions` = πόσες φορές εκτελέστηκε ΜΕΧΡΙ ΤΩΡΑ — ΟΧΙ το πλάνο επαναλήψεων. Το
        # πραγματικό πλάνο ("3 από 4", "1 από 6") ζει στο CDA repeat schedule (parse_cda →
        # `repeat_planned`). Όταν λείπει, κρατάμε repeat_total=0 (άγνωστο) αντί να το φαμπρικάρουμε
        # = executions (που έβγαζε παραπλανητικά "N/N" badges)· το display παράγει την αλυσίδα από
        # τις εκτελέσεις + τον εξαγόμενο ρυθμό. repeat_current = ο executionNo αυτής της γραμμής.
        # Repeat chain — AUTHORITATIVE from the ΗΔΥΚΑ CDA: 1.1.4 = planned count (1=απλή, 3/4/5/6 =
        # 3/4/5/6-μηνη αλυσίδα), 1.1.4.1 = Σειρά (this prescription's position). Gives the real
        # "X of Y" (e.g. 1 of 6) even when sibling repeat-barcodes are not synced. Validator needs
        # current ≤ total. Falls back to a single (1/1) when the CDA carries no chain info.
        repeat_type = int(float(cda.get("repeat_type") or 0))
        repeat_seq = int(float(cda.get("repeat_seq") or 0))
        repeat_total = repeat_type if repeat_type > 1 else 1
        repeat_current = min(repeat_seq, repeat_total) if repeat_seq > 0 else 1

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
                "generic_suggested": m.get("generic_suggested"),
                "drug_type": m.get("drug_type"),
                "substitution_allowed": m.get("substitution_allowed"),
                "outstanding": m.get("outstanding"),
                "line_total_difference": mc(m.get("line_total_difference")),
                "fund_difference": mc(m.get("fund_difference")),
                "lot": m.get("lot"),
                "dose": m.get("dose"), "frequency": m.get("frequency"), "duration": m.get("duration"),
                "qr": m.get("qr"), "strip": m.get("strip"),
                "qr_batch": m.get("qr_batch"), "qr_expiry": m.get("qr_expiry"),
                "qr_product_code": m.get("qr_product_code"),
                # ΕΝΑ κουπόνι ανά εκτελεσμένο τεμάχιο (ταινία/QR) — όσα και η ποσότητα.
                "coupons": m.get("coupons") or [],
            }
            # «Ανεκτέλεστο» = αυθεντικά από το Υπόλοιπο (1.4.19): >0 ⇒ δεν δόθηκε όλη η ποσότητα.
            # Πέφτουμε στο statusCode μόνο όταν λείπει το Υπόλοιπο.
            outstanding = m.get("outstanding")
            executed = (outstanding is not None and outstanding <= 0) if outstanding is not None \
                else bool(m.get("is_executed", True))
            # Γαληνικά (ΕΟΦ «-1» = ΓΑΛΗΝΙΚΟ ΣΚΕΥΑΣΜΑ) & εισαγωγές ΙΦΕΤ («-2») είναι ΕΙΔΙΚΑ είδη: όχι
            # εμπορικά προϊόντα, χωρίς Δελτίο Τιμών (wholesale=0). ΔΕΝ πρέπει να συγχωνεύονται όλα σε
            # ένα προϊόν (το catalog δίνει κοινό barcode 280-11) — κάθε γαληνικό = δική του σύνθεση,
            # άρα μοναδικό barcode ανά γραμμή. Όνομα = η σύνθεση/οδηγία του γιατρού (από το CDA).
            special = {"-1": "galenic", "-2": "ifet"}.get(eof) or ("galenic" if m.get("galenic") else None)
            composition = str(m.get("notes") or "").strip()
            if special:
                it_barcode = f"{barcode}-{(eof.lstrip('-') or 'g')}-{n}"
                it_name = (f"Γαληνικό: {composition}" if (special == "galenic" and composition)
                           else cat.get("name") or m.get("name") or
                           ("Γαληνικό σκεύασμα" if special == "galenic" else "Εισαγωγή ΙΦΕΤ"))
                it_category, it_wholesale = special, 0
                if composition:
                    details["composition"] = composition
            else:
                it_barcode = str(cat.get("barcode") or eof or f"{barcode}-{n}")
                # FULL pharmacist-facing name (brand + strength/pack) so LOSEC 20 vs 40 never confused.
                it_name = cat.get("full_name") or cat.get("name") or m.get("name") or "Φάρμακο"
                it_category = "narcotic" if cat.get("narcotic") else "normal"
                it_wholesale = int(cat.get("wholesale_cents") or 0)
            items.append(CanonicalItem(
                barcode=it_barcode,
                name=it_name,
                substance=cat.get("atc") or m.get("atc"),
                quantity=qty,
                retail_price=retail_cents,
                wholesale_price=it_wholesale,
                category=it_category,
                is_executed=executed,
                details={k: v for k, v in details.items() if v is not None},
            ))
        if not items:                                   # CDA missing → prescription-level line
            items = [CanonicalItem(barcode=barcode or "rx", name="Συνταγή (ΗΔΥΚΑ)",
                                   quantity=1, retail_price=total, is_executed=True)]
        elif sum(i.retail_price * i.quantity for i in items) == 0 and total > 0:
            items[0].retail_price = total               # catalog miss → keep revenue on line 1

        # ── ΚΥΥΑΠ / «ΕΤΥΑΠ» σωμάτων ασφαλείας (Ι.Κ.Α. πρώην Ο.Π.Α.Δ. - Κ.Υ.Υ.Α.Π.) ─────────────
        # ΤΡΙΜΕΡΗΣ επιμερισμός (επαληθευμένος στο επίσημο έντυπο ΗΔΥΚΑ): ο ασφαλισμένος πληρώνει τη
        # ΜΙΣΗ διαφορά (στρογγ. κάτω) + το 1€ ΕΟΠΥΥ· το ΚΥΥΑΠ πληρώνει τη συμμετοχή + την άλλη μισή
        # διαφορά· το ΕΟΠΥΥ το υπόλοιπο (amount_total − ασφ/νος − ΚΥΥΑΠ, μέσω amount_claimed). Μόνο
        # για συμβεβλημένα φαρμακεία (νομός Αττικής/Θεσσαλονίκης κ.λπ.)· αλλιώς σαν απλό ΕΟΠΥΥ.
        fund_label = str(_first(fund_d, "name") or cda_pat.get("fund_name") or "").upper().replace(".", "")
        is_kyyap = "ΚΥΥΑΠ" in fund_label
        kyyap_covered = 0
        if self.etyap_contracted and is_kyyap:
            pat_diff_half = kyy = 0
            for it in items:
                if not it.is_executed:
                    continue
                dd = it.details or {}
                ref_unit, pct = dd.get("reference_price"), dd.get("participation_pct")
                if not ref_unit or not pct:
                    continue
                ref_line = int(ref_unit) * it.quantity
                diff_line = dd.get("difference")
                if diff_line is None:
                    diff_line = max(0, it.retail_price * it.quantity - ref_line)
                participation_line = _round_half_up(ref_line * float(pct) / 100.0)
                half = _round_half_down(diff_line / 2.0)        # ασφαλισμένου μερίδιο διαφοράς
                pat_diff_half += half
                kyy += participation_line + (diff_line - half)  # ΚΥΥΑΠ: συμμετοχή + άλλη μισή
            if kyy or pat_diff_half:
                share = pat_diff_half + surcharge               # ασφ/νος: μισή διαφορά + 1€
                kyyap_covered = kyy

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
        # Όλα τα χαρακτηριστικά συνταγής (parse) περνούν αυτούσια (future-proof)· τα ποσά → cents
        # και προστίθενται τα υπολογιζόμενα/top-level. Το φιλτράρισμα κρατά μόνο ουσιαστικές τιμές.
        _money = ("fund_surcharge_amount", "patient_share_total", "fund_share_total",
                  "supplementary_amount", "kyyap_difference")
        presc_details = {
            **_cd,
            **{k: _mc(_cd.get(k)) for k in _money},
            # ποσό που πληρώνει το ΚΥΥΑΠ (συμμετοχή + μισή διαφορά) — για την ανάλυση/εκτύπωση ΕΤΥΑΠ
            "kyyap_covered": kyyap_covered or None,
            # ρυθμός χορήγησης (μήνες): αυθεντικά από 1.1.4.4 (30/28/60 ημ.), αλλιώς μηνιαία/δίμηνη
            "interval_months": ({30: 1, 28: 1, 60: 2}.get(_cd.get("repeat_period_days"))
                                or (2 if cda.get("bimonthly") else 1 if cda.get("monthly") else None)),
            "chronic": (True if cda.get("chronic") else None),
            # περίπτωση εκτέλεσης (1.1.18): 1=όλα·2=όχι όλα(επιθυμία)·3=ασυμφ.δοσολ.·4=όχι πλήρης
            "execution_case": cda.get("execution_case"),
            "n3816": (True if cda.get("n3816") else None),     # ΦΥΚ Ν.3816
            "ekas": (True if cda.get("ekas") else None),       # δικαιούχος ΕΚΑΣ
        }
        # κράτα μόνο ουσιαστικές τιμές (πέτα None/""/False/μηδενικά ποσά → λιτό doc)
        presc_details = {k: v for k, v in presc_details.items() if v not in (None, "", False, 0, 0.0)}
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
                                   specialty=cda_doc.get("specialty"),
                                   phone=cda_doc.get("phone"), email=cda_doc.get("email")),
            fund=CanonicalFund(code=fund_code, name=fund_name),
            items=items,
            icd10=[d["code"] for d in cda.get("icd10", []) if d.get("code")],
            repeat_current=repeat_current,
            repeat_total=repeat_total,
            patient_share=share,
            amount_total=total,        # ΗΔΥΚΑ retail (totalValue+totalDifference) — authoritative
            valid_until=valid_until,
            valid_from=valid_from,
            repeat_root=repeat_root,
            details=presc_details,
        )

    def get_pdf(self, path: str, params: dict) -> httpx.Response:
        """Raw GET for a binary ΗΔΥΚΑ document (PDF printout). Returns the httpx.Response so the
        caller can stream the bytes back; auth/Api-Key headers ride along as on every request."""
        return self._client.get(self._url(path), params=params, headers={"Accept": "application/pdf"})

    def _get_xml(self, path: str, params: dict) -> ET.Element:
        # Retry transient ΗΔΥΚΑ failures (429 rate-limit / 5xx) με exponential backoff — αλλιώς ένα
        # 429 σε φόρτο αποτυγχάνει το sync. Εξαντλημένα retries → TimeoutError (Celery autoretry).
        for attempt in range(4):
            try:
                self._gate()
                r = self._client.get(self._url(path), params=params)
                if self.throttle:
                    time.sleep(self.throttle)
                gw = _gateway_message(r.text)
                if gw:               # gateway HTML (e.g. lockout) even with HTTP 200
                    raise PermissionError(gw)
                if r.status_code in (429, 500, 502, 503, 504) and attempt < 3:
                    ra = r.headers.get("Retry-After")
                    wait = (float(ra) if (ra or "").isdigit()
                            else min(2 ** attempt, 30) * (2 if r.status_code == 429 else 1))
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                return ET.fromstring(r.content)
            except PermissionError:
                raise
            except httpx.TimeoutException as exc:
                if attempt < 3:
                    time.sleep(min(2 ** attempt, 20))
                    continue
                raise TimeoutError(f"ΗΔΥΚΑ list timeout: {exc}") from exc
            except httpx.TransportError as exc:
                if attempt < 3:
                    time.sleep(min(2 ** attempt, 20))
                    continue
                raise ConnectionError(f"ΗΔΥΚΑ list transport error: {exc}") from exc
            except ET.ParseError as exc:
                raise ValueError(f"ΗΔΥΚΑ list: invalid XML: {exc}") from exc
        raise TimeoutError("ΗΔΥΚΑ list: rate-limited/5xx after retries")

    # ── mapping (ΗΔΥΚΑ XML record → canonical) ──────────────
    @staticmethod
    def map_raw(raw: dict) -> CanonicalExecution:
        """Map one ΗΔΥΚΑ prescription record (PharmPrescriptionDTO field names) to a
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
        # ΗΔΥΚΑ doesn't return wholesale price; the engine resolves it from product
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
