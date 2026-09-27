"""RxVision Partner API — ξεχωριστή εφαρμογή, δικό της Swagger.

ΓΙΑΤΙ ΞΕΧΩΡΙΣΤΗ ΕΦΑΡΜΟΓΗ ΚΑΙ ΟΧΙ ΑΛΛΟ ΕΝΑ ROUTER:
Το εσωτερικό API έχει τα docs ΚΛΕΙΣΤΑ στην παραγωγή, επίτηδες — εκθέτει admin, GDPR, ingestion.
Το API συνεργατών πρέπει να έχει τα docs ΑΝΟΙΧΤΑ, αλλιώς δεν το χρησιμοποιεί κανείς. Δύο
εφαρμογές με χωριστά schemas λύνουν και τα δύο: ό,τι δεν είναι εδώ μέσα, δεν φαίνεται ποτέ.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

#: Έκδοση ΤΟΥ API — SINGLE SOURCE OF TRUTH. Τη διαβάζουν και το Swagger και το `GET /v1/ping`,
#: ώστε να μην μπορούν ΠΟΤΕ να διαφωνήσουν. Ο κανόνας είναι στο `create_partner_app()`.
API_VERSION = "1.1.0"

DESCRIPTION = """
Welcome to the **RxVision Partner API**.

It lets your software read and write data for a pharmacy that uses RxVision — product catalogue,
stock, prescription dispensings and e-shop orders.

---

## 1. Getting started in three steps

**Step 1 — Get a key.** The key is issued by **the pharmacist**, from
*Settings → API keys* inside RxVision. They choose what it may do (scopes) and hand you the key:

```
rxv_live_8tKm2pQvXn4RsYbW9cFhJ3dLgE7aZuNt
```

> ⚠️ **The key is shown once.** We never store the key itself, only a fingerprint of it — exactly
> as passwords are handled. If it is lost it cannot be recovered: the pharmacist revokes the old
> one and issues a new one.

**Step 2 — Check that it works.** One command:

```bash
curl -H "X-API-Key: rxv_live_…" https://api.rxvision.gr/v1/ping
```

If you get `{"ok": true, ...}` you are in. If not, see **§5 Errors** — every error tells you what
is wrong and how to fix it.

**Step 3 — Call your first real endpoint.** Start with `GET /v1/products`: it is read-only,
changes nothing, and shows you real data immediately.

---

## 2. Authentication

Send this header on **every** request:

```
X-API-Key: rxv_live_…
```

**The key also determines which pharmacy the request is about.** You never send a `tenant_id` or
any "on behalf of" parameter — no such parameter exists anywhere in this API. A key sees **only**
the pharmacy that issued it, and there is no way for it to see another.

### Scopes

Each key carries specific permissions. If the one an endpoint needs is missing you get **403**,
naming the scope.

| Scope | What it allows |
|---|---|
| `products:read` | product catalogue and prices |
| `stock:read` | read stock levels |
| `stock:write` | record stock movements |
| `prescriptions:read` | prescription dispensings *(no patient identity)* |
| `patients:read` | patients — **contains health data** |
| `orders:read` | e-shop orders |
| `orders:write` | change order status |
| `sales:write` | send till sales (OTC, parapharmacy, services) |
| `sales:read` | read till sales |

> 💡 **Ask for the fewest scopes you need.** If your software only updates stock, ask for
> `stock:read` and `stock:write` and nothing else. A leaked key then does limited damage — and
> the pharmacist approves the request far more readily.

---

## 3. The pharmacy's subscription must be active

If the pharmacy's RxVision subscription has **expired, been suspended or cancelled**, every call
returns **402** with `error: "subscription_inactive"` — even with a perfectly valid key.

Nothing is wrong with your integration. Tell the pharmacy; the moment they renew, the API works
again immediately and **no new key is needed**.

> 💡 A subscription in its payment grace period (`past_due`) still serves requests normally.

---

## 4. Pagination

Every endpoint that returns a list behaves **identically**:

| Parameter | Default | Maximum |
|---|---|---|
| `limit` | 50 | 200 |
| `cursor` | — | — |

The response always has this shape:

```json
{
  "items": [ ... ],
  "next_cursor": "eyJpZCI6IjY1YT...",
  "has_more": true
}
```

**To read a whole list:** call without `cursor`. While `has_more` is `true`, call again passing
`cursor` = the `next_cursor` you received. Stop when it turns `false`.

```bash
# first page
curl -H "X-API-Key: …" "https://api.rxvision.gr/v1/products?limit=100"
# next page
curl -H "X-API-Key: …" "https://api.rxvision.gr/v1/products?limit=100&cursor=eyJpZCI6…"
```

> ⚠️ **Never build a `cursor` yourself.** It is opaque and its format may change. Pass back
> exactly what we gave you.

---

## 5. Errors

Every error returns **the same three fields**:

```json
{
  "error": "missing_scope",
  "message": "Your key does not have the scope “stock:write”.",
  "hint": "Ask the pharmacy to issue a key with this scope."
}
```

| Status | Meaning | What to do |
|---|---|---|
| **400** | Bad request | Read `message` — it names the field at fault |
| **401** | Key missing, invalid, revoked, expired, or your IP is not allowed | The `error` code distinguishes these |
| **402** | The pharmacy's subscription is not active | Tell the pharmacy — nothing to fix on your side |
| **403** | The key lacks the required scope | Ask for a new key with that scope |
| **404** | Not found | The id does not belong to this pharmacy |
| **409** | Conflict | The action already happened or contradicts another |
| **422** | Body does not match the schema | See `fields` — it names each problem |
| **429** | Rate limit exceeded | Wait; see the `Retry-After` header |
| **5xx** | Our problem | Retry with backoff; if it persists, contact us |

> 💡 **`hint` is written to be read.** In most cases the answer is inside the error itself.

---

## 6. Rate limits

**600 requests per minute, per key.** On 429 you get a `Retry-After` header with the number of
seconds to wait.

**Good practice:** do not poll asking "has anything changed?". Read once and keep what you got;
for the rest use the date filters (`updated_since`, `from`/`to`) so you receive **only what
changed**.

---

## 7. Dates, times and money

- **Dates and times:** always **ISO 8601 in UTC**, e.g. `2026-09-27T14:30:00Z`. Anything you send
  without a timezone is read as UTC.
- **Money:** always **integer cents**, never decimals. `1250` means **€12.50**.
  *Why:* binary floating point loses cents when you add them up — unacceptable for money.

---

## 8. What this API does not do

So you do not waste time looking:

- **It does not submit anything to ΗΔΥΚΑ or HMVO.** The pharmacy's own dispensing software does
  that. RxVision is an analytics tool.
- **It does not dispense prescriptions.** It reads dispensings that already happened.
- **It does not change prices of prescription medicines.** Those are set by state tariff.

---

## 9. Versioning — how you know something changed

The version at the top of this page (and in `GET /v1/ping`) changes **every time this API
changes**. It follows semantic versioning:

| Change | Version | What it means for you |
|---|---|---|
| **PATCH** (1.1.0 → 1.1.1) | a fix | Nothing to do. Behaviour now matches what this page already promised. |
| **MINOR** (1.1.0 → 1.2.0) | new endpoints or new **optional** fields | Nothing breaks. Read the changelog to see what you gained. |
| **MAJOR** (1.x → 2.0.0) | breaking | A field was removed, renamed, or changed meaning. **You will be told before this happens.** |

The path prefix `/v1/` is a **separate** promise: it only ever changes on a MAJOR, and the old
version keeps serving while you migrate. So `1.x` will never break your integration.

> 💡 **Worth doing:** log the `api_version` from `GET /v1/ping` on start-up. When support asks
> “which version were you calling?”, you will have the answer in one line instead of a guess.

---

## 10. Changelog

### 1.1.0 — 27/09/2026
**Loyalty and clinical support — nine new endpoints.**

*New — Customers (`patients:read`)*
- `POST /v1/customers/link` · `DELETE /v1/customers/{customer_ref}/link` — bridge your customer id
  to the pharmacy's patient record, once. Everything personalised needs it.

*New — Loyalty (`loyalty:read` / `loyalty:write`, feature `loyalty`)*
- `GET /v1/loyalty/config` · `GET /v1/loyalty/customers/{customer_ref}` ·
  `POST /v1/loyalty/enroll` · `GET /v1/loyalty/rewards` · `POST /v1/loyalty/redeem`
- Run the pharmacy's loyalty card at your own till. Redemptions are idempotent on your
  `external_id`.

*New — Clinical (`clinical:read`, feature `pharmacat`)*
- `POST /v1/clinical/interactions` — check a basket; with a linked `customer_ref` and
  `patients:read`, checked against the patient's whole active ΗΔΥΚΑ therapy (needs the pharmacy's
  `drug_interactions` feature).
- `POST /v1/clinical/advise` — counter advice, red flags first, OTC **categories** not products.

*Changed — `POST /v1/sales`*
- Sales carrying a linked `customer_ref` now **credit loyalty points automatically**. The response
  gained a `loyalty` object (`credited_sales`, `credited_cents`). Existing callers are unaffected:
  without the field, or with loyalty off, it reports zero.

*Fixed*
- Errors from endpoints that legitimately return **404** (patient not matched, customer not
  linked) used to be replaced by a generic “no endpoint exists at …”. They now return their real
  `error` code, and the wrong-path message shows the path **you** called, not our internal one.
- Sending neither `amka` nor `phone` to `/v1/customers/link` now returns **400 `no_identifier`**
  instead of a misleading 404.
- `involves_new` on interactions was never `true` when you sent a brand or a strength
  (“Ibuprofen 400mg”). It now matches on substance words, so the interactions your basket caused
  are flagged as intended.

### 1.0.0 — 27/09/2026
First release: catalogue, stock (read + movements), prescription dispensings, till sales, e-shop
orders.
"""

TAGS = [
    {"name": "Health check", "description":
        "Start here. Confirm your key works and see which scopes it carries."},
    {"name": "Catalogue", "description":
        "The pharmacy's products: barcode, name, prices, category. Read only."},
    {"name": "Stock", "description":
        "Read and update stock. This is where dispensing software usually connects."},
    {"name": "Prescriptions", "description":
        "Prescription dispensings. **No patient identity is returned** — the patient appears as a "
        "stable pseudonym, so you can correlate records without learning who they are."},
    {"name": "Sales", "description":
        "Till sales — including OTC, parapharmacy and services. This is how the pharmacy gets a "
        "complete commercial picture instead of only the reimbursed part. Free sales are stored "
        "separately and never mix into prescription analytics."},
    {"name": "Orders", "description":
        "e-shop orders and their journey to delivery."},
    {"name": "Customers", "description":
        "Link a customer in your system to their patient record — once per customer. Everything "
        "personalised (loyalty balance, therapy checks) needs this bridge, and nothing else in the "
        "API ever asks for an identifier again."},
    {"name": "Loyalty", "description":
        "The pharmacy's **loyalty programme**, usable from your till. Points are earned from "
        "prescription adherence and from the sales you send us; they are spent as money off the "
        "basket or on the pharmacy's own rewards. Most commercial systems have no loyalty "
        "programme — this one is already built, already configured by the pharmacist, and already "
        "accruing. You read a balance and apply a discount."},
    {"name": "Clinical", "description":
        "**PharmaCat** — interaction checks and counter advice. With a linked customer, a basket is "
        "checked against the patient's whole active therapy as recorded in ΗΔΥΚΑ, *including "
        "prescriptions dispensed at other pharmacies* — something your own database cannot see. "
        "Clinical decision support: it assists the pharmacist, it does not diagnose."},
]


def create_partner_app() -> FastAPI:
    app = FastAPI(
        title="RxVision Partner API",
        # ⚠ ΚΑΝΟΝΑΣ (οδηγία ιδιοκτήτη 27/09/2026): ΚΑΘΕ αλλαγή στο API ανεβάζει ΑΥΤΟΝ τον αριθμό
        # και γράφει γραμμή στο «10. Changelog» του DESCRIPTION. Ο συνεργάτης δεν έχει άλλο τρόπο
        # να μάθει ότι κάτι άλλαξε: δεν του στέλνουμε email, δεν μπαίνει στο adminpanel. Το
        # Swagger ΕΙΝΑΙ η ανακοίνωση. Semver για API:
        #   PATCH → διόρθωση χωρίς αλλαγή συμβολαίου
        #   MINOR → νέα endpoints/πεδία, συμβατά προς τα πίσω
        #   MAJOR → breaking (αφαίρεση/μετονομασία πεδίου, αλλαγή σημασίας)
        # ΔΕΝ είναι η έκδοση της εφαρμογής (`frontend/src/lib/version.ts`) — άλλο κοινό, άλλος ρυθμός.
        version=API_VERSION,
        description=DESCRIPTION,
        openapi_tags=TAGS,
        # ΔΙΚΕΣ ΜΑΣ σελίδες docs (πιο κάτω). ΓΙΑΤΙ: το app είναι mounted, οπότε το FastAPI
        # γράφει στο HTML την ΕΣΩΤΕΡΙΚΗ διαδρομή `/api/partner/openapi.json` — που το
        # developers.rxvision.gr σκόπιμα ΔΕΝ σερβίρει. Ο browser έπαιρνε «No API definition».
        docs_url=None,
        redoc_url=None,
        openapi_url="/openapi.json",
        contact={"name": "RxVision", "url": "https://rxvision.gr"},
        # ΠΡΟΣΟΧΗ: το app είναι mounted στο /api/partner, οπότε το FastAPI βάζει ΜΟΝΟ ΤΟΥ αυτό
        # το πρόθεμα στα servers. Αν το αφήσουμε, το «Try it out» του Swagger χτυπά
        # `/api/partner/v1/…` πάνω στο developers.rxvision.gr — που δεν σερβίρει δεδομένα.
        # Το `root_path_in_servers=False` το εμποδίζει· δηλώνουμε εμείς τη ΔΗΜΟΣΙΑ διεύθυνση.
        root_path_in_servers=False,
        servers=[{"url": "https://api.rxvision.gr", "description": "Production"}],
    )

    # ΤΟ ΣΧΗΜΑ ΣΦΑΛΜΑΤΟΣ ΠΡΕΠΕΙ ΝΑ ΕΙΝΑΙ ΑΚΡΙΒΩΣ ΑΥΤΟ ΠΟΥ ΥΠΟΣΧΕΤΑΙ ΤΟ SWAGGER.
    # Το FastAPI τυλίγει το detail σε {"detail": …}. Αν το αφήναμε, ο προγραμματιστής που
    # διάβασε «τρία πεδία: error, message, hint» θα έπαιρνε κάτι άλλο — και θα έχανε ώρες.
    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request, exc):  # noqa: ANN001
        d = exc.detail
        if isinstance(d, dict) and "error" in d:
            body = {"error": d.get("error"), "message": d.get("message"), "hint": d.get("hint")}
            extra = {k: v for k, v in d.items() if k not in body}
            body.update(extra)
        else:
            body = {"error": f"http_{exc.status_code}", "message": str(d), "hint": None}
        headers = getattr(exc, "headers", None)
        return JSONResponse(status_code=exc.status_code, content=body, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request, exc):  # noqa: ANN001
        """422: πες ΠΟΙΟ πεδίο φταίει και τι περίμενες — όχι σκέτο stack των pydantic errors."""
        errs = exc.errors()
        first = errs[0] if errs else {}
        loc = " → ".join(str(x) for x in first.get("loc", []) if x != "body")
        return JSONResponse(status_code=422, content={
            "error": "validation_error",
            "message": f"Field “{loc or '?'}” is not valid: {first.get('msg', '')}",
            "hint": "See `fields` for every problem. Money is INTEGER CENTS and dates are "
                    "ISO 8601 in UTC (e.g. 2026-09-27T14:30:00Z).",
            "fields": [{"field": " → ".join(str(x) for x in e.get("loc", []) if x != "body"),
                        "problem": e.get("msg")} for e in errs[:10]],
        })

    @app.exception_handler(Exception)
    async def _unhandled(request, exc):  # noqa: ANN001
        import logging
        logging.getLogger(__name__).exception("partner api error")
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error",
                     "message": "Something went wrong on our side.",
                     "hint": "Retry shortly. If it persists, send us the time of the request "
                             "and the endpoint."})

    # Οι σελίδες τεκμηρίωσης, με ΡΗΤΗ δημόσια διαδρομή στο schema.
    @app.get("/docs", include_in_schema=False)
    async def _docs():
        return get_swagger_ui_html(
            openapi_url="/openapi.json",
            title="RxVision Partner API — documentation",
            swagger_ui_parameters={"docExpansion": "list", "defaultModelsExpandDepth": 2,
                                   "tryItOutEnabled": True, "persistAuthorization": True,
                                   "displayRequestDuration": True})

    @app.get("/redoc", include_in_schema=False)
    async def _redoc():
        return get_redoc_html(openapi_url="/openapi.json",
                              title="RxVision Partner API — τεκμηρίωση")

    from app.api.partner.v1 import router as v1
    app.include_router(v1, prefix="/v1")

    # 404 ΠΟΥ ΒΟΗΘΑΕΙ. Το σκέτο «Not Found» αφήνει τον προγραμματιστή να μαντεύει αν έγραψε
    # λάθος τη διαδρομή, αν λείπει το /v1, ή αν το endpoint δεν υπάρχει καθόλου.
    @app.exception_handler(404)
    async def _not_found(request, exc):  # noqa: ANN001
        # ΠΡΩΤΑ ΤΑ ΔΙΚΑ ΜΑΣ 404. Ένα endpoint που λέει «ο ασθενής δεν βρέθηκε» ή «ο πελάτης δεν
        # είναι συνδεδεμένος» ΔΕΝ πρέπει να γίνεται «δεν υπάρχει τέτοια διαδρομή» — ο
        # προγραμματιστής θα έψαχνε ώρες λάθος πράγμα. Ο γενικός χειριστής αφορά ΜΟΝΟ διαδρομές
        # που πραγματικά δεν υπάρχουν.
        d = getattr(exc, "detail", None)
        if isinstance(d, dict) and "error" in d:
            body = {"error": d.get("error"), "message": d.get("message"), "hint": d.get("hint")}
            body.update({k: v for k, v in d.items() if k not in body})
            return JSONResponse(status_code=404, content=body)
        # Η ΔΙΑΔΡΟΜΗ ΟΠΩΣ ΤΗΝ ΕΓΡΑΨΕ Ο ΚΑΛΩΝ. Το app είναι mounted στο /api/partner, οπότε το
        # `url.path` δείχνει την ΕΣΩΤΕΡΙΚΗ διαδρομή — και η υπόδειξη έβγαινε παραπλανητική
        # («πρέπει να αρχίζει με /v1/») ακόμη και όταν ο καλών είχε γράψει σωστά /v1/…
        root = request.scope.get("root_path") or ""
        path = request.url.path
        if root and path.startswith(root):
            path = path[len(root):] or "/"
        hint = ("All endpoints start with `/v1/`. See the full list at "
                "https://developers.rxvision.gr")
        if not path.startswith("/v1"):
            hint = ("The path must start with `/v1/` — e.g. "
                    "`https://api.rxvision.gr/v1/ping`. " + hint)
        return JSONResponse(status_code=404, content={
            "error": "not_found",
            "message": f"No endpoint exists at “{path}”.",
            "hint": hint})

    return app
