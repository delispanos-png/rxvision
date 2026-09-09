"""AI credits — προπληρωμένο ΠΟΡΤΟΦΟΛΙ ΣΕ ΕΥΡΩ πάνω από το δωρεάν όριο του πακέτου.

Το φαρμακείο αγοράζει ένα πακέτο (π.χ. «AI +20 €») και το πορτοφόλι του πιστώνεται με **ακριβώς αυτά
τα ευρώ**. Όταν εξαντληθεί ο δωρεάν προϋπολογισμός της περιόδου (βλ. ai_quota), κάθε ερώτηση χρεώνει
το πορτοφόλι με **τιμή πώλησης = πραγματικό κόστος × (1 + περιθώριο%)** — άρα ο πελάτης κάνει όσες
ερωτήσεις αντέχει το υπόλοιπό του, και το περιθώριό μας μένει ανέπαφο. Αγορά μέσω Viva/Revolut →
webhook → πίστωση + παραστατικό (idempotent), ίδιο μοτίβο με το message_wallet.

ΓΙΑΤΙ ΔΕΝ ΜΕΤΡΑΜΕ «ΕΡΩΤΗΣΕΙΣ»: μία ερώτηση κοστίζει 0,036€–0,141€ (10× διαφορά ανάλογα με το
ερώτημα), οπότε ένα πακέτο «N ερωτήσεων» πουλούσε άλλοτε κάτω κι άλλοτε πάνω από το κόστος. Με
μονάδα το ΕΥΡΩ αυτό γίνεται αδύνατο. Το πεδίο `questions` καταργήθηκε (2026-09-09).
"""

from __future__ import annotations

from datetime import datetime, timezone

from pymongo import ReturnDocument

from app.core.db import shared_db

# Default πακέτα (seed) — ΜΟΝΟ τιμή· το πορτοφόλι πιστώνεται με το ίδιο ποσό.
# Editable στο adminpanel (ai_credit_packs).
DEFAULT_PACKS = [
    {"_id": "ai10", "name": "Πακέτο AI credits 10 €", "price_cents": 1000, "active": True},
    {"_id": "ai20", "name": "Πακέτο AI credits 20 €", "price_cents": 2000, "active": True},
    {"_id": "ai30", "name": "Πακέτο AI credits 30 €", "price_cents": 3000, "active": True},
]


def credit_cents_of(pack: dict) -> int:
    """Πόσα λεπτά πιστώνονται στο πορτοφόλι για αυτό το πακέτο = η τιμή του.

    Ανέχεται παλιά έγγραφα που είχαν ξεχωριστό `credit_cents` (πριν την ενοποίηση 2026-09-09).
    """
    return int(pack.get("credit_cents") or pack.get("price_cents") or 0)


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def balance(tenant_id: str) -> int:
    w = await shared_db()["ai_credit_wallets"].find_one({"_id": tenant_id})
    return int((w or {}).get("balance", 0) or 0)


async def consume(tenant_id: str, n: int = 1) -> bool:
    """Atomic: τράβα n ΛΕΠΤΑ κόστους ΑΝ υπάρχουν (χωρίς μερική χρέωση). Returns True αν καταναλώθηκαν."""
    if not tenant_id or n <= 0:
        return False
    db = shared_db()
    doc = await db["ai_credit_wallets"].find_one_and_update(
        {"_id": tenant_id, "balance": {"$gte": n}},
        {"$inc": {"balance": -n}, "$set": {"updated_at": _now()}},
        return_document=ReturnDocument.AFTER)
    if not doc:
        return False
    await _ledger(tenant_id, "consume", -n, doc["balance"], None)
    return True


async def add(tenant_id: str, cents: int, *, reason: str = "topup", ref: str | None = None) -> dict:
    """Πίστωση λεπτών ευρώ στο πορτοφόλι (αγορά / bonus / manual grant)."""
    db = shared_db()
    doc = await db["ai_credit_wallets"].find_one_and_update(
        {"_id": tenant_id}, {"$inc": {"balance": int(cents)}, "$set": {"updated_at": _now()}},
        upsert=True, return_document=ReturnDocument.AFTER)
    await _ledger(tenant_id, reason, int(cents), doc["balance"], ref)
    return {"balance": doc["balance"]}


async def _ledger(tenant_id: str, kind: str, delta: int, balance_after: int, ref: str | None) -> None:
    await shared_db()["ai_credit_ledger"].insert_one({
        "tenant_id": tenant_id, "kind": kind, "delta": int(delta),
        "balance_after": int(balance_after or 0), "ref": ref, "ts": _now()})


# ── πακέτα credits (platform catalog) ────────────────────────────────────────
async def _ensure_seed() -> None:
    db = shared_db()
    if await db["ai_credit_packs"].count_documents({}) == 0:
        await db["ai_credit_packs"].insert_many([dict(p) for p in DEFAULT_PACKS])


async def packs(active_only: bool = True) -> list[dict]:
    await _ensure_seed()
    flt = {"active": True} if active_only else {}
    return [p async for p in shared_db()["ai_credit_packs"].find(flt).sort("price_cents", 1)]


async def get_pack(pack_id: str) -> dict | None:
    return await shared_db()["ai_credit_packs"].find_one({"_id": pack_id, "active": True})


# ── αγορά (top-up) μέσω παρόχου πληρωμής — ίδια ροή με message_wallet ─────────
async def record_pending_topup(tenant_id: str, pack: dict, order_id: str) -> None:
    await shared_db()["ai_credit_topups"].insert_one({
        "order_id": order_id, "tenant_id": tenant_id, "pack_id": pack["_id"],
        "credit_cents": credit_cents_of(pack), "price_cents": int(pack.get("price_cents") or 0),
        "status": "pending", "created_at": _now()})


async def complete_topup(order_id: str) -> bool:
    """Καλείται από τα webhooks (Viva/Revolut) σε ολοκλήρωση. Πιστώνει ΜΙΑ φορά (idempotent).
    Returns True αν το order_id ήταν δικό μας (pending) AI top-up."""
    db = shared_db()
    doc = await db["ai_credit_topups"].find_one_and_update(
        {"order_id": order_id, "status": "pending"},
        {"$set": {"status": "completed", "completed_at": _now()}},
        return_document=ReturnDocument.AFTER)
    if not doc:
        return await db["ai_credit_topups"].count_documents({"order_id": order_id}) > 0
    await add(doc["tenant_id"], int(doc["credit_cents"]), reason="topup", ref=order_id)
    try:
        from app.services import invoice_service
        await invoice_service.create_for_payment(
            tenant_id=doc["tenant_id"], kind="ai_credits", gross_cents=int(doc.get("price_cents", 0) or 0),
            description=f"Αγορά AI credits RxVision ({doc['credit_cents']/100:.2f}€)",
            item_key=f"ai_credit:{doc.get('pack_id')}",
            payment={"method": "card", "provider": doc.get("provider"), "transaction_id": order_id})
    except Exception:  # noqa: BLE001 — η πίστωση έγινε· το παραστατικό είναι best-effort
        pass
    return True


async def ledger(tenant_id: str, limit: int = 50) -> list[dict]:
    return [r async for r in shared_db()["ai_credit_ledger"].find({"tenant_id": tenant_id}).sort("ts", -1).limit(limit)]
