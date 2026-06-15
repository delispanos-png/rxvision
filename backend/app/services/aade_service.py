"""ΑΑΔΕ (GSIS) VAT lookup — RgWsPublic2 SOAP service.

AFM → company name / title / ΔΟΥ / address, for onboarding auto-fill so the pharmacy doesn't
retype its details. Requires a special TAXISnet account registered for RgWsPublic2; credentials
live in `platform_settings._id='aade'` (entered in admin, like the cloud tokens) — never in git.
"""

from __future__ import annotations

import html

import defusedxml.ElementTree as ET  # XXE/billion-laughs-safe drop-in for ElementTree

import httpx

from app.core.db import shared_db

_URL = "https://www1.gsis.gr/wsaade/RgWsPublic2/RgWsPublic2"


async def _creds() -> tuple[str | None, str | None]:
    cfg = await shared_db()["platform_settings"].find_one({"_id": "aade"}) or {}
    return cfg.get("username"), cfg.get("password")


def _iter(root, local: str):
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] == local:
            yield el


def _txt(root, local: str) -> str | None:
    for el in _iter(root, local):
        return (el.text or "").strip() or None
    return None


def _envelope(user: str, pw: str, afm: str) -> str:
    u, p, a = html.escape(user), html.escape(pw), html.escape(afm)
    return (
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" '
        'xmlns:ns2="http://rgwspublic2/RgWsPublic2">'
        '<soapenv:Header>'
        '<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/'
        'oasis-200401-wss-wssecurity-secext-1.0.xsd">'
        f'<wsse:UsernameToken><wsse:Username>{u}</wsse:Username>'
        '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/'
        f'oasis-200401-wss-username-token-profile-1.0#PasswordText">{p}</wsse:Password>'
        '</wsse:UsernameToken></wsse:Security></soapenv:Header>'
        '<soapenv:Body><ns2:rgWsPublic2AfmMethod><ns2:INPUT_REC>'
        '<ns2:afm_called_by></ns2:afm_called_by>'
        f'<ns2:afm_called_for>{a}</ns2:afm_called_for>'
        '</ns2:INPUT_REC></ns2:rgWsPublic2AfmMethod></soapenv:Body></soapenv:Envelope>'
    )


async def lookup(afm: str) -> dict:
    """AFM (9 digits) → {ok, name, title, doy, address, postal_code, city, active} or {ok: False, error}."""
    afm = (afm or "").strip()
    if not (afm.isdigit() and len(afm) == 9):
        return {"ok": False, "error": "invalid_afm"}
    user, pw = await _creds()
    if not user or not pw:
        return {"ok": False, "error": "aade_not_configured"}
    try:
        async with httpx.AsyncClient(timeout=20) as cl:
            r = await cl.post(_URL, content=_envelope(user, pw, afm).encode("utf-8"),
                              headers={"Content-Type": "text/xml; charset=utf-8"})
        root = ET.fromstring(r.text)
    except Exception as e:  # noqa: BLE001 — surface a clean error to the wizard
        return {"ok": False, "error": f"aade_unreachable:{type(e).__name__}"}

    err = _txt(root, "errorDescr") or _txt(root, "faultstring")
    if err:
        return {"ok": False, "error": err}
    name = _txt(root, "onomasia")
    if not name:
        return {"ok": False, "error": "not_found"}
    addr = " ".join(x for x in [_txt(root, "postalAddress"), _txt(root, "postalAddressNo")] if x)
    return {
        "ok": True, "afm": afm, "name": name,
        "title": _txt(root, "commerTitle"),
        "doy": _txt(root, "doyDescr"),
        "address": addr or None,
        "postal_code": _txt(root, "postalZipCode"),
        "city": _txt(root, "postalAreaDescription"),
        # RgWsPublic2: deactivationFlag "1" = active, "2" = deactivated
        "active": (_txt(root, "deactivationFlag") or "1") == "1",
    }
