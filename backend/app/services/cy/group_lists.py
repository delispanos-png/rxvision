"""Κύπρος: οι λίστες των Οικογενειών / Δομών φροντίδας με ΤΟ ΙΔΙΟ σχήμα με την Ελλάδα
(`services/group_lists.py`), ώστε οι οθόνες να δουλεύουν αυτούσιες. `ids` = ψευδώνυμα ΓεΣΥ (pseudo_id).

Πηγές: εκτελέσεις ΓεΣΥ (`cy_dispensings`), αλυσίδες φάσεων (`chains`, ΕΝΑΣ ορισμός με Ανοιχτές
συνταγές/Παραγγελία), προχορηγήσεις Κύπρου (`cy_loans`). Το «barcode» των ελληνικών λιστών εδώ είναι ο
αριθμός συνταγής/εκτέλεσης ΓεΣΥ. Χωρίς «άυλη» συνταγή (δεν υπάρχει η έννοια στο ΓεΣΥ).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from app.repositories.cy import CyDispensingRepository, CyLoanRepository
from app.services.cy import chains as ch


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _aware(d):
    return d.replace(tzinfo=timezone.utc) if isinstance(d, datetime) and d.tzinfo is None else d


async def opening(tenant_id: str, ids: list, names: dict[str, str], *, days: int = 45,
                  limit: int = 500) -> list[dict]:
    """Ποιες συνταγές έχουν ΕΠΟΜΕΝΗ ΦΑΣΗ μέσα στο παράθυρο (ή καθυστερούν), ανά άνθρωπο."""
    if not ids:
        return []
    want = set(ids)
    out = []
    for c in await ch.chains(tenant_id):
        if c["patient_ref"] not in want or c["status"] not in ("soon", "upcoming", "late"):
            continue
        if c["days_to_due"] > days:
            continue
        out.append({"patient_id": c["patient_ref"], "name": names.get(c["patient_ref"], "—"),
                    "barcode": c["prescription_id"],
                    "opens_at": datetime.combine(date.fromisoformat(c["next_due"]), datetime.min.time(),
                                                 tzinfo=timezone.utc),
                    "intangible": False, "items": c.get("items") or [], "qty": 0,
                    "late": c["status"] == "late"})
    out.sort(key=lambda r: r["opens_at"])
    return out[:limit]


def by_person(rows: list[dict]) -> list[dict]:
    from app.services.group_lists import by_person as gr_by_person
    return gr_by_person(rows)


async def to_order(tenant_id: str, ids: list, *, days: int = 45, limit: int = 200) -> list[dict]:
    """Τα ίδια ανά σκεύασμα: πόσα θα χρειαστούν (ό,τι γράφτηκε στην τελευταία φάση) και για πόσους."""
    rows = await opening(tenant_id, ids, {}, days=days)
    if not rows:
        return []
    last = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        {"$match": {"prescription_id": {"$in": [r["barcode"] for r in rows]}}},
        {"$sort": {"dispensed_at": -1}},
        {"$group": {"_id": "$prescription_id", "lines": {"$first": "$lines"}, "p": {"$first": "$patient_ref"}}}])
    acc: dict[str, dict] = {}
    for r in last:
        for ln in r.get("lines") or []:
            k = ln.get("description") or ln.get("code") or "—"
            b = acc.setdefault(k, {"name": k, "barcode": ln.get("barcode"), "qty": 0, "_p": set()})
            b["qty"] += int(ln.get("qty_presc") or 0)
            b["_p"].add(r.get("p"))
    out = [{"name": b["name"], "barcode": b["barcode"], "qty": b["qty"], "people": len(b["_p"] - {None})}
           for b in acc.values()]
    return sorted(out, key=lambda x: -x["qty"])[:limit]


async def pending(tenant_id: str, ids: list, names: dict[str, str], *, limit: int = 200) -> list[dict]:
    """Είδη της ΤΕΛΕΥΤΑΙΑΣ επίσκεψης κάθε ανθρώπου (60 ημέρες) που δεν δόθηκαν (QtyDisp 0)."""
    if not ids:
        return []
    since = _now() - timedelta(days=60)
    rows = await CyDispensingRepository(tenant_id=tenant_id).find(
        {"patient_ref": {"$in": list(ids)}, "dispensed_at": {"$gte": since}},
        sort=[("dispensed_at", -1)], limit=500)
    seen: set[str] = set()
    out = []
    for d in rows:
        ref = d.get("patient_ref")
        if ref in seen:
            continue                              # μόνο η πιο πρόσφατη επίσκεψη μετράει
        seen.add(ref)
        miss = [{"name": ln.get("description"), "left": int(ln.get("qty_presc") or 0)}
                for ln in d.get("lines") or [] if not ln.get("qty_disp") and (ln.get("qty_presc") or 0) > 0]
        if miss:
            out.append({"patient_id": ref, "name": names.get(ref, "—"), "barcode": d["dispensing_id"],
                        "executed_at": _aware(d["dispensed_at"]), "valid_until": None, "value": 0,
                        "items": miss})
    return out[:limit]


async def loans(tenant_id: str, ids: list, names: dict[str, str], *, limit: int = 200) -> list[dict]:
    if not ids:
        return []
    rows = await CyLoanRepository(tenant_id=tenant_id).find(
        {"status": "open", "patient_ref": {"$in": list(ids)}}, sort=[("created_at", 1)], limit=limit)
    return [{"id": str(d["_id"]), "patient_id": d.get("patient_ref"),
             "name": names.get(d.get("patient_ref"), "—"), "created_at": d.get("created_at"),
             "expected_at": None,
             "items": [i.get("name") or i.get("gtin") for i in (d.get("items") or [])
                       if i.get("status") == "open" and (i.get("name") or i.get("gtin"))]} for d in rows]


async def recent(tenant_id: str, ids: list, names: dict[str, str], *, months: int = 12,
                 limit: int = 300) -> list[dict]:
    if not ids:
        return []
    rows = await CyDispensingRepository(tenant_id=tenant_id).find(
        {"patient_ref": {"$in": list(ids)}, "dispensed_at": {"$gte": _now() - timedelta(days=30 * max(1, months))}},
        sort=[("dispensed_at", -1)], limit=limit)
    return [{"patient_id": d.get("patient_ref"), "name": names.get(d.get("patient_ref"), "—"),
             "barcode": d["dispensing_id"], "external_id": d["dispensing_id"],
             "executed_at": _aware(d["dispensed_at"]), "value": (d.get("totals") or {}).get("total", 0),
             "paid": (d.get("totals") or {}).get("beneficiary", 0),
             "partial": any(not ln.get("qty_disp") for ln in d.get("lines") or []),
             "items": [ln.get("description") for ln in d.get("lines") or []
                       if ln.get("qty_disp") and ln.get("description")][:8]} for d in rows]


async def everything(tenant_id: str, ids: list, names: dict[str, str], *, days: int = 45,
                     months: int = 12) -> dict[str, Any]:
    return {"recent": await recent(tenant_id, ids, names, months=months),
            "opening": await opening(tenant_id, ids, names, days=days),
            "order": await to_order(tenant_id, ids, days=days),
            "pending": await pending(tenant_id, ids, names),
            "loans": await loans(tenant_id, ids, names)}


async def instructions(tenant_id: str, ids: list, names: dict[str, str], *, months: int = 6) -> list[dict]:
    """ΦΥΛΛΟ ΟΔΗΓΙΩΝ ΛΗΨΗΣ ανά άνθρωπο, από τη δοσολογία του XML ΓεΣΥ — η ΤΕΛΕΥΤΑΙΑ οδηγία νικά."""
    if not ids:
        return []
    from app.services.cy.meds import _dosage_text, key_of
    rows = await CyDispensingRepository(tenant_id=tenant_id).find(
        {"patient_ref": {"$in": list(ids)}, "dispensed_at": {"$gte": _now() - timedelta(days=30 * max(1, months))}},
        sort=[("dispensed_at", 1)], limit=2000)
    per: dict[str, dict[str, dict]] = {}
    for d in rows:
        for ln in d.get("lines") or []:
            if not ln.get("qty_disp") or ln.get("kind") == "consumable":
                continue
            per.setdefault(d["patient_ref"], {})[key_of(ln)] = {
                "name": ln.get("description") or "—", "dosage": _dosage_text(ln.get("dosage") or {}) or "",
                "last": _aware(d["dispensed_at"])}
    out = [{"patient_id": pid, "name": names.get(pid, "—"), "meds": sorted(m.values(), key=lambda x: x["name"])}
           for pid, m in per.items()]
    return sorted(out, key=lambda b: b["name"] or "")
