"""On-demand ΗΔΥΚΑ getpatient — άντληση στοιχείων πελάτη με ΑΜΚΑ, για onboarding νέου πελάτη
ΧΩΡΙΣ εκτέλεση συνταγής (καρτέλα χωρίς κίνηση). Best-effort & normalized· ποτέ δεν ρίχνει."""

from __future__ import annotations

import asyncio

from app.services.ingestion.hdika_client import (
    HdikaClient, HdikaInvalidAmka, PatientDeceased, _first, _sex,
)


async def fetch_hdika_patient(tenant_id: str, amka: str) -> dict:
    """{found, first_name, last_name, full_name, birth_year, sex, area} από τη ΗΔΥΚΑ (getpatient).
    Σε λάθος ΑΜΚΑ → {found: False, error: 'invalid_amka'}· σε θάνατο → 'deceased'· αλλιώς 'hdika_unavailable'."""
    from app.api.v1.routers.ingestion import _effective_hdika_creds
    creds = dict(await _effective_hdika_creds(tenant_id))
    if not (creds.get("username") and creds.get("api_key")
            and (creds.get("base_url") or creds.get("live_endpoint"))):
        return {"found": False, "error": "not_configured"}

    def _do():
        cl = HdikaClient(creds)
        try:
            cl.authenticate()
            return cl.get_patient(amka)
        finally:
            cl.close()

    try:
        d = await asyncio.to_thread(_do)
    except HdikaInvalidAmka:
        return {"found": False, "error": "invalid_amka"}
    except PatientDeceased:
        return {"found": False, "error": "deceased"}
    except Exception:  # noqa: BLE001 — timeout/auth/transport → μη διαθέσιμη, χειρόγραφη συμπλήρωση
        return {"found": False, "error": "hdika_unavailable"}

    return normalize_hdika_patient(d)


def normalize_hdika_patient(d: dict) -> dict:
    """Μετατρέπει την ωμή απάντηση της ΗΔΥΚΑ getpatient σε normalized dict (ονοματεπώνυμο + φύλο +
    διεύθυνση + στοιχεία επικοινωνίας). Κοινό μεταξύ on-demand lookup & μαζικού backfill."""
    patient = d.get("patient") if isinstance(d.get("patient"), dict) else d
    if not isinstance(patient, dict):
        return {"found": False, "error": "empty"}
    first = str(_first(patient, "firstName", "givenName", "name", default="") or "")
    last = str(_first(patient, "lastName", "familyName", "surname", default="") or "")
    birth = str(_first(patient, "birthDate", "birthdate", default="") or "")
    tel = str(_first(patient, "telephone", "mobile", "phone", default="") or "").strip()
    # φύλο: η ΗΔΥΚΑ το δίνει nested {id, name} (1/Άρρεν, 2/Θήλυ) — ο shared _sex δεν το πιάνει.
    sx = patient.get("sex")
    if isinstance(sx, dict):
        sid, nm = str(sx.get("id") or ""), str(sx.get("name") or "")
        sex_val = "M" if (sid == "1" or "ρρεν" in nm) else ("F" if (sid == "2" or "ήλυ" in nm) else _sex(patient))
    else:
        sex_val = _sex(patient)
    return {
        "found": True,
        "first_name": first, "last_name": last,
        "full_name": (f"{first} {last}".strip()) or None,
        "birth_year": int(birth[:4]) if birth[:4].isdigit() else None,
        "sex": sex_val,
        "area": _first(patient, "city", "countryName", default=None),
        # διεύθυνση + επικοινωνία (η ΗΔΥΚΑ τα επιστρέφει: address/postalCode/city/county/telephone/email)
        "address": (str(_first(patient, "address", default="") or "").strip() or None),
        "postal_code": (str(_first(patient, "postalCode", "postalcode", default="") or "").strip() or None),
        "city": (str(_first(patient, "city", default="") or "").strip() or None),
        "county": (str(_first(patient, "county", default="") or "").strip() or None),
        # κινητό αν μοιάζει (69… 10ψήφιο) αλλιώς σταθερό
        "mobile": tel if (tel.startswith("69") and len(tel) == 10) else None,
        "phone": tel if not (tel.startswith("69") and len(tel) == 10) else None,
        "email": (str(_first(patient, "email", default="") or "").strip() or None),
    }
