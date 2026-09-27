"""Response schemas — with EXAMPLES.

Κάθε πεδίο έχει `description` και κάθε μοντέλο ρεαλιστικό `example`. Το κείμενο είναι ΑΓΓΛΙΚΑ:
το διαβάζει προγραμματιστής τρίτου, όχι φαρμακοποιός. Έτσι βλέπει ΤΙ θα πάρει πριν κάνει την
πρώτη κλήση — η διαφορά ανάμεσα σε «δοκιμάζω μέχρι να πετύχει» και «ξέρω τι κάνω».
"""

from __future__ import annotations

from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    """A page of results. The SAME shape on every list endpoint."""
    items: list[T] = Field(description="The results on this page.")
    next_cursor: str | None = Field(
        default=None,
        description="Pass this as the `cursor` parameter to get the next page. "
                    "`null` when there is nothing more.")
    has_more: bool = Field(
        description="`true` if more results exist. Stop your loop when it turns `false`.")


class ApiError(BaseModel):
    """The shape of EVERY error. Three fields, always the same."""
    error: str = Field(description="Stable code — branch your logic on this.",
                       examples=["missing_scope"])
    message: str = Field(description="What happened, in plain words.",
                         examples=["Your key does not have the scope “stock:write”."])
    hint: str | None = Field(default=None, description="How to fix it.",
                            examples=["Ask the pharmacy to issue a key with this scope."])

    model_config = {"json_schema_extra": {"example": {
        "error": "missing_scope",
        "message": "Your key does not have the scope “stock:write”.",
        "hint": "Ask the pharmacy to issue a key with this scope.",
    }}}


class Ping(BaseModel):
    ok: bool = Field(description="Always `true` when the key works.")
    pharmacy: str = Field(description="The pharmacy this key can see.")
    key_name: str = Field(description="The name the pharmacist gave this key.")
    scopes: list[str] = Field(description="What this key is allowed to do.")
    expires_at: datetime | None = Field(description="When the key expires.")
    server_time: datetime = Field(description="Our server time in UTC — useful for clock alignment.")
    api_version: str = Field(
        description="The API version now serving you. Log it on start-up: when something behaves "
                    "unexpectedly, this is the first thing support will ask for. See the changelog "
                    "at https://developers.rxvision.gr",
        examples=["1.1.0"])

    model_config = {"json_schema_extra": {"example": {
        "ok": True, "pharmacy": "Papadopoulos Pharmacy", "key_name": "Dispensing software",
        "scopes": ["products:read", "stock:read", "stock:write"],
        "expires_at": "2027-03-27T10:00:00Z", "server_time": "2026-09-27T14:30:00Z",
        "api_version": "1.1.0",
    }}}


class Product(BaseModel):
    barcode: str = Field(description="The EAN/barcode. **This is the join key** with your own system.")
    name: str = Field(description="Trade name.")
    atc: str | None = Field(default=None, description="ATC code, when available.")
    retail_cents: int | None = Field(default=None, description="Retail price in **cents** (1250 = €12.50).")
    wholesale_cents: int | None = Field(default=None, description="Wholesale price in cents.")
    category: str | None = Field(default=None, description="Product category.")
    updated_at: datetime | None = Field(default=None, description="Last change — use with `updated_since` to fetch only what moved.")

    model_config = {"json_schema_extra": {"example": {
        "barcode": "5205152001010", "name": "DEPON 500MG/TAB BTx20",
        "atc": "N02BE01", "retail_cents": 219, "wholesale_cents": 152,
        "category": "normal", "updated_at": "2026-09-20T08:15:00Z",
    }}}


class StockItem(BaseModel):
    barcode: str = Field(description="The product barcode.")
    name: str | None = Field(default=None, description="Name, for convenience.")
    quantity: int = Field(description="Current stock, in units.")
    updated_at: datetime | None = Field(default=None, description="When it last changed.")

    model_config = {"json_schema_extra": {"example": {
        "barcode": "5205152001010", "name": "DEPON 500MG/TAB BTx20",
        "quantity": 14, "updated_at": "2026-09-27T09:00:00Z",
    }}}


class StockMovementIn(BaseModel):
    """One stock movement. You send THE MOVEMENT, not the new total."""
    barcode: str = Field(description="The product barcode.", examples=["5205152001010"])
    kind: str = Field(
        description="`receipt` goods in · `sale` sale/outflow · `count` stocktake · "
                    "`withdrawal` write-off.",
        examples=["receipt"])
    quantity: int = Field(
        description="Units. For `count` this is the **final total**; for the others it is the "
                    "**change** (always positive — the sign comes from `kind`).",
        examples=[12])
    reference: str | None = Field(
        default=None, description="Your own reference (e.g. invoice number) — echoed back "
                                  "unchanged, which helps you reconcile.",
        examples=["INV-2026-00412"])
    occurred_at: datetime | None = Field(
        default=None, description="When it happened. Defaults to now.")

    model_config = {"json_schema_extra": {"example": {
        "barcode": "5205152001010", "kind": "receipt", "quantity": 12,
        "reference": "INV-2026-00412", "occurred_at": "2026-09-27T11:05:00Z",
    }}}


class Execution(BaseModel):
    """One prescription dispensing. **No patient identity is included.**"""
    id: str = Field(description="RxVision id for this dispensing.")
    executed_at: datetime = Field(description="When it was dispensed (UTC).")
    patient_ref: str = Field(
        description="A **stable pseudonym** for the patient. The same person keeps the same "
                    "`patient_ref` within THIS pharmacy, so you can correlate dispensings "
                    "without learning who they are. It is not a national id and cannot be "
                    "reversed. The same person has a DIFFERENT value at another pharmacy.")
    amount_total_cents: int = Field(description="Total value in cents.")
    amount_claimed_cents: int = Field(description="Amount claimed from the insurance fund, in cents.")
    patient_share_cents: int = Field(description="Patient co-payment, in cents.")
    status: str | None = Field(default=None, description="Dispensing status.")

    model_config = {"json_schema_extra": {"example": {
        "id": "6ab7a48240c678bca71df54d", "executed_at": "2026-09-26T13:52:24Z",
        "patient_ref": "6a94323269764c02ced1c6dc", "amount_total_cents": 1214,
        "amount_claimed_cents": 910, "patient_share_cents": 304, "status": "executed",
    }}}


class Order(BaseModel):
    id: str = Field(description="Order id.")
    created_at: datetime = Field(description="When it was placed.")
    status: str = Field(description="Status: `new`, `preparing`, `ready`, `shipped`, `delivered`, `cancelled`.")
    total_cents: int = Field(description="Order total in cents.")
    items_count: int = Field(description="How many lines it has.")

    model_config = {"json_schema_extra": {"example": {
        "id": "6ab90f1240c678bca71e0021", "created_at": "2026-09-27T10:12:00Z",
        "status": "preparing", "total_cents": 4380, "items_count": 3,
    }}}


class SaleLine(BaseModel):
    """One line of a till receipt."""
    barcode: str = Field(description="Product barcode (EAN). Our join key.",
                         examples=["5205152001010"])
    quantity: int = Field(description="Units sold. Use a negative number for a return.",
                          examples=[2])
    unit_price_cents: int = Field(
        description="Price per unit actually charged, in **cents**, after any line discount.",
        examples=[219])
    discount_cents: int = Field(
        default=0, description="Discount given on this line, in cents. Informational.",
        examples=[0])
    vat_pct: float | None = Field(default=None, description="VAT rate applied, e.g. `6` or `24`.")
    kind: str = Field(
        default="otc",
        description="`rx` prescription medicine · `otc` over-the-counter · `para` parapharmacy "
                    "· `service` service. **This is what lets us separate free sales from "
                    "prescription dispensings** — get it right.",
        examples=["otc"])


class SaleIn(BaseModel):
    """One completed sale (a receipt), with its lines."""
    external_id: str = Field(
        description="**Your** id for this sale — receipt number, or anything unique and stable. "
                    "We use it to deduplicate: sending the same `external_id` twice never "
                    "creates a second sale, so retries are always safe.",
        examples=["POS-2026-0009412"])
    sold_at: datetime = Field(description="When the sale happened (ISO 8601, UTC).")
    lines: list[SaleLine] = Field(description="The receipt lines. At least one.")
    total_cents: int | None = Field(
        default=None, description="Receipt total in cents. If omitted we compute it from the "
                                  "lines; if given and it disagrees, we keep yours and flag it.")
    payment_method: str | None = Field(
        default=None, description="`cash`, `card`, `mixed`, `other` — optional but useful.")
    operator: str | None = Field(default=None, description="Who served, if you track it.")
    till: str | None = Field(default=None, description="Till/register identifier, if you have several.")
    customer_ref: str | None = Field(
        default=None,
        description="Your own customer id, **if** the sale was linked to a known customer. "
                    "Never send a national id (ΑΜΚΑ) or a name here.")

    model_config = {"json_schema_extra": {"example": {
        "external_id": "POS-2026-0009412",
        "sold_at": "2026-09-27T11:42:00Z",
        "payment_method": "card",
        "lines": [
            {"barcode": "5205152001010", "quantity": 2, "unit_price_cents": 219, "kind": "otc"},
            {"barcode": "5201580001234", "quantity": 1, "unit_price_cents": 1490,
             "discount_cents": 150, "kind": "para"},
        ],
    }}}


# ── Customer bridge ─────────────────────────────────────────────────────────────
class CustomerLinkIn(BaseModel):
    """Link YOUR customer to the pharmacy's patient record — done once per customer."""
    customer_ref: str = Field(
        min_length=1, max_length=64,
        description="Your own customer id. Use it in every later call. We never send you ours.",
        examples=["CUST-10492"])
    amka: str | None = Field(
        default=None,
        description="The customer's ΑΜΚΑ (Greek social security number). The most reliable match.",
        examples=["01019012345"])
    phone: str | None = Field(
        default=None,
        description="Mobile or landline, any format. Used only when you have no ΑΜΚΑ. "
                    "If it matches more than one person we refuse the link rather than guess.",
        examples=["6971234567"])

    model_config = {"json_schema_extra": {"example": {
        "customer_ref": "CUST-10492", "amka": "01019012345"}}}


class CustomerLink(BaseModel):
    customer_ref: str = Field(description="Your id, echoed back.", examples=["CUST-10492"])
    linked: bool = Field(description="`true` once the bridge exists.", examples=[True])
    matched_by: str = Field(description="Which identifier matched: `amka` or `phone`.",
                            examples=["amka"])
    loyalty: dict | None = Field(
        default=None,
        description="The customer's loyalty card, if the pharmacy runs the programme and the "
                    "customer is a member. `null` otherwise.")


# ── Loyalty ─────────────────────────────────────────────────────────────────────
class LoyaltyConfig(BaseModel):
    """How THIS pharmacy's loyalty programme is set up. Read it once at start-up and render
    your till screen from it — never hard-code the numbers, every pharmacy chooses its own."""
    enabled: bool = Field(description="`false` → the pharmacy does not run a loyalty programme. "
                                      "Hide the loyalty part of your till screen.",
                          examples=[True])
    cents_per_point: int = Field(
        description="What one point is WORTH, in cents. 5 → 10 points = 0.50 €.", examples=[5])
    min_redeem_cents: int = Field(description="Smallest redemption allowed, in cents.",
                                 examples=[100])
    earn_from_sales: bool = Field(
        description="`true` → the sales you send us earn points automatically. `false` → points "
                    "come only from prescription adherence; sending sales still improves the "
                    "pharmacy's analytics.", examples=[True])
    earn_pct: int = Field(
        description="Percentage of the NON-PRESCRIPTION basket value credited as wallet money.",
        examples=[2])
    tiers: list[str] = Field(description="The tier ladder, lowest first.",
                             examples=[["Bronze", "Silver", "Gold", "Platinum"]])
    terms: str = Field(description="The pharmacy's terms of participation. Show these before you "
                                   "enrol anyone — consent is the pharmacy's legal obligation.")


class LoyaltyCard(BaseModel):
    """What to show at the till."""
    customer_ref: str = Field(examples=["CUST-10492"])
    enrolled: bool = Field(description="`false` → not a member yet. Offer to enrol them.",
                           examples=[True])
    points: int = Field(description="Points available now.", examples=[340])
    balance_cents: int = Field(description="What those points are worth, in cents. "
                                           "This is the amount you may discount.", examples=[1700])
    min_redeem_cents: int = Field(examples=[100])
    tier: str | None = Field(default=None, examples=["Silver"])
    next_tier: str | None = Field(default=None, examples=["Gold"])
    to_next_points: int = Field(default=0, description="Points still needed for the next tier — "
                                                       "a good line to say out loud at the till.",
                               examples=[660])
    refill_points_as_of: str | None = Field(
        default=None,
        description="When the adherence part of the balance was last computed (cached up to 5 "
                    "minutes). Redemptions and manual credits are ALWAYS live, so the amount you "
                    "may discount is never stale.")


class LoyaltyEnrollIn(BaseModel):
    customer_ref: str = Field(min_length=1, max_length=64, examples=["CUST-10492"])
    accept_terms: bool = Field(
        description="Must be `true`. Send it only after the customer has actually agreed — you "
                    "are recording their consent, and the pharmacy answers for it under GDPR.",
        examples=[True])


class LoyaltyReward(BaseModel):
    reward_id: str = Field(description="Pass this to `/v1/loyalty/redeem`.",
                           examples=["66f2a1c9e4b0a1d2c3e4f5a6"])
    title: str = Field(examples=["Δωρεάν μέτρηση πίεσης"])
    type: str = Field(description="`product`, `service` or `discount`.", examples=["service"])
    cost_points: int = Field(examples=[100])
    cost_cents: int = Field(description="The same cost expressed in cents.", examples=[500])


class LoyaltyRedeemIn(BaseModel):
    customer_ref: str = Field(min_length=1, max_length=64, examples=["CUST-10492"])
    external_id: str = Field(
        min_length=1, max_length=64,
        description="YOUR unique id for this redemption (e.g. the receipt number). Retrying with "
                    "the same value NEVER deducts twice — send it again after a timeout.",
        examples=["POS-2026-0009412-R"])
    reward_id: str | None = Field(
        default=None, description="Redeem a catalogue reward. Either this or `cents`.",
        examples=["66f2a1c9e4b0a1d2c3e4f5a6"])
    cents: int | None = Field(
        default=None, ge=1,
        description="Redeem a free amount off the basket, in cents. Either this or `reward_id`.",
        examples=[500])

    model_config = {"json_schema_extra": {"example": {
        "customer_ref": "CUST-10492", "external_id": "POS-2026-0009412-R", "cents": 500}}}


class LoyaltyRedeem(BaseModel):
    ok: bool = Field(examples=[True])
    duplicate: bool = Field(default=False,
                            description="`true` → we had already recorded this `external_id`; "
                                        "nothing was deducted a second time.", examples=[False])
    deducted_cents: int = Field(description="How much came off the wallet.", examples=[500])
    balance_cents: int = Field(description="What is left.", examples=[1200])
    reward: str | None = Field(default=None, examples=["Δωρεάν μέτρηση πίεσης"])


# ── Clinical (PharmaCat) ────────────────────────────────────────────────────────
class InteractionCheckIn(BaseModel):
    substances: list[str] = Field(
        default_factory=list, max_length=30,
        description="Medicine or substance names — brand names are fine. Send what is in the "
                    "basket. May be empty when you send `customer_ref` and only want their "
                    "existing therapy checked.",
        examples=[["Depon 500mg", "Voltaren gel"]])
    customer_ref: str | None = Field(
        default=None,
        description="A LINKED customer. When you send this AND your key has `patients:read`, we "
                    "check the basket against the patient's WHOLE ACTIVE THERAPY as recorded in "
                    "ΗΔΥΚΑ — including prescriptions dispensed at other pharmacies, which your "
                    "software cannot see.",
        examples=["CUST-10492"])


class Interaction(BaseModel):
    a: str = Field(description="One substance.", examples=["Ιβουπροφαίνη"])
    b: str = Field(description="The other.", examples=["Ασενοκουμαρόλη"])
    severity: str = Field(description="`minor`, `moderate`, `major` or `contraindicated`. "
                                      "Stop the sale on the last two.",
                         examples=["major"])
    mechanism: str = Field(examples=["Αναστολή συσσώρευσης αιμοπεταλίων + μετατόπιση από πρωτεΐνες"])
    risk: str = Field(examples=["Σημαντικά αυξημένος κίνδυνος αιμορραγίας"])
    action: str = Field(description="What the pharmacist should DO. Show this verbatim.",
                       examples=["Αποφυγή· πρότεινε παρακεταμόλη και ενημέρωσε τον ιατρό"])
    involves_new: bool | None = Field(
        default=None,
        description="`true` → the interaction involves something from the basket, not just the "
                    "patient's existing therapy. Highlight these first.", examples=[True])


class InteractionCheck(BaseModel):
    ok: bool = Field(examples=[True])
    checked: list[str] = Field(description="Everything that was actually checked together.",
                              examples=[["Depon 500mg", "Ασενοκουμαρόλη", "Μετφορμίνη"]])
    from_patient_therapy: bool = Field(
        description="`true` → the patient's active ΗΔΥΚΑ therapy was included.", examples=[True])
    interactions: list[Interaction] = Field(default_factory=list)
    max_severity: str | None = Field(
        default=None, description="The worst severity found — branch your till warning on this. "
                                  "`null` when nothing was found.", examples=["major"])
    source: str | None = Field(default=None,
                              description="`cache` (free, instant) or `llm` (freshly analysed).",
                              examples=["cache"])


class AdviseIn(BaseModel):
    question: str = Field(
        min_length=3, max_length=2000,
        description="What the customer is asking, in their own words. Greek or English.",
        examples=["Βήχας ξηρός 3 μέρες, παίρνει και ραμιπρίλη για πίεση"])
    customer_ref: str | None = Field(
        default=None, description="A linked customer — lets the advice take their therapy and "
                                  "age into account.", examples=["CUST-10492"])


class AdviseRedFlag(BaseModel):
    flag: str = Field(examples=["Βήχας >3 εβδομάδες σε ασθενή με αναστολέα ΜΕΑ"])
    action: str = Field(examples=["Παραπομπή σε ιατρό — πιθανή ανεπιθύμητη ενέργεια"])


class Advise(BaseModel):
    ok: bool = Field(examples=[True])
    reply: str = Field(description="The advice, ready to read to the customer.")
    stage: str | None = Field(default=None,
                              description="`triage`, `questions`, `recommendation`, `interaction` "
                                          "or `referral`.", examples=["recommendation"])
    red_flags: list[AdviseRedFlag] = Field(
        default_factory=list,
        description="Warning signs. If this is not empty, show it BEFORE any product suggestion.")
    otc_categories: list[str] = Field(
        default_factory=list,
        description="Categories of non-prescription products that fit — match them to your own "
                    "catalogue.", examples=[["Αντιβηχικά κεντρικής δράσης"]])
    non_drug_advice: list[str] = Field(default_factory=list,
                                       examples=[["Ενυδάτωση", "Αποφυγή ερεθιστικών"]])
    referral_needed: bool = Field(description="`true` → send them to a doctor.", examples=[False])
    referral_urgency: str | None = Field(default=None,
                                         description="`none`, `gp`, `urgent` or `emergency`.",
                                         examples=["gp"])
    source: str | None = Field(default=None, examples=["llm"])
