"""DrugBank Clinical API — drug-drug interaction (DDI) source.

WHY: curated κλινική βάση + ΣΤΑΘΕΡΟ μηνιαίο κόστος συνδρομής (όχι per-token σαν το AI).
Πηγή αληθείας για drug-drug interactions· το PharmaCat AI μένει fallback μέχρι να μπει κλειδί.

Config (platform_settings._id="drugbank", encrypted): {api_key, enabled, region}.
Το κλειδί μπαίνει από το adminpanel (Πληρωμές & ΑΑΔΕ → DrugBank).

Docs: https://docs.drugbank.com/v1/  ·  DDI: GET https://api.drugbank.com/v1/ddi (auth header
`Authorization: <api_key>`, έως 40 φάρμακα/κλήση, severity minor|moderate|major). Τα ονόματα
γίνονται resolve σε product_concept ids μέσω /v1/product_concepts πριν το /ddi.

⚠️ Τα ΑΚΡΙΒΗ paths/params/fields επιβεβαιώνονται με το ΠΡΑΓΜΑΤΙΚΟ κλειδί — απομονωμένα εδώ
(_BASE, _resolve_ids, _parse_ddi) ώστε η διόρθωση να είναι σε ένα σημείο.
"""

from __future__ import annotations

import logging

import httpx

from app.core.db import shared_db

logger = logging.getLogger(__name__)

_BASE = "https://api.drugbank.com/v1"
_TIMEOUT = httpx.Timeout(20.0, connect=8.0)
_MAX_DRUGS = 40                     # όριο DrugBank ανά κλήση
_SEV = {"minor", "moderate", "major"}


async def _config() -> dict:
    from app.services.platform_secrets import decrypt_doc
    cfg = decrypt_doc("drugbank", await shared_db()["platform_settings"].find_one({"_id": "drugbank"})) or {}
    return {"api_key": cfg.get("api_key"), "enabled": cfg.get("enabled", True),
            "region": cfg.get("region") or "eu"}


async def configured() -> bool:
    """True αν υπάρχει κλειδί DrugBank & είναι enabled → χρησιμοποιούμε DrugBank αντί για AI."""
    c = await _config()
    return bool(c["api_key"]) and c["enabled"]


def _headers(api_key: str, region: str) -> dict:
    # DrugBank: API key στο Authorization· region για EU σκευάσματα (ingredient-level DDI cross-region).
    return {"Authorization": api_key, "Accept": "application/json", "Region": region}


async def _resolve_ids(client: httpx.AsyncClient, names: list[str], api_key: str, region: str) -> dict[str, str]:
    """name (δραστική/εμπορικό) → drugbank product_concept id. Ό,τι δεν βρεθεί παραλείπεται.
    ⚠️ endpoint/field ονόματα προς επιβεβαίωση με πραγματικό κλειδί."""
    out: dict[str, str] = {}
    for nm in names:
        try:
            r = await client.get(f"{_BASE}/product_concepts",
                                  params={"q": nm, "region": region}, headers=_headers(api_key, region))
            if r.status_code != 200:
                continue
            data = r.json()
            hits = data if isinstance(data, list) else (data.get("products") or data.get("data") or [])
            if hits:
                h = hits[0]
                pcid = h.get("drugbank_pcid") or h.get("id") or h.get("ncit_id")
                if pcid:
                    out[nm] = pcid
        except Exception as exc:  # noqa: BLE001
            logger.warning("DrugBank resolve failed for %s: %s", nm, exc)
    return out


def _parse_ddi(payload, id_to_name: dict[str, str]) -> list[dict]:
    """DrugBank DDI response → κοινή μορφή {a,b,severity,mechanism,risk,action} (ίδια με το AI/UI).
    ⚠️ field ονόματα προς επιβεβαίωση με πραγματικό κλειδί."""
    rows = payload if isinstance(payload, list) else (payload.get("interactions") or payload.get("data") or [])
    out: list[dict] = []
    for it in rows:
        sev = (it.get("severity") or "moderate").lower()
        if sev not in _SEV:
            sev = "moderate"
        # τα εμπλεκόμενα φάρμακα (ids/names) — δείξε ονόματα αν τα ξέρουμε
        drugs = it.get("drugs") or it.get("affected_products") or []
        nm = [id_to_name.get(d.get("id") or d.get("drugbank_pcid") or "", d.get("name") or "")
              for d in drugs if isinstance(d, dict)]
        nm = [x for x in nm if x][:2]
        out.append({
            "a": nm[0] if len(nm) > 0 else (it.get("subject") or "?"),
            "b": nm[1] if len(nm) > 1 else (it.get("affected") or "?"),
            "severity": sev,
            "mechanism": it.get("extended_description") or it.get("description") or "",
            "risk": it.get("description") or "",
            "action": it.get("management") or it.get("action") or "",
        })
    return out


async def check(names: list[str]) -> dict:
    """Έλεγχος drug-drug interactions μέσω DrugBank. Επιστρέφει {ok, interactions[], checked_drugs, source}.
    Σε οποιοδήποτε σφάλμα/μη-ρύθμιση → {ok: False, error} ώστε ο caller να πέσει σε AI fallback."""
    c = await _config()
    if not c["api_key"] or not c["enabled"]:
        return {"ok": False, "error": "not_configured"}
    names = [n.strip() for n in names if n and n.strip()][:_MAX_DRUGS]
    if len(names) < 1:
        return {"ok": True, "interactions": [], "checked_drugs": [], "source": "drugbank"}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            ids = await _resolve_ids(client, names, c["api_key"], c["region"])
            if len(ids) < 2:
                # <2 αναγνωρίσιμα → δεν γίνεται drug-drug (ο caller αποφασίζει fallback/μήνυμα)
                return {"ok": True, "interactions": [], "checked_drugs": list(ids.keys()),
                        "source": "drugbank", "note": "insufficient_matches"}
            id_to_name = {v: k for k, v in ids.items()}
            r = await client.get(f"{_BASE}/ddi",
                                 params=[("product_concept_id[]", pcid) for pcid in ids.values()],
                                 headers=_headers(c["api_key"], c["region"]))
            if r.status_code != 200:
                return {"ok": False, "error": f"http_{r.status_code}"}
            interactions = _parse_ddi(r.json(), id_to_name)
        return {"ok": True, "interactions": interactions, "checked_drugs": list(ids.keys()),
                "source": "drugbank"}
    except Exception as exc:  # noqa: BLE001
        logger.warning("DrugBank DDI check failed: %s", exc)
        return {"ok": False, "error": f"unavailable:{type(exc).__name__}"}
