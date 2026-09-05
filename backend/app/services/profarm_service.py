"""Ενσωμάτωση προμηθευτή Profarm (b2b.profarmsa.gr) — αντιστοίχιση barcode → φωτογραφία προϊόντος.

Ο φαρμακοποιός έχει ΔΙΚΟ ΤΟΥ λογαριασμό στο B2B του προμηθευτή (εξουσιοδοτημένη πρόσβαση). Κάνουμε
login με session-cookie (POST /sign-in: username, password, moduleid=940, action=checkin), ψάχνουμε το
προϊόν με το barcode και κατεβάζουμε την επίσημη φωτογραφία — έτσι η αντιστοίχιση είναι ΣΩΣΤΗ (ακριβές EAN).

Τα search/image endpoints του portal ανακαλύπτονται με `probe()` σε authenticated session (LogicOne CMS).
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta, timezone

# Οι αλλαγές πιάνονται ΦΘΗΝΑ από την τιμή/διαθεσιμότητα της ΛΙΣΤΑΣ (100 προϊόντα/request)· ανοίγουμε το
# detail μόνο όσων άλλαξε η τιμή. _DEEP_RESYNC = βαθύς έλεγχος ασφαλείας ανά είδος (πιάνει ό,τι δεν φάνηκε
# στην τιμή, π.χ. αλλαγή περιγραφής) — αραιά, για να μένει ήπιο.
_DEEP_RESYNC = timedelta(days=30)
# Μετά από ΠΛΗΡΕΣ πέρασμα όλων των κατηγοριών, περίμενε τόσο πριν ξανα-σαρώσεις (συνεχής ήπιος συγχρονισμός).
_RESCAN_AFTER = timedelta(hours=6)

import httpx


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)

BASE = "https://b2b.profarmsa.gr"
LOGIN_URL = f"{BASE}/sign-in"
_UA = "Mozilla/5.0 (compatible; RxVision-PhotoSync/1.0)"


async def login(username: str, password: str) -> httpx.AsyncClient | None:
    """Σύνδεση· επιστρέφει authenticated AsyncClient (με cookies) ή None αν απέτυχε."""
    cl = httpx.AsyncClient(timeout=httpx.Timeout(12.0, connect=8.0), follow_redirects=True,
                           headers={"User-Agent": _UA})
    try:
        await cl.get(LOGIN_URL)   # πάρε τυχόν αρχικό cookie
        r = await cl.post(LOGIN_URL, data={
            "moduleid": "940", "action": "checkin",
            "username": username, "password": password, "login": "",
        })
        html = r.text or ""
        # Επιτυχία = δεν ξαναδείχνει τη φόρμα login (id login_form_940 / πεδίο username placeholder).
        if 'id="login_form_940"' in html or 'name="password"' in html and "checkin" in html:
            await cl.aclose()
            return None
        return cl
    except Exception:  # noqa: BLE001
        await cl.aclose()
        return None


async def test_login(username: str, password: str) -> bool:
    cl = await login(username, password)
    if cl:
        await cl.aclose()
        return True
    return False


_MODULES = 'a:1:{s:16:"Προϊόντα";a:1:{i:0;s:13:"ecommerceShow";}}'
_FIND_URL = (f"{BASE}/search-results/autosearch/1/product_id/nv/postdata/nv/"
             "tmpvars[873][action]/findQuery/tmpvars[873][onlyaction]/1")
_THUMB_RE = re.compile(r"thumbnails/\d+/\d+x\d+/img\d+\.(?:jpg|jpeg|png|webp)", re.I)


async def find_by_barcode(cl: httpx.AsyncClient, barcode: str) -> dict | None:
    """Αναζήτηση προϊόντος με barcode. Επιστρέφει {product_id, image_url} ή None αν καμία ταύτιση."""
    bc = re.sub(r"\s", "", str(barcode or ""))
    if len(bc) < 6:
        return None
    try:
        r = await cl.post(_FIND_URL, data={"modules": _MODULES, "query": bc})
    except Exception:  # noqa: BLE001
        return None
    html = r.text or ""
    if "ecm_product" not in html:
        return None
    pid = re.search(r"product_id/(\d+)", html)
    thumb = _THUMB_RE.search(html)
    if not thumb:
        return None
    # Το αρχικό thumb (autocomplete) υπάρχει σίγουρα· η fetch_image δοκιμάζει μεγαλύτερα μεγέθη με fallback.
    return {"product_id": pid.group(1) if pid else None, "image_url": f"{BASE}/{thumb.group(0)}"}


# Μεγέθη προς δοκιμή (μεγαλύτερο→μικρότερο)· δεν υπάρχουν όλα για κάθε προϊόν → fallback στο αρχικό.
_TRY_SIZES = ("1600x1600", "800x800", "600x600", "400x400")


async def fetch_image(cl: httpx.AsyncClient, url: str) -> tuple[bytes, str] | None:
    """Κατεβάζει την εικόνα δοκιμάζοντας μεγαλύτερα μεγέθη· fallback στο αρχικό URL (που σίγουρα υπάρχει)."""
    candidates = [re.sub(r"/\d+x\d+/", f"/{s}/", url) for s in _TRY_SIZES] + [url]
    seen = set()
    for u in candidates:
        if u in seen:
            continue
        seen.add(u)
        try:
            r = await cl.get(u)
        except Exception:  # noqa: BLE001
            continue
        ct = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
        if r.status_code == 200 and ct.startswith("image/") and len(r.content) >= 500:
            return r.content, ct
    return None


async def sync_batch(tenant_id: str, *, batch: int = 40, only_for_sale: bool = False) -> dict:
    """Μαζικό harvest: για είδη ΧΩΡΙΣ φωτο & με barcode, ψάξε στο Profarm και κατέβασε την επίσημη
    φωτογραφία όπου το barcode ΤΑΙΡΙΑΖΕΙ. Idempotent (marker `profarm_tried`), throttled. Επεξεργάζεται
    `batch` είδη ανά κλήση ώστε ο frontend να δείχνει πρόοδο (loop μέχρι remaining=0)."""
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    from app.repositories.supplier_settings import SupplierSettingsRepository
    sup = SupplierSettingsRepository(tenant_id=tenant_id)
    doc = await sup.find_one({"key": "profarm"}) or {}
    if doc.get("sync_stopped"):                 # οριστική διακοπή από τον χρήστη
        return {"ok": True, "stopped": True, "processed": 0, "matched": 0, "attached": 0}
    creds = await sup.profarm_creds()
    if not creds:
        return {"ok": False, "error": "not_configured"}
    cl = await login(creds["username"], creds["password"])
    if not cl:
        return {"ok": False, "error": "login_failed"}
    repo = PharmacyCatalogRepository(tenant_id=tenant_id)
    col = repo._db["pharmacy_products"]
    q: dict = {"tenant_id": tenant_id, "active": {"$ne": False},
               "profarm_tried": {"$ne": True},
               "$and": [{"$or": [{"image_id": {"$in": [None, ""]}}, {"image_id": {"$exists": False}}]},
                        {"barcode": {"$nin": [None, ""]}}]}
    if only_for_sale:
        q["for_sale"] = True
    matched = attached = processed = 0
    fails = 0
    throttled = False
    try:
        docs = await col.find(q, {"barcode": 1, "barcodes": 1}).limit(int(batch)).to_list(int(batch))
        for p in docs:
            if fails >= 4:                    # συνεχόμενες αποτυχίες = πιθανό throttling → σταμάτα ήπια
                throttled = True
                break
            hit = None
            try:
                for bc in [p.get("barcode")] + list(p.get("barcodes") or []):
                    if not bc:
                        continue
                    hit = await asyncio.wait_for(find_by_barcode(cl, bc), timeout=14)
                    if hit:
                        break
                    await asyncio.sleep(0.5)
                fails = 0
            except (TimeoutError, Exception):  # noqa: BLE001 — δίκτυο/timeout: ΜΗΝ μαρκάρεις (retry αργότερα)
                fails += 1
                await asyncio.sleep(2)
                continue
            processed += 1
            upd = {"profarm_tried": True, "profarm_tried_at": _now()}
            if hit and hit.get("image_url"):
                matched += 1
                try:
                    img = await asyncio.wait_for(fetch_image(cl, hit["image_url"]), timeout=20)
                except (TimeoutError, Exception):  # noqa: BLE001
                    img = None
                if img:
                    image_id = await repo.save_image(img[0], img[1])
                    if image_id:
                        upd["image_id"] = image_id
                        upd["photo_source"] = "profarm"
                        attached += 1
            await col.update_one({"_id": p["_id"]}, {"$set": upd})
            await asyncio.sleep(0.35)          # ήπιος ρυθμός (ένα-ένα) — χωρίς burst
    finally:
        await cl.aclose()
    remaining = await col.count_documents(q)
    return {"ok": True, "processed": processed, "matched": matched, "attached": attached,
            "remaining": remaining, "throttled": throttled}


async def sync_status(tenant_id: str) -> dict:
    """Πρόοδος: πόσα έχουν φωτο Profarm, πόσα δοκιμάστηκαν, πόσα μένουν (χωρίς φωτο & με barcode)."""
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    from app.repositories.supplier_settings import SupplierSettingsRepository
    col = PharmacyCatalogRepository(tenant_id=tenant_id)._db["pharmacy_products"]
    base = {"tenant_id": tenant_id, "active": {"$ne": False}}
    remaining = await col.count_documents({**base, "profarm_tried": {"$ne": True},
        "$and": [{"$or": [{"image_id": {"$in": [None, ""]}}, {"image_id": {"$exists": False}}]},
                 {"barcode": {"$nin": [None, ""]}}]})
    attached = await col.count_documents({**base, "photo_source": "profarm"})
    tried = await col.count_documents({**base, "profarm_tried": True})
    doc = await SupplierSettingsRepository(tenant_id=tenant_id).find_one({"key": "profarm"}) or {}
    return {"attached": attached, "tried": tried, "remaining": remaining,
            "stopped": bool(doc.get("sync_stopped"))}


async def set_sync_stopped(tenant_id: str, stopped: bool) -> dict:
    """Οριστική διακοπή (ή επανενεργοποίηση) της φωτο-σάρωσης — flag ανά φαρμακείο."""
    from app.repositories.supplier_settings import SupplierSettingsRepository
    await SupplierSettingsRepository(tenant_id=tenant_id).update_one(
        {"key": "profarm"}, {"$set": {"sync_stopped": bool(stopped)},
                             "$setOnInsert": {"key": "profarm"}}, upsert=True)
    return {"ok": True, "stopped": bool(stopped)}


# ── ΕΙΣΑΓΩΓΗ ΟΛΟΚΛΗΡΩΝ ΠΡΟΪΟΝΤΩΝ (OTC/παραφάρμακα) από κατηγορίες Profarm ─────────────────────
# ΜΗΣΥΦΑ(11)=otc_medicine· τα υπόλοιπα e-shop-relevant = parapharmacy. Εξαιρούνται Φάρμακα/Νοσοκομειακά.
IMPORT_CATS = {11: "otc_medicine", 5: "parapharmacy", 309: "parapharmacy", 3: "parapharmacy",
               4: "parapharmacy", 2: "parapharmacy", 8: "parapharmacy", 9: "parapharmacy",
               6: "parapharmacy"}
# Ειδικές Profarm κατηγορίες → απευθείας κατηγορία e-shop (καλές ως έχουν). ΜΗΣΥΦΑ(11)/Παραφάρμακα(5,309)
# = γενικές → None → AI-ταξινόμηση από όνομα (classify_new_products)· ό,τι δεν βρεθεί μένει κενό (χειροκίνητα).
_PROFARM_CATEGORY = {3: "Αντηλιακά", 4: "Γάλατα", 2: "Επιδεσμικό Υλικό",
                     6: "Μέσα Ατομικής Προστασίας", 8: "Ορθοπεδικά", 9: "Διαγνωστικά"}
_EUR_RE = re.compile(r"([0-9]+(?:[.,][0-9]{1,2})?)")


def _cents(s: str) -> int:
    m = _EUR_RE.search(str(s or ""))
    if not m:
        return 0
    return round(float(m.group(1).replace(".", "").replace(",", ".")) * 100)


def parse_product(html: str) -> dict:
    """Εξάγει από τη σελίδα προϊόντος: name, barcodes[], vat_rate%, retail_cents, wholesale_cents
    (αρχική/διαγεγραμμένη — από % «τιμολογιακής πολιτικής» αν υπάρχει), image_url, description."""
    def g(pat, grp=1, flags=re.S | re.I):
        m = re.search(pat, html, flags)
        return m.group(grp).strip() if m else ""
    name = re.sub(r"<[^>]+>", "", g(r"<h1[^>]*>(.*?)</h1>")).strip()
    bc_raw = g(r"Barcode:\s*<strong>([^<]+)</strong>")
    barcodes = [re.sub(r"\D", "", x) for x in bc_raw.split(",")]
    barcodes = [b for b in barcodes if len(b) >= 8]
    vat = g(r"Συντελεστής ΦΠΑ:\s*</span>\s*<span[^>]*>\s*(\d+)\s*%")
    retail = g(r"Προτεινόμενη Λιανική Τιμή:\s*</span>\s*<span[^>]*>([^<]+)</span>")
    price = g(r'id="price\d+">([^<]+)</span>')          # τρέχουσα (εκπτωτική) καθαρή χονδρική
    disc = g(r"Έκπτωση\s*([0-9]+(?:[.,][0-9]+)?)\s*%")   # «τιμολογιακή πολιτική» %
    wholesale = _cents(price)
    if disc:
        try:
            d = float(disc.replace(",", ".")) / 100
            if 0 < d < 0.9:
                wholesale = round(wholesale / (1 - d))    # → αρχική (διαγεγραμμένη) χονδρική
        except ValueError:
            pass
    thumb = _THUMB_RE.search(html)
    desc = re.sub(r"<[^>]+>", " ", g(r'ecm_prod_description[^>]*>(.*?)</div>')).strip()[:2000]
    return {"name": name, "barcodes": barcodes, "vat_rate": int(vat or 0),
            "retail_cents": _cents(retail), "wholesale_cents": wholesale,
            "image_url": f"{BASE}/{thumb.group(0)}" if thumb else None,
            "description": desc or None}


async def list_category_products(cl: httpx.AsyncClient, cat_id, page: int, rows: int = 100) -> list[str]:
    url = (f"{BASE}/farmaka-1/category_id/{cat_id}/rowsperpage784/{rows}/productspage784/{page}"
           "/tmpvars[784][no_deps]/1/mode/ajax/ajax/784")
    try:
        r = await asyncio.wait_for(cl.get(url), timeout=25)
    except Exception:  # noqa: BLE001
        return []
    # μοναδικά product_ids με σειρά εμφάνισης
    return list(dict.fromkeys(re.findall(r"product_id/(\d+)", r.text or "")))


def parse_category_listing(html: str) -> list[dict]:
    """Από τη σελίδα ΛΙΣΤΑΣ κατηγορίας (100 προϊόντα/request) βγάζει ΑΝΑ ΠΡΟΪΟΝ: {pid, price_cents, in_stock}.
    Δίνει ΦΘΗΝΟ σήμα αλλαγής (τιμή/διαθεσιμότητα) → ανοίγουμε το detail ΜΟΝΟ όσων άλλαξαν."""
    out: list[dict] = []
    seen: set[str] = set()
    for block in re.split(r'class="ecm_product"', html)[1:]:
        m = re.search(r"product_id/(\d+)", block)
        if not m or m.group(1) in seen:
            continue
        pid = m.group(1)
        seen.add(pid)
        seg = block[:1600]
        # ΧΟΝΔΡΙΚΗ = η ΚΑΝΟΝΙΚΗ/ΔΙΑΓΡΑΜΜΕΝΗ τιμή (ecm_prod_price ... <span>) — ΠΡΙΝ την «τιμολογιακή
        # πολιτική» (π.χ. 12,29 €). ΟΧΙ η εκπτωτική (ecm_prod_sale, π.χ. 11,92 €) που είναι η καθαρή αγορά.
        reg = re.search(r'ecm_prod_price[^>]*>\s*<span[^>]*>([^<]+)</span>', seg)
        pc = _cents(reg.group(1)) if reg else None
        out.append({"pid": pid, "price_cents": pc or None,
                    "in_stock": "stock_level_zero" not in seg})
    return out


async def list_category_items(cl: httpx.AsyncClient, cat_id, page: int, rows: int = 100) -> list[dict]:
    """Σαν το list_category_products αλλά με ΤΙΜΗ+ΔΙΑΘΕΣΙΜΟΤΗΤΑ ανά προϊόν (για φθηνό change-detection)."""
    url = (f"{BASE}/farmaka-1/category_id/{cat_id}/rowsperpage784/{rows}/productspage784/{page}"
           "/tmpvars[784][no_deps]/1/mode/ajax/ajax/784")
    try:
        r = await asyncio.wait_for(cl.get(url), timeout=25)
    except Exception:  # noqa: BLE001
        return []
    return parse_category_listing(r.text or "")


async def _upsert_profarm_product(cl, col, repo, tenant_id: str, pid: str, ptype: str,
                                  category_name: str | None = None,
                                  list_price_cents: int | None = None,
                                  in_stock: bool | None = None) -> tuple[str, bool, bool]:
    """Fetch detail → parse → create/enrich ΕΝΑ προϊόν. Returns (result, had_photo, reclassified).
    ΕΛΕΓΧΟΣ τύπου: ο τύπος παίρνεται από την ΕΠΙΣΗΜΗ κατηγορία Profarm (ΜΗΣΥΦΑ=OTC, παραφάρμακα=
    parapharmacy)· η εισαγωγή ΔΕΝ σαρώνει ποτέ «Φάρμακα» (συνταγογραφούμενα), άρα δεν αγγίζει rx.
    reclassified=True όταν διορθώνεται λάθος τύπος υπάρχοντος είδους. result: created|enriched|skip|error."""
    # RE-SYNC ΒΑΣΕΙ ΠΑΛΑΙΟΤΗΤΑΣ: αν το είδος με αυτό το pid συγχρονίστηκε ΠΡΟΣΦΑΤΑ (< _RESYNC_AFTER) & έχει
    # φωτο → SKIP χωρίς detail (γρήγορο re-crawl). Αν έχει «παλιώσει» → ξανακατεβάζουμε detail για να πιάσουμε
    # ΑΛΛΑΓΕΣ (χονδρική/λιανική-πρόταση/φωτο/περιγραφή). Έτσι το ίδιο process κάνει ΚΑΙ import ΚΑΙ update.
    pidd = await col.find_one({"tenant_id": tenant_id, "profarm_pid": pid},
                              {"profarm_synced_at": 1, "image_id": 1, "profarm_list_price": 1})
    if pidd:
        sc = pidd.get("profarm_synced_at")
        if sc and getattr(sc, "tzinfo", None) is None:
            sc = sc.replace(tzinfo=timezone.utc)
        # ΧΟΝΔΡΙΚΗ = struck price από τη ΛΙΣΤΑ (100/request). Αν έχει φωτο & δεν είναι ώρα για βαθύ έλεγχο →
        # ΔΕΝ ανοίγουμε detail: ενημερώνουμε ΦΘΗΝΑ διαθεσιμότητα + (αν άλλαξε) τη ΧΟΝΔΡΙΚΗ, απευθείας.
        stored_lp = pidd.get("profarm_list_price")   # τελευταία γνωστή χονδρική λίστας
        wh_changed = list_price_cents is not None and stored_lp != list_price_cents
        deep_due = (not sc) or (_now() - sc) >= _DEEP_RESYNC
        if pidd.get("image_id") and not deep_due:
            cheap: dict = {}
            if in_stock is not None:
                cheap["profarm_in_stock"] = bool(in_stock)
            if wh_changed:                      # η χονδρική άλλαξε → ενημέρωσε ΑΠΕΥΘΕΙΑΣ από τη λίστα
                cheap["wholesale_cents"] = list_price_cents
                cheap["profarm_list_price"] = list_price_cents
                cheap["profarm_synced_at"] = _now()
                cheap["updated_at"] = _now()
            if cheap:
                await col.update_one({"tenant_id": tenant_id, "profarm_pid": pid}, {"$set": cheap})
            return ("enriched" if wh_changed else "skip"), False, False
    try:
        b = (await asyncio.wait_for(cl.get(f"{BASE}/farmaka-1/product_id/{pid}"), timeout=18)).text
    except (TimeoutError, Exception):  # noqa: BLE001
        return "error", False, False
    d = parse_product(b)
    if not d.get("barcodes"):
        return "skip", False, False
    bc = d["barcodes"][0]
    existing = await col.find_one({"tenant_id": tenant_id, "barcode": bc},
                                  {"image_id": 1, "type": 1, "profarm_pid": 1,
                                   "wholesale_cents": 1, "description_long": 1, "vat_rate": 1})
    image_id = None
    # Κατέβασε εικόνα ΜΟΝΟ αν το υπάρχον δεν έχει ήδη (αλλιώς άσκοπο 18s fetch που πετιέται).
    if d.get("image_url") and not (existing and existing.get("image_id")):
        try:
            img = await asyncio.wait_for(fetch_image(cl, d["image_url"]), timeout=18)
        except (TimeoutError, Exception):  # noqa: BLE001
            img = None
        if img:
            image_id = await repo.save_image(img[0], img[1])
    reclassified = bool(existing) and existing.get("type") != ptype
    if existing:
        # Ο τύπος από την ΚΑΤΗΓΟΡΙΑ Profarm είναι authoritative — διορθώνει το λάθος default (rx) του ΗΔΥΚΑ.
        # first_link = πρώτη φορά που δένεται στο Profarm· στα ΕΠΟΜΕΝΑ re-sync ΔΕΝ πατάμε τη λιανική τιμή
        # (μπορεί ο φαρμακοποιός να την έχει ορίσει χειροκίνητα — OTC/παραφάρμακα = ελεύθερη τιμή).
        first_link = existing.get("profarm_pid") != pid
        s = {"type": ptype, "vat_rate": d["vat_rate"], "price_includes_vat": True, "profarm_pid": pid,
             "profarm_synced_at": _now(), "updated_at": _now()}
        if list_price_cents is not None:
            s["profarm_list_price"] = list_price_cents   # για φθηνό change-detection στο επόμενο πέρασμα
        if in_stock is not None:
            s["profarm_in_stock"] = bool(in_stock)
        changed = reclassified
        # ΧΟΝΔΡΙΚΗ: η struck τιμή της ΛΙΣΤΑΣ (12,29) είναι authoritative· fallback το detail αν λείπει.
        wh = list_price_cents if list_price_cents is not None else d["wholesale_cents"]
        if wh and wh != existing.get("wholesale_cents"):
            s["wholesale_cents"] = wh; changed = True
        if first_link and d["retail_cents"]:     # προτεινόμενη λιανική Profarm ΜΟΝΟ στο 1ο link
            s["price_cents"] = d["retail_cents"]; changed = True
        if image_id and not existing.get("image_id"):
            s["image_id"] = image_id; s["photo_source"] = "profarm"; changed = True
        if d.get("description") and d["description"] != existing.get("description_long"):
            s["description_long"] = d["description"]; changed = True
        if len(d.get("barcodes") or []) > 1:
            s["barcodes"] = d["barcodes"][1:]
        await col.update_one({"_id": existing["_id"]}, {"$set": s})
        # «enriched» όταν ΟΝΤΩΣ άλλαξε κάτι (νέα αλλαγή Profarm)· αλλιώς «skip» (μόνο ανανέωση synced_at).
        return ("enriched" if changed else "skip"), bool(image_id), reclassified
    doc = {"tenant_id": tenant_id, "barcode": bc, "barcodes": d["barcodes"][1:],
           "name": d["name"][:200] or bc, "type": ptype, "vat_rate": d["vat_rate"],
           "category": category_name or None,   # ειδική Profarm κατηγορία (αλλιώς None → AI/χειροκίνητα)
           "price_includes_vat": True, "price_cents": d["retail_cents"],
           # ΧΟΝΔΡΙΚΗ = struck τιμή λίστας (authoritative)· fallback το detail
           "wholesale_cents": list_price_cents if list_price_cents is not None else d["wholesale_cents"],
           "description_long": d.get("description"),
           "active": True, "for_sale": False, "stock_qty": 0,
           "image_id": image_id, "photo_source": "profarm" if image_id else None,
           "source": "profarm", "profarm_pid": pid, "profarm_synced_at": _now(),
           "profarm_list_price": list_price_cents, "profarm_in_stock": in_stock,
           "created_at": _now(), "updated_at": _now()}
    await col.insert_one(doc)
    return "created", bool(image_id), False


_MAX_PAGES = 600   # ασφάλεια ενάντια σε ατέρμονη σελιδοποίηση (wrap)


async def import_chunk(tenant_id: str, category_ids: list | None = None, *, chunk: int = 10) -> dict:
    """Importer OTC/παραφαρμάκων ΣΕΛΙΔΑ-ΣΕΛΙΔΑ: φόρτωσε ΜΙΑ σελίδα 100 product_ids, εισήγαγε λίγα-λίγα
    (chunk) με fetch detail→upsert(create/enrich)+φωτο, και όταν τελειώσει η σελίδα → επόμενη σελίδα.
    ΧΩΡΙΣ γιγάντια προ-καταγραφή. Idempotent (barcode), resumable, ήπιο."""
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    from app.repositories.supplier_settings import SupplierSettingsRepository
    sup = SupplierSettingsRepository(tenant_id=tenant_id)
    creds = await sup.profarm_creds()
    if not creds:
        return {"ok": False, "error": "not_configured"}
    job = await sup.find_one({"key": "profarm_import"}) or {}
    if job.get("status") != "importing":
        cats = [c for c in (category_ids or list(IMPORT_CATS)) if int(c) in IMPORT_CATS]
        job = {"key": "profarm_import", "status": "importing", "cats": cats, "cat_i": 0, "page": 0,
               "page_pids": [], "page_pos": 0, "created": 0, "enriched": 0, "photos": 0}
        await sup.update_one({"key": "profarm_import"}, {"$set": job}, upsert=True)
    cats = job["cats"]
    cat_i, page = job.get("cat_i", 0), job.get("page", 0)
    page_pids, page_pos = job.get("page_pids", []), job.get("page_pos", 0)
    page_prices = job.get("page_prices", {})   # {pid: τιμή λίστας cents} — φθηνό change-signal
    page_stock = job.get("page_stock", {})     # {pid: in_stock}
    # Cooldown ανάμεσα σε ΠΛΗΡΗ περάσματα — συνεχής ΗΠΙΟΣ συγχρονισμός χωρίς tight loop.
    npa = job.get("next_pass_after")
    if npa and getattr(npa, "tzinfo", None) is None:
        npa = npa.replace(tzinfo=timezone.utc)
    if npa and _now() < npa:
        return {"ok": True, "cooldown": True}
    if cat_i >= len(cats):
        # ΤΕΛΟΣ πλήρους περάσματος → ΞΑΝΑ από την αρχή (re-scan για ΑΛΛΑΓΕΣ/ΝΕΑ) μετά από cooldown.
        await sup.update_one({"key": "profarm_import"}, {"$set": {
            "status": "importing", "cat_i": 0, "page": 0, "page_pids": [], "page_pos": 0, "seen_pids": [],
            "last_pass_at": _now(), "next_pass_after": _now() + _RESCAN_AFTER}})
        return {"ok": True, "pass_done": True}
    cl = await login(creds["username"], creds["password"])
    if not cl:
        return {"ok": False, "error": "login_failed"}
    created = enriched = photos = 0
    try:
        # χρειάζεσαι ΝΕΑ σελίδα;
        seen = set(job.get("seen_pids") or [])   # pids που έχουμε ήδη δει σε ΑΥΤΗ την κατηγορία
        if page_pos >= len(page_pids):
            items = await list_category_items(cl, cats[cat_i], page)   # με τιμή+διαθεσιμότητα ανά προϊόν
            pids = [it["pid"] for it in items]
            new_pids = [p for p in pids if str(p) not in seen]
            # ΤΕΛΟΣ κατηγορίας όταν: κενή σελίδα, όριο ασφαλείας, Ή WRAP — η σελίδα δεν φέρνει ΚΑΝΕΝΑ
            # νέο pid (το Profarm επαναλαμβάνει σελίδες πέρα από το πραγματικό τέλος → μη ξαναδουλεύεις
            # τα ίδια προϊόντα ~40 φορές· αυτό ήταν το bug «κόλλημα σε κατηγορία 1/9, σελίδα 484»).
            if not pids or page >= _MAX_PAGES or (pids and not new_pids):
                if (cat_i + 1) >= len(cats):
                    # τέλος πλήρους περάσματος → loop-back με cooldown (συνεχής συγχρονισμός)
                    await sup.update_one({"key": "profarm_import"}, {"$set": {
                        "status": "importing", "cat_i": 0, "page": 0, "page_pids": [], "page_pos": 0,
                        "seen_pids": [], "last_pass_at": _now(), "next_pass_after": _now() + _RESCAN_AFTER}})
                    return {"ok": True, "pass_done": True}
                await sup.update_one({"key": "profarm_import"}, {"$set": {
                    "cat_i": cat_i + 1, "page": 0, "page_pids": [], "page_pos": 0,
                    "seen_pids": []}})   # reset του «seen» για τη νέα κατηγορία
                return {"ok": True, "phase": "next-category", "cat_i": cat_i + 1}
            if len(seen) < 60000:                 # cap: μη φουσκώνει το job doc (distinct/κατηγορία = μικρό)
                seen.update(str(p) for p in pids)
            page_pids, page_pos, page = new_pids, 0, page + 1   # μόνο τα ΝΕΑ pids αυτής της σελίδας
            # χάρτες τιμής/διαθεσιμότητας για ΑΥΤΗ τη σελίδα (φθηνό change-signal στο upsert)
            page_prices = {it["pid"]: it["price_cents"] for it in items if it["pid"] in set(new_pids)}
            page_stock = {it["pid"]: it["in_stock"] for it in items if it["pid"] in set(new_pids)}
        # εισήγαγε chunk από την ΤΡΕΧΟΥΣΑ σελίδα
        repo = PharmacyCatalogRepository(tenant_id=tenant_id)
        col = repo._db["pharmacy_products"]
        ptype = IMPORT_CATS.get(int(cats[cat_i]), "parapharmacy")
        cat_name = _PROFARM_CATEGORY.get(int(cats[cat_i]))   # ειδική κατηγορία (ή None για γενικά)
        end = min(page_pos + chunk, len(page_pids))
        reclassified = 0
        for k in range(page_pos, end):
            _pid = page_pids[k]
            res, ph, rc = await _upsert_profarm_product(
                cl, col, repo, tenant_id, _pid, ptype, cat_name,
                list_price_cents=page_prices.get(_pid), in_stock=page_stock.get(_pid))
            if res == "error":
                break                    # πιθανό throttling → σταμάτα, retry ίδιο pos επόμενο tick
            page_pos = k + 1
            if res == "created":
                created += 1
            elif res == "enriched":
                enriched += 1
            if ph:
                photos += 1
            if rc:
                reclassified += 1
            if res != "skip":          # skip = ΚΑΝΕΝΑ external request → μη σπαταλάς throttle-sleep
                await asyncio.sleep(0.35)
        await sup.update_one({"key": "profarm_import"}, {"$set": {
            "page": page, "page_pids": page_pids, "page_pos": page_pos, "seen_pids": list(seen),
            "page_prices": page_prices, "page_stock": page_stock,
            "created": job.get("created", 0) + created, "enriched": job.get("enriched", 0) + enriched,
            "photos": job.get("photos", 0) + photos,
            "reclassified": job.get("reclassified", 0) + reclassified, "updated_at": _now()}})
        return {"ok": True, "phase": "importing", "created": created, "enriched": enriched,
                "photos": photos, "cat_i": cat_i, "page": page, "page_pos": page_pos}
    finally:
        await cl.aclose()


async def import_status(tenant_id: str) -> dict:
    from app.repositories.supplier_settings import SupplierSettingsRepository
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    j = await SupplierSettingsRepository(tenant_id=tenant_id).find_one({"key": "profarm_import"}) or {}
    cats = j.get("cats", [])
    # ΠΡΑΓΜΑΤΙΚΑ distinct νούμερα από τη βάση — ΟΧΙ οι cumulative μετρητές λειτουργιών (created/enriched),
    # που φουσκώνουν όταν το Profarm επαναλαμβάνει σελίδες (το ίδιο είδος upsert-άρεται πολλές φορές).
    col = PharmacyCatalogRepository(tenant_id=tenant_id)._db["pharmacy_products"]
    q = {"tenant_id": tenant_id}
    new_items = await col.count_documents({**q, "source": "profarm"})
    touched = await col.count_documents({**q, "profarm_pid": {"$exists": True}})
    photos = await col.count_documents({**q, "photo_source": "profarm"})
    return {"status": j.get("status") or "idle",
            # distinct είδη (η αλήθεια): νέα, ενημερωμένα (υπάρχοντα), με φωτο Profarm
            "created": new_items, "enriched": max(0, touched - new_items),
            "photos": photos, "imported": touched,
            "reclassified": j.get("reclassified", 0),
            "cat_i": j.get("cat_i", 0), "cats_total": len(cats), "page": j.get("page", 0),
            "pct": round(100 * j.get("cat_i", 0) / len(cats)) if cats else 0,
            # πληροφοριακά: πόσες φορές τρέξαμε upsert συνολικά (με re-processing) — όχι distinct
            "ops_processed": int(j.get("created", 0)) + int(j.get("enriched", 0))}


async def import_reset(tenant_id: str) -> dict:
    from app.repositories.supplier_settings import SupplierSettingsRepository
    await SupplierSettingsRepository(tenant_id=tenant_id).delete_many({"key": "profarm_import"})
    return {"ok": True}


async def classify_new_products(tenant_id: str, *, limit: int = 300) -> dict:
    """AI-ταξινόμηση (haiku) εισαγμένων Profarm προϊόντων ΧΩΡΙΣ κατηγορία, από το όνομα, στο υπάρχον
    λεξιλόγιο κατηγοριών μας (ή νέα σύντομη). Ό,τι δεν ταξινομηθεί μένει κενό (χειροκίνητα)."""
    import json as _json
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    from app.services import pharmacat_service
    c = await pharmacat_service._config()
    if not c.get("api_key"):
        return {"ok": False, "error": "ai_not_configured"}
    col = PharmacyCatalogRepository(tenant_id=tenant_id)._db["pharmacy_products"]
    vocab = [x for x in await col.distinct("category", {"tenant_id": tenant_id,
             "category": {"$nin": [None, ""]}}) if x][:70]
    rows = await col.find({"tenant_id": tenant_id, "source": "profarm", "name": {"$nin": [None, ""]},
                           "$or": [{"category": {"$in": [None, ""]}}, {"category": {"$exists": False}}]},
                          {"barcode": 1, "name": 1}).limit(int(limit)).to_list(int(limit))
    if not rows:
        return {"ok": True, "classified": 0, "remaining": 0}
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=c["api_key"])
    prompt = ("Είσαι φαρμακοποιός. Ταξινόμησε ΚΑΘΕ προϊόν στη σωστή κατηγορία e-shop φαρμακείου. "
              "Χρησιμοποίησε ΚΑΤΑ ΠΡΟΤΙΜΗΣΗ μία υπάρχουσα κατηγορία: " + _json.dumps(vocab, ensure_ascii=False)
              + ". Αν καμία δεν ταιριάζει, βάλε σύντομη νέα ελληνική (π.χ. «Βιταμίνες & Συμπληρώματα», "
              "«Περιποίηση προσώπου», «Στοματική υγιεινή», «Βρεφικά»). Επίστρεψε ΜΟΝΟ JSON "
              "{\"barcode\":\"κατηγορία\"} για: ")
    classified = 0
    for start in range(0, len(rows), 40):
        batch = [{"barcode": r["barcode"], "name": r["name"]} for r in rows[start:start + 40]]
        try:
            resp = await client.messages.create(
                model="claude-haiku-4-5", max_tokens=4000,
                messages=[{"role": "user", "content": prompt + _json.dumps(batch, ensure_ascii=False)}])
            from app.services import ai_cost
            await ai_cost.record("__profarm_classify__", "claude-haiku-4-5", getattr(resp, "usage", None))
            text = "".join(b.text for b in resp.content if b.type == "text")
            m = re.search(r"\{.*\}", text, re.S)
            mp = _json.loads(m.group(0)) if m else {}
            for bc, cat in mp.items():
                cat = str(cat or "").strip()[:80]
                if cat:
                    await col.update_one({"tenant_id": tenant_id, "barcode": str(bc)},
                                         {"$set": {"category": cat, "updated_at": _now()}})
                    classified += 1
        except Exception:  # noqa: BLE001
            continue
    remaining = await col.count_documents({"tenant_id": tenant_id, "source": "profarm",
        "$or": [{"category": {"$in": [None, ""]}}, {"category": {"$exists": False}}]})
    return {"ok": True, "classified": classified, "remaining": remaining}
