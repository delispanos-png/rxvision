"""Χονδρική τιμή γραμμής — ΕΝΑΣ ορισμός για συγχρονισμό ΚΑΙ επανυπολογισμό (05/10/2026).

ΣΕΙΡΑ: (1) χονδρική της πηγής (ΗΔΥΚΑ) · (2) γνωστή πραγματική στα προϊόντα · (3) ΕΠΙΣΗΜΗ χονδρική του
Δελτίου Τιμών (`medicine_catalog.wholesale_cents` — ταυτίζεται 100% με της ΗΔΥΚΑ σε 3.000 δείγματα) ·
(4) ΕΚΤΙΜΗΣΗ από τη λιανική με την κλίμακα διατίμησης.

ΕΚΤΙΜΗΣΗ — μετρημένο σε 12.729 φάρμακα: λιανική = χονδρική × (1 + περιθώριο) × (1 + ΦΠΑ), και το
κλιμάκιο του περιθωρίου επιλέγεται από τη ΧΟΝΔΡΙΚΗ (≤50 € → 30%, ≤100 € → 20%, ≤150 € → 16% …).
Άρα: χονδρική = (λιανική ÷ (1+ΦΠΑ)) ÷ (1 + περιθώριο του κλιμακίου όπου πέφτει η χονδρική).
Πριν υπήρχαν ΤΡΙΑ λάθη: ο ΦΠΑ δεν αφαιρούνταν (+6%), το κλιμάκιο διαλεγόταν από τη λιανική (φάρμακο
80 € έπαιρνε 20% αντί 30%), και ο συγχρονισμός έγραφε λιανική × (1 − %) ενώ ο επανυπολογισμός
λιανική ÷ (1 + %) — δύο τύποι για το ίδιο. Οι γαληνικές εξαιρούνται (Ν/Α) στον συγχρονισμό.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.services import dispensed, vat

# Default κλίμακα Υπουργείου Υγείας — ισχύει μέχρι/εκτός αν ο platform admin την αλλάξει.
DEFAULT_BANDS: list[list[float]] = [
    [50, 30.0], [100, 20.0], [150, 16.0], [200, 14.0], [300, 12.0],
    [400, 10.0], [500, 9.0], [600, 8.0], [700, 7.0], [800, 6.5],
    [900, 6.0], [1000, 5.5], [1250, 5.0], [1500, 4.25], [1750, 3.75],
    [2000, 3.25], [2250, 3.0], [2500, 2.75], [2750, 2.5], [3000, 2.25],
]


def sanitize_bands(bands) -> list[list[float]]:
    out: list[list[float]] = []
    for b in bands or []:
        try:
            hi, pct = float(b[0]), float(b[1])
        except (TypeError, ValueError, IndexError):
            continue
        if hi > 0 and 0 <= pct <= 100:
            out.append([round(hi, 2), round(pct, 4)])
    out.sort(key=lambda x: x[0])
    return out


async def load_bands(db) -> list[list[float]]:
    doc = await db["platform_settings"].find_one({"_id": "markup"})
    bands = sanitize_bands((doc or {}).get("bands"))
    return bands or [list(b) for b in DEFAULT_BANDS]


def _band_pct(net_cents: float, bands: list[list[float]]) -> float:
    """Περιθώριο του κλιμακίου όπου πέφτει η ΧΟΝΔΡΙΚΗ που προκύπτει από την καθαρή λιανική."""
    for hi, pct in bands:
        if net_cents / (1 + pct / 100) / 100 <= hi:
            return pct
    return bands[-1][1] if bands else 2.25


def estimate_wholesale(retail_cents: int, bands: list[list[float]], vat_pct: float = vat.DEFAULT_PCT) -> int:
    """Εκτιμώμενη χονδρική (χωρίς ΦΠΑ) από λιανική ΜΕ ΦΠΑ — βλ. αρχή αρχείου."""
    if not retail_cents or retail_cents <= 0:
        return 0
    n = retail_cents / vat.divisor(vat_pct)
    return round(n / (1 + _band_pct(n, bands) / 100))


def _estimate_expr(bands: list[list[float]], vat_pct: float) -> dict:
    """Mongo: ίδιος υπολογισμός με estimate_wholesale (κλιμάκιο από τη χονδρική)."""
    n = {"$divide": ["$retail_price", vat.divisor(vat_pct)]}
    branches = [{"case": {"$lte": [{"$divide": [n, (1 + pct / 100) * 100]}, hi]},
                 "then": {"$divide": [n, 1 + pct / 100]}} for hi, pct in bands]
    last = bands[-1][1] if bands else 2.25
    return {"$round": [{"$switch": {"branches": branches, "default": {"$divide": [n, 1 + last / 100]}}}, 0]}


async def catalog_wholesale(db, barcodes: list) -> dict:
    """{barcode → επίσημη χονδρική Δελτίου Τιμών} (κατάλογος ΗΔΥΚΑ)."""
    out: dict = {}
    bcs = [b for b in set(barcodes) if b]
    for i in range(0, len(bcs), 5000):
        async for c in db["medicine_catalog"].find(
                {"$or": [{"barcode": {"$in": bcs[i:i + 5000]}}, {"_id": {"$in": bcs[i:i + 5000]}}],
                 "wholesale_cents": {"$gt": 0}}, {"barcode": 1, "wholesale_cents": 1}):
            for k in (c.get("barcode"), c["_id"]):     # το προϊόν μπορεί να κρατά barcode ή κωδικό ΕΟΦ
                if k:
                    out[k] = int(c["wholesale_cents"])
    return out


async def recompute(db, bands: list[list[float]], tenant_id: str | None = None) -> dict:
    """Επανυπολογισμός χονδρικής + κόστους εκτελέσεων (όλα τα φαρμακεία αν tenant_id=None). Idempotent.

    Εκτιμώμενα είδη: πρώτα η ΕΠΙΣΗΜΗ χονδρική του καταλόγου (→ «catalog»), αλλιώς σωστή εκτίμηση
    (estimate_wholesale). Κέρδος γραμμής/προϊόντος = λιανική χωρίς ΦΠΑ − χονδρική. Το wholesale_cost
    κάθε εκτέλεσης ξαναχτίζεται από τα είδη. Πραγματικές τιμές (source/masterdata/catalog) μένουν ως έχουν.
    """
    from pymongo import UpdateOne

    tenants = [tenant_id] if tenant_id else await db["prescription_executions"].distinct("tenant_id")
    g_items = g_catalog = 0
    for tid in tenants:
        pct = vat.tenant_pct(await db["tenants"].find_one({"_id": tid}, {"medicine_vat_pct": 1, "country": 1}))
        # (α) εκτιμώμενα με ΕΠΙΣΗΜΗ χονδρική στον κατάλογο → η πραγματική (πηγή «catalog»)
        prods = {p["_id"]: p.get("barcode") async for p in db["products"].find(
            {"tenant_id": tid, "wholesale_source": "estimated"}, {"barcode": 1})}
        cat = await catalog_wholesale(db, list(prods.values()))
        p_ops, i_ops = [], []
        for pid, bc in prods.items():
            w = cat.get(bc)
            if not w:
                continue
            p_ops.append(UpdateOne({"_id": pid, "tenant_id": tid}, [
                {"$set": {"wholesale_price": w, "wholesale_source": "catalog"}},
                {"$set": {"margin": {"$subtract": [vat.net_expr("$retail_price", pct), w]}}}]))
            i_ops.append(UpdateOne({"tenant_id": tid, "product_id": pid, "wholesale_source": "estimated"}, [
                {"$set": {"wholesale_price": w, "wholesale_source": "catalog"}},
                {"$set": {"margin": {"$subtract": [vat.net_expr("$retail_price", pct), w]}}}]))
        for coll, ops in (("products", p_ops), ("prescription_items", i_ops)):
            for i in range(0, len(ops), 2000):
                r = await db[coll].bulk_write(ops[i:i + 2000], ordered=False)  # tenant-ok: rebuild· κάθε UpdateOne φιλτράρει tenant_id
                if coll == "prescription_items":
                    g_catalog += r.modified_count
        # (β) τα υπόλοιπα εκτιμώμενα → σωστή εκτίμηση (ΦΠΑ έξω, κλιμάκιο από τη χονδρική)
        g_items += (await db["prescription_items"].update_many(
            {"tenant_id": tid, "wholesale_source": "estimated", "retail_price": {"$gt": 0}}, [
                {"$set": {"wholesale_price": _estimate_expr(bands, pct)}},
                {"$set": {"margin": {"$subtract": [vat.net_expr("$retail_price", pct), "$wholesale_price"]}}},
            ])).modified_count
        await db["products"].update_many(
            {"tenant_id": tid, "wholesale_source": "estimated", "retail_price": {"$gt": 0}}, [
                {"$set": {"wholesale_price": _estimate_expr(bands, pct)}}])
        # κέρδος γραμμής & προϊόντος: λιανική ΧΩΡΙΣ ΦΠΑ − χονδρική (ένας ορισμός — services/vat.py)
        await db["prescription_items"].update_many({"tenant_id": tid}, [
            {"$set": {"margin": {"$subtract": [vat.net_expr("$retail_price", pct),
                                               {"$ifNull": ["$wholesale_price", 0]}]}}}])
        await db["products"].update_many({"tenant_id": tid}, [
            {"$set": {"_n": vat.net_expr("$retail_price", pct)}},
            {"$set": {"margin": {"$subtract": ["$_n", {"$ifNull": ["$wholesale_price", 0]}]},
                      "margin_pct": {"$cond": [{"$gt": ["$_n", 0]}, {"$round": [{"$multiply": [{"$divide": [
                          {"$subtract": ["$_n", {"$ifNull": ["$wholesale_price", 0]}]}, "$_n"]}, 100]}, 2]}, 0]}}},
            {"$unset": "_n"}])

    g_exec = 0
    for tid in tenants:
        sums: dict = {}
        async for r in db["prescription_items"].aggregate([
            {"$match": {"tenant_id": tid}},
            # βάρη = τεμάχια ΑΥΤΗΣ της εγγραφής (qty_here) — όχι η συνταγογραφημένη ποσότητα όλης
            # της συνταγής, που έδινε λάθος μείγμα κόστους σε τμηματικές εκτελέσεις (01/10/2026)
            {"$set": {"_q": dispensed.qty_expr()}},
            {"$group": {"_id": "$execution_id",
                        "raw_w": {"$sum": {"$multiply": [
                            {"$ifNull": ["$wholesale_price", 0]}, {"$ifNull": ["$_q", 0]}]}},
                        "raw_retail": {"$sum": {"$multiply": [
                            {"$ifNull": ["$retail_price", 0]}, {"$ifNull": ["$_q", 0]}]}}}},
        ]):
            sums[r["_id"]] = (r["raw_w"], r["raw_retail"])
        ops: list = []
        async for ex in db["prescription_executions"].find({"tenant_id": tid}, {"amount_total": 1}):
            rw, rr = sums.get(ex["_id"], (0, 0))
            amt = ex.get("amount_total", 0) or 0
            wc = round(rw * amt / rr) if (amt > 0 and rr > 0) else rw
            ops.append(UpdateOne({"_id": ex["_id"], "tenant_id": tid}, {"$set": {"wholesale_cost": wc}}))
            if len(ops) >= 2000:
                await db["prescription_executions"].bulk_write(ops, ordered=False)  # tenant-ok: rebuild πλατφόρμας· UpdateOne φιλτράρει tenant_id
                g_exec += len(ops)
                ops = []
        if ops:
            await db["prescription_executions"].bulk_write(ops, ordered=False)  # tenant-ok: rebuild πλατφόρμας· UpdateOne φιλτράρει tenant_id
            g_exec += len(ops)
    return {"tenants": len(tenants), "items": g_items, "items_from_catalog": g_catalog,
            "executions": g_exec, "at": datetime.now(tz=timezone.utc).isoformat()}
