"""Viva Wallet (Smart Checkout) — κάρτα + IRIS με ΕΝΑ integration.

Δύο χρήσεις, ίδιο client:
  • ΠΛΑΤΦΟΡΜΑ (συνδρομές): creds στο platform_settings._id='viva' — εναλλακτική του Revolut για
    off-session recurring χρέωση συνδρομών (χρήσιμο όσο δεν έχει ενεργοποιηθεί ο λογαριασμός Revolut).
  • E-SHOP (ανά φαρμακείο): creds ανά tenant → τα λεφτά πάνε ΚΑΤΕΥΘΕΙΑΝ στο φαρμακείο.

Auth Viva (δύο μηχανισμοί):
  • OAuth2 client-credentials (Smart Checkout /checkout/v2/*) — client_id + client_secret.
  • Basic auth (classic /api/*, recurring) — merchant_id + api_key.
Το IRIS εμφανίζεται ΑΥΤΟΜΑΤΑ στο checkout αν ο έμπορος το έχει ενεργό στο Viva — χωρίς extra κώδικα.
"""

from __future__ import annotations

import base64

import httpx

from app.core.db import shared_db

# Live vs demo (sandbox) endpoints
_URLS = {
    "live": {"accounts": "https://accounts.vivapayments.com",
             "api": "https://api.vivapayments.com",
             "web": "https://www.vivapayments.com",
             "checkout": "https://www.vivapayments.com/web/checkout?ref="},
    "demo": {"accounts": "https://demo-accounts.vivapayments.com",
             "api": "https://demo-api.vivapayments.com",
             "web": "https://demo.vivapayments.com",
             "checkout": "https://demo.vivapayments.com/web/checkout?ref="},
}


def _urls(creds: dict) -> dict:
    return _URLS["live"] if creds.get("mode") == "live" else _URLS["demo"]


async def platform_config() -> dict:
    from app.services.platform_secrets import decrypt_doc
    return decrypt_doc("viva", await shared_db()["platform_settings"].find_one({"_id": "viva"})) or {}


async def _creds(creds: dict | None) -> dict:
    """Χρησιμοποίησε τα δοσμένα creds (e-shop, ανά φαρμακείο) ή τα platform creds (συνδρομές).
    Trim σε κάθε string πεδίο — κρυφά κενά/tabs από copy-paste (π.χ. API key) σπάνε το Basic/OAuth auth."""
    c = creds if creds is not None else await platform_config()
    return {k: (v.strip() if isinstance(v, str) else v) for k, v in (c or {}).items()}


def is_ready(creds: dict) -> bool:
    """Έτοιμο για Smart Checkout (κάρτα/IRIS): client_id + client_secret + source_code."""
    return bool(creds.get("client_id") and creds.get("client_secret") and creds.get("source_code"))


def can_recurring(creds: dict) -> bool:
    """Έτοιμο για off-session recurring (συνδρομές): merchant_id + api_key."""
    return bool(creds.get("merchant_id") and creds.get("api_key"))


async def is_configured(creds: dict | None = None) -> bool:
    return is_ready(await _creds(creds))


async def _oauth_token(creds: dict) -> str | None:
    """OAuth2 client-credentials access token για το Smart Checkout API."""
    cid, csec = creds.get("client_id"), creds.get("client_secret")
    if not (cid and csec):
        return None
    basic = base64.b64encode(f"{cid}:{csec}".encode()).decode()
    try:
        async with httpx.AsyncClient(timeout=20) as cl:
            r = await cl.post(f"{_urls(creds)['accounts']}/connect/token",
                              headers={"Authorization": f"Basic {basic}",
                                       "Content-Type": "application/x-www-form-urlencoded"},
                              data={"grant_type": "client_credentials"})
            r.raise_for_status()
            return r.json().get("access_token")
    except Exception:  # noqa: BLE001
        return None


def _basic(creds: dict) -> str:
    raw = f"{creds.get('merchant_id')}:{creds.get('api_key')}"
    return "Basic " + base64.b64encode(raw.encode()).decode()


async def create_checkout_order(*, amount: int, ref: str, description: str,
                                email: str = "", full_name: str = "", phone: str = "",
                                allow_recurring: bool = False, creds: dict | None = None) -> dict:
    """Δημιούργησε Smart Checkout order (κάρτα + IRIS). `amount` σε cents. Επιστρέφει
    {ok, order_code, checkout_url} → ο πελάτης ανακατευθύνεται εκεί & πληρώνει (κάρτα ή IRIS).
    `allow_recurring=True` → αποθηκεύει την κάρτα ώστε να χρεώνουμε off-session αργότερα (συνδρομές)."""
    c = await _creds(creds)
    if not is_ready(c):
        return {"ok": False, "error": "viva_not_configured"}
    token = await _oauth_token(c)
    if not token:
        return {"ok": False, "error": "viva_auth_failed"}
    payload = {
        "amount": int(amount),
        "customerTrns": description[:2048],
        "customer": {"email": email or "", "fullName": full_name or "",
                     "phone": phone or "", "countryCode": "GR", "requestLang": "el-GR"},
        "paymentTimeout": 1800, "preauth": False,
        "allowRecurring": bool(allow_recurring),
        "maxInstallments": 0, "paymentNotification": True,
        "sourceCode": c.get("source_code"), "merchantTrns": ref[:2048],
    }
    try:
        async with httpx.AsyncClient(timeout=25) as cl:
            r = await cl.post(f"{_urls(c)['api']}/checkout/v2/orders",
                              headers={"Authorization": f"Bearer {token}",
                                       "Content-Type": "application/json"}, json=payload)
            r.raise_for_status()
            code = r.json().get("orderCode")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"viva_error:{type(e).__name__}"}
    if not code:
        return {"ok": False, "error": "viva_no_order_code"}
    return {"ok": True, "order_code": str(code), "checkout_url": f"{_urls(c)['checkout']}{code}"}


async def charge_recurring(*, original_transaction_id: str, amount: int, description: str,
                           creds: dict | None = None) -> dict:
    """Off-session recurring χρέωση στην αποθηκευμένη κάρτα (ανανέωση συνδρομής), βάσει του
    original transaction id της πρώτης (recurring-enabled) πληρωμής. Επιστρέφει {ok, transaction_id}."""
    c = await _creds(creds)
    if not can_recurring(c):
        return {"ok": False, "error": "viva_recurring_not_configured"}
    payload = {"amount": int(amount), "customerTrns": description[:2048],
               "sourceCode": c.get("source_code")}
    try:
        async with httpx.AsyncClient(timeout=30) as cl:
            r = await cl.post(f"{_urls(c)['api']}/api/transactions/{original_transaction_id}",
                              headers={"Authorization": _basic(c),
                                       "Content-Type": "application/json"}, json=payload)
            r.raise_for_status()
            d = r.json()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"viva_error:{type(e).__name__}"}
    tid = d.get("TransactionId") or d.get("transactionId")
    ok = bool(d.get("Success", True)) and bool(tid)
    return {"ok": ok, "transaction_id": tid, "raw_state": d.get("StatusId")}


async def webhook_verification_key(creds: dict | None = None) -> str | None:
    """Viva GET-verification: όταν καταχωρείς webhook URL, το Viva κάνει GET & περιμένει {"Key": ...}.
    Το key αντλείται από /api/messages/config/token (Basic auth)."""
    c = await _creds(creds)
    if not can_recurring(c):
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as cl:
            # Το webhook verification-key ζει στον MAIN host (www./demo.vivapayments.com), όχι στο api.
            r = await cl.get(f"{_urls(c)['web']}/api/messages/config/token",
                             headers={"Authorization": _basic(c)})
            r.raise_for_status()
            return r.json().get("Key")
    except Exception:  # noqa: BLE001
        return None


async def get_transaction(transaction_id: str, creds: dict | None = None) -> dict | None:
    """Ανάκτηση συναλλαγής (επιβεβαίωση πληρωμής μετά το redirect/webhook)."""
    c = await _creds(creds)
    if not can_recurring(c):
        return None
    try:
        async with httpx.AsyncClient(timeout=20) as cl:
            r = await cl.get(f"{_urls(c)['api']}/api/transactions/{transaction_id}",
                             headers={"Authorization": _basic(c)})
            r.raise_for_status()
            return r.json()
    except Exception:  # noqa: BLE001
        return None
