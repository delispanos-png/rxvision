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
import logging

import httpx

from app.core.db import shared_db

log = logging.getLogger(__name__)

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


def _rest_url(creds: dict, path: str) -> str:
    """ΕΝΑΣ ορισμός host για το Basic-auth REST API (/api/transactions…): ζει στο «web» (www./demo.),
    ΟΧΙ στο api.vivapayments.com (404). Το api. είναι ΜΟΝΟ για OAuth endpoints (/checkout/v2/…).
    Η παγίδα έπιασε δύο φορές (επαλήθευση 2026-09, αυτόματη χρέωση 2026-10) — κάθε /api/ κλήση περνά από εδώ."""
    return f"{_urls(creds)['web']}{path}"


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
    except httpx.HTTPStatusError as e:
        # π.χ. 400 invalid_client → λάθος/ανακληθέν client_id ή client_secret στο adminpanel → Πληρωμές.
        log.warning("viva_oauth_failed mode=%s status=%s body=%s",
                    creds.get("mode"), e.response.status_code, e.response.text[:200])
        return None
    except Exception as e:  # noqa: BLE001
        log.warning("viva_oauth_error mode=%s err=%r", creds.get("mode"), e)
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
                           merchant_trns: str = "", creds: dict | None = None) -> dict:
    """Off-session recurring χρέωση στην αποθηκευμένη κάρτα (ανανέωση συνδρομής), βάσει του
    original transaction id της πρώτης (recurring-enabled) πληρωμής. Επιστρέφει {ok, transaction_id}."""
    c = await _creds(creds)
    if not can_recurring(c):
        return {"ok": False, "error": "viva_recurring_not_configured"}
    payload = {"amount": int(amount), "customerTrns": description[:2048],
               "sourceCode": c.get("source_code")}
    if merchant_trns:
        payload["merchantTrns"] = merchant_trns[:2048]
    try:
        async with httpx.AsyncClient(timeout=30) as cl:
            # Basic-auth REST (/api/…) = host «web» (www.) — στο api. γύριζε 404 και ΚΑΜΙΑ αυτόματη χρέωση
            # δεν έφτανε ποτέ στη Viva (02/10/2026). Βλ. _rest_url.
            r = await cl.post(_rest_url(c, f"/api/transactions/{original_transaction_id}"),
                              headers={"Authorization": _basic(c),
                                       "Content-Type": "application/json"}, json=payload)
            r.raise_for_status()
            d = r.json()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"viva_error:{type(e).__name__}"}
    tid = d.get("TransactionId") or d.get("transactionId")
    # Η Viva απαντά HTTP 200 ΚΑΙ στην αποτυχία (StatusId "E", ErrorCode/ErrorText) → επιτυχία = "F" + id
    ok = bool(d.get("Success", True)) and str(d.get("StatusId") or "") == "F" and bool(tid)
    return {"ok": ok, "transaction_id": tid, "raw_state": d.get("StatusId"),
            "error": None if ok else f"viva_{d.get('ErrorCode')}: {d.get('ErrorText') or ''}"[:300]}


async def webhook_verification_key(creds: dict | None = None) -> str | None:
    """Viva GET-verification: όταν καταχωρείς webhook URL, το Viva κάνει GET & περιμένει {"Key": ...}.
    Το key αντλείται από /api/messages/config/token (Basic auth)."""
    c = await _creds(creds)
    if not can_recurring(c):
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as cl:
            # Το webhook verification-key ζει στον MAIN host (www./demo.vivapayments.com), όχι στο api.
            r = await cl.get(_rest_url(c, "/api/messages/config/token"),
                             headers={"Authorization": _basic(c)})
            r.raise_for_status()
            return r.json().get("Key")
    except Exception:  # noqa: BLE001
        return None


def _first_transaction(payload) -> dict | None:
    """Το Viva τυλίγει ΠΑΝΤΑ την απάντηση σε {"Transactions": [ … ]} — ακόμη και όταν ζητάς ΜΙΑ
    συναλλαγή με το id της. Χωρίς ξετύλιγμα, το `StatusId` διαβαζόταν από το ΠΕΡΙΤΥΛΙΓΜΑ και έβγαινε
    πάντα None → ο fail-closed έλεγχος απέρριπτε κάθε γνήσια πληρωμή."""
    if not isinstance(payload, dict):
        return None
    rows = payload.get("Transactions")
    if isinstance(rows, list):
        return next((t for t in rows if isinstance(t, dict)), None)
    return payload if "StatusId" in payload else None


async def get_transaction(transaction_id: str, creds: dict | None = None) -> dict | None:
    """Ανάκτηση συναλλαγής (επιβεβαίωση πληρωμής μετά το redirect/webhook)."""
    c = await _creds(creds)
    if not can_recurring(c):
        return None
    try:
        async with httpx.AsyncClient(timeout=20) as cl:
            # ΠΡΟΣΟΧΗ ΣΤΟΝ HOST: το Basic-auth REST API (/api/…) ζει στον MAIN host
            # (www./demo.vivapayments.com) — ΟΧΙ στο api.vivapayments.com, που γυρίζει 404.
            r = await cl.get(_rest_url(c, f"/api/transactions/{transaction_id}"),
                             headers={"Authorization": _basic(c)})
            r.raise_for_status()
            return _first_transaction(r.json())
    except Exception:  # noqa: BLE001
        return None


async def get_order_transactions(order_code: str, creds: dict | None = None) -> list[dict]:
    """Οι συναλλαγές μιας παραγγελίας checkout, με βάση τον **orderCode**.

    ΓΙΑΤΙ ΧΡΕΙΑΖΕΤΑΙ: το webhook μάς δίνει TransactionId, αλλά εμείς κρατάμε orderCode. Όταν το
    webhook ΔΕΝ φτάσει (δίκτυο, λάθος ρύθμιση, downtime), αυτό είναι ο ΜΟΝΟΣ τρόπος να μάθουμε
    μόνοι μας ότι ο πελάτης πλήρωσε — χωρίς αυτό, «πλήρωσε και δεν έγινε τίποτα», σιωπηλά.
    """
    c = await _creds(creds)
    if not can_recurring(c):
        return []
    try:
        async with httpx.AsyncClient(timeout=20) as cl:
            r = await cl.get(_rest_url(c, "/api/transactions"),
                             params={"ordercode": str(order_code)},
                             headers={"Authorization": _basic(c)})
            r.raise_for_status()
            d = r.json()
    except Exception:  # noqa: BLE001
        return []
    rows = d.get("Transactions") if isinstance(d, dict) else d
    return [t for t in (rows or []) if isinstance(t, dict)]


def amount_cents(info: dict | None) -> int:
    """Το Viva δίνει Amount σε ΕΥΡΩ (float) στο REST API — εμείς δουλεύουμε σε cents."""
    try:
        return int(round(float((info or {}).get("Amount") or 0) * 100))
    except (TypeError, ValueError):
        return 0


async def verify_payment(transaction_id: str | None, *, expected_cents: int | None = None,
                         merchant_trns: str | None = None, order_code: str | None = None,
                         creds: dict | None = None) -> dict:
    """ΕΝΑΣ ορισμός για το «πληρώθηκε;» (02/10/2026). ΚΑΘΕ απόφαση πληρωμής Viva — ανανέωση, εγγραφή,
    φόρτωση μονάδων, αναβάθμιση, e-shop, «Πληρωμένο» σε παραστατικό — περνά από εδώ. Ρωτά την ΙΔΙΑ τη Viva
    και ελέγχει: ολοκληρωμένη (StatusId F) · ΠΟΙΑ πληρωμή (MerchantTrns / OrderCode) · ΠΟΣΑ (≥ αναμενόμενο).
    FAIL-CLOSED: οτιδήποτε ασαφές → ok=False με `reason`.

    Γιατί: η επαλήθευση κάρτας 0,10 € (Helthea, 29/09/2026) πέρασε ως «ανανέωση 110,36 € — πληρωμένο»,
    επειδή κάθε ροή αποφάσιζε μόνη της, χωρίς να ρωτά ποσό και είδος."""
    if not transaction_id:
        return {"ok": False, "reason": "no_transaction"}
    info = await get_transaction(str(transaction_id), creds=creds)
    if not info:
        return {"ok": False, "reason": "not_found", "transaction_id": str(transaction_id)}
    res = {"transaction_id": str(transaction_id), "status": str(info.get("StatusId") or ""),
           "amount_cents": amount_cents(info), "merchant_trns": str(info.get("MerchantTrns") or ""),
           "order_code": str(info.get("OrderCode") or "")}
    if res["status"] != "F":
        return {**res, "ok": False, "reason": "not_finished"}
    if merchant_trns is not None and res["merchant_trns"] != merchant_trns:
        return {**res, "ok": False, "reason": "other_payment"}
    if order_code and res["order_code"] != str(order_code):
        return {**res, "ok": False, "reason": "other_order"}
    if expected_cents is not None and res["amount_cents"] < int(expected_cents):
        return {**res, "ok": False, "reason": "amount_short"}
    return {**res, "ok": True, "reason": None}


async def order_paid_transaction(order_code: str, creds: dict | None = None) -> dict | None:
    """Η ΕΠΙΤΥΧΗΜΕΝΗ συναλλαγή μιας παραγγελίας (StatusId 'F'), αλλιώς None."""
    for t in await get_order_transactions(order_code, creds):
        if str(t.get("StatusId") or "") == "F":
            return t
    return None
