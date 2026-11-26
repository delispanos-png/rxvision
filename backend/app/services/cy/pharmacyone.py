"""RxVision Κύπρος ↔ PharmacyOne CY (εξωτερικό API, μόνο ανάγνωση).

ΔΥΟ ΡΟΕΣ:
1. **Εκτελέσεις ΓεΣΥ** ανά φαρμακείο (`/executions`) → ο ΙΔΙΟΣ importer με το ανέβασμα XML
   (`importer.import_files`): ίδιος έλεγχος φαρμακείου, ίδια ψευδωνυμοποίηση, ίδια αποφυγή διπλών.
   Μόνο `Sent`/`Resent` — μια `Failed` εκτέλεση δεν έγινε δεκτή από το ΓεΣΥ.
2. **Κεντρικός κατάλογος ειδών** (`/items`, κοινός για όλα τα φαρμακεία) → `cy_catalog_items`
   (καθολική συλλογή: δημόσια πληροφορία ραφιού, ΚΑΝΕΝΑ δεδομένο πελάτη). Από εκεί ο κατάλογος
   περνά στα φαρμακεία με το πρόσθετο `catalog_seed` (ίδιος μηχανισμός με την Ελλάδα: catalog_sync).

ΤΟ CLIENT ID ΕΙΝΑΙ ΜΥΣΤΙΚΟ (ταυτοποιεί το φαρμακείο): ζει ΜΟΝΟ στο Vault
(`tenants/<id>/pharmacyone`), το γράφει ο διαχειριστής από το adminpanel, δεν επιστρέφεται ποτέ,
δεν γράφεται σε log. Κανόνες API (τεκμηρίωση PharmacyOne): σελιδοποίηση με cursor, μία σελίδα τη
φορά (ποτέ παράλληλα)· επανάληψη ΜΟΝΟ σε 5xx/δίκτυο· 400/401/404 → καμία επανάληψη.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator
from zoneinfo import ZoneInfo

import httpx

from app.core.db import shared_db

log = logging.getLogger(__name__)

BASE_URL = "https://pharmacyonecy.cloudon.gr/external/v1"
VAULT_SOURCE = "pharmacyone"
ITEMS_COLL = "cy_catalog_items"
EXEC_PAGE = 100
ITEMS_PAGE = 500
RECENT_DAYS = 7          # οι εκτελέσεις αλλάζουν (Failed → Resent): ξαναδιαβάζουμε το πρόσφατο παράθυρο
ATHENS = ZoneInfo("Europe/Athens")   # οι ώρες του API είναι ώρα Αθήνας
_ID_RX = re.compile(r"^[0-9a-f]{24}$")


class PharmacyOneError(Exception):
    """Σφάλμα που ΔΕΝ ξαναδοκιμάζεται (400/401/404 ή ρύθμιση). `code` για την οθόνη."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


# ── μυστικό ───────────────────────────────────────────────────────────────────────────────────
def valid_client_id(v: str) -> bool:
    return bool(_ID_RX.match((v or "").strip().lower()))


def client_id(tenant_id: str) -> str | None:
    from app.services.vault_service import vault
    return (vault.get_secret(f"tenants/{tenant_id}/{VAULT_SOURCE}") or {}).get("client_id")


def set_client_id(tenant_id: str, value: str | None) -> None:
    from app.services.vault_service import vault
    if value:
        vault.set_tenant_credentials(tenant_id, VAULT_SOURCE, {"client_id": value.strip().lower()})
    else:
        vault.delete_secret(f"tenants/{tenant_id}/{VAULT_SOURCE}")


def hint(cid: str | None) -> str | None:
    """Μόνο τα 4 τελευταία — αρκεί για να αναγνωρίσει ο διαχειριστής ποιο έβαλε."""
    return f"••••{cid[-4:]}" if cid else None


# ── HTTP ─────────────────────────────────────────────────────────────────────────────────────
async def _get(cid: str | None, path: str, params: dict | None = None, *, client: httpx.AsyncClient | None = None,
               attempts: int = 4) -> dict:
    """Αυθεντικοποίηση PharmacyOne (18/11/2026): `X-API-Key` = το κλειδί ΤΗΣ ΕΦΑΡΜΟΓΗΣ μας (ένα, για όλα)·
    `X-Client-Id` = το φαρμακείο, ΜΟΝΟ για /executions (ο κατάλογος /items είναι κοινός)."""
    headers: dict[str, str] = {}
    if key := await api_key():
        headers["X-API-Key"] = key
    if cid:
        headers["X-Client-Id"] = cid
    own = client is None
    client = client or httpx.AsyncClient(timeout=60)
    try:
        for i in range(attempts):
            try:
                r = await client.get(f"{BASE_URL}{path}", params=params or {}, headers=headers)
            except httpx.HTTPError as exc:
                if i == attempts - 1:
                    raise PharmacyOneError("network", type(exc).__name__) from exc
                await asyncio.sleep(2 ** i)
                continue
            # Καμία επανάληψη σε αυτά (οδηγία PharmacyOne): λείπει/λάθος κλειδί · κακό/άγνωστο Client Id
            if r.status_code == 401:
                raise PharmacyOneError("unauthorized", "Λείπει ή είναι λάθος το κλειδί εφαρμογής")
            if r.status_code == 400:
                raise PharmacyOneError("bad_client_id", r.text[:200])
            if r.status_code == 404:
                raise PharmacyOneError("unknown_client_id", r.text[:200])
            if r.status_code >= 500:
                if i == attempts - 1:
                    raise PharmacyOneError("server", f"HTTP {r.status_code}")
                await asyncio.sleep(2 ** i)
                continue
            r.raise_for_status()
            return r.json()
    finally:
        if own:
            await client.aclose()
    raise PharmacyOneError("server", "no response")


async def _pages(cid: str, path: str, params: dict, key: str, *,
                 client: httpx.AsyncClient | None = None) -> AsyncIterator[tuple[list[dict], dict]]:
    """Σελίδα-σελίδα με cursor (σειριακά). Δίνει (εγγραφές, απάντηση)."""
    cursor = None
    while True:
        page = await _get(cid, path, {**params, **({"cursor": cursor} if cursor else {})}, client=client)
        yield page.get(key) or [], page
        cursor = page.get("next_cursor")
        if not page.get("has_more") or not cursor:
            return


# ── 1. Εκτελέσεις ΓεΣΥ ────────────────────────────────────────────────────────────────────────
async def test_connection(tenant_id: str) -> dict:
    cid = client_id(tenant_id)
    if not cid:
        raise PharmacyOneError("not_configured")
    page = await _get(cid, "/executions", {"limit": 1})
    c = page.get("client") or {}
    return {"ok": True, "pharmacy": {k: c.get(k) for k in ("name", "company", "branch")},
            "executions_total": page.get("total")}


def _state_key() -> str:
    return "cy_pharmacyone"


async def state(tenant_id: str) -> dict:
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {_state_key(): 1}) or {}
    return t.get(_state_key()) or {}


async def _set_state(tenant_id: str, patch: dict) -> None:
    await shared_db()["tenants"].update_one(
        {"_id": tenant_id}, {"$set": {f"{_state_key()}.{k}": v for k, v in patch.items()}})


async def set_enabled(tenant_id: str, enabled: bool) -> None:
    await _set_state(tenant_id, {"enabled": bool(enabled)})


async def sync_executions(tenant_id: str, *, full: bool = False,
                          client: httpx.AsyncClient | None = None) -> dict:
    """Φέρνει τις εκτελέσεις του φαρμακείου και τις περνά από τον importer.
    Πρώτη φορά (ή `full`): όλο το ιστορικό (order=asc). Μετά: από την τελευταία επιτυχία − 7 ημέρες
    (μια Failed μπορεί να γίνει Resent· ο importer αγνοεί όσα δεν άλλαξαν)."""
    from app.services.cy.importer import import_files
    cid = client_id(tenant_id)
    if not cid:
        raise PharmacyOneError("not_configured")
    st = await state(tenant_id)
    started = _now()
    params: dict[str, Any] = {"limit": EXEC_PAGE, "order": "asc", "status": "Sent,Resent", "include_xml": "true"}
    last = st.get("last_ok_at")
    if last and not full:
        since = (last if isinstance(last, datetime) else datetime.fromisoformat(str(last))) - timedelta(days=RECENT_DAYS)
        params["date_from"] = since.strftime("%Y-%m-%d")
    tot = {"fetched": 0, "imported": 0, "updated": 0, "duplicates": 0, "failed": 0, "no_xml": 0}
    errors: list[dict] = []
    await _set_state(tenant_id, {"running_since": started})
    try:
        async for rows, _page in _pages(cid, "/executions", params, "executions", client=client):
            files = []
            for e in rows:
                tot["fetched"] += 1
                x = e.get("xml")
                if not x:
                    tot["no_xml"] += 1
                    continue
                files.append((e.get("filename") or f"{e.get('prescription_id')}_{e.get('dispensing_id')}.xml",
                              x.encode("utf-8") if isinstance(x, str) else x))
            if files:
                r = await import_files(tenant_id, files)
                for k in ("imported", "updated", "duplicates", "failed"):
                    tot[k] += r.get(k, 0)
                errors += r.get("errors") or []
        res = {"ok": True, **tot, "errors": errors[:10], "full": bool(full or not last)}
        await _set_state(tenant_id, {"last_ok_at": started, "last_run_at": started, "last_result": res,
                                     "running_since": None})
        return res
    except PharmacyOneError as exc:
        res = {"ok": False, "error": exc.code, **tot}
        await _set_state(tenant_id, {"last_run_at": started, "last_result": res, "running_since": None})
        raise


async def due_tenants() -> list[str]:
    """Κυπριακά φαρμακεία με ενεργή λήψη από την PharmacyOne."""
    return [t["_id"] async for t in shared_db()["tenants"].find(
        {"country": "CY", f"{_state_key()}.enabled": True}, {"_id": 1})]


# ── 2. Κεντρικός κατάλογος ειδών ─────────────────────────────────────────────────────────────
def _num(v: Any) -> float | None:
    try:
        return float(str(v).replace(",", ".")) if v not in (None, "") else None
    except ValueError:
        return None


def _cents(v: Any) -> int | None:
    n = _num(v)
    return round(n * 100) if n is not None else None


def product_type(it: dict) -> str:
    """Η PharmacyOne χωρίζει ρητά: `supergroup` = MEDICINE / NON-MEDICINE (δείγμα 18/11/2026: 644/356 ανά
    1.000). Τα φάρμακα μπαίνουν ως Rx, ώστε να μην πάρουν ποτέ έκπτωση κατά λάθος (ο φαρμακοποιός αλλάζει
    τον τύπο όπου χρειάζεται)."""
    sg = str(it.get("supergroup") or "").upper()
    if sg == "MEDICINE":
        return "rx_medicine"
    if sg == "NON-MEDICINE":
        return "parapharmacy"
    return "rx_medicine" if (it.get("drug_code") or it.get("gesy") or it.get("moh")) else "parapharmacy"


def atc_of(it: dict) -> str | None:
    """ATC από το ΓεΣΥ (π.χ. «J01EA01-1» → «J01EA01»). Τροφοδοτεί Διατροφή & θεραπευτικά segments."""
    raw = str((it.get("gesy") or {}).get("ATC") or "").strip().upper()
    code = raw.split("-")[0]
    return code if re.fullmatch(r"[A-Z]\d{2}[A-Z0-9]{0,4}", code) else None


#: Οι χονδρέμποροι της Κύπρου όπως εμφανίζονται στην PharmacyOne (κλειδί υπο-αντικειμένου → όνομα).
SUPPLIERS = {"mefal": "Mefal", "blue": "Blue", "kedifap": "Kedifap", "koudounas": "Koudounas",
             "marathon": "Marathon", "pharma_express": "Pharma Express", "pharma_link": "Pharma Link",
             "pharmacy_line": "Pharmacy Line", "hadjigrigoriou": "Hadjigrigoriou", "iama": "IAMA",
             "biosearch": "Biosearch"}


# ── «Οι φαρμακαποθήκες μου» (26/11/2026) ──────────────────────────────────────────────────────────
# Η σύγκριση τιμών δείχνει ΜΟΝΟ τις φαρμακαποθήκες με τις οποίες συνεργάζεται το φαρμακείο (απόφαση
# ιδιοκτήτη: «μην το δείξουμε στη ΜΕΦΑΛ και δείχνει ότι η ΚΕΔΙΦΑΠ είναι φθηνότερη»). Η λίστα ΔΕΝ βγαίνει
# αυτόματα: το `supplier` του καταλόγου είναι η πηγή της PharmacyOne, όχι από πού αγοράζει το φαρμακείο.
# Μη ρυθμισμένο → ΚΑΜΙΑ φαρμακαποθήκη (η οθόνη ζητά να επιλεγούν), ποτέ «όλες».
async def my_suppliers(tenant_id: str) -> list[str] | None:
    """Τα ΟΝΟΜΑΤΑ των φαρμακαποθηκών του φαρμακείου, ή None αν δεν έχουν οριστεί."""
    from app.core.db import shared_db
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"settings.cy_suppliers": 1})  # tenant-ok: own tenant
    keys = ((t or {}).get("settings") or {}).get("cy_suppliers")
    if keys is None:
        return None
    return [SUPPLIERS[k] for k in keys if k in SUPPLIERS]


async def set_my_suppliers(tenant_id: str, keys: list[str]) -> list[str]:
    from app.core.db import shared_db
    clean = [k for k in dict.fromkeys(keys or []) if k in SUPPLIERS]
    await shared_db()["tenants"].update_one(  # tenant-ok: own tenant
        {"_id": tenant_id}, {"$set": {"settings.cy_suppliers": clean}})
    return clean


def only_mine(suppliers: list[dict] | None, mine: list[str] | None) -> list[dict]:
    """Ο ΕΝΑΣ κανόνας: από τους προμηθευτές ενός είδους κρατά μόνο τους δικούς μου (κανέναν αν δεν έχουν οριστεί)."""
    if not mine:
        return []
    allowed = set(mine)
    return [x for x in suppliers or [] if x.get("name") in allowed]


def suppliers_of(it: dict) -> list[dict]:
    """Όλοι οι χονδρέμποροι που διαθέτουν το είδος: κωδικός, χονδρική, λιανική, απόθεμα, προσφορά."""
    out = []
    for key, label in SUPPLIERS.items():
        sub = it.get(key)
        if not isinstance(sub, dict) or sub.get("active") is False:
            continue
        stock = _num(sub.get("stock"))
        out.append({"key": key, "name": label, "code": sub.get("code") or None,
                    "wholesale_cents": _cents(sub.get("wh_price") if sub.get("wh_price") is not None else sub.get("wholesale_price")),
                    "retail_cents": _cents(sub.get("retail_price")),
                    "stock": int(stock) if stock is not None else None,
                    "offer": (sub.get("offer") or sub.get("discount_message") or None) or None})
    return out


def category_path(it: dict, ptype: str) -> list[str]:
    """Κατηγορίες 3 επιπέδων: φάρμακα → θεραπευτική κατηγορία (ATC)· παραφάρμακα → κατηγορίες ραφιού."""
    if ptype == "rx_medicine":
        layers = it.get("atc_layers") or {}
        path = [layers.get(f"atc_category{i}") for i in (1, 2, 3)]
    else:
        path = [it.get(f"bus_category{i}") for i in (1, 2, 3)]
    out = []
    for c in path:
        c = str(c or "").strip()
        if not c:
            break
        out.append(c[:80])
    return out


def brand_of(it: dict) -> str | None:
    """Η μάρκα έρχεται ΜΕΡΙΚΕΣ φορές ως αντικείμενο {brand_id, brand} αντί για κείμενο (18/11/2026:
    έριξε τη σελίδα της Αποθήκης). Πάντα κείμενο ή None."""
    b = it.get("brand")
    if isinstance(b, dict):
        b = b.get("brand") or b.get("name")
    b = str(b).strip() if b else ""
    return b[:80] or None


def to_product(it: dict) -> dict | None:
    """Είδος PharmacyOne → σχήμα `pharmacy_products` (ίδια πεδία με την Ελλάδα).
    Barcode: το EAN-13· αν δεν έχει, ο κωδικός φαρμάκου ΓεΣΥ (= HIOcode των εκτελέσεων), ώστε να
    ταιριάζει με τις γραμμές των συνταγών. Τιμές: της PharmacyOne, αλλιώς του μητρώου Υπ. Υγείας."""
    bcs = [str(b).strip() for b in (it.get("barcodes") or []) if str(b).strip()]
    code = str(it.get("drug_code") or "").strip()
    if not bcs and not code:
        return None
    primary = next((b for b in bcs if len(b) == 13 and b.isdigit()), bcs[0] if bcs else code)
    moh = it.get("moh") or {}
    vat = _num(it.get("vat"))
    if vat is not None and 0 < vat < 1:
        vat *= 100
    ptype = product_type(it)
    path = category_path(it, ptype)
    sups = suppliers_of(it)
    main = SUPPLIERS.get(str(it.get("source") or "")) or (sups[0]["name"] if sups else None)
    return {"photo_url": ((it.get("extra") or {}).get("image_url") or None),
            "supplier": main, "suppliers": sups, "cat_path": path,
            "category": path[0] if path else None,"barcode": primary, "barcodes": bcs or [code], "name": (it.get("name") or "").strip() or primary,
            "type": ptype, "atc": atc_of(it), "brand": brand_of(it),
            "price_cents": _cents(it.get("retail_price")) or _cents(moh.get("retail_price")),
            "wholesale_cents": _cents(it.get("wh_price")) or _cents(moh.get("wholesale_price")),
            "vat_rate": int(round(vat)) if vat is not None else None, "price_includes_vat": True,
            "cy_item_id": str(it.get("id")), "drug_code": code or None}


# ΚΛΕΙΔΙ ΕΦΑΡΜΟΓΗΣ PharmacyOne (`X-API-Key`): ένα για όλο το RxVision. Ο Vault της παραγωγής δέχεται
# εγγραφές ΜΟΝΟ κάτω από tenants/* → ζει στο platform_settings/cy, κρυπτογραφημένο με το Κλειδί Μυστικών
# (platform_secrets.SECRET_FIELDS["cy"]), όπως όλα τα μυστικά της πλατφόρμας. Δεν επιστρέφεται ποτέ.
_API_KEY_FIELD = "pharmacyone_api_key"
# Πριν από το κλειδί (έως 18/11/2026) ο κατάλογος κατέβαινε με Client Id φαρμακείου. Διαβάζεται ΜΟΝΟ
# ως εναλλακτική όσο δεν υπάρχει κλειδί· σβήνεται μόλις μπει κλειδί.
_LEGACY_CID_FIELD = "pharmacyone_client_id"


async def _secret(field: str) -> str | None:
    from app.services.platform_secrets import pdec
    doc = await shared_db()["platform_settings"].find_one({"_id": "cy"}, {field: 1}) or {}
    return pdec(doc.get(field)) or None


async def api_key() -> str | None:
    return await _secret(_API_KEY_FIELD)


async def platform_client_id() -> str | None:
    return await _secret(_LEGACY_CID_FIELD)


def valid_api_key(v: str) -> bool:
    return 8 <= len((v or "").strip()) <= 256 and not any(c.isspace() for c in v.strip())


async def set_api_key(value: str | None) -> None:
    from app.services.platform_secrets import penc
    await shared_db()["platform_settings"].update_one(
        {"_id": "cy"}, {"$set": {_API_KEY_FIELD: penc(value.strip()) if value else None,
                                 **({_LEGACY_CID_FIELD: None} if value else {})}}, upsert=True)


async def _pick_items_cid() -> str | None:
    """Μόνο χωρίς κλειδί εφαρμογής (παλιός τρόπος): Client Id της πλατφόρμας, αλλιώς οποιουδήποτε
    κυπριακού φαρμακείου. Με κλειδί, ο κατάλογος δεν θέλει Client Id."""
    if cid := await platform_client_id():
        return cid
    async for t in shared_db()["tenants"].find({"country": "CY"}, {"_id": 1}):
        cid = client_id(t["_id"])
        if cid:
            return cid
    return None


async def sync_items(*, full: bool = False, client: httpx.AsyncClient | None = None) -> dict:
    """Upsert ανά `id`. Αυξητικά με `updated_since` (τελευταία έναρξη − 10′). Μία φορά τη μέρα
    πλήρες πέρασμα: ό,τι δεν επιστράφηκε (συγχωνεύτηκε/διαγράφηκε στην πηγή) γίνεται ανενεργό."""
    db = shared_db()
    cid = None if await api_key() else await _pick_items_cid()
    if not cid and not await api_key():
        return {"ok": True, "skipped": "no_api_key"}
    cfg = (await db["platform_settings"].find_one({"_id": "cy"}, {"items_sync": 1}) or {}).get("items_sync") or {}
    started = _now()
    params: dict[str, Any] = {"limit": ITEMS_PAGE}
    last = cfg.get("last_started_at")
    if isinstance(last, datetime) and last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    if last and not full:
        params["updated_since"] = (last - timedelta(minutes=10)).astimezone(ATHENS).strftime("%Y-%m-%d %H:%M:%S")
    col = db[ITEMS_COLL]
    await db["platform_settings"].update_one({"_id": "cy"}, {"$set": {"items_sync.running_since": started}}, upsert=True)
    try:
        return await _sync_items_pages(db, col, cid, params, started, full, client)
    except PharmacyOneError as exc:
        await db["platform_settings"].update_one({"_id": "cy"}, {"$set": {
            "items_sync.running_since": None,
            "items_sync.last_result": {"ok": False, "error": exc.code, "at": started}}})
        raise


async def _sync_items_pages(db, col, cid, params, started, full, client) -> dict:
    async def upsert(it: dict) -> None:
        it = {k: v for k, v in it.items() if k != "timestamp"}   # «αγγίζεται» σε κάθε run, δεν σημαίνει αλλαγή
        key = str(it["id"])
        await col.update_one({"_id": key}, {"$set": {"raw": it, "seen_at": started, "active": True},
                                            "$setOnInsert": {"created_at": started}}, upsert=True)
        # «άλλαξε» μόνο όταν άλλαξε το περιεχόμενο (update_date) — κλειδί για τη νυχτερινή ενημέρωση
        await col.update_one({"_id": key, "raw_update_date": {"$ne": it.get("update_date")}},
                             {"$set": {"raw_update_date": it.get("update_date"), "changed_at": started}})

    n = 0
    async for rows, _page in _pages(cid, "/items", params, "items", client=client):
        rows = [it for it in rows if it.get("id")]
        # ανά σελίδα (≤500) παράλληλα: 52.903 είδη × 2 εγγραφές σειριακά θα ήταν >100.000 διαδοχικές κλήσεις
        for i in range(0, len(rows), 100):
            await asyncio.gather(*(upsert(it) for it in rows[i:i + 100]))
        n += len(rows)
    deactivated = 0
    if full:
        r = await col.update_many({"seen_at": {"$lt": started}, "active": True},
                                  {"$set": {"active": False, "changed_at": started}})
        deactivated = r.modified_count
    res = {"ok": True, "upserted": n, "deactivated": deactivated, "full": full,
           "total_active": await col.count_documents({"active": True})}
    if full or n:
        # ATC για τα φάρμακα που το ΓεΣΥ δεν δίνει (ταύτιση σκευασμάτων — κανένα δεδομένο ασθενών)
        from app.services.cy import atc_match
        res["atc_match"] = {k: v for k, v in (await atc_match.run(db)).items() if k not in ("ok", "at")}
    await db["platform_settings"].update_one({"_id": "cy"}, {"$set": {
        "items_sync.running_since": None,
        "items_sync.last_started_at": started, "items_sync.last_result": res,
        **({"items_sync.last_full_at": started} if full else {})}}, upsert=True)
    return res


def product_from_doc(d: dict) -> dict | None:
    """Είδος καταλόγου → pharmacy_products, ΜΑΖΙ με τον ATC από ταυτοποίηση (services/cy/atc_match.py)
    όταν το ΓεΣΥ δεν τον δίνει. Η πηγή του ATC μένει γραμμένη (`atc_source`)."""
    p = to_product(d.get("raw") or {})
    if not p:
        return None
    m = d.get("atc_match")
    if p.get("atc"):
        p["atc_source"] = "gesy"
    elif m and m.get("atc"):
        p["atc"], p["atc_source"] = m["atc"], m.get("source")
        if p["type"] == "rx_medicine" and not p.get("cat_path") and m.get("cat_path"):
            p["cat_path"] = m["cat_path"]
            p["category"] = m["cat_path"][0]
    return p


async def catalog_products(types: list[str]) -> AsyncIterator[tuple[dict, datetime | None]]:
    """Πηγή καταλόγου ΚΥΠΡΟΥ για το catalog_sync: (είδος σε σχήμα pharmacy_products, πότε άλλαξε)."""
    async for d in shared_db()[ITEMS_COLL].find({"active": True}):
        p = product_from_doc(d)
        if p and p["type"] in types:
            yield p, d.get("changed_at")


# ── Οθόνη adminpanel «Κατάλογος ειδών Κύπρου» ────────────────────────────────────────────────
async def test_platform() -> dict:
    key = await api_key()
    cid = None if key else await platform_client_id()
    if not key and not cid:
        raise PharmacyOneError("not_configured")
    page = await _get(cid, "/items", {"limit": 1})
    return {"ok": True, "items_total": page.get("total")}


async def catalog_stats() -> dict:
    db = shared_db()
    col = db[ITEMS_COLL]
    cfg = (await db["platform_settings"].find_one({"_id": "cy"}, {"items_sync": 1}) or {}).get("items_sync") or {}
    act = {"active": True}
    key = await api_key()
    legacy = await platform_client_id()
    return {"configured": bool(key or legacy), "hint": (f"••••{key[-4:]}" if key else None),
            "legacy_client_id": bool(legacy and not key),
            "active": await col.count_documents(act),
            "inactive": await col.count_documents({"active": False}),
            "medicine": await col.count_documents({**act, "raw.supergroup": "MEDICINE"}),
            "non_medicine": await col.count_documents({**act, "raw.supergroup": "NON-MEDICINE"}),
            "with_atc": await col.count_documents({**act, "raw.gesy.ATC": {"$nin": [None, ""]}}),
            "matched_atc": await col.count_documents({**act, "raw.supergroup": "MEDICINE", "atc_match.atc": {"$nin": [None, ""]}}),
            "atc_match": (await db["platform_settings"].find_one({"_id": "cy"}, {"atc_match": 1}) or {}).get("atc_match"),
            "no_barcode": await col.count_documents({**act, "raw.barcodes.0": {"$exists": False}}),
            "running_since": cfg.get("running_since"), "last_started_at": cfg.get("last_started_at"),
            "last_full_at": cfg.get("last_full_at"), "last_result": cfg.get("last_result")}


async def search_items(q: str, limit: int = 50) -> list[dict]:
    q = (q or "").strip()
    if len(q) < 2:
        return []
    rx = {"$regex": re.escape(q), "$options": "i"}
    out = []
    async for d in shared_db()[ITEMS_COLL].find(
            {"$or": [{"raw.name": rx}, {"raw.barcodes": q}, {"raw.drug_code": q}]}).limit(limit):
        raw = d.get("raw") or {}
        p = product_from_doc(d) or {}
        out.append({"id": d["_id"], "name": raw.get("name"), "barcode": p.get("barcode"),
                    "type": p.get("type"), "category": p.get("category"), "atc": p.get("atc"),
                    "brand": p.get("brand"), "price_cents": p.get("price_cents"),
                    "wholesale_cents": p.get("wholesale_cents"), "vat_rate": p.get("vat_rate"),
                    "source": raw.get("source"), "active": d.get("active"), "loadable": bool(p),
                    "photo_url": p.get("photo_url"), "supplier": p.get("supplier"),
                    "suppliers": len(p.get("suppliers") or []), "cat_path": p.get("cat_path") or [],
                    "atc_source": p.get("atc_source")})
    return out


async def pharmacies() -> list[dict]:
    """Τα κυπριακά φαρμακεία: παίρνουν τον κατάλογο; τι έχουν στην αποθήκη;"""
    from app.services.auth_service import resolve_tenant_modules, tenant_has
    db = shared_db()
    out = []
    async for t in db["tenants"].find({"country": "CY"}, {"name": 1, "status": 1, "catalog_sync": 1}):
        cs = t.get("catalog_sync") or {}
        out.append({"id": t["_id"], "name": t.get("name"), "status": t.get("status"),
                    "has_addon": tenant_has(await resolve_tenant_modules(t["_id"]), "catalog_seed"),
                    "types": cs.get("types") or [], "last_sync_at": cs.get("last_sync_at"),
                    "last_result": cs.get("last_result"), "loading_since": cs.get("loading_since"),
                    "warehouse": await db["pharmacy_products"].count_documents({"tenant_id": t["_id"]}),
                    "from_catalog": await db["pharmacy_products"].count_documents(
                        {"tenant_id": t["_id"], "origin": "pharmacyone"})})
    return out
