"""Άυλη συνταγογράφηση («nopaper») — ο ΑΣΘΕΝΗΣ φέρνει μόνος του τις ΝΕΕΣ συνταγές του.

ΓΙΑΤΙ ΥΠΑΡΧΕΙ: το `/prescriptions/search` που χρησιμοποιεί το ingestion επιστρέφει ΜΟΝΟ ΕΚΤΕΛΕΣΜΕΝΕΣ
συνταγές (επαληθεύτηκε: 687/687 στο δοκιμαστικό). Οι ΝΕΕΣ συνταγές που μόλις έγραψε ο γιατρός δεν
φαίνονται πουθενά στο φαρμακείο μέχρι ο ασφαλισμένος να τις αναθέσει. Το `nopaper` API καλύπτει
ακριβώς αυτό το κενό.

ΡΟΗ (2 βήματα, επαληθευμένη στο δοκιμαστικό περιβάλλον):
  1. GET /api/v1/common/getpatient/nopaper/pin?amkaOrEkaa={ΑΜΚΑ}      → 204 No Content
     Το PIN ΔΕΝ επιστρέφεται σε εμάς — η ΗΔΥΚΑ το στέλνει **SMS στο κινητό του ασφαλισμένου**
     (μέθοδος `sendPIN`). Αυτό είναι το στοιχείο συγκατάθεσης: αποδεικνύει κατοχή του τηλεφώνου.
  2. GET /api/v1/prescriptions/nopaper?amkaOrEkaa={ΑΜΚΑ}&pin={PIN}&page=&size=

ΑΣΦΑΛΕΙΑ — ΤΟ ΑΜΚΑ ΔΕΝ ΕΡΧΕΤΑΙ ΠΟΤΕ ΑΠΟ ΤΟ ΑΙΤΗΜΑ: ο caller οφείλει να το αντλεί από τον
ΑΥΘΕΝΤΙΚΟΠΟΙΗΜΕΝΟ λογαριασμό. Επαληθεύτηκε ότι η ΗΔΥΚΑ **ΔΕΝ βάζει κανένα rate-limit** (5 διαδοχικές
αιτήσεις → 5× 204 → 5 SMS) και ότι ανύπαρκτο ΑΜΚΑ επιστρέφει κι αυτό 204 (anti-enumeration). Άρα, αν
το ΑΜΚΑ ερχόταν από τον client, η πύλη μας θα γινόταν εργαλείο SMS-bombing με χρέωση της ΗΔΥΚΑ και
ίχνος στον δικό μας integrator λογαριασμό. Ο φραγμός πρέπει να είναι ΔΙΚΟΣ ΜΑΣ.

Σφάλματα ΗΔΥΚΑ: λάθος/ληγμένο PIN → HTTP 400 + <code>1001</code> «Το PIN δεν είναι σωστό.»
"""
from __future__ import annotations

import asyncio

from app.services.hdika_lookup import _creds_for
import defusedxml.ElementTree as _DET   # ίδιος σκληρυμένος parser με το ingestion (XXE-safe)

from app.services.ingestion.hdika_client import (
    HdikaAuthError, HdikaClient, _first, _to_dict,
)

_PIN_PATH = "/api/v1/common/getpatient/nopaper/pin"
_LIST_PATH = "/api/v1/prescriptions/nopaper"


def _client(creds: dict) -> HdikaClient:
    """Ίδια σύμβαση με το ingestion/lookup: Basic auth + Api-Key + timeouts + throttle."""
    return HdikaClient(creds)


def _send_pin_sync(creds: dict, amka: str) -> dict:
    c = _client(creds)
    try:
        c._gate()
        r = c._client.get(c._url(_PIN_PATH), params={"amkaOrEkaa": amka},
                          headers={"accept": "application/xml"})
        if r.status_code in (401, 403):
            raise HdikaAuthError("Η ΗΔΥΚΑ απέρριψε τα credentials του φαρμακείου.")
        if r.status_code in (200, 204):
            # 204 και για ανύπαρκτο ΑΜΚΑ (anti-enumeration) — δεν αποκαλύπτουμε τη διαφορά.
            return {"ok": True}
        return {"ok": False, "error": "hdika_error", "status": r.status_code,
                "detail": _err_text(r.text)}
    finally:
        try:
            c._client.close()
        except Exception:  # noqa: BLE001
            pass


def _err_text(xml: str) -> str:
    """Ανθρώπινο μήνυμα από <description>/<detail>/<title> του ΗΔΥΚΑ ApiError."""
    for tag in ("description", "detail", "title", "message"):
        a, b = f"<{tag}>", f"</{tag}>"
        if a in xml and b in xml:
            return xml.split(a, 1)[1].split(b, 1)[0].strip()[:200]
    return (xml or "")[:200]


def _list_sync(creds: dict, amka: str, pin: str, page: int, size: int) -> dict:
    c = _client(creds)
    try:
        c._gate()
        r = c._client.get(c._url(_LIST_PATH),
                          params={"amkaOrEkaa": amka, "pin": pin, "page": page, "size": size},
                          headers={"accept": "application/xml"})
        if r.status_code in (401, 403):
            raise HdikaAuthError("Η ΗΔΥΚΑ απέρριψε τα credentials του φαρμακείου.")
        if r.status_code != 200:
            txt = r.text or ""
            # code 1001 = λάθος/ληγμένο PIN → ξεχωριστό σφάλμα ώστε το UI να ζητήσει νέο PIN
            bad_pin = "<code>1001</code>" in txt or "PIN" in _err_text(txt).upper()
            return {"ok": False, "error": "bad_pin" if bad_pin else "hdika_error",
                    "detail": _err_text(txt)}
        data = _to_dict(_DET.fromstring(r.content))   # ίδια σύμβαση με _get_xml του ingestion
        rows = HdikaClient._rows(data)
        return {"ok": True, "items": [_row(x) for x in rows if isinstance(x, dict)],
                "page": int(_first(data, "number", default=page) or page),
                "total": int(_first(data, "totalEntries", default=0) or 0),
                "total_pages": int(_first(data, "totalPages", default=1) or 1),
                "last": str(data.get("lastPage", "")).lower() == "true"}
    finally:
        try:
            c._client.close()
        except Exception:  # noqa: BLE001
            pass


def _row(r: dict) -> dict:
    """Ένα <item> → το σχήμα που ήδη καταναλώνει η πύλη (ίδια ονόματα με το rx-request/lookup)."""
    pi = r.get("patientInfo") if isinstance(r.get("patientInfo"), dict) else {}
    st = r.get("status") if isinstance(r.get("status"), dict) else {}
    ph = r.get("pharmacy") if isinstance(r.get("pharmacy"), dict) else {}
    return {
        "barcode": str(_first(r, "barcode", default="") or ""),
        "issue_date": _first(r, "issueDate"),
        "execution_date": _first(r, "executionDate"),
        "expiry_date": _first(r, "expiryDate"),
        "status": _first(st, "status", "name") or _first(r, "status"),
        "status_id": _first(st, "id"),
        "executions": _first(r, "executions"),
        "prescription_type": _first(r, "prescriptionTypeName"),
        "drug_category": _first(r, "drugCategory"),
        "medicine_drug": str(_first(r, "medicineDrug", default="")).lower() == "true",
        "execution_case": _first(r, "executionCase"),
        "patient_name": " ".join(x for x in (_first(pi, "firstName"), _first(pi, "lastName")) if x) or None,
        "social_insurance": _first(r, "socialInsurance", default=None) if not isinstance(
            r.get("socialInsurance"), dict) else _first(r["socialInsurance"], "shortName", "name"),
        "pharmacy_name": _first(ph, "name") if ph else None,
    }


async def send_pin(tenant_id: str, amka: str) -> dict:
    """Βήμα 1: ζητά από τη ΗΔΥΚΑ να στείλει PIN με SMS στον ασφαλισμένο.

    ⚠️ Το `amka` ΠΡΕΠΕΙ να προέρχεται από τον αυθεντικοποιημένο λογαριασμό του ασθενή.
    """
    if not (amka or "").strip():
        return {"ok": False, "error": "amka_missing"}
    creds = await _creds_for(tenant_id)
    if not creds:
        return {"ok": False, "error": "no_connection"}
    try:
        return await asyncio.to_thread(_send_pin_sync, creds, amka.strip())
    except HdikaAuthError as e:
        return {"ok": False, "error": "pharmacy_auth", "detail": str(e)[:200]}
    except Exception as e:  # noqa: BLE001 — δίκτυο/ΗΔΥΚΑ κάτω δεν πρέπει να ρίχνει την πύλη
        return {"ok": False, "error": "unavailable", "detail": str(e)[:200]}


async def list_prescriptions(tenant_id: str, amka: str, pin: str, *,
                             page: int = 0, size: int = 50) -> dict:
    """Βήμα 2: οι συνταγές του ασφαλισμένου (σελιδοποιημένα), με το PIN που έλαβε στο SMS."""
    if not (amka or "").strip():
        return {"ok": False, "error": "amka_missing"}
    if not (pin or "").strip():
        return {"ok": False, "error": "pin_required"}
    creds = await _creds_for(tenant_id)
    if not creds:
        return {"ok": False, "error": "no_connection"}
    try:
        return await asyncio.to_thread(_list_sync, creds, amka.strip(), pin.strip(),
                                       max(0, int(page)), max(1, min(100, int(size))))
    except HdikaAuthError as e:
        return {"ok": False, "error": "pharmacy_auth", "detail": str(e)[:200]}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "unavailable", "detail": str(e)[:200]}
