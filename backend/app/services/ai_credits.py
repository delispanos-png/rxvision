"""AI credits — prepaid ΕΡΩΤΗΣΕΙΣ πάνω από το included του πακέτου (Phase C του AI pricing).

Κάθε πακέτο credits = N ερωτήσεις για X€. Όταν εξαντληθεί το included (βλ. ai_quota), κάθε επιπλέον
ερώτηση τραβάει 1 credit· όταν αδειάσουν → block («αγόρασε επιπλέον»). Ίδιο μοτίβο με το message_wallet:
αγορά μέσω Viva/Revolut → webhook → πίστωση + παραστατικό (idempotent). Το balance είναι σε ΕΡΩΤΗΣΕΙΣ.
"""

from __future__ import annotations

from datetime import datetime, timezone

from pymongo import ReturnDocument

from app.core.db import shared_db

# Default πακέτα (seed) — τιμή cost-plus (~4¢/ερώτηση). Editable στο adminpanel (ai_credit_packs).
DEFAULT_PACKS = [
    {"_id": "ai200", "name": "200 ερωτήσεις", "questions": 200, "price_cents": 890, "active": True},
    {"_id": "ai500", "name": "500 ερωτήσεις", "questions": 500, "price_cents": 1990, "active": True},
    {"_id": "ai1000", "name": "1.000 ερωτήσεις", "questions": 1000, "price_cents": 3490, "active": True},
]


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def balance(tenant_id: str) -> int:
    w = await shared_db()["ai_credit_wallets"].find_one({"_id": tenant_id})
    return int((w or {}).get("balance", 0) or 0)


async def consume(tenant_id: str, n: int = 1) -> bool:
    """Atomic: τράβα n credits ΑΝ υπάρχουν (χωρίς μερική χρέωση). Returns True αν καταναλώθηκαν."""
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


async def add(tenant_id: str, questions: int, *, reason: str = "topup", ref: str | None = None) -> dict:
    """Πίστωση ερωτήσεων (αγορά / bonus / manual grant)."""
    db = shared_db()
    doc = await db["ai_credit_wallets"].find_one_and_update(
        {"_id": tenant_id}, {"$inc": {"balance": int(questions)}, "$set": {"updated_at": _now()}},
        upsert=True, return_document=ReturnDocument.AFTER)
    await _ledger(tenant_id, reason, int(questions), doc["balance"], ref)
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
        "questions": int(pack["questions"]), "price_cents": int(pack["price_cents"]),
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
    await add(doc["tenant_id"], int(doc["questions"]), reason="topup", ref=order_id)
    try:
        from app.services import invoice_service
        await invoice_service.create_for_payment(
            tenant_id=doc["tenant_id"], kind="ai_credits", gross_cents=int(doc.get("price_cents", 0) or 0),
            description=f"Αγορά AI credits RxVision ({doc['questions']} ερωτήσεις)",
            item_key=f"ai_credit:{doc.get('pack_id')}",
            payment={"method": "card", "provider": doc.get("provider"), "transaction_id": order_id})
    except Exception:  # noqa: BLE001 — η πίστωση έγινε· το παραστατικό είναι best-effort
        pass
    return True


async def ledger(tenant_id: str, limit: int = 50) -> list[dict]:
    return [r async for r in shared_db()["ai_credit_ledger"].find({"tenant_id": tenant_id}).sort("ts", -1).limit(limit)]
