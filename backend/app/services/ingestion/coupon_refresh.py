"""Κουπόνια που η ΗΔΥΚΑ καταχώρισε ΑΡΓΟΤΕΡΑ από την εκτέλεση — ανανέωση (27/11/2026).

ΤΟ ΠΡΟΒΛΗΜΑ: μια τμηματική/επαναλαμβανόμενη συνταγή έρχεται ως `barcode:1`, `:2`… και ΚΑΘΕ εγγραφή
κουβαλά ΟΛΑ τα κουπόνια της συνταγής, το καθένα με τη φάση του (`execution_no`, CDA 2.10.8). Όταν
αντλούμε την εγγραφή `:N` λίγο μετά την εκτέλεση, η ΗΔΥΚΑ μπορεί να μην έχει ακόμη κρεμάσει το
κουπόνι της φάσης N στο CDA. Κρατούσαμε αυτό το στιγμιότυπο για πάντα:
  · το hash περιεχομένου (engine._content_hash) δεν περιέχει κουπόνια → κάθε επόμενη άντληση
    έβγαινε «duplicate» και δεν ξαναγραφόταν·
  · οι παλιές ημέρες δεν ξανακατεβαίνουν.
Αποτέλεσμα: «Έλεγχος Barcode» → Εκτέλεση N χωρίς κανένα φάρμακο, και `qty_here` = 0 σε όλα τα είδη
της εγγραφής (λάθος τεμάχια). Μετρημένο 27/11/2026: 93 από 504.423 εγγραφές, 8 φαρμακεία.

ΚΑΝΟΝΑΣ «μπαγιάτικου» (ΕΝΑΣ ορισμός, `stale_phase`): η εγγραφή `:N` ΔΕΝ έχει κανένα κουπόνι της
φάσης N, ενώ υπάρχουν κουπόνια άλλων φάσεων.

ΘΕΡΑΠΕΙΑ (εδώ): ξαναδιαβάζουμε ΜΙΑ φορά το CDA της συνταγής και ξαναγράφουμε τα κουπόνια + `qty_here`
σε ΟΛΕΣ τις εγγραφές της (και το κόστος χονδρικής της εγγραφής, που ζυγίζεται με τα `qty_here`).
Ποσά της ΗΔΥΚΑ (amount_total/claimed/συμμετοχή) δεν αγγίζονται — έρχονται από την εκτέλεση, όχι από
τα κουπόνια. Καλείται από: το engine (σημαία `coupons_stale`), τη νυχτερινή εργασία
`refresh_stale_coupons`, και το άνοιγμα της συνταγής στον «Έλεγχο Barcode».
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone

from app.services import dispensed

MAX_ATTEMPTS = 8          # ~1 ημέρα (ανά 3 ώρες)· μετά σταματάμε — π.χ. φάση με είδος χωρίς κουπόνι


def _no(c: dict) -> int:
    try:
        return int(float(c.get("execution_no") or 0))
    except (TypeError, ValueError):
        return 0


def stale_phase(coupon_lists, n: int) -> bool:
    """`coupon_lists` = τα κουπόνια κάθε είδους της εγγραφής `:n`. True = λείπει η φάση n."""
    nos = {_no(c) for cps in coupon_lists for c in (cps or [])}
    nos.discard(0)
    return bool(nos) and n not in nos


def _cents_weighted(items: list[dict]) -> tuple[int, int]:
    amount = cost = 0
    for it in items:
        q = int(it.get("qty_here") or 0)
        amount += int(it.get("retail_price") or 0) * q
        cost += int(it.get("wholesale_price") or 0) * q
    return amount, cost


async def apply_fresh_coupons(db, tenant_id: str, barcode: str, cda_lines: list[dict]) -> dict:
    """Γράφει τα κουπόνια του φρέσκου CDA σε ΟΛΕΣ τις εγγραφές της συνταγής. Αντιστοίχιση γραμμής:
    (eof_code, σειρά εμφάνισης) — ίδια σειρά με το ingestion (_map_full απαριθμεί τις γραμμές του CDA)."""
    fresh: dict[str, list[list]] = {}
    for ln in cda_lines or []:
        fresh.setdefault(str(ln.get("eof_code") or ""), []).append(ln.get("coupons") or [])
    now = datetime.now(tz=timezone.utc)
    out = {"records": 0, "items": 0, "still_stale": 0}
    async for e in db["prescription_executions"].find(
            {"tenant_id": tenant_id, "source": "HDIKA",
             "external_id": {"$regex": f"^{re.escape(barcode)}(:|$)"}},
            {"external_id": 1, "amount_total": 1, "wholesale_cost": 1}):
        n = dispensed.record_no(e.get("external_id"))
        items = [it async for it in db["prescription_items"].find(
            {"tenant_id": tenant_id, "execution_id": e["_id"]}).sort("_id", 1)]
        seen: dict[str, int] = {}
        changed = False
        for it in items:
            d = it.get("details") or {}
            eof = str(d.get("eof_code") or "")
            k = seen.get(eof, 0)
            seen[eof] = k + 1
            lst = fresh.get(eof) or []
            if k >= len(lst) or not lst[k] or lst[k] == (d.get("coupons") or []):
                continue
            cps = lst[k]
            qh = dispensed.qty_here(cps, it.get("executed_qty"), it.get("quantity"),
                                    it.get("is_executed"), n)
            await db["prescription_items"].update_one(
                {"_id": it["_id"], "tenant_id": tenant_id},
                {"$set": {"details.coupons": cps, "qty_here": qh}})
            it.setdefault("details", {})["coupons"] = cps
            it["qty_here"] = qh
            out["items"] += 1
            changed = True
        stale = stale_phase([(it.get("details") or {}).get("coupons") for it in items], n)
        upd: dict = {"$set": {"coupons_stale": stale, "coupons_refreshed_at": now}}
        if stale:
            upd["$inc"] = {"coupon_refresh_attempts": 1}
            out["still_stale"] += 1
        else:
            upd.setdefault("$unset", {})["coupon_refresh_attempts"] = ""
        if changed:
            out["records"] += 1
            # ίδιος κανόνας με engine._persist: χονδρική ζυγισμένη με τα τεμάχια ΑΥΤΗΣ της εγγραφής,
            # κλιμακωμένη στο αυθεντικό σύνολο της ΗΔΥΚΑ
            amount_here, cost_here = _cents_weighted(items)
            if amount_here > 0 and (e.get("amount_total") or 0) > 0:
                upd["$set"]["wholesale_cost"] = round(cost_here * e["amount_total"] / amount_here)
        await db["prescription_executions"].update_one({"_id": e["_id"], "tenant_id": tenant_id}, upd)
    return out


async def refresh_rx(db, tenant_id: str, barcode: str, client=None) -> dict:
    """Ξαναδιαβάζει το CDA της συνταγής από την ΗΔΥΚΑ και ενημερώνει τα κουπόνια. `client` = ήδη
    ανοιχτός HdikaClient (νυχτερινή εργασία)· αλλιώς ανοίγει έναν με τα στοιχεία του φαρμακείου."""
    own = client is None
    if own:
        from app.services.ingestion.cda_lookup import _creds
        from app.services.ingestion.hdika_client import HdikaClient
        creds = await _creds(tenant_id, db)
        if not ((creds.get("base_url") or creds.get("live_endpoint"))
                and creds.get("api_key") and creds.get("username")):
            return {"ok": False, "reason": "no_creds"}
        client = HdikaClient(creds)
    try:
        cda = await asyncio.to_thread(client._fetch_cda, barcode)
    finally:
        if own:
            client.close()
    lines = (cda or {}).get("lines") or []
    if not lines:
        return {"ok": False, "reason": "no_cda"}
    return {"ok": True, **await apply_fresh_coupons(db, tenant_id, barcode, lines)}


async def mark_stale(db, tenant_id: str | None = None) -> int:
    """Σημαδεύει ως `coupons_stale` όσες ΥΠΑΡΧΟΥΣΕΣ εγγραφές πληρούν τον κανόνα (μία φορά, για όσες
    γράφτηκαν πριν το engine αρχίσει να βάζει τη σημαία). Επιστρέφει πόσες σημαδεύτηκαν."""
    match: dict = {"details.coupons.0": {"$exists": True}}
    if tenant_id:
        match["tenant_id"] = tenant_id
    nos: dict = {}
    async for g in db["prescription_items"].aggregate([
            {"$match": match},
            {"$group": {"_id": "$execution_id", "c": {"$push": "$details.coupons"}}}],
            allowDiskUse=True):
        nos[g["_id"]] = g["c"]
    marked = 0
    ids = list(nos)
    for i in range(0, len(ids), 2000):
        q: dict = {"_id": {"$in": ids[i:i + 2000]}, "source": "HDIKA"}
        if tenant_id:
            q["tenant_id"] = tenant_id
        async for e in db["prescription_executions"].find(q, {"external_id": 1, "tenant_id": 1}):
            if stale_phase(nos[e["_id"]], dispensed.record_no(e.get("external_id"))):
                await db["prescription_executions"].update_one(
                    {"_id": e["_id"], "tenant_id": e["tenant_id"]}, {"$set": {"coupons_stale": True}})
                marked += 1
    return marked
