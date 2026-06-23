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
    # RgWsPublic2 is a SOAP 1.2 endpoint — the envelope namespace must be the SOAP 1.2 one
    # (http://www.w3.org/2003/05/soap-envelope). A SOAP 1.1 envelope returns HTTP 415 with a
    # VersionMismatch fault. The content-type must likewise be application/soap+xml (see lookup).
    u, p, a = html.escape(user), html.escape(pw), html.escape(afm)
    return (
        '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" '
        'xmlns:ns2="http://rgwspublic2/RgWsPublic2">'
        '<env:Header>'
        '<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/'
        'oasis-200401-wss-wssecurity-secext-1.0.xsd">'
        f'<wsse:UsernameToken><wsse:Username>{u}</wsse:Username>'
        '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/'
        f'oasis-200401-wss-username-token-profile-1.0#PasswordText">{p}</wsse:Password>'
        '</wsse:UsernameToken></wsse:Security></env:Header>'
        '<env:Body><ns2:rgWsPublic2AfmMethod><ns2:INPUT_REC>'
        '<ns2:afm_called_by></ns2:afm_called_by>'
        f'<ns2:afm_called_for>{a}</ns2:afm_called_for>'
        '</ns2:INPUT_REC></ns2:rgWsPublic2AfmMethod></env:Body></env:Envelope>'
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
                              headers={"Content-Type": "application/soap+xml; charset=utf-8"})
        root = ET.fromstring(r.text)
    except Exception as e:  # noqa: BLE001 — surface a clean error to the wizard
        return {"ok": False, "error": f"aade_unreachable:{type(e).__name__}"}

    # RgWsPublic2 response fields are snake_case; errors live in error_rec/error_descr.
    err = _txt(root, "error_descr") or _txt(root, "Text") or _txt(root, "faultstring")
    if err:
        return {"ok": False, "error": err}
    name = _txt(root, "onomasia")
    if not name:
        return {"ok": False, "error": "not_found"}
    addr = " ".join(x for x in [_txt(root, "postal_address"), _txt(root, "postal_address_no")] if x)
    return {
        "ok": True, "afm": afm, "name": name,
        "title": _txt(root, "commer_title"),
        "doy": _txt(root, "doy_descr"),
        "address": addr or None,
        "postal_code": _txt(root, "postal_zip_code"),
        "city": _txt(root, "postal_area_description"),
        # RgWsPublic2: deactivation_flag "1" = active, "2" = deactivated
        "active": (_txt(root, "deactivation_flag") or "1") == "1",
    }
