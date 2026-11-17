"""Προχορηγήσεις (δανεικά) για την Κύπρο.

Ίδιοι κανόνες με την Ελλάδα (απαιτήσεις ιδιοκτήτη):
- ο πελάτης επιλέγεται ΠΑΝΤΑ από τη λίστα (πελάτης ΓεΣΥ), ποτέ ελεύθερο κείμενο·
- ΜΙΑ φόρμα = ένας πελάτης + όσα σκευάσματα θέλει·
- η ξεχρέωση ΔΕΝ γίνεται αυτόματα: προτείνουμε την εκτέλεση ΓεΣΥ που φαίνεται να την καλύπτει,
  λέμε ΓΙΑΤΙ (ίδιο σκεύασμα, ίδια παρτίδα), και το «ναι» το δίνει ο άνθρωπος.
- ΔΕΝ είναι λογιστική αποθήκης: μόνο καταγραφή και ξεχρέωση.

Ταύτιση: GTIN και παρτίδα του κουτιού (DataMatrix), που το XML ΓεΣΥ γράφει στο EMVS κάθε γραμμής.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.cy import CyDispensingRepository, CyLoanRepository, CyPatientRepository

MAX_QTY = 20


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def gtin13(code: str | None) -> str | None:
    """GTIN-14 με αρχικό 0 ≡ EAN-13 (το ίδιο κουτί). Σύγκριση πάντα στα 13 τελευταία ψηφία."""
    d = re.sub(r"\D", "", code or "")
    if len(d) == 14 and d.startswith("0"):
        d = d[1:]
    return d[-13:] if len(d) >= 8 else None


def _oid(v: str):
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


async def name_for(tenant_id: str, gtin: str | None) -> str | None:
    """Όνομα σκευάσματος: από όσα έχουν ήδη εκτελεστεί εδώ (XML), αλλιώς από την αποθήκη."""
    g = gtin13(gtin)
    if not g:
        return None
    rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        {"$match": {"$or": [{"lines.barcode": g}, {"lines.emvs.gtin": {"$in": [g, "0" + g]}}]}},
        {"$unwind": "$lines"},
        {"$match": {"$or": [{"lines.barcode": g}, {"lines.emvs.gtin": {"$in": [g, "0" + g]}}]}},
        {"$limit": 1}, {"$project": {"_id": 0, "d": "$lines.description"}}])
    if rows:
        return rows[0].get("d")
    from app.core.db import shared_db
    p = await shared_db()["pharmacy_products"].find_one(  # tenant-ok: tenant_id στο φίλτρο
        {"tenant_id": tenant_id, "barcode": {"$in": [g, "0" + g]}}, {"name": 1})
    return (p or {}).get("name")


async def scan(tenant_id: str, raw: str) -> dict[str, Any]:
    """Σάρωση: DataMatrix κουτιού (01/17/10/21 με οποιαδήποτε σειρά) ή σκέτο barcode."""
    from app.services import gs1_scan
    raw = (raw or "").strip()
    p = gs1_scan.parse(raw)
    if p and p.get("corrupt"):
        return {"ok": False, "kind": "corrupt"}
    if p and p.get("gtin"):
        item = {"gtin": gtin13(p["gtin"]), "lot": p.get("batch"), "expiry": p.get("expiry")}
    elif re.fullmatch(r"\d{8,14}", raw):
        item = {"gtin": gtin13(raw), "lot": None, "expiry": None}
    else:
        return {"ok": False, "kind": "unknown"}
    item["name"] = await name_for(tenant_id, item["gtin"]) or ""
    return {"ok": True, "item": item}


async def create(tenant_id: str, *, patient_ref: str, items: list[dict], note: str = "",
                 by: str | None = None) -> dict[str, Any]:
    p = await CyPatientRepository(tenant_id=tenant_id).find_one({"pseudo_id": patient_ref})
    if not p:
        raise ValueError("patient_not_found")       # πάντα πελάτης από τη λίστα
    clean = []
    for it in items or []:
        g = gtin13(it.get("gtin"))
        name = (it.get("name") or "").strip() or (await name_for(tenant_id, g) if g else None)
        qty = int(it.get("qty") or 1)
        if not (g or name):
            raise ValueError("item_needs_code_or_name")
        if not 1 <= qty <= MAX_QTY:
            raise ValueError("bad_qty")
        clean.append({"gtin": g, "name": name or g, "qty": qty, "lot": (it.get("lot") or "").strip() or None,
                      "expiry": it.get("expiry"), "status": "open"})
    if not clean:
        raise ValueError("no_items")
    doc = {"patient_ref": patient_ref, "patient_name": p.get("full_name"), "items": clean,
           "note": (note or "")[:300], "status": "open", "created_at": _now(), "by": by}
    lid = await CyLoanRepository(tenant_id=tenant_id).insert_one(doc)
    return {"ok": True, "id": str(lid)}


def _view(d: dict) -> dict:
    d = {**d, "id": str(d.pop("_id"))}
    d.pop("tenant_id", None)
    d["open_items"] = sum(1 for i in d.get("items") or [] if i.get("status") == "open")
    return d


async def listing(tenant_id: str, *, status: str = "open", patient_ref: str | None = None) -> list[dict]:
    q: dict[str, Any] = {} if status == "all" else {"status": status}
    if patient_ref:
        q["patient_ref"] = patient_ref
    rows = await CyLoanRepository(tenant_id=tenant_id).find(q, sort=[("created_at", -1)], limit=500)
    now = _now()
    out = []
    for r in rows:
        v = _view(r)
        at = r.get("created_at")
        if isinstance(at, str):
            at = datetime.fromisoformat(at)
        v["age_days"] = (now - (at if at.tzinfo else at.replace(tzinfo=timezone.utc))).days if at else None
        out.append(v)
    return out


async def suggestions(tenant_id: str, *, days: int = 60) -> list[dict]:
    """Για κάθε ανοιχτό σκεύασμα: εκτελέσεις ΓεΣΥ του ΙΔΙΟΥ πελάτη, μετά το δανεικό, με το ίδιο
    σκεύασμα. Μόνο ΠΡΟΤΑΣΗ — η ξεχρέωση θέλει επιβεβαίωση."""
    loans = await CyLoanRepository(tenant_id=tenant_id).find({"status": "open"}, limit=500)
    used = {(i.get("cleared_dispensing_id"), i.get("gtin"))
            for ln in await CyLoanRepository(tenant_id=tenant_id).find({"items.cleared_dispensing_id": {"$ne": None}}, limit=500)
            for i in ln.get("items") or [] if i.get("cleared_dispensing_id")}
    disp = CyDispensingRepository(tenant_id=tenant_id)
    out = []
    for ln in loans:
        at = ln["created_at"] if isinstance(ln["created_at"], datetime) else datetime.fromisoformat(str(ln["created_at"]))
        since = at - timedelta(days=1)   # ίδια μέρα: το δανεικό γράφεται συχνά λίγο μετά την εκτέλεση
        for idx, it in enumerate(ln.get("items") or []):
            if it.get("status") != "open" or not it.get("gtin"):
                continue
            g = it["gtin"]
            rows = await disp.find({"patient_ref": ln["patient_ref"], "dispensed_at": {"$gte": since},
                                    "$or": [{"lines.barcode": g}, {"lines.emvs.gtin": {"$in": [g, "0" + g]}}]},
                                   sort=[("dispensed_at", 1)], limit=10)
            for r in rows:
                if (r["dispensing_id"], g) in used:
                    continue
                for line in r.get("lines") or []:
                    gt = {gtin13(e.get("gtin")) for e in line.get("emvs") or []} | {gtin13(line.get("barcode"))}
                    if g not in gt or not line.get("qty_disp"):
                        continue
                    lots = {e.get("lot") for e in line.get("emvs") or [] if e.get("lot")}
                    out.append({"loan_id": str(ln["_id"]), "idx": idx, "patient_ref": ln["patient_ref"],
                                "patient_name": ln.get("patient_name"), "item": it.get("name"),
                                "dispensing_id": r["dispensing_id"], "dispensed_at": r["dispensed_at"],
                                "qty_disp": line.get("qty_disp"),
                                "reason": "same_lot" if it.get("lot") and it["lot"] in lots else "same_product"})
                    break
                else:
                    continue
                break
    return out


async def set_item(tenant_id: str, loan_id: str, idx: int, *, cleared: bool, dispensing_id: str | None,
                   by: str | None) -> dict:
    repo = CyLoanRepository(tenant_id=tenant_id)
    oid = _oid(loan_id)
    ln = await repo.find_one({"_id": oid}) if oid else None
    if not ln or not 0 <= idx < len(ln.get("items") or []):
        raise LookupError("not_found")
    if ln.get("status") == "cancelled":
        raise ValueError("cancelled")
    items = ln["items"]
    items[idx].update({"status": "cleared", "cleared_at": _now(), "cleared_by": by,
                       "cleared_dispensing_id": dispensing_id} if cleared
                      else {"status": "open", "cleared_at": None, "cleared_by": None, "cleared_dispensing_id": None})
    status = "closed" if all(i.get("status") == "cleared" for i in items) else "open"
    await repo.update_one({"_id": oid}, {"$set": {"items": items, "status": status, "updated_at": _now()}})
    return {"ok": True, "status": status}


async def cancel(tenant_id: str, loan_id: str, *, by: str | None) -> dict:
    repo = CyLoanRepository(tenant_id=tenant_id)
    oid = _oid(loan_id)
    if not oid or not await repo.find_one({"_id": oid}):
        raise LookupError("not_found")
    await repo.update_one({"_id": oid}, {"$set": {"status": "cancelled", "cancelled_by": by, "updated_at": _now()}})
    return {"ok": True}
