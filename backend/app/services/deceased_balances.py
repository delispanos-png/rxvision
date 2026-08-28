"""Λίστα ΟΛΩΝ των θανόντων ασθενών + τυχόν ΕΚΚΡΕΜΟΤΗΤΕΣ ανά θανόντα: ΑΝΕΚΤΕΛΕΣΤΕΣ συνταγές
(εκτελέσεις με ανεκτέλεστες ουσίες) + ΑΝΟΙΧΤΕΣ e-shop παραγγελίες (unpaid/pending). ΟΧΙ loyalty
(οι πόντοι πιστότητας δεν διεκδικούνται). Ώστε το φαρμακείο να δει τι εκκρεμεί & να το κλείσει."""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db
from app.repositories.base import jsonsafe
from app.utils.masking import mask_amka


async def deceased_balances(tenant_id: str, *, include_settled: bool = False, demo: bool = False) -> dict:
    db = shared_db()
    deceased = await db["patients_anonymized"].find(
        {"tenant_id": tenant_id, "deceased": True},
        {"_id": 1, "full_name": 1, "amka": 1, "deceased_at": 1},
    ).to_list(length=None)
    empty = {"patients": 0, "with_open": 0, "unexecuted_rx": 0, "orders_count": 0, "orders_cents": 0}
    if not deceased:
        return {"items": [], "totals": empty}

    ref_ids = [d["_id"] for d in deceased]
    ref_strs = [str(x) for x in ref_ids]

    # ΑΝΕΚΤΕΛΕΣΤΕΣ συνταγές ανά θανόντα (εκτελέσεις με ανεκτέλεστες ουσίες)
    unexec: dict[str, int] = {}
    async for r in db["prescription_executions"].aggregate([
        {"$match": {"tenant_id": tenant_id, "patient_ref": {"$in": ref_ids},
                    "has_unexecuted_substances": True}},
        {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}}},
    ]):
        unexec[str(r["_id"])] = r["n"]

    # ΑΝΟΙΧΤΕΣ e-shop παραγγελίες (patient_ref μπορεί να είναι str ή ObjectId → ταίριαξε και τα δύο)
    orders_by: dict[str, dict] = {}
    async for o in db["orders_delivery"].aggregate([
        {"$match": {"tenant_id": tenant_id, "patient_ref": {"$in": ref_strs + ref_ids},
                    "payment_status": {"$in": ["unpaid", "pending"]},
                    "status": {"$nin": ["cancelled"]}}},
        {"$group": {"_id": {"$toString": "$patient_ref"}, "orders": {"$sum": 1},
                    "cents": {"$sum": {"$ifNull": ["$total_cents", 0]}}}},
    ]):
        orders_by[o["_id"]] = o

    settled = set(await db["patient_contacts"].distinct(
        "_id", {"tenant_id": tenant_id, "deceased_balance_settled": True}))

    items = []
    tot_unexec = tot_ord_n = tot_ord_c = with_open = 0
    for d in deceased:
        rid = str(d["_id"])
        ux = int(unexec.get(rid, 0))
        ob = orders_by.get(rid, {})
        orders_count = int(ob.get("orders") or 0)
        orders_cents = int(ob.get("cents") or 0)
        open_items = ux + orders_count
        is_settled = d["_id"] in settled
        # ΟΛΟΙ οι θανόντες. Οι «τακτοποιημένοι» κρύβονται μόνο αν είχαν εκκρεμότητες & δεν ζητήθηκαν ρητά.
        if is_settled and open_items > 0 and not include_settled:
            continue
        items.append({
            "patient_id": rid,
            "name": (d.get("full_name") or "—"),
            "amka": mask_amka(d.get("amka"), demo),
            "deceased_at": jsonsafe(d.get("deceased_at")),
            "unexecuted_rx": ux,
            "orders_count": orders_count,
            "orders_cents": orders_cents,
            "open_items": open_items,
            "settled": is_settled,
        })
        tot_unexec += ux
        tot_ord_n += orders_count
        tot_ord_c += orders_cents
        if open_items > 0:
            with_open += 1

    # πρώτα όσοι έχουν εκκρεμότητες (φθίνον), μετά οι υπόλοιποι κατά ημ/νία θανάτου (πιο πρόσφατοι πρώτα)
    items.sort(key=lambda x: (x["open_items"], x["deceased_at"] or ""), reverse=True)
    return {"items": items, "totals": {
        "patients": len(items), "with_open": with_open, "unexecuted_rx": tot_unexec,
        "orders_count": tot_ord_n, "orders_cents": tot_ord_c}}


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
