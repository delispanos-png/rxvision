"""Partner API v1 — τα endpoints.

ΚΑΝΟΝΑΣ ΑΠΟΜΟΝΩΣΗΣ: το `tenant_id` έρχεται ΠΑΝΤΑ από το κλειδί (`ctx.tenant_id`). Καμία
διαδρομή δεν δέχεται «για ποιο φαρμακείο» ως παράμετρο — ούτε καν προαιρετικά.
"""

from __future__ import annotations

import base64
import json
import logging
from datetime import datetime, timezone

from bson import ObjectId
from pymongo.errors import DuplicateKeyError
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status

from app.api.partner.deps import (PartnerContext, get_partner, require, require_module,
                                  require_scope)
from app.api.partner.schemas import (Advise, AdviseIn, ApiError, CustomerLink, CustomerLinkIn,
                                     Execution, Interaction, InteractionCheck, InteractionCheckIn,
                                     LoyaltyCard, LoyaltyConfig, LoyaltyEnrollIn, LoyaltyRedeem,
                                     LoyaltyRedeemIn, LoyaltyReward, Order, Page, Ping, Product,
                                     SaleIn, StockItem, StockMovementIn)
from app.api.partner.app import API_VERSION
from app.core.db import shared_db

logger = logging.getLogger(__name__)

router = APIRouter()

#: Τα σφάλματα που μπορεί να δει ΚΑΘΕ endpoint — μπαίνουν στο Swagger μία φορά, εδώ.
COMMON_ERRORS = {
    401: {"model": ApiError,
          "description": "`X-API-Key` missing, invalid, revoked, expired, or IP not allowed."},
    402: {"model": ApiError,
          "description": "The pharmacy's subscription is not active — nothing to fix on your side."},
    403: {"model": ApiError,
          "description": "The key lacks the required scope, or the pharmacy has not "
                         "enabled the feature (`module_not_enabled`)."},
    429: {"model": ApiError, "description": "Rate limit exceeded — see `Retry-After`."},
}


def _cur_encode(v) -> str:
    return base64.urlsafe_b64encode(json.dumps({"id": str(v)}).encode()).decode().rstrip("=")


def _cur_decode(c: str | None):
    if not c:
        return None
    try:
        pad = "=" * (-len(c) % 4)
        return ObjectId(json.loads(base64.urlsafe_b64decode(c + pad))["id"])
    except Exception:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={
            "error": "bad_cursor",
            "message": "The `cursor` is not valid.",
            "hint": "Do not build cursors yourself — pass back exactly the `next_cursor` "
                    "returned by the previous call."}) from None


async def _page(coll: str, tenant_id: str, q: dict, limit: int, cursor: str | None,
                shape) -> Page:
    """Σελιδοποίηση με cursor πάνω στο `_id` — σταθερή ακόμη κι αν προστεθούν εγγραφές.

    ⚠ ΤΟ `tenant_id` ΜΠΑΙΝΕΙ ΤΕΛΕΥΤΑΙΟ, ΕΠΙΤΗΔΕΣ.
    Αν το tenant_id έμπαινε ΠΡΩΤΟ και το `q` ακολουθούσε, τότε ένα μελλοντικό `q` που
    (κατά λάθος ή επίτηδες) περιείχε κλειδί `tenant_id` θα ΑΝΤΙΚΑΘΙΣΤΟΥΣΕ το φίλτρο
    απομόνωσης — διαρροή μεταξύ φαρμακείων από μία γραμμή απροσεξίας. Με αυτή τη σειρά,
    το φίλτρο δεν ΜΠΟΡΕΙ να παρακαμφθεί.
    """
    flt = {**q, "tenant_id": tenant_id}
    assert flt["tenant_id"] == tenant_id      # δικλείδα: αν σπάσει, σταματά ΠΡΙΝ το ερώτημα
    after = _cur_decode(cursor)
    if after:
        flt["_id"] = {"$gt": after}
    rows = [d async for d in shared_db()[coll].find(flt).sort("_id", 1).limit(limit + 1)]
    more = len(rows) > limit
    rows = rows[:limit]
    return Page(items=[shape(d) for d in rows],
                next_cursor=_cur_encode(rows[-1]["_id"]) if (more and rows) else None,
                has_more=more)


# ── Έλεγχος ─────────────────────────────────────────────────────────────────────────────────
@router.get("/ping", tags=["Health check"], response_model=Ping, responses=COMMON_ERRORS,
            summary="Check that your key works",
            description="""
**Start here.** No scope is required — a valid key is enough.

It tells you which pharmacy your key can see, what it is allowed to do, and when it expires.

```bash
curl -H "X-API-Key: rxv_live_…" https://api.rxvision.gr/v1/ping
```

> 💡 A **401** means the key did not arrive or is not valid. A **200** whose `scopes` lack what
> you need means you should ask the pharmacist for a new key.

> 💡 A **402** means the pharmacy's subscription is not active. Your integration is fine — the
> pharmacy needs to renew.
""")
async def ping(ctx: PartnerContext = Depends(get_partner)) -> Ping:
    t = await shared_db()["tenants"].find_one({"_id": ctx.tenant_id},
                                              {"name": 1, "company": 1}) or {}
    # Άμυνα σε βάθος: το κλειδί έχει ήδη επαληθευτεί, αλλά το φιλτράρουμε ΚΑΙ με tenant_id —
    # ώστε καμία μελλοντική αλλαγή στο `ctx.key_id` να μη μπορεί να διαβάσει ξένη εγγραφή.
    k = await shared_db()["api_keys"].find_one(
        {"_id": ObjectId(ctx.key_id), "tenant_id": ctx.tenant_id}, {"expires_at": 1}) or {}
    return Ping(ok=True,
                pharmacy=((t.get("company") or {}).get("name") or t.get("name") or ctx.tenant_id),
                key_name=ctx.key_name, scopes=ctx.scopes,
                expires_at=k.get("expires_at"),
                server_time=datetime.now(tz=timezone.utc),
                api_version=API_VERSION)


# ── Κατάλογος ───────────────────────────────────────────────────────────────────────────────
@router.get("/products", tags=["Catalogue"], response_model=Page[Product],
            responses=COMMON_ERRORS, summary="The pharmacy's products",
            description="""
The product catalogue with barcode, name and prices.

**The `barcode` is your join key** — not our `id`.

### Fetching only what changed
Instead of downloading the whole catalogue every time, remember when you last synced and pass it
as `updated_since`:

```bash
curl -H "X-API-Key: …" \\
  "https://api.rxvision.gr/v1/products?updated_since=2026-09-20T00:00:00Z&limit=200"
```

> ⚠️ Prices are in **cents**: `219` means **€2.19**.
""")
async def products(
    updated_since: datetime | None = Query(
        None, description="Only items changed after this moment (ISO 8601, UTC)."),
    barcode: str | None = Query(None, description="A single product."),
    limit: int = Query(50, ge=1, le=200, description="Results per page (maximum 200)."),
    cursor: str | None = Query(None, description="The `next_cursor` from your previous call."),
    ctx: PartnerContext = Depends(require_scope("products:read")),
) -> Page[Product]:
    q: dict = {}
    if updated_since:
        q["updated_at"] = {"$gte": updated_since}
    if barcode:
        q["barcode"] = barcode.strip()
    return await _page("products", ctx.tenant_id, q, limit, cursor, lambda d: Product(
        barcode=d.get("barcode") or "", name=d.get("name") or "", atc=d.get("atc"),
        retail_cents=d.get("retail_price"), wholesale_cents=d.get("wholesale_price"),
        category=d.get("category"), updated_at=d.get("updated_at")))


# ── Απόθεμα ─────────────────────────────────────────────────────────────────────────────────
@router.get("/stock", tags=["Stock"], response_model=Page[StockItem],
            responses=COMMON_ERRORS, summary="Current stock levels",
            description="""
Stock per product, in units.

> ⚠️ Only products with tracked stock are returned. If a barcode is missing, it means the
> pharmacy does not track stock for it — **not** that the quantity is zero. Do not treat an
> absent barcode as an out-of-stock signal.
""")
async def stock(
    barcode: str | None = Query(None, description="A single product."),
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = Query(None),
    ctx: PartnerContext = Depends(require_scope("stock:read")),
) -> Page[StockItem]:
    q: dict = {"stock_qty": {"$exists": True}}
    if barcode:
        q["barcode"] = barcode.strip()
    return await _page("pharmacy_products", ctx.tenant_id, q, limit, cursor, lambda d: StockItem(
        barcode=d.get("barcode") or "", name=d.get("name"),
        quantity=int(d.get("stock_qty") or 0), updated_at=d.get("updated_at")))


@router.post("/stock/movements", tags=["Stock"], status_code=status.HTTP_202_ACCEPTED,
             responses={**COMMON_ERRORS,
                        400: {"model": ApiError, "description": "Invalid `kind` or unknown barcode."}},
             summary="Record stock movements",
             description="""
You send **movements**, not totals. That way two systems can write at the same time without one
overwriting the other's work.

| `kind` | Meaning | `quantity` is |
|---|---|---|
| `receipt` | goods in from supplier | the **change** (+) |
| `sale` | sale / outflow | the **change** (−) |
| `count` | stocktake | the **final total** |
| `withdrawal` | write-off | the **change** (−) |

Send **up to 200 movements** in one call:

```bash
curl -X POST https://api.rxvision.gr/v1/stock/movements \\
  -H "X-API-Key: …" -H "Content-Type: application/json" \\
  -d '[{"barcode":"5205152001010","kind":"receipt","quantity":12,"reference":"INV-2026-00412"}]'
```

> ⚠️ **`quantity` is always positive** — the sign comes from `kind`. If you send `sale` with −3,
> we read it as 3 units going out.

### Partial success is normal
The response reports how many were accepted and which were rejected **with the reason**. One bad
barcode does not fail the whole batch:

```json
{
  "accepted": 2,
  "rejected": [{"barcode": "0000", "reason": "unknown_barcode",
                "message": "This product is not in the pharmacy's catalogue."}],
  "message": "Recorded 2 movements. Rejected 1."
}
```

> 💡 **Use `reference`.** Put your invoice or document number there; we echo it back unchanged,
> which makes reconciliation with your own system straightforward.
""")
async def stock_movements(
    movements: list[StockMovementIn] = Body(..., max_length=200),
    ctx: PartnerContext = Depends(require_scope("stock:write")),
) -> dict:
    KINDS = {"receipt": 1, "sale": -1, "withdrawal": -1, "count": 0}
    db = shared_db()
    ok = 0
    rejected: list[dict] = []
    for m in movements:
        if m.kind not in KINDS:
            rejected.append({"barcode": m.barcode, "reason": "bad_kind",
                             "message": f"Unknown kind “{m.kind}”. Allowed: "
                                        + ", ".join(KINDS)})
            continue
        prod = await db["pharmacy_products"].find_one(
            {"tenant_id": ctx.tenant_id, "barcode": m.barcode.strip()})
        if not prod:
            rejected.append({"barcode": m.barcode, "reason": "unknown_barcode",
                             "message": "This product is not in the pharmacy's catalogue."})
            continue
        qty = abs(int(m.quantity))
        when = m.occurred_at or datetime.now(tz=timezone.utc)
        if m.kind == "count":
            upd = {"$set": {"stock_qty": qty, "updated_at": when}}
        else:
            upd = {"$inc": {"stock_qty": KINDS[m.kind] * qty},
                   "$set": {"updated_at": when}}
        # Ρητό tenant_id, παρότι το `prod` ήρθε ήδη φιλτραρισμένο: το φίλτρο απομόνωσης
        # πρέπει να φαίνεται ΣΤΗΝ ΙΔΙΑ γραμμή που γράφει, ώστε να μην εξαρτάται από το τι
        # έκανε ο κώδικας δέκα γραμμές πιο πάνω — και να το πιάνει ο αυτόματος ελεγκτής.
        await db["pharmacy_products"].update_one(
            {"_id": prod["_id"], "tenant_id": ctx.tenant_id}, upd)
        await db["pharmacy_stock_movements"].insert_one({
            "tenant_id": ctx.tenant_id, "barcode": m.barcode.strip(), "kind": m.kind,
            "quantity": qty, "reference": m.reference, "at": when,
            "source": "partner_api", "api_key_id": ctx.key_id})
        ok += 1
    return {"accepted": ok, "rejected": rejected,
            "message": f"Recorded {ok} movements."
                       + (f" Rejected {len(rejected)}." if rejected else "")}


# ── Συνταγές ────────────────────────────────────────────────────────────────────────────────
@router.get("/prescriptions", tags=["Prescriptions"], response_model=Page[Execution],
            responses=COMMON_ERRORS, summary="Prescription dispensings",
            description="""
The pharmacy's prescription dispensings.

> 🔒 **No patient identity is returned** — no name, no national id, no contact details. The
> patient appears as `patient_ref`: a **stable pseudonym** within this pharmacy. You can correlate
> dispensings belonging to the same person without ever learning who they are. The same person
> has a **different** `patient_ref` at another pharmacy, by design.

All amounts are in **cents**.

```bash
curl -H "X-API-Key: …" \\
  "https://api.rxvision.gr/v1/prescriptions?from=2026-09-01T00:00:00Z&limit=200"
```

> 💡 For incremental sync, keep the newest `executed_at` you have seen and pass it as `from` on
> the next run.
""")
async def prescriptions(
    date_from: datetime | None = Query(None, alias="from",
                                       description="From this moment onwards (UTC)."),
    date_to: datetime | None = Query(None, alias="to", description="Up to this moment (UTC)."),
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = Query(None),
    ctx: PartnerContext = Depends(require_scope("prescriptions:read")),
) -> Page[Execution]:
    q: dict = {}
    if date_from or date_to:
        rng: dict = {}
        if date_from:
            rng["$gte"] = date_from
        if date_to:
            rng["$lt"] = date_to
        q["executed_at"] = rng
    return await _page("prescription_executions", ctx.tenant_id, q, limit, cursor,
                       lambda d: Execution(
                           id=str(d["_id"]), executed_at=d.get("executed_at"),
                           patient_ref=str(d.get("patient_ref") or ""),
                           amount_total_cents=int(d.get("amount_total") or 0),
                           amount_claimed_cents=int(d.get("amount_claimed") or 0),
                           patient_share_cents=int(d.get("patient_share") or 0),
                           status=d.get("status")))


# ── Παραγγελίες ─────────────────────────────────────────────────────────────────────────────
@router.get("/orders", tags=["Orders"], response_model=Page[Order],
            responses=COMMON_ERRORS, summary="e-shop orders",
            description="""
e-shop orders and their current status.

Filter with `status` to get only what concerns you — e.g. `new` for orders that just arrived.
""")
async def orders(
    order_status: str | None = Query(None, alias="status",
                                     description="`new`, `preparing`, `ready`, `shipped`, "
                                                 "`delivered`, `cancelled`."),
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = Query(None),
    ctx: PartnerContext = Depends(require_scope("orders:read")),
) -> Page[Order]:
    q: dict = {}
    if order_status:
        q["status"] = order_status.strip()
    return await _page("orders_delivery", ctx.tenant_id, q, limit, cursor, lambda d: Order(
        id=str(d["_id"]), created_at=d.get("created_at") or d.get("at"),
        status=d.get("status") or "new", total_cents=int(d.get("total_cents") or 0),
        items_count=len(d.get("items") or [])))


# ── Πωλήσεις ταμείου ────────────────────────────────────────────────────────────────────────
@router.post("/sales", tags=["Sales"], status_code=status.HTTP_202_ACCEPTED,
             responses={**COMMON_ERRORS,
                        400: {"model": ApiError, "description": "Malformed batch."}},
             summary="Send till sales (including OTC and parapharmacy)",
             description="""
Send us **every sale from the till** — not only prescription medicines.

### Why this matters
RxVision already sees prescription dispensings through ΗΔΥΚΑ. What it cannot see is the rest of
the counter: OTC, parapharmacy, services. Send those and the pharmacy finally gets **one honest
picture** of its business — and the analytics it already pays for start covering everything, not
just the reimbursed part.

> 🔒 **Free sales never contaminate prescription analytics.** They are stored separately and
> tagged with `kind`. Reimbursement, ΕΟΠΥΥ and dispensing figures stay exactly as they are.

### Deduplication — retries are always safe
Every sale carries **your** `external_id`. Sending the same one twice never creates a duplicate;
the second call reports it as `duplicate` and changes nothing. So if a network call times out,
**just send it again** — you never need to reconcile by hand.

### How to use it
Send a batch (up to 500 sales) whenever it suits you: after each sale, every few minutes, or once
at close of day. Order does not matter.

```bash
curl -X POST https://api.rxvision.gr/v1/sales \\
  -H "X-API-Key: …" -H "Content-Type: application/json" \\
  -d '[{"external_id":"POS-2026-0009412","sold_at":"2026-09-27T11:42:00Z",
        "lines":[{"barcode":"5205152001010","quantity":2,"unit_price_cents":219,"kind":"otc"}]}]'
```

### Getting `kind` right
| Value | Use for |
|---|---|
| `rx` | prescription medicine sold against a prescription |
| `otc` | non-prescription medicine |
| `para` | parapharmacy (cosmetics, devices, supplements…) |
| `service` | a service you charged for |

> ⚠️ **A return is a negative `quantity`**, not a separate document type. Keep the same
> `unit_price_cents` as the original sale so the value nets out correctly.

> ⚠️ Prices are **integer cents** and **what you actually charged**, after any line discount.

### Send `customer_ref` and the basket starts paying for itself
If the sale carries a **linked** `customer_ref` (see `/v1/customers/link`), two things happen with
no extra call from you:

1. **Loyalty points are credited automatically** — on the non-prescription part of the basket, at
   the pharmacy's own rate. The response tells you how much went on the card, so you can print it
   on the receipt: «+0,42 € στην κάρτα σας».
2. The purchase joins that customer's picture, so the next interaction check and the next piece of
   advice are based on what they actually buy, not only on what a doctor prescribed.

Points are credited **once per `external_id`**, so a retry never double-credits. If the pharmacy
has loyalty switched off, or the customer is not linked, the sale is stored exactly as before and
`loyalty.credited_cents` is `0` — nothing to handle, nothing to branch on.

> 💡 This is the whole reason sending sales is worth your while. Prescription data we already have.
> The counter is the half of the pharmacy nobody sees — and once it is visible, the analytics, the
> loyalty card and the clinical check all get better at the same time, from one POST you were
> already making.
""")
async def sales(
    batch: list[SaleIn] = Body(..., max_length=500),
    ctx: PartnerContext = Depends(require_scope("sales:write")),
) -> dict:
    from app.services import partner_customers
    db = shared_db()
    accepted = duplicate = 0
    points_credited = points_cents = 0
    rejected: list[dict] = []
    for sale in batch:
        if not sale.lines:
            rejected.append({"external_id": sale.external_id, "reason": "no_lines",
                             "message": "A sale must have at least one line."})
            continue
        # ΙΔΕΜΠΟΤΕΝΤΙΚΟ: το ζεύγος (tenant, external_id) είναι μοναδικό. Χωρίς αυτό, ένα timeout
        # στον συνεργάτη θα παρήγαγε διπλές πωλήσεις — δηλαδή ψεύτικο τζίρο στα δικά μας νούμερα.
        if await db["pos_sales"].find_one(
                {"tenant_id": ctx.tenant_id, "external_id": sale.external_id}, {"_id": 1}):
            duplicate += 1
            continue
        computed = sum(l.quantity * l.unit_price_cents - l.discount_cents for l in sale.lines)
        doc = {
            "tenant_id": ctx.tenant_id,
            "external_id": sale.external_id,
            "sold_at": sale.sold_at,
            "total_cents": sale.total_cents if sale.total_cents is not None else computed,
            "computed_cents": computed,
            "total_mismatch": bool(sale.total_cents is not None and sale.total_cents != computed),
            "payment_method": sale.payment_method,
            "operator": sale.operator,
            "till": sale.till,
            "customer_ref": sale.customer_ref,
            "lines": [{
                "barcode": l.barcode.strip(), "quantity": l.quantity,
                "unit_price_cents": l.unit_price_cents, "discount_cents": l.discount_cents,
                "vat_pct": l.vat_pct, "kind": l.kind,
                "line_total_cents": l.quantity * l.unit_price_cents - l.discount_cents,
            } for l in sale.lines],
            "source": "partner_api",
            "api_key_id": ctx.key_id,
            "received_at": datetime.now(tz=timezone.utc),
        }
        try:
            # `tenant_id` ΡΗΤΑ και στην κλήση (είναι ήδη στο doc): η απομόνωση πρέπει να
            # φαίνεται στο σημείο της εγγραφής, ώστε ούτε μελλοντική αναδιάταξη του `doc`
            # ούτε ο αυτόματος έλεγχος να μπορούν να τη χάσουν.
            await db["pos_sales"].insert_one({**doc, "tenant_id": ctx.tenant_id})
            accepted += 1
            # ── ΠΙΣΤΟΤΗΤΑ: το καλάθι πιστώνει πόντους μόνο του ─────────────────────────────
            # ΓΙΑΤΙ ΕΔΩ ΚΑΙ ΟΧΙ ΣΕ ΞΕΧΩΡΙΣΤΗ ΚΛΗΣΗ: αν ο συνεργάτης έπρεπε να καλέσει δεύτερο
            # endpoint για τους πόντους, κάποιοι δεν θα το έκαναν ποτέ — και ο πελάτης θα
            # ρωτούσε «γιατί δεν πήρα πόντους». Ένα αίτημα, ένα σωστό αποτέλεσμα.
            #
            # ΜΟΝΟ ΜΗ-ΣΥΝΤΑΓΟΓΡΑΦΟΥΜΕΝΑ: τα rx έχουν κρατική διατίμηση (ίδιος κανόνας με την
            # έκπτωση καλαθιού στην πύλη). ΙΔΕΜΠΟΤΕΝΤΙΚΟ μέσω του external_id: η επανάληψη μιας
            # πώλησης δεν ξαναπιστώνει ποτέ.
            #
            # ΠΟΤΕ ΔΕΝ ΧΑΛΑΕΙ ΤΗΝ ΠΩΛΗΣΗ: η πώληση είναι ήδη αποθηκευμένη. Αν η πίστωση
            # αποτύχει, το λέμε στην απάντηση — δεν πετάμε σφάλμα που θα έκανε τον συνεργάτη να
            # ξαναστείλει ένα καλάθι που μπήκε κανονικά.
            if sale.customer_ref:
                try:
                    eligible = sum(l["line_total_cents"] for l in doc["lines"]
                                   if l.get("kind") != "rx")
                    ref = await partner_customers.patient_ref_for(ctx.tenant_id, sale.customer_ref)
                    if ref and eligible > 0:
                        r = await _loyalty(ctx.tenant_id).earn_from_sale(
                            ref, eligible, dedup_key=f"pos:earn:{sale.external_id}",
                            reason="Αγορά στο ταμείο")
                        if r.get("credited"):
                            points_credited += 1
                            points_cents += int(r.get("cents") or 0)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("loyalty credit skipped for sale %s: %s",
                                   sale.external_id, exc)
        except DuplicateKeyError:
            # Δύο ΤΑΥΤΟΧΡΟΝΑ αιτήματα με το ίδιο external_id περνούν και τα δύο τον έλεγχο
            # παραπάνω. Το μοναδικό ευρετήριο είναι η πραγματική εγγύηση — εδώ απλώς το
            # μεταφράζουμε σε «ήταν διπλό», όχι σε σφάλμα.
            duplicate += 1
    return {"accepted": accepted, "duplicate": duplicate, "rejected": rejected,
            "loyalty": {"credited_sales": points_credited, "credited_cents": points_cents},
            "message": f"Stored {accepted} sales."
                       + (f" {duplicate} already existed (ignored)." if duplicate else "")
                       + (f" {len(rejected)} rejected." if rejected else "")
                       + (f" Loyalty: {points_cents} cents credited on {points_credited} sales."
                          if points_credited else "")}


# ═══════════════════════════════════════════════════════════════════════════════
# CUSTOMERS — η γέφυρα ανάμεσα στον κωδικό πελάτη ΤΟΥ ΕΜΠΟΡΙΚΟΥ και τον ασθενή μας
# ═══════════════════════════════════════════════════════════════════════════════

def _loyalty(tenant_id: str):
    from app.repositories.loyalty import LoyaltyRepository
    return LoyaltyRepository(tenant_id=tenant_id)


async def _linked_patient(ctx: PartnerContext, customer_ref: str) -> str:
    """patient_ref ενός ΣΥΝΔΕΔΕΜΕΝΟΥ πελάτη — αλλιώς 404 με οδηγία τι να κάνει."""
    from app.services import partner_customers
    ref = await partner_customers.patient_ref_for(ctx.tenant_id, customer_ref)
    if not ref:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={"error": "customer_not_linked", "customer_ref": customer_ref,
                    "message": "This customer is not linked to a patient record.",
                    "hint": "Call POST /v1/customers/link once for this customer (with their "
                            "ΑΜΚΑ or mobile), then retry."})
    return ref


@router.post("/customers/link", tags=["Customers"], response_model=CustomerLink,
             responses={**COMMON_ERRORS,
                        404: {"model": ApiError, "description": "No patient matched."},
                        409: {"model": ApiError, "description": "The phone matched more than one "
                                                               "person — link by ΑΜΚΑ instead."}},
             summary="Link your customer to their patient record",
             description="""
Do this **once per customer**. Afterwards you use **your own** `customer_ref` everywhere — in
sales, loyalty and clinical calls — and no identifier ever travels again.

### Why a link is needed at all
Your software knows the customer by your code. RxVision knows them through ΗΔΥΚΑ. Until the two
are joined, a basket you send us is anonymous: no points can be credited and no therapy can be
checked. One call fixes that permanently.

### What you get in return — this is the interesting part
Once linked, RxVision can tell you things **your own database cannot know**, because it sees the
patient's prescriptions from *every* pharmacy through ΗΔΥΚΑ:

* their **whole active therapy** — so an OTC sale can be checked against it (`/v1/clinical/interactions`)
* their **loyalty balance**, earned from adherence, ready to spend at your till

### Matching
| You send | Behaviour |
|---|---|
| `amka` | The reliable match. Use it when you have it. |
| `phone` | Fallback. Matched on the last 10 digits, so formatting does not matter. |

> ⚠️ If a phone matches **more than one person** (a family sharing a number) we return `409` and
> link nothing. Guessing would put one person's points — and one person's **medication** — on
> another. Fall back to ΑΜΚΑ.

### GDPR
This is the only endpoint that accepts an identifier, so it needs the **`patients:read`** scope,
which a pharmacist can only grant after an explicit acknowledgement. The link is a pointer and
nothing else: `DELETE` it and the pointer is gone, with no effect on any health record.
""")
async def customers_link(
    body: CustomerLinkIn,
    ctx: PartnerContext = Depends(require_scope("patients:read")),
) -> CustomerLink:
    from app.services import partner_customers
    ref, how = await partner_customers.resolve(ctx.tenant_id, amka=body.amka, phone=body.phone)
    if not ref:
        if how == "phone_ambiguous":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={"error": "phone_ambiguous",
                        "message": "That phone number belongs to more than one patient.",
                        "hint": "Families often share a number. Link by ΑΜΚΑ instead — it is "
                                "unique to one person."})
        if how == "no_identifier":
            # ΔΕΝ είναι «δεν βρέθηκε» — είναι «δεν έστειλες τίποτα να ψάξω». Το λάθος μήνυμα εδώ
            # στέλνει τον προγραμματιστή να ψάχνει στα δεδομένα αντί στο αίτημά του.
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail={"error": "no_identifier",
                        "message": "You must send either `amka` or `phone`.",
                        "hint": "`amka` is the reliable match. Use `phone` only when you have no "
                                "ΑΜΚΑ."})
        if how == "phone_invalid":
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail={"error": "phone_invalid",
                        "message": "That does not look like a phone number.",
                        "hint": "Send at least 10 digits. Formatting (+30, spaces, dashes) does "
                                "not matter — we compare the last 10 digits."})
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={"error": how or "not_found",
                    "message": "No patient in this pharmacy matched what you sent.",
                    "hint": "The pharmacy only knows patients who have had a prescription "
                            "dispensed there. A brand-new walk-in will not be found yet."})
    await partner_customers.link(ctx.tenant_id, body.customer_ref, ref,
                                 method=how or "unknown", api_key_id=ctx.key_id)
    card = None
    if ctx.allows("loyalty:read"):
        card = await _loyalty(ctx.tenant_id).till_card(ref)
    return CustomerLink(customer_ref=body.customer_ref, linked=True, matched_by=how or "unknown",
                        loyalty=card)


@router.delete("/customers/{customer_ref}/link", tags=["Customers"],
               responses={**COMMON_ERRORS,
                          404: {"model": ApiError, "description": "No such link."}},
               summary="Remove the link",
               description="""
Deletes the pointer between your customer and the patient record. Nothing else is touched — no
health data, no loyalty balance, no history.

Call this when a customer is deleted in your system, or asks you to stop the connection. Under
GDPR the pharmacy must be able to honour that request, and this is how you honour it.
""")
async def customers_unlink(
    customer_ref: str,
    ctx: PartnerContext = Depends(require_scope("patients:read")),
) -> dict:
    from app.services import partner_customers
    if not await partner_customers.unlink(ctx.tenant_id, customer_ref):
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"error": "not_linked",
                                    "message": "There is no link for that customer_ref.",
                                    "hint": "Nothing to do — the state you wanted is the state "
                                            "you already have."})
    return {"ok": True, "customer_ref": customer_ref, "message": "Link removed."}


# ═══════════════════════════════════════════════════════════════════════════════
# LOYALTY — το πρόγραμμα επιβράβευσης του φαρμακείου, στο ΤΑΜΕΙΟ του συνεργάτη
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/loyalty/config", tags=["Loyalty"], response_model=LoyaltyConfig,
            responses=COMMON_ERRORS,
            summary="How this pharmacy's loyalty programme works",
            description="""
Read this **once when your till starts** and render your loyalty screen from it. Every pharmacy
sets its own values — hard-coding them guarantees you will show the wrong number somewhere.

### Why bother integrating loyalty at all
Most commercial pharmacy systems have **no loyalty programme**. This one is already running, the
pharmacist already configured it, and the points are already being earned from prescription
adherence. You do not have to build, price or support any of it — you read three numbers and show
a balance. The pharmacist sees their own programme working at their own till, which is exactly
where they wanted it.

### What `enabled: false` means
The pharmacy does not run the programme. Hide the loyalty UI entirely; do not show a zero
balance, which only invites the question “why is it zero?”.
""")
async def loyalty_config(
    ctx: PartnerContext = Depends(require("loyalty:read", "loyalty")),
) -> LoyaltyConfig:
    from app.repositories.loyalty import TIERS
    cfg = await _loyalty(ctx.tenant_id).config()
    return LoyaltyConfig(
        enabled=bool(cfg.get("enabled")),
        cents_per_point=cfg["cents_per_point"],
        min_redeem_cents=cfg["min_redeem_cents"],
        earn_from_sales=bool(cfg.get("pos_earn_enabled")),
        earn_pct=int(cfg.get("pos_earn_pct") or 0),
        tiers=[name for _, name in TIERS],
        terms=cfg["terms"])


@router.get("/loyalty/customers/{customer_ref}", tags=["Loyalty"], response_model=LoyaltyCard,
            responses={**COMMON_ERRORS,
                       404: {"model": ApiError, "description": "Customer not linked."}},
            summary="The customer's card — what to show at the till",
            description="""
Call this when you identify the customer at checkout. It answers the only two questions that
matter at that moment: **are they a member**, and **how much can they spend**.

### Use `balance_cents`, not `points`
`balance_cents` is the amount you may take off the basket. `points` is for display — customers
think in points, tills must work in money.

### Freshness — read this once and you can stop worrying
The adherence part of the balance is cached for up to 5 minutes (`refill_points_as_of` tells you
when it was computed). **Redemptions and credits are always live.** That split is deliberate: it
means the spendable amount can never be stale, so the same balance cannot be spent twice, while
the expensive part does not have to be recomputed on every sale.

### `enrolled: false`
Not a member yet. This is your cue to offer it — `POST /v1/loyalty/enroll`.
""")
async def loyalty_card(
    customer_ref: str,
    ctx: PartnerContext = Depends(require("loyalty:read", "loyalty")),
) -> LoyaltyCard:
    ref = await _linked_patient(ctx, customer_ref)
    repo = _loyalty(ctx.tenant_id)
    card = await repo.till_card(ref)
    if not card:
        cfg = await repo.config()
        return LoyaltyCard(customer_ref=customer_ref, enrolled=False, points=0, balance_cents=0,
                           min_redeem_cents=cfg["min_redeem_cents"])
    return LoyaltyCard(customer_ref=customer_ref, enrolled=True, points=card["points"],
                       balance_cents=card["balance_cents"],
                       min_redeem_cents=card["min_redeem_cents"], tier=card["tier"],
                       next_tier=card["next_tier"], to_next_points=card["to_next_points"],
                       refill_points_as_of=card["refill_points_as_of"])


@router.post("/loyalty/enroll", tags=["Loyalty"], response_model=LoyaltyCard,
             status_code=status.HTTP_201_CREATED,
             responses={**COMMON_ERRORS,
                        400: {"model": ApiError, "description": "Terms not accepted."},
                        404: {"model": ApiError, "description": "Customer not linked."}},
             summary="Enrol a customer in the loyalty programme",
             description="""
Sign the customer up from your till, after they have agreed to the pharmacy's terms (read them
from `/v1/loyalty/config` and **show them**).

`accept_terms` must be `true`. You are recording a person's consent, and the pharmacy answers for
that record under GDPR — so we will not accept an enrolment that does not claim it.

Enrolling is idempotent: a customer who is already a member simply gets their card back.

> 💡 Points start accruing from **enrolment onwards**, including from past adherence recorded in
> ΗΔΥΚΑ. A long-standing chronic patient can therefore walk away from their first visit with a
> balance already on the card — which is the moment they understand the programme is real.
""")
async def loyalty_enroll(
    body: LoyaltyEnrollIn,
    ctx: PartnerContext = Depends(require("loyalty:write", "loyalty")),
) -> LoyaltyCard:
    if not body.accept_terms:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={"error": "terms_not_accepted",
                    "message": "`accept_terms` must be true.",
                    "hint": "Show the pharmacy's terms from /v1/loyalty/config, then send true "
                            "once the customer has agreed."})
    ref = await _linked_patient(ctx, body.customer_ref)
    repo = _loyalty(ctx.tenant_id)
    cfg = await repo.config()
    if not cfg.get("enabled"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={"error": "programme_disabled",
                    "message": "This pharmacy has the loyalty feature but has not switched the "
                               "programme on.",
                    "hint": "Nothing for you to fix — the pharmacist enables it in "
                            "Πιστότητα → Ρυθμίσεις."})
    await repo.enroll(ref, method="partner_api")
    card = await repo.till_card(ref) or {}
    return LoyaltyCard(customer_ref=body.customer_ref, enrolled=True,
                       points=card.get("points", 0), balance_cents=card.get("balance_cents", 0),
                       min_redeem_cents=cfg["min_redeem_cents"], tier=card.get("tier"),
                       next_tier=card.get("next_tier"),
                       to_next_points=card.get("to_next_points", 0),
                       refill_points_as_of=card.get("refill_points_as_of"))


@router.get("/loyalty/rewards", tags=["Loyalty"], response_model=list[LoyaltyReward],
            responses=COMMON_ERRORS,
            summary="The pharmacy's reward catalogue",
            description="""
The rewards this pharmacy offers, cheapest first, with the cost in **both** points and cents.

Show the customer what their balance can actually buy — «έχεις 340 πόντους» means nothing,
«σου φτάνουν για δωρεάν μέτρηση πίεσης» means everything.

Only active rewards are returned, so you can render the list as-is.
""")
async def loyalty_rewards(
    ctx: PartnerContext = Depends(require("loyalty:read", "loyalty")),
) -> list[LoyaltyReward]:
    rows = await _loyalty(ctx.tenant_id).rewards(only_active=True)
    return [LoyaltyReward(reward_id=str(r["_id"]), title=r.get("title") or "",
                          type=r.get("type") or "product",
                          cost_points=int(r.get("cost_points") or 0),
                          cost_cents=int(r.get("cost_cents") or 0)) for r in rows]


@router.post("/loyalty/redeem", tags=["Loyalty"], response_model=LoyaltyRedeem,
             responses={**COMMON_ERRORS,
                        400: {"model": ApiError, "description": "Bad request or below the minimum."},
                        404: {"model": ApiError, "description": "Customer not linked, or no reward."},
                        409: {"model": ApiError, "description": "Insufficient balance."}},
             summary="Spend points at the till",
             description="""
Take value off the wallet — either a catalogue reward (`reward_id`) or a free amount (`cents`).

### Retries can never cost the customer twice
`external_id` is **your** id for this redemption — the receipt number works well. If the call
times out, **send exactly the same request again**: we recognise the id, deduct nothing, and
return the balance with `duplicate: true`. Without this, one flaky connection would quietly empty
a customer's wallet twice, and nobody would notice until they complained.

### Order of operations at the till
1. `GET /v1/loyalty/customers/{customer_ref}` → `balance_cents`
2. Ask the customer how much to use (≥ `min_redeem_cents`)
3. `POST /v1/loyalty/redeem`
4. Apply the discount to the basket **only after** you get `ok: true`

> ⚠️ Step 4 matters. Discount first and you can end up giving money away on a redemption that was
> refused for insufficient balance.
""")
async def loyalty_redeem(
    body: LoyaltyRedeemIn,
    ctx: PartnerContext = Depends(require("loyalty:write", "loyalty")),
) -> LoyaltyRedeem:
    if bool(body.reward_id) == bool(body.cents):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={"error": "bad_request",
                    "message": "Send exactly one of `reward_id` or `cents`.",
                    "hint": "`reward_id` for a catalogue reward, `cents` for a free amount."})
    ref = await _linked_patient(ctx, body.customer_ref)
    repo = _loyalty(ctx.tenant_id)
    dedup = f"pos:redeem:{body.external_id}"
    if body.reward_id:
        res = await repo.redeem_reward(ref, body.reward_id, dedup_key=dedup)
    else:
        cfg = await repo.config()
        if body.cents < cfg["min_redeem_cents"]:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail={"error": "below_minimum", "min_redeem_cents": cfg["min_redeem_cents"],
                        "message": f"The smallest redemption at this pharmacy is "
                                   f"{cfg['min_redeem_cents']} cents.",
                        "hint": "Read `min_redeem_cents` from /v1/loyalty/config and validate "
                                "before you ask the customer."})
        res = await repo.redeem(ref, body.cents, reason="Ταμείο (API συνεργάτη)",
                                kind="discount", dedup_key=dedup)
    if not res.get("ok"):
        err = res.get("error")
        if err == "insufficient":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={"error": "insufficient_balance",
                        "balance_cents": res.get("balance_cents", 0),
                        "message": "The customer does not have that much on their card.",
                        "hint": "Re-read the card — a balance you cached may be out of date."})
        raise HTTPException(
            status.HTTP_404_NOT_FOUND if err in ("not_found", "no_member", "bad_reward")
            else status.HTTP_400_BAD_REQUEST,
            detail={"error": err or "redeem_failed",
                    "message": {"no_member": "That customer is not a loyalty member.",
                                "not_found": "That customer is not a loyalty member.",
                                "bad_reward": "No such reward.",
                                "bad_amount": "The amount must be a positive number of cents."}
                    .get(err, "The redemption was not accepted."),
                    "hint": "Enrol them first with POST /v1/loyalty/enroll."
                            if err in ("no_member", "not_found") else None})
    return LoyaltyRedeem(ok=True, duplicate=bool(res.get("duplicate")),
                         deducted_cents=int(res.get("deducted_cents") or 0),
                         balance_cents=int(res.get("balance_cents") or 0),
                         reward=res.get("reward"))


# ═══════════════════════════════════════════════════════════════════════════════
# CLINICAL — PharmaCat στο ταμείο του συνεργάτη
#
# ΓΙΑΤΙ ΕΙΝΑΙ Η ΠΙΟ ΔΥΝΑΤΗ ΣΥΝΕΡΓΑΣΙΑ: το εμπορικό πρόγραμμα ξέρει ΤΙ ΠΟΥΛΗΣΕ ΤΟ ΙΔΙΟ. Εμείς
# ξέρουμε ΤΙ ΠΑΙΡΝΕΙ Ο ΑΣΘΕΝΗΣ — από ΟΛΑ τα φαρμακεία, μέσω ΗΔΥΚΑ. Ο έλεγχος ενός ΜΗ.ΣΥ.ΦΑ. πάνω
# στην πλήρη ενεργή αγωγή είναι κάτι που το εμπορικό ΔΕΝ μπορεί να κάνει μόνο του, όσο καλό κι αν
# είναι — και δεν το ανταγωνίζεται: του δίνει δυνατότητα που δεν είχε.
#
# ΚΟΣΤΟΣ: κάθε κλήση περνά από το ημερήσιο όριο AI του φαρμακείου και από το κοινό cache
# απαντήσεων (ίδιος συνδυασμός φαρμάκων → δωρεάν, ακαριαία). Ο συνεργάτης δεν μπορεί να
# ξοδέψει χρήματα του φαρμακείου χωρίς φραγμό.
# ═══════════════════════════════════════════════════════════════════════════════

_SEVERITY_ORDER = ["minor", "moderate", "major", "contraindicated"]


def _max_severity(rows: list[dict]) -> str | None:
    found = [r.get("severity") for r in rows if r.get("severity") in _SEVERITY_ORDER]
    return max(found, key=_SEVERITY_ORDER.index) if found else None


def _pharmacat(tenant_id: str):
    from app.repositories.pharmacat import PharmaCatRepository
    # demo=False: το PharmaCat δεν επιστρέφει ΠΟΤΕ στοιχεία προσώπου — κάθε «όνομα» που βγάζει
    # είναι ΦΑΡΜΑΚΟ ή δραστική, και αυτά δεν μασκάρονται ποτέ (θα άλλαζε το κλινικό νόημα).
    return PharmaCatRepository(tenant_id=tenant_id, demo=False)


def _ai_error(res: dict) -> None:
    """Μετάφραση αποτυχίας AI σε μήνυμα που λέει ΤΙ φταίει και ποιος το διορθώνει."""
    err = str(res.get("error") or "")
    if err in ("not_configured", "disabled"):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail={"error": "clinical_unavailable",
                                    "message": "The clinical assistant is not available right now.",
                                    "hint": "Nothing to fix on your side. Retry later."})
    if "quota" in err or err == "budget_exceeded":
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            detail={"error": "ai_quota_exceeded", "limit": res.get("limit"),
                                    "message": "The pharmacy has used its AI allowance for today.",
                                    "hint": "Your key is fine. The pharmacy can raise its limit "
                                            "in Ρυθμίσεις → Χρέωση; it resets tomorrow either way."})
    raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                        detail={"error": err or "clinical_failed",
                                "message": "The clinical check could not be completed.",
                                "hint": "Safe to retry once. Never block a sale on this endpoint "
                                        "being up — treat a failure as “not checked”, not as "
                                        "“no interactions”."})


@router.post("/clinical/interactions", tags=["Clinical"], response_model=InteractionCheck,
             responses={**COMMON_ERRORS,
                        400: {"model": ApiError, "description": "Nothing to check."},
                        404: {"model": ApiError, "description": "Customer not linked."},
                        502: {"model": ApiError, "description": "The check failed — retry."},
                        503: {"model": ApiError, "description": "Assistant unavailable."}},
             summary="Check a basket for drug interactions",
             description="""
Send what is in the basket and get back the interactions, each with **what the pharmacist should
do about it**. Show it before the sale is finished.

### The part your own database cannot do
Send `customer_ref` as well (a linked customer, key needs `patients:read`) and we check the basket
against the patient's **whole active therapy as recorded in ΗΔΥΚΑ** — including prescriptions
dispensed at *other* pharmacies. Your software only knows what it sold. This knows what the person
is actually taking.

> ℹ️ The basket-only check needs the pharmacy's PharmaCat feature. Checking against the patient's
> therapy is a **separate feature** (`drug_interactions`) — without it you get `403
> module_not_enabled` and the pharmacy can enable it themselves, with a free trial. Send the basket
> without `customer_ref` and you still get a useful answer.

That is the difference between «αυτά τα δύο δεν πάνε μαζί» and «αυτό που κρατάτε δεν πάει με το
αντιπηκτικό που παίρνετε» — and it is the check that stops the sale that should not happen.

### Reading the answer
| Field | Use |
|---|---|
| `max_severity` | Branch your UI on this. `major` / `contraindicated` deserve a modal, not a toast. |
| `involves_new` | `true` → the basket caused it. Show these first; the rest is existing therapy. |
| `action` | Display verbatim. It is written for a pharmacist to act on. |
| `source` | `cache` means a previously analysed combination — free and instant. |

### Cost and limits
Every call is subject to the pharmacy's daily AI allowance, and identical combinations are served
from a shared cache at no cost. You cannot run up the pharmacy's bill by polling.

> ⚠️ **Never treat a failure as “no interactions”.** On `502`/`503` show “δεν ελέγχθηκε”, not a
> green tick. Silence is not safety.

> ℹ️ Clinical decision support — it assists the pharmacist, it does not replace their judgement
> and it does not diagnose.
""")
async def clinical_interactions(
    body: InteractionCheckIn,
    ctx: PartnerContext = Depends(require("clinical:read", "pharmacat", "ai_assistant")),
) -> InteractionCheck:
    subs = [s.strip() for s in (body.substances or []) if s and s.strip()][:30]
    repo = _pharmacat(ctx.tenant_id)
    who = f"api:{ctx.key_id}"
    use_therapy = bool(body.customer_ref) and ctx.allows("patients:read")
    if body.customer_ref and not use_therapy:
        # Δεν σκάμε — αλλά ούτε σιωπούμε: ο προγραμματιστής πρέπει να ξέρει ΓΙΑΤΙ δεν μπήκε η αγωγή.
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={"error": "missing_scope", "required": "patients:read",
                    "granted": ctx.scopes,
                    "message": "Checking against a patient's therapy needs the `patients:read` "
                               "scope.",
                    "hint": "Either ask the pharmacy for a key with that scope, or omit "
                            "`customer_ref` to check the basket on its own."})
    if use_therapy:
        # ΞΕΧΩΡΙΣΤΟ ΠΛΗΡΩΜΕΝΟ ΠΡΟΣΘΕΤΟ: ο έλεγχος πάνω στην ΑΓΩΓΗ του ασθενή είναι το
        # `drug_interactions`, όχι το PharmaCat. Ίδιο σύνορο με το εσωτερικό API
        # (`/pharmacat/interactions/patient`) — αλλιώς το API θα χάριζε από την πίσω πόρτα
        # πρόσθετο που πουλάμε από την μπροστινή.
        await require_module("drug_interactions")(ctx)
        ref = await _linked_patient(ctx, body.customer_ref or "")
        res = await repo.interactions_for_patient(who, patient_id=ref, added=subs)
    else:
        if len(subs) < 2:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail={"error": "nothing_to_check",
                        "message": "Send at least two substances, or a `customer_ref` so we can "
                                   "check against their existing therapy.",
                        "hint": "One substance on its own has nothing to interact with."})
        res = await repo.interactions(who, subs)
    if not res.get("ok"):
        _ai_error(res)
    rows = [r for r in (res.get("interactions") or []) if isinstance(r, dict)]
    return InteractionCheck(
        ok=True,
        checked=res.get("checked_drugs") or res.get("drugs") or subs,
        from_patient_therapy=use_therapy,
        interactions=[Interaction(
            a=r.get("a") or "", b=r.get("b") or "", severity=r.get("severity") or "minor",
            mechanism=r.get("mechanism") or "", risk=r.get("risk") or "",
            action=r.get("action") or "", involves_new=r.get("involves_new")) for r in rows],
        max_severity=_max_severity(rows),
        source=res.get("source"))


@router.post("/clinical/advise", tags=["Clinical"], response_model=Advise,
             responses={**COMMON_ERRORS,
                        404: {"model": ApiError, "description": "Customer not linked."},
                        502: {"model": ApiError, "description": "The check failed — retry."},
                        503: {"model": ApiError, "description": "Assistant unavailable."}},
             summary="Ask for counter advice on a symptom",
             description="""
The counter question — «τι να πάρω για…» — answered as a pharmacist would answer it: triage first,
warning signs before products, referral when referral is what is needed.

### What comes back, and in what order to show it
1. **`red_flags`** — if this is not empty, show it FIRST and do not lead with a product. These are
   the cases where selling something is the wrong answer.
2. **`referral_needed` / `referral_urgency`** — `urgent` or `emergency` means stop and send them on.
3. **`reply`** — the advice itself, ready to read out.
4. **`otc_categories`** — product *categories* that fit. Match them against **your own** catalogue
   and your own stock: we deliberately do not pick products for you, because you know what is on
   the shelf and at what price.

### Why we do not name products
Two reasons, and both are in your interest. Recommending a specific brand would put us between you
and your pricing, and it would be advice given without knowing your stock. Categories keep the
clinical judgement with us and the commercial decision with you.

Add `customer_ref` (linked, needs `patients:read`) and the advice accounts for the therapy the
person is already on — which is how you avoid suggesting an NSAID to someone on an anticoagulant.

> ℹ️ Clinical decision support, not diagnosis. Subject to the pharmacy's daily AI allowance.
""")
async def clinical_advise(
    body: AdviseIn,
    ctx: PartnerContext = Depends(require("clinical:read", "pharmacat", "ai_assistant")),
) -> Advise:
    context: dict = {}
    if body.customer_ref:
        if not ctx.allows("patients:read"):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={"error": "missing_scope", "required": "patients:read",
                        "granted": ctx.scopes,
                        "message": "Personalising advice needs the `patients:read` scope.",
                        "hint": "Omit `customer_ref` for general advice, or ask the pharmacy for "
                                "a key with that scope."})
        ref = await _linked_patient(ctx, body.customer_ref)
        from app.repositories.patient_portal import PatientRxRepository
        sched = await PatientRxRepository(tenant_id=ctx.tenant_id).medication_schedule(ref)
        meds = [t.get("name") for t in (sched.get("therapies") or []) if t.get("name")][:20]
        if meds:
            context["ενεργή αγωγή"] = ", ".join(meds)
    res = await _pharmacat(ctx.tenant_id).chat(
        f"api:{ctx.key_id}", [{"role": "user", "content": body.question}], context or None)
    if not res.get("ok"):
        _ai_error(res)
    ref_block = res.get("referral") or {}
    return Advise(
        ok=True, reply=res.get("reply") or "", stage=res.get("stage"),
        red_flags=[{"flag": f.get("flag") or "", "action": f.get("action") or ""}
                   for f in (res.get("red_flags") or []) if isinstance(f, dict)],
        otc_categories=[str(c) for c in (res.get("otc_categories") or [])],
        non_drug_advice=[str(a) for a in (res.get("non_drug_advice") or [])],
        referral_needed=bool(ref_block.get("needed")),
        referral_urgency=ref_block.get("urgency"),
        source=res.get("source"))
