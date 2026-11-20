"""Καθημερινή ενημέρωση καταλόγου για όσα φαρμακεία πληρώνουν το πρόσθετο `catalog_seed`.

Ο φαρμακοποιός διαλέγει ΜΕ ΠΟΙΑ από τα τρία θέλει να ενημερώνεται (συνταγογραφούμενα,
ΜΗ.ΣΥ.ΦΑ., παραφάρμακα) και κάθε βράδυ παίρνει ό,τι άλλαξε στη βάση μας γι' αυτά.

ΤΙ ΔΕΝ ΠΑΤΑΜΕ ΠΟΤΕ — και γιατί:
Ο φαρμακοποιός δουλεύει πάνω στον κατάλογό του: βάζει δικές του τιμές σε παραφάρμακα (ελεύθερη
τιμή), κρύβει είδη από το e-shop, ρυθμίζει αποθέματα και εκπτώσεις. Μια «πλήρης ευθυγράμμιση»
θα του τα έσβηνε όλα αυτά κάθε βράδυ, σιωπηλά. Γι' αυτό:
  · `stock_qty`, `for_sale`, `discount_pct`, `min_stock` → ΠΟΤΕ (δικές του αποφάσεις)
  · τιμή → μόνο αν ΔΕΝ την έχει πειράξει. Όταν γράφουμε είδος, κρατάμε `seed_price_cents`
    (τι του δώσαμε)· αν η τρέχουσα τιμή είναι ακόμη ίδια μ' αυτό, είναι «δική μας» και την
    ενημερώνουμε — αλλιώς είναι δική του και μένει. Έτσι οι κρατικές διατιμήσεις των
    συνταγογραφούμενων περνούν, χωρίς να χαθεί καμία δική του τιμή.
  · τα υπόλοιπα περιγραφικά (όνομα, φωτο, κατηγορία, χονδρική) ενημερώνονται κανονικά.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db
from app.services.catalog_taxonomy import PRODUCT_TYPES

#: Περιγραφικά πεδία που ακολουθούν τη βάση μας.
_SYNC_FIELDS = ("name", "description_short", "description_long", "image_id", "images",
                "photo_url", "category", "type", "wholesale_cents", "barcodes", "usage_video_url")

_PARALLEL = 200   # πόσες ενημερώσεις ειδών ταυτόχρονα

#: Κύπρος: επιπλέον πεδία από την PharmacyOne. ΜΟΝΟ για κυπριακά φαρμακεία — στην Ελλάδα ο
#: «προμηθευτής» είναι δική του επιλογή του φαρμακοποιού και δεν έρχεται από τον κύριο κατάλογο.
_CY_SYNC_FIELDS = ("supplier", "suppliers", "cat_path", "brand", "atc", "atc_source", "vat_rate", "drug_code")

#: Ποτέ δεν αντιγράφονται — ταυτότητα εγγραφής ή δεδομένα του ΠΗΓΑΙΟΥ φαρμακείου.
_NEVER = {"_id", "tenant_id", "created_at", "updated_at", "stock_qty", "for_sale", "discount_pct",
          "min_stock", "source", "profarm_tried", "profarm_tried_at", "profarm_synced_at",
          "profarm_pid", "photo_source", "sale_starts_at", "sale_ends_at",
          # ανά φαρμακείο (προέλευση/κλείδωμα/επεξεργασία) — ποτέ από την πηγή
          "origin", "catalog_locked", "locked_at", "lock_prev", "user_edited_at", "seed_price_cents"}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _aware(d: datetime) -> datetime:
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d


async def master_tenant(db) -> str | None:
    """Ο ΕΛΛΗΝΙΚΟΣ κύριος κατάλογος (το φαρμακείο με τα περισσότερα είδη). Τα κυπριακά εξαιρούνται:
    η Κύπρος έχει δική της πηγή (PharmacyOne) — ένας κυπριακός κατάλογος δεν γίνεται ποτέ πηγή
    για ελληνικά φαρμακεία, ούτε το αντίστροφο."""
    from app.services.cy.gate import cy_tenant_ids
    cy = await cy_tenant_ids()
    rows = await db["pharmacy_products"].aggregate([
        *([{"$match": {"tenant_id": {"$nin": cy}}}] if cy else []),
        {"$group": {"_id": "$tenant_id", "n": {"$sum": 1}}},
        {"$sort": {"n": -1}}, {"$limit": 1}]).to_list(length=1)
    return rows[0]["_id"] if rows else None


async def get_settings(tenant_id: str) -> dict:
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"catalog_sync": 1}) or {}
    cs = t.get("catalog_sync") or {}
    return {"types": [x for x in (cs.get("types") or []) if x in PRODUCT_TYPES],
            "last_sync_at": cs.get("last_sync_at"), "last_result": cs.get("last_result")}


async def set_settings(tenant_id: str, *, types: list[str]) -> dict:
    clean = [t for t in (types or []) if t in PRODUCT_TYPES]
    await shared_db()["tenants"].update_one(
        {"_id": tenant_id}, {"$set": {"catalog_sync.types": clean, "updated_at": _now()}})
    return {"ok": True, "types": clean}


async def run_for_tenant(tenant_id: str, *, dry_run: bool = False, full: bool = False) -> dict:
    """Μία ενημέρωση για ένα φαρμακείο: νέα είδη + όσα άλλαξαν στη βάση μας."""
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    db = shared_db()
    cfg = await get_settings(tenant_id)
    types = cfg["types"]
    if not types:
        # Καμία επιλογή = ρητή σιωπή. ΔΕΝ υποθέτουμε «όλα»: θα φόρτωνε 40.000 είδη σε κάποιον
        # που απλώς δεν έχει ανοίξει ακόμη τη ρύθμιση.
        return {"ok": True, "skipped": "no_types"}
    t = await db["tenants"].find_one({"_id": tenant_id}, {"country": 1}) or {}
    is_cy = (t.get("country") or "GR").upper() == "CY"
    master = None
    if not is_cy:
        master = await master_tenant(db)
        if not master or master == tenant_id:
            return {"ok": True, "skipped": "no_master"}

    col = db["pharmacy_products"]
    repo = PharmacyCatalogRepository(tenant_id=tenant_id)
    since = None if full else cfg.get("last_sync_at")   # full: ξαναπερνά τα περιγραφικά σε ΟΛΑ (όχι τιμή/απόθεμα)

    fields = _SYNC_FIELDS + (_CY_SYNC_FIELDS if is_cy else ())
    mine: dict[str, dict] = {}
    # Φέρνουμε και τα περιγραφικά πεδία, για να γράφουμε ΜΟΝΟ όπου υπάρχει διαφορά (βλ. παρακάτω).
    async for d in col.find({"tenant_id": tenant_id},
                            {"barcode": 1, "price_cents": 1, "seed_price_cents": 1, **{k: 1 for k in fields}}):
        if d.get("barcode"):
            mine[str(d["barcode"])] = d

    async def source():
        """(είδος, πότε άλλαξε στην πηγή). Ελλάδα: ο κύριος κατάλογος· Κύπρος: PharmacyOne."""
        if is_cy:
            from app.services.cy.pharmacyone import catalog_products
            async for item in catalog_products(types):
                yield item
            return
        q: dict = {"tenant_id": master, "type": {"$in": types}, "barcode": {"$nin": [None, ""]}}
        async for doc in col.find(q):
            yield doc, doc.get("updated_at")
    added = updated = 0
    buf: list[dict] = []
    # Ημερολόγιο αλλαγών: χωρίς αυτό δεν μπορούμε να πούμε στον φαρμακοποιό ΤΙ του αλλάξαμε
    # χθες το βράδυ — και ένας κατάλογος που αλλάζει αόρατα είναι χειρότερος από στατικό.
    run_at = _now()
    events: list[dict] = []
    # Ενημερώσεις ΠΑΡΑΛΛΗΛΑ ανά ομάδα: ένα-ένα, 48.000 είδη θέλουν πάνω από ώρα (μετρημένο 18/11/2026).
    pending: list[tuple[str, dict]] = []

    async def flush() -> None:
        import asyncio
        while pending:
            part = pending[:_PARALLEL]
            del pending[:_PARALLEL]
            await asyncio.gather(*(repo.update_one({"barcode": b}, {"$set": pt}) for b, pt in part))

    async for p, changed_at in source():
        bc = str(p.get("barcode"))
        src = {k: v for k, v in p.items() if k not in _NEVER}
        if bc not in mine:
            if dry_run:
                added += 1
                continue
            buf.append({**src, "tenant_id": tenant_id, "stock_qty": 0, "source": "catalog_sync",
                        "origin": "pharmacyone" if is_cy else "rxvision",
                        "seed_price_cents": p.get("price_cents"),
                        "created_at": _now(), "updated_at": _now()})
            events.append({"tenant_id": tenant_id, "run_at": run_at, "kind": "added",
                           "barcode": bc, "name": p.get("name"), "type": p.get("type"),
                           "category": p.get("category"), "price_cents": p.get("price_cents")})
            if len(buf) >= 1000:
                await col.insert_many(buf); added += len(buf); buf = []
            continue
        # υπάρχον: ενημέρωση ΜΟΝΟ αν άλλαξε στη βάση μας από τον τελευταίο συγχρονισμό
        if since and _aware(changed_at or _now()) <= _aware(since):
            continue
        cur = mine[bc]
        # ΜΟΝΟ ό,τι διαφέρει. Πριν γράφαμε σε ΚΑΘΕ είδος που πέρασε τον έλεγχο ημερομηνίας, ακόμη κι
        # όταν ήταν ίδιο — 48.000 άσκοπες εγγραφές σε ένα πλήρες πέρασμα (18/11/2026).
        patch = {k: p[k] for k in fields if k in p and cur.get(k) != p[k]}
        # Η τιμή περνά μόνο αν είναι ακόμη «δική μας» (δεν την έχει αλλάξει ο φαρμακοποιός).
        untouched = (cur.get("seed_price_cents") is not None
                     and cur.get("price_cents") == cur.get("seed_price_cents"))
        old_price, new_price = cur.get("price_cents"), p.get("price_cents")
        if untouched and old_price != new_price:
            patch["price_cents"] = new_price
            patch["seed_price_cents"] = new_price
        if not patch:
            continue   # τίποτα δεν άλλαξε → καμία εγγραφή, κανένα «ενημερώθηκε» στην αναφορά
        updated += 1
        if untouched and old_price != new_price:
            events.append({"tenant_id": tenant_id, "run_at": run_at, "kind": "price",
                           "barcode": bc, "name": p.get("name"), "type": p.get("type"),
                           "old_price_cents": old_price, "price_cents": new_price})
        elif (p.get("name") or "") != (cur.get("name") or ""):
            events.append({"tenant_id": tenant_id, "run_at": run_at, "kind": "renamed",
                           "barcode": bc, "name": p.get("name"), "old_name": cur.get("name"),
                           "type": p.get("type")})
        else:
            events.append({"tenant_id": tenant_id, "run_at": run_at, "kind": "info",
                           "barcode": bc, "name": p.get("name"), "type": p.get("type")})
        if not dry_run:
            patch["updated_at"] = _now()
            pending.append((bc, patch))
            if len(pending) >= _PARALLEL:
                await flush()
    if not dry_run:
        await flush()
    if buf and not dry_run:
        await col.insert_many(buf); added += len(buf)

    res = {"ok": True, "added": added, "updated": updated, "types": types}
    if is_cy and not dry_run:
        res["categories"] = await _cy_category_tree(tenant_id)
    if events and not dry_run:
        for i in range(0, len(events), 1000):
            await db["catalog_sync_events"].insert_many(events[i:i + 1000])
    if not dry_run:
        await db["tenants"].update_one({"_id": tenant_id}, {"$set": {
            "catalog_sync.last_sync_at": _now(), "catalog_sync.last_result": res}})
        if added and not is_cy:   # η AI κατηγοριοποίηση είναι για τα ελληνικά ονόματα
            from app.workers.catalog_categories import classify_parapharmacy
            classify_parapharmacy.delay(0)
    return res


async def report(tenant_id: str, *, days: int = 30, kind: str | None = None) -> dict:
    """Τι άλλαξε στον κατάλογο του φαρμακείου: ανά βραδιά, και αναλυτικά ανά είδος."""
    from app.repositories.catalog_sync_events import CatalogSyncEventRepository
    repo = CatalogSyncEventRepository(tenant_id=tenant_id)
    return {"runs": await repo.runs(), "items": await repo.items(days=days, kind=kind)}


async def run_all() -> dict:
    """Όλα τα φαρμακεία που πληρώνουν το πρόσθετο και έχουν διαλέξει κατηγορίες."""
    from app.repositories.catalog_sync_events import CatalogSyncEventRepository
    db = shared_db()
    out: dict[str, dict] = {}
    async for t in db["tenants"].find(
            {"modules.catalog_seed": {"$in": ["enabled", "trial"]}}, {"_id": 1}):
        try:
            out[t["_id"]] = await run_for_tenant(t["_id"])
            await CatalogSyncEventRepository(tenant_id=t["_id"]).purge_old()
        except Exception as e:  # noqa: BLE001 — ένα φαρμακείο δεν ρίχνει τα υπόλοιπα
            out[t["_id"]] = {"ok": False, "error": str(e)[:160]}
    return {"ok": True, "tenants": len(out), "results": out}


async def _cy_category_tree(tenant_id: str) -> dict:
    """Κύπρος: το δέντρο κατηγοριών (Κατ.1 → 2 → 3) του φαρμακείου από τις κατηγορίες της PharmacyOne,
    και ανάθεση στα είδη. ΜΟΝΟ όπου το είδος δεν έχει ήδη κατηγορία (ποτέ πάνω σε επιλογή του
    φαρμακοποιού). Ίδια δομή με τις κατηγορίες e-shop της Ελλάδας."""
    from app.repositories.pharmacy_categories import PharmacyCategoryRepository
    db = shared_db()
    repo = PharmacyCategoryRepository(tenant_id=tenant_id)
    cache: dict = {}

    async def ensure(name: str, parent: str | None) -> str | None:
        key = (parent or "", name.lower())
        if key not in cache:
            cache[key] = (await repo.add(name, parent)).get("id")
        return cache[key]

    # ανά ΠΛΗΡΗ διαδρομή (distinct σε πίνακα θα έδινε μεμονωμένα στοιχεία)
    rows = await db["pharmacy_products"].aggregate([
        {"$match": {"tenant_id": tenant_id, "cat_path.0": {"$exists": True},
                    "$or": [{"cat1_id": {"$in": [None, ""]}}, {"cat1_id": {"$exists": False}}]}},
        {"$group": {"_id": "$cat_path"}}]).to_list(length=None)
    assigned = 0
    for r in rows:
        path = r["_id"] or []
        ids: list = []
        parent = None
        for name in path[:3]:
            parent = await ensure(name, parent)
            if not parent:
                break
            ids.append(parent)
        if not ids:
            continue
        upd = {"cat1_id": ids[0], **({"cat2_id": ids[1]} if len(ids) > 1 else {}),
               **({"cat3_id": ids[2]} if len(ids) > 2 else {}), "updated_at": _now()}
        res = await db["pharmacy_products"].update_many(
            {"tenant_id": tenant_id, "cat_path": path,
             "$or": [{"cat1_id": {"$in": [None, ""]}}, {"cat1_id": {"$exists": False}}]}, {"$set": upd})
        assigned += res.modified_count
    return {"paths": len(rows), "assigned": assigned}
