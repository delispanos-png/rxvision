"""ΗΔΥΚΑ medicine price catalog (Δελτίο Τιμών) — global, shared by all tenants.

masterdata/medicines (~14k items) carries the real retail / wholesale / reference
prices + participation + ATC + narcotic flag per medicine, keyed by `eofCode` — the
same code the prescription CDA puts on each <manufacturedMaterial>. We load it once
into the global `medicine_catalog` collection and look up per-medicine prices/cost
from there, which is what powers serious per-medicine profitability (retail−wholesale).
"""
from __future__ import annotations

from datetime import datetime, timezone

from pymongo import UpdateOne

from app.services.ingestion.hdika_client import _to_dict

_PAGE = 150


def _cents(v) -> int:
    try:
        return round(float(v) * 100)
    except (TypeError, ValueError):
        return 0


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _full_name(commercial, content) -> str:
    """Full pharmacist-facing name = brand + strength/content, e.g. 'DEPON 500MG/TAB' (the bare
    commercialName 'DEPON' can't distinguish 500 vs 1000 — content carries the differentiator)."""
    c = str(commercial or "").strip()
    ct = str(content or "").strip()
    return f"{c} {ct}".strip() if ct else c


def _substance_name(active_substances) -> str:
    """Pull the human substance name(s) out of the nested activeSubstances structure:
    {activeSubstance:{activeSubstance:{description: 'ATORVASTATIN…'}}} (dict or list)."""
    names: list[str] = []

    def walk(node):
        if isinstance(node, list):
            for n in node:
                walk(n)
        elif isinstance(node, dict):
            desc = node.get("description")
            if desc and "activeSubstance" not in node:
                names.append(str(desc).strip())
            for k in ("activeSubstance", "activeSubstances"):
                if k in node:
                    walk(node[k])

    walk(active_substances)
    seen, out = set(), []
    for n in names:
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return ", ".join(out)


async def refresh_catalog(db, client) -> int:
    """Page masterdata/medicines → upsert into global `medicine_catalog` (keyed by eofCode).
    Logs every retail-price change vs the previous snapshot into `price_changes` (powers the
    price-change module). Returns the number of medicines loaded. Idempotent."""
    coll = db["medicine_catalog"]
    prev = {d["_id"]: d.get("retail_cents", 0) async for d in coll.find({}, {"retail_cents": 1})}
    now = datetime.now(tz=timezone.utc)
    page = 0
    total = 0
    changes = []
    while True:
        try:
            data = _to_dict(client._get_xml("/api/v1/masterdata/medicines", {"size": _PAGE, "page": page}))
        except Exception:  # noqa: BLE001
            break
        rows = client._rows(data)
        ops = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            eof = str(r.get("eofCode") or "")
            if not eof:
                continue
            retail = _cents(r.get("retailPrice"))
            old = prev.get(eof)
            if old is not None and old != retail and retail > 0 and old > 0:
                changes.append(UpdateOne(
                    {"eofCode": eof, "changed_at": now},
                    {"$set": {"eofCode": eof, "name": r.get("commercialName"),
                              "barcode": r.get("barcode"), "atc": r.get("atcCode"),
                              "old_cents": old, "new_cents": retail,
                              "delta_cents": retail - old,
                              "direction": "up" if retail > old else "down",
                              "changed_at": now}}, upsert=True))
            ops.append(UpdateOne({"_id": eof}, {"$set": {
                "_id": eof, "eofCode": eof, "barcode": r.get("barcode"),
                "name": r.get("commercialName"),
                "full_name": _full_name(r.get("commercialName"), r.get("content")),
                "content": r.get("content"),
                "form_code": r.get("formCode"),
                "package_form": r.get("packageForm"),
                "retail_cents": retail,
                "wholesale_cents": _cents(r.get("wholesalePrice")),
                "reference_cents": _cents(r.get("referencePrice")),
                "participation": _num(r.get("participationPercentage")),
                "narcotic": str(r.get("drug", "")).lower() == "true",
                # αντιγριπικό εμβόλιο (ΗΔΥΚΑ MasterData isFluantiviral) → συνταγή = εμβολιασμός γρίπης
                "flu_vaccine": str(r.get("isFluantiviral", "")).lower() == "true",
                "high_cost": str(r.get("highCost", "")).lower() == "true",
                "requires_opinion": (str(r.get("highCost", "")).lower() == "true"
                                     or str(r.get("eopyyPreapproval", "")).lower() == "true"
                                     or str(r.get("onlyByProtocol", "")).lower() == "true"),
                "atc": r.get("atcCode"),
                "drug_category": r.get("drugCategoryId"),
                "active_substances": r.get("activeSubstances"),
                "substance_name": _substance_name(r.get("activeSubstances")),
                "vendor_update_date": r.get("updateDate"),
                "updated_at": now,
            }}, upsert=True))
        if ops:
            await coll.bulk_write(ops, ordered=False)
            total += len(ops)
        if client._is_last(data, len(rows)):
            break
        page += 1
    if changes:
        await db["price_changes"].bulk_write(changes, ordered=False)
    await enrich_product_categories(db)
    return total


def categorize(atc, narcotic, high_cost, name: str = "") -> str:
    """ΗΔΥΚΑ medicine class: narcotic / vaccine (ATC J07) / allergen (ATC V01) / ΦΥΚ
    (high-cost) / normal. ATC code is the primary signal, with name fallbacks."""
    a = (atc or "").upper()
    n = (name or "").upper()
    if narcotic is True or str(narcotic).lower() == "true":
        return "narcotic"
    if a.startswith("J07") or "ΕΜΒΟΛΙ" in n or "VACCINE" in n:
        return "vaccine"
    if a.startswith("V01") or "ΑΛΛΕΡΓΙΟΓΟΝ" in n or "ALLERGEN" in n:
        return "allergen"
    if high_cost is True or str(high_cost).lower() == "true":
        return "fyk"
    return "normal"


async def enrich_product_categories(db) -> int:
    """Tag every product (all tenants — shared collection) with category/atc/substance
    from the catalog, keyed by eofCode (== product.barcode). Idempotent; run after each
    catalog refresh so new medicines get classified."""
    from pymongo import UpdateOne

    import re
    by_id: dict = {}
    by_bc: dict = {}
    async for d in db["medicine_catalog"].find(
            {}, {"atc": 1, "narcotic": 1, "high_cost": 1, "substance_name": 1,
                 "barcode": 1, "full_name": 1, "name": 1}):
        by_id[d["_id"]] = d                        # eofCode
        if d.get("barcode"):
            by_bc[d["barcode"]] = d                # full EAN-13
    ops = []
    async for p in db["products"].find({}, {"barcode": 1, "name": 1, "substance": 1}):  # tenant-ok: platform catalog enrichment (shared, tenant-agnostic)
        # product.barcode is inconsistent (sometimes eofCode, sometimes full EAN) → try both
        c = by_id.get(p.get("barcode")) or by_bc.get(p.get("barcode"))
        if not c:
            continue
        cls = categorize(c.get("atc"), c.get("narcotic"), c.get("high_cost"),
                         c.get("substance_name") or p.get("name"))
        set_fields = {"category": cls, "atc": c.get("atc"),
                      "substance": c.get("substance_name") or p.get("substance")}
        # Backfill the FULL drug name (brand + strength + pack) when the product carries a
        # brand-only name (no strength/digit) — so LOSEC 20 vs LOSEC 40 are never confused.
        cur = p.get("name") or ""
        full = c.get("full_name") or c.get("name")
        if full and not re.search(r"\d", cur) and re.search(r"\d", full):
            set_fields["name"] = full
        ops.append(UpdateOne({"_id": p["_id"]}, {"$set": set_fields}))
    if ops:
        await db["products"].bulk_write(ops, ordered=False)  # tenant-ok: enrichment writes by _id
    return len(ops)


async def refresh_icd10(db, client) -> int:
    """Page masterdata/icd10s → global `icd10_codes` (_id=code → Greek title). Powers
    ICD-10 names in the diagnosis analytics. Idempotent."""
    coll = db["icd10_codes"]
    page = 0
    total = 0
    while True:
        try:
            data = _to_dict(client._get_xml("/api/v1/masterdata/icd10s", {"size": _PAGE, "page": page}))
        except Exception:  # noqa: BLE001
            break
        rows = client._rows(data)
        ops = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            code = str(r.get("code") or "")
            if not code:
                continue
            ops.append(UpdateOne({"_id": code}, {"$set": {
                "_id": code, "title_el": r.get("title"),
                "description": r.get("description")}}, upsert=True))
        if ops:
            await coll.bulk_write(ops, ordered=False)
            total += len(ops)
        if client._is_last(data, len(rows)):
            break
        page += 1
    return total


async def load_catalog_map(db) -> dict:
    """eofCode → {retail_cents, wholesale_cents, name, barcode, narcotic, atc} for fast
    in-memory lookups during ingestion."""
    out: dict = {}
    cur = db["medicine_catalog"].find({}, {
        "eofCode": 1, "retail_cents": 1, "wholesale_cents": 1, "name": 1, "full_name": 1,
        "barcode": 1, "narcotic": 1, "atc": 1})
    async for d in cur:
        out[str(d["_id"])] = d
    return out
