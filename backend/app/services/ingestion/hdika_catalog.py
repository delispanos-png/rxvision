"""ΗΔΙΚΑ medicine price catalog (Δελτίο Τιμών) — global, shared by all tenants.

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


async def refresh_catalog(db, client) -> int:
    """Page masterdata/medicines → upsert into global `medicine_catalog` (keyed by eofCode).
    Returns the number of medicines loaded. Safe to re-run (idempotent upserts)."""
    coll = db["medicine_catalog"]
    page = 0
    total = 0
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
            ops.append(UpdateOne({"_id": eof}, {"$set": {
                "_id": eof, "eofCode": eof, "barcode": r.get("barcode"),
                "name": r.get("commercialName"),
                "retail_cents": _cents(r.get("retailPrice")),
                "wholesale_cents": _cents(r.get("wholesalePrice")),
                "reference_cents": _cents(r.get("referencePrice")),
                "participation": _num(r.get("participationPercentage")),
                "narcotic": str(r.get("drug", "")).lower() == "true",
                "high_cost": str(r.get("highCost", "")).lower() == "true",
                "atc": r.get("atcCode"),
                "drug_category": r.get("drugCategoryId"),
                "active_substances": r.get("activeSubstances"),
                "updated_at": datetime.now(tz=timezone.utc),
            }}, upsert=True))
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
        "eofCode": 1, "retail_cents": 1, "wholesale_cents": 1, "name": 1,
        "barcode": 1, "narcotic": 1, "atc": 1})
    async for d in cur:
        out[str(d["_id"])] = d
    return out
