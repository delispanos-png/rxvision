"""Λίστα θανόντων ασθενών με ΑΝΟΙΧΤΟ υπόλοιπο — ώστε το φαρμακείο να διεκδικήσει το υπόλοιπο από
την οικογένεια (αν το επιθυμεί) ή να το κλείσει. «Υπόλοιπο» = loyalty balance (πόντοι→€) +
ανεξόφλητες e-shop παραγγελίες (orders_delivery, unpaid/pending)."""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db
from app.repositories.base import jsonsafe
from app.repositories.loyalty import LoyaltyRepository
from app.utils.masking import mask_amka


async def deceased_balances(tenant_id: str, *, include_settled: bool = False, demo: bool = False) -> dict:
    db = shared_db()
    deceased = await db["patients_anonymized"].find(
        {"tenant_id": tenant_id, "deceased": True},
        {"_id": 1, "full_name": 1, "amka": 1, "deceased_at": 1},
    ).to_list(length=None)
    if not deceased:
        return {"items": [], "totals": {"patients": 0, "loyalty_cents": 0, "orders_cents": 0, "total_cents": 0}}

    ref_ids = [d["_id"] for d in deceased]
    ref_strs = [str(x) for x in ref_ids]

    loy = await LoyaltyRepository(tenant_id=tenant_id).balances_for_refs(ref_strs)

    # ανεξόφλητες παραγγελίες (patient_ref μπορεί να είναι str ή ObjectId ανά caller → ταίριαξε και τα δύο)
    orders = await db["orders_delivery"].aggregate([
        {"$match": {"tenant_id": tenant_id, "patient_ref": {"$in": ref_strs + ref_ids},
                    "payment_status": {"$in": ["unpaid", "pending"]},
                    "status": {"$nin": ["cancelled"]}}},
        {"$group": {"_id": {"$toString": "$patient_ref"}, "orders": {"$sum": 1},
                    "cents": {"$sum": {"$ifNull": ["$total_cents", 0]}}}},
    ]).to_list(length=None)
    orders_by = {o["_id"]: o for o in orders}

    settled = set(await db["patient_contacts"].distinct(
        "_id", {"tenant_id": tenant_id, "deceased_balance_settled": True}))

    items = []
    tot_loy = tot_ord = 0
    for d in deceased:
        rid = str(d["_id"])
        lb = loy.get(rid, {})
        ob = orders_by.get(rid, {})
        loyalty_cents = int(lb.get("balance_cents") or 0)
        orders_cents = int(ob.get("cents") or 0)
        total = loyalty_cents + orders_cents
        if total <= 0:
            continue
        is_settled = d["_id"] in settled
        if is_settled and not include_settled:
            continue
        items.append({
            "patient_id": rid,
            "name": (d.get("full_name") or "—"),
            "amka": mask_amka(d.get("amka"), demo),
            "deceased_at": jsonsafe(d.get("deceased_at")),
            "loyalty_points": int(lb.get("points") or 0),
            "loyalty_cents": loyalty_cents,
            "orders_count": int(ob.get("orders") or 0),
            "orders_cents": orders_cents,
            "total_cents": total,
            "settled": is_settled,
        })
        tot_loy += loyalty_cents
        tot_ord += orders_cents

    items.sort(key=lambda x: x["total_cents"], reverse=True)
    return {"items": items, "totals": {
        "patients": len(items), "loyalty_cents": tot_loy,
        "orders_cents": tot_ord, "total_cents": tot_loy + tot_ord}}


async def set_settled(tenant_id: str, patient_id: str, settled: bool, by: str | None = None) -> dict:
    """Σημείωσε το υπόλοιπο ενός θανόντα ως «τακτοποιημένο» (διεκδικήθηκε/κλείστηκε) — ίχνος, όχι
    αυτόματη ακύρωση πόντων/παραγγελιών (αυτό το κάνει ο φαρμακοποιός χειροκίνητα κατά περίπτωση)."""
    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(patient_id)
    except (InvalidId, TypeError):
        return {"ok": False, "error": "bad_id"}
    now = datetime.now(tz=timezone.utc)
    await shared_db()["patient_contacts"].update_one(
        {"_id": oid, "tenant_id": tenant_id},
        {"$set": {"deceased_balance_settled": bool(settled),
                  "deceased_balance_settled_at": now if settled else None,
                  "deceased_balance_settled_by": by if settled else None,
                  "tenant_id": tenant_id},
         "$setOnInsert": {"_id": oid, "created_at": now}}, upsert=True)
    return {"ok": True, "settled": bool(settled)}
