"""Alpha Bank card payments — Alpha e-Commerce (Nexi/Cardlink) redirect integration.

Alpha e-Commerce uses a **redirect / hosted-payment-page** flow: we POST a signed form to the
gateway, the cardholder pays on Alpha's page, then the gateway redirects back to our confirm URL
with a signed result we verify. The signature is a Base64 SHA-256 **digest** over the ordered
parameter values concatenated with the merchant **shared secret**.

⚠️ LIVE ACTIVATION NEEDS: merchant_id + shared_secret + the exact gateway URL & digest field order
from Alpha Bank (see docs/alphabank-api-requirements.md). Credentials are stored encrypted in
``platform_settings._id="alphabank"``. Until configured, ``is_configured()`` is False and the
upgrade flow will not offer this method.
"""

from __future__ import annotations

import base64
import hashlib

from app.core.db import shared_db
from app.services.platform_secrets import decrypt_doc, encrypt_fields

# Hosted-payment-page endpoints (Cardlink/Nexi standard hosts). Confirm the exact host with Alpha.
_HOSTS = {
    "test": "https://alpha.test.modirum.com/vpos/shophandlermpi",
    "live": "https://www.alphaecommerce.gr/vpos/shophandlermpi",
}


async def config() -> dict:
    return decrypt_doc("alphabank", await shared_db()["platform_settings"].find_one({"_id": "alphabank"})) or {}


async def is_configured() -> bool:
    c = await config()
    return bool(c.get("merchant_id") and c.get("shared_secret"))


async def save_config(*, merchant_id: str | None = None, shared_secret: str | None = None,
                      mode: str | None = None) -> None:
    upd: dict = {}
    if merchant_id is not None:
        upd["merchant_id"] = merchant_id
    if shared_secret:
        upd["shared_secret"] = shared_secret
    if mode:
        upd["mode"] = mode
    if upd:
        await shared_db()["platform_settings"].update_one(
            {"_id": "alphabank"}, {"$set": encrypt_fields("alphabank", upd)}, upsert=True)


def _digest(values: list[str], secret: str) -> str:
    """Base64(SHA-256(concat(values) + shared_secret)) — the Alpha e-Commerce message digest."""
    raw = ("".join(values) + secret).encode("utf-8")
    return base64.b64encode(hashlib.sha256(raw).digest()).decode("ascii")


async def create_payment(*, amount_cents: int, currency: str, order_id: str, description: str,
                         confirm_url: str, cancel_url: str, email: str = "") -> dict:
    """Build the signed form the browser auto-submits to Alpha's hosted payment page.

    Returns {ok, action (gateway URL), fields (form fields incl. digest)}. The frontend renders a
    hidden <form method=POST action=action> with these fields and submits it.
    """
    c = await config()
    if not (c.get("merchant_id") and c.get("shared_secret")):
        return {"ok": False, "error": "alphabank_not_configured"}
    mode = c.get("mode", "test")
    amount = f"{amount_cents / 100:.2f}"
    # Ordered fields per the Alpha e-Commerce spec (confirm the exact set/order with Alpha).
    fields = {
        "version": "2",
        "mid": str(c["merchant_id"]),
        "orderid": order_id,
        "orderDesc": description,
        "amount": amount,
        "currency": currency,
        "payerEmail": email,
        "trType": "1",              # 1 = sale/purchase
        "confirmUrl": confirm_url,
        "cancelUrl": cancel_url,
    }
    # digest over the value list in field order + shared secret
    fields["digest"] = _digest(list(fields.values()), c["shared_secret"])
    return {"ok": True, "action": _HOSTS.get(mode, _HOSTS["test"]), "fields": fields,
            "order_id": order_id, "mode": mode}


async def verify_callback(params: dict) -> dict:
    """Verify the redirect-back digest and extract the payment result.

    Returns {ok, paid, order_id}. ⚠️ The exact response field names & digest field order must be
    confirmed with Alpha Bank before relying on this in production.
    """
    c = await config()
    secret = c.get("shared_secret")
    if not secret:
        return {"ok": False, "error": "not_configured"}
    supplied = params.get("digest") or ""
    ordered = [str(params.get(k, "")) for k in (
        "mid", "orderid", "status", "orderAmount", "currency", "paymentTotal", "txId")]
    expected = _digest(ordered, secret)
    status = str(params.get("status", "")).upper()
    return {"ok": supplied == expected, "paid": status in ("CAPTURED", "AUTHORIZED", "SUCCESS"),
            "order_id": params.get("orderid")}
