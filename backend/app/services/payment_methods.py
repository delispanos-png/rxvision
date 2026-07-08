"""Payment-method availability (platform-configurable).

The platform admin turns each method on/off; the tenant upgrade flow and the public registration
wizard render only the ENABLED ones. Methods:

* ``card_revolut``  — instant card payment via Revolut (existing integration).
* ``card_alpha``    — instant card payment via Alpha Bank (Alpha e-Commerce redirect). Needs the
                       merchant credentials configured (see ``alphabank_service``) to go live.
* ``bank_transfer`` — manual bank deposit → shows as a request in the admin panel, applied on approval.

Config lives in ``platform_settings._id="payment_methods"`` = {method: {enabled: bool}}.
"""

from __future__ import annotations

from app.core.db import shared_db

METHODS = ("card_revolut", "card_alpha", "bank_transfer")

# Sensible defaults if never configured: Revolut card + bank transfer on, Alpha off (no creds yet).
_DEFAULTS = {
    "card_revolut": {"enabled": True},
    "card_alpha": {"enabled": False},
    "bank_transfer": {"enabled": True},
}

_LABELS = {
    "card_revolut": {"el": "Κάρτα (Revolut)", "en": "Card (Revolut)"},
    "card_alpha": {"el": "Κάρτα (Alpha Bank)", "en": "Card (Alpha Bank)"},
    "bank_transfer": {"el": "Τραπεζική κατάθεση", "en": "Bank transfer"},
}


async def _cfg() -> dict:
    return await shared_db()["platform_settings"].find_one({"_id": "payment_methods"}) or {}


async def config() -> dict:
    """Full config (admin view): every method with its enabled flag."""
    cfg = await _cfg()
    return {m: {"enabled": bool((cfg.get(m) or _DEFAULTS[m]).get("enabled", _DEFAULTS[m]["enabled"])),
                "label": _LABELS[m]} for m in METHODS}


async def enabled() -> dict[str, bool]:
    cfg = await config()
    return {m: cfg[m]["enabled"] for m in METHODS}


async def is_enabled(method: str) -> bool:
    return (await enabled()).get(method, False)


async def public_methods() -> list[dict]:
    """Enabled methods for the tenant/registration UI (id + label)."""
    en = await enabled()
    return [{"id": m, "label": _LABELS[m]} for m in METHODS if en.get(m)]


async def set_config(updates: dict[str, bool]) -> dict:
    """Enable/disable methods. `updates` = {method: bool}."""
    cfg = await _cfg()
    for m, on in updates.items():
        if m in METHODS:
            cfg.setdefault(m, {})["enabled"] = bool(on)
    cfg.pop("_id", None)
    await shared_db()["platform_settings"].update_one(
        {"_id": "payment_methods"}, {"$set": cfg}, upsert=True)
    return await config()
