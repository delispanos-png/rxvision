"""Ενσωμάτωση προμηθευτή Profarm (b2b.profarmsa.gr) — αντιστοίχιση barcode → φωτογραφία προϊόντος.

Ο φαρμακοποιός έχει ΔΙΚΟ ΤΟΥ λογαριασμό στο B2B του προμηθευτή (εξουσιοδοτημένη πρόσβαση). Κάνουμε
login με session-cookie (POST /sign-in: username, password, moduleid=940, action=checkin), ψάχνουμε το
προϊόν με το barcode και κατεβάζουμε την επίσημη φωτογραφία — έτσι η αντιστοίχιση είναι ΣΩΣΤΗ (ακριβές EAN).

Τα search/image endpoints του portal ανακαλύπτονται με `probe()` σε authenticated session (LogicOne CMS).
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone

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


async def probe(username: str, password: str, *, barcode: str | None = None,
                path: str | None = None) -> dict:
    """Διαγνωστικό: authenticated fetch για ανακάλυψη δομής (search-by-barcode + image URL).
    Επιστρέφει μικρά αποσπάσματα HTML (search forms, img tags) — για ανάλυση, όχι bulk."""
    cl = await login(username, password)
    if not cl:
        return {"ok": False, "error": "login_failed"}
    try:
        target = f"{BASE}{path}" if path else f"{BASE}/b2b-daily"
        r = await cl.get(target)
        html = r.text or ""
        forms = re.findall(r"<form[^>]*>", html)[:8]
        imgs = re.findall(r"<img[^>]*src=\"[^\"]*\"[^>]*>", html)
        imgs = [i for i in imgs if not re.search(r"logo|icon|site/|minus|plus", i)][:15]
        inputs = re.findall(r"<input[^>]*(?:name|id)=\"[^\"]*\"[^>]*>", html)[:25]
        found = bool(barcode and barcode in html)
        return {"ok": True, "status": r.status_code, "url": str(r.url),
                "forms": forms, "imgs": imgs, "inputs": inputs,
                "barcode_in_page": found, "len": len(html)}
    finally:
        await cl.aclose()


async def sync_batch(tenant_id: str, *, batch: int = 40, only_for_sale: bool = False) -> dict:
    """Μαζικό harvest: για είδη ΧΩΡΙΣ φωτο & με barcode, ψάξε στο Profarm και κατέβασε την επίσημη
    φωτογραφία όπου το barcode ΤΑΙΡΙΑΖΕΙ. Idempotent (marker `profarm_tried`), throttled. Επεξεργάζεται
    `batch` είδη ανά κλήση ώστε ο frontend να δείχνει πρόοδο (loop μέχρι remaining=0)."""
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    from app.repositories.supplier_settings import SupplierSettingsRepository
    creds = await SupplierSettingsRepository(tenant_id=tenant_id).profarm_creds()
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
    col = PharmacyCatalogRepository(tenant_id=tenant_id)._db["pharmacy_products"]
    base = {"tenant_id": tenant_id, "active": {"$ne": False}}
    remaining = await col.count_documents({**base, "profarm_tried": {"$ne": True},
        "$and": [{"$or": [{"image_id": {"$in": [None, ""]}}, {"image_id": {"$exists": False}}]},
                 {"barcode": {"$nin": [None, ""]}}]})
    attached = await col.count_documents({**base, "photo_source": "profarm"})
    tried = await col.count_documents({**base, "profarm_tried": True})
    return {"attached": attached, "tried": tried, "remaining": remaining}


# ── ΕΙΣΑΓΩΓΗ ΟΛΟΚΛΗΡΩΝ ΠΡΟΪΟΝΤΩΝ (OTC/παραφάρμακα) από κατηγορίες Profarm ─────────────────────
# ΜΗΣΥΦΑ(11)=otc_medicine· τα υπόλοιπα e-shop-relevant = parapharmacy. Εξαιρούνται Φάρμακα/Νοσοκομειακά.
IMPORT_CATS = {11: "otc_medicine", 5: "parapharmacy", 309: "parapharmacy", 3: "parapharmacy",
               4: "parapharmacy", 2: "parapharmacy", 8: "parapharmacy", 9: "parapharmacy",
               6: "parapharmacy"}
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


async def import_chunk(tenant_id: str, category_ids: list | None = None, *, chunk: int = 12) -> dict:
    """Stateful importer OTC/παραφαρμάκων: (1) enumerate product_ids των κατηγοριών (μία σελίδα/tick),
    (2) import chunk προϊόντων (fetch detail→parse→upsert create/enrich + φωτο). Ήπιο, resumable."""
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    from app.repositories.supplier_settings import SupplierSettingsRepository
    sup = SupplierSettingsRepository(tenant_id=tenant_id)
    creds = await sup.profarm_creds()
    if not creds:
        return {"ok": False, "error": "not_configured"}
    job = await sup.find_one({"key": "profarm_import"}) or {}
    status = job.get("status")
    if status not in ("enumerating", "importing"):
        cats = [c for c in (category_ids or list(IMPORT_CATS)) if int(c) in IMPORT_CATS]
        job = {"key": "profarm_import", "status": "enumerating", "cats": cats, "enum_i": 0,
               "enum_page": 0, "queue": [], "pos": 0, "created": 0, "enriched": 0, "photos": 0}
        await sup.update_one({"key": "profarm_import"}, {"$set": job}, upsert=True)
    cl = await login(creds["username"], creds["password"])
    if not cl:
        return {"ok": False, "error": "login_failed"}
    try:
        # ── Φάση 1: ENUMERATE (μία σελίδα κατηγορίας ανά tick) ──
        if job["status"] == "enumerating":
            cats = job["cats"]
            i, page = job.get("enum_i", 0), job.get("enum_page", 0)
            if i >= len(cats):
                await sup.update_one({"key": "profarm_import"}, {"$set": {"status": "importing"}})
                return {"ok": True, "phase": "enumerated", "total": len(job.get("queue", []))}
            cid = cats[i]
            pids = await list_category_products(cl, cid, page)
            q = job.get("queue", [])
            have = {x[0] for x in q}
            ptype = IMPORT_CATS.get(int(cid), "parapharmacy")
            for pid in pids:
                if pid not in have:
                    q.append([pid, ptype])
            nxt = {"queue": q}
            if len(pids) < 100:          # τέλος κατηγορίας → επόμενη
                nxt["enum_i"] = i + 1
                nxt["enum_page"] = 0
            else:
                nxt["enum_page"] = page + 1
            await sup.update_one({"key": "profarm_import"}, {"$set": nxt})
            return {"ok": True, "phase": "enumerating", "cat": cid, "collected": len(q)}
        # ── Φάση 2: IMPORT (chunk προϊόντων) ──
        repo = PharmacyCatalogRepository(tenant_id=tenant_id)
        col = repo._db["pharmacy_products"]
        queue = job.get("queue", [])
        pos = job.get("pos", 0)
        created = enriched = photos = 0
        end = min(pos + chunk, len(queue))
        for idx in range(pos, end):
            pid, ptype = queue[idx]
            try:
                b = (await asyncio.wait_for(cl.get(f"{BASE}/farmaka-1/product_id/{pid}"), timeout=18)).text
            except (TimeoutError, Exception):  # noqa: BLE001
                break            # πιθανό throttling → σταμάτα, retry επόμενο tick (χωρίς advance)
            d = parse_product(b)
            if not d.get("barcodes"):
                continue
            bc = d["barcodes"][0]
            image_id = None
            if d.get("image_url"):
                try:
                    img = await asyncio.wait_for(fetch_image(cl, d["image_url"]), timeout=18)
                except (TimeoutError, Exception):  # noqa: BLE001
                    img = None
                if img:
                    image_id = await repo.save_image(img[0], img[1])
            existing = await col.find_one({"tenant_id": tenant_id, "barcode": bc}, {"image_id": 1})
            if existing:
                s = {"vat_rate": d["vat_rate"], "price_includes_vat": True, "profarm_pid": pid,
                     "profarm_synced_at": _now(), "updated_at": _now()}
                if d["wholesale_cents"]:
                    s["wholesale_cents"] = d["wholesale_cents"]
                if image_id and not existing.get("image_id"):
                    s["image_id"] = image_id
                    s["photo_source"] = "profarm"
                if d.get("description"):
                    s["description_long"] = d["description"]
                if d.get("barcodes"):
                    s["barcodes"] = d["barcodes"][1:]
                await col.update_one({"_id": existing["_id"]}, {"$set": s})
                enriched += 1
            else:
                doc = {"tenant_id": tenant_id, "barcode": bc, "barcodes": d["barcodes"][1:],
                       "name": d["name"][:200] or bc, "type": ptype, "vat_rate": d["vat_rate"],
                       "price_includes_vat": True, "price_cents": d["retail_cents"],
                       "wholesale_cents": d["wholesale_cents"], "description_long": d.get("description"),
                       "active": True, "for_sale": False, "stock_qty": 0,
                       "image_id": image_id, "photo_source": "profarm" if image_id else None,
                       "source": "profarm", "profarm_pid": pid,
                       "created_at": _now(), "updated_at": _now()}
                await col.insert_one(doc)
                created += 1
            if image_id:
                photos += 1
            await asyncio.sleep(0.35)
        newpos = end
        upd = {"pos": newpos, "created": job.get("created", 0) + created,
               "enriched": job.get("enriched", 0) + enriched, "photos": job.get("photos", 0) + photos,
               "updated_at": _now()}
        if newpos >= len(queue):
            upd["status"] = "done"
        await sup.update_one({"key": "profarm_import"}, {"$set": upd})
        return {"ok": True, "phase": "importing", "created": created, "enriched": enriched,
                "photos": photos, "pos": newpos, "total": len(queue),
                "done": newpos >= len(queue)}
    finally:
        await cl.aclose()


async def import_status(tenant_id: str) -> dict:
    from app.repositories.supplier_settings import SupplierSettingsRepository
    j = await SupplierSettingsRepository(tenant_id=tenant_id).find_one({"key": "profarm_import"}) or {}
    return {"status": j.get("status") or "idle", "total": len(j.get("queue", [])), "pos": j.get("pos", 0),
            "created": j.get("created", 0), "enriched": j.get("enriched", 0), "photos": j.get("photos", 0),
            "cats": j.get("cats", [])}


async def import_reset(tenant_id: str) -> dict:
    from app.repositories.supplier_settings import SupplierSettingsRepository
    await SupplierSettingsRepository(tenant_id=tenant_id).delete_many({"key": "profarm_import"})
    return {"ok": True}
