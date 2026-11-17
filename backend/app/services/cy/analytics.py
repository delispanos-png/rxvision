"""Κυπριακό Dashboard και λίστες (εκτελέσεις, πελάτες, γιατρός), ίδια λογική με τις ελληνικές οθόνες.

Ίδιες οθόνες, ίδιο φίλτρο ημερομηνιών (`date_from` ως `date_to`, όπου το `date_to` ΔΕΝ περιλαμβάνεται,
όπως στο κοινό φίλτρο της πλατφόρμας), δεδομένα μόνο από τα `cy_*` μέσα από BaseRepository.
Οι ημέρες και οι ώρες μετρούν σε ώρα Κύπρου (Asia/Nicosia). Οι καταστάσεις συνταγών έρχονται ΠΑΝΤΑ
από `chains.py`, που είναι ο μόνος ορισμός τους.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Any

from app.repositories.cy import CyDispensingRepository, CyPatientRepository
from app.services.cy import chains as ch

# μετρική → πεδίο του `totals` (οι «executions» μετρούν εκτελέσεις)
METRICS = {"executions": None, "value": "total", "hio": "hio", "beneficiary": "beneficiary", "pc2": "pc2"}
SORTS = {"dispensed_at", "total", "hio", "beneficiary"}


def _dt(d: date) -> datetime:
    return datetime.combine(d, datetime.min.time(), tzinfo=ch.TZ)


def window(date_from: date | None, date_to: date | None) -> dict[str, Any]:
    """Φίλτρο ημερομηνίας. Το `date_to` δεν περιλαμβάνεται (σύμβαση του κοινού φίλτρου)."""
    rng: dict[str, Any] = {}
    if date_from:
        rng["$gte"] = _dt(date_from)
    if date_to:
        rng["$lt"] = _dt(date_to)
    return {"dispensed_at": rng} if rng else {}


async def _refs_by_name(tenant_id: str, q: str) -> list[str]:
    """Αναζήτηση πελάτη με όνομα ή κωδικό ΟΑΥ. Η ταυτότητα δεν αποθηκεύεται, άρα δεν ψάχνεται."""
    rx = {"$regex": re.escape(q.strip()), "$options": "i"}
    rows = await CyPatientRepository(tenant_id=tenant_id).find(
        {"$or": [{"full_name": rx}, {"hio_code": rx}]}, limit=500)
    return [r["pseudo_id"] for r in rows]


# ── Dashboard ────────────────────────────────────────────────────────────────

async def summary(tenant_id: str, date_from: date | None, date_to: date | None,
                  *, doctor_id: str | None = None) -> dict[str, Any]:
    match = {**window(date_from, date_to), **({"doctor.id": doctor_id} if doctor_id else {})}
    rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        *([{"$match": match}] if match else []),
        {"$group": {"_id": None, "executions": {"$sum": 1},
                    "value": {"$sum": "$totals.total"}, "hio": {"$sum": "$totals.hio"},
                    "beneficiary": {"$sum": "$totals.beneficiary"}, "pc2": {"$sum": "$totals.pc2"},
                    "prescriptions": {"$addToSet": "$prescription_id"},
                    "patients": {"$addToSet": "$patient_ref"}}}])
    r = rows[0] if rows else {}
    return {"executions": r.get("executions", 0), "value": r.get("value", 0), "hio": r.get("hio", 0),
            "beneficiary": r.get("beneficiary", 0), "pc2": r.get("pc2", 0),
            "prescriptions": len(r.get("prescriptions") or []),
            "patient_count": len([p for p in r.get("patients") or [] if p])}


async def _points(tenant_id: str, match: dict) -> list[tuple[datetime, dict]]:
    """(ώρα Κύπρου, ποσά) ανά εκτέλεση. Η ομαδοποίηση ανά ημέρα/ώρα γίνεται εδώ με zoneinfo:
    ίδιο αποτέλεσμα με τον Mongo `timezone`, αλλά ελέγξιμο στα τεστ (το mongomock δεν τον υποστηρίζει).
    Ένα φαρμακείο έχει λίγες δεκάδες χιλιάδες εκτελέσεις τον χρόνο, άρα η προβολή μένει μικρή."""
    rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        *([{"$match": match}] if match else []),
        {"$project": {"_id": 0, "dispensed_at": 1, "totals": 1}}])
    out = []
    for r in rows:
        at = r["dispensed_at"] if isinstance(r["dispensed_at"], datetime) else datetime.fromisoformat(
            str(r["dispensed_at"]))
        out.append((at.astimezone(ch.TZ), r.get("totals") or {}))
    return out


def _metric(metric: str, totals: dict) -> int:
    return 1 if metric == "executions" else int(totals.get(METRICS.get(metric, "value"), 0) or 0)


async def timeseries(tenant_id: str, date_from: date, date_to: date, *, metric: str = "value",
                     grain: str = "day", match: dict | None = None) -> list[dict[str, Any]]:
    """Μία τιμή ανά ημέρα ή μήνα. Οι κενές ημέρες/μήνες γεμίζουν με 0 (το γράφημα δεν «πηδά» μέρες)."""
    fmt = "%Y-%m" if grain == "month" else "%Y-%m-%d"
    got: dict[str, int] = {}
    for at, totals in await _points(tenant_id, {**window(date_from, date_to), **(match or {})}):
        k = at.strftime(fmt)
        got[k] = got.get(k, 0) + _metric(metric, totals)
    end = min(date_to, datetime.now(tz=ch.TZ).date() + timedelta(days=1))
    out, d = [], date_from
    if grain == "month":
        d = d.replace(day=1)
        while d < end:
            k = d.strftime("%Y-%m")
            out.append({"bucket": k, "value": got.get(k, 0)})
            d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    else:
        while d < end:
            k = d.isoformat()
            out.append({"bucket": k, "value": got.get(k, 0)})
            d += timedelta(days=1)
    return out


async def heatmap(tenant_id: str, date_from: date | None, date_to: date | None) -> list[dict[str, int]]:
    """Εκτελέσεις ανά ημέρα εβδομάδας (1=Δευτέρα) και ώρα, σε ώρα Κύπρου."""
    cells: dict[tuple[int, int], int] = {}
    for at, _ in await _points(tenant_id, window(date_from, date_to)):
        k = (at.isoweekday(), at.hour)
        cells[k] = cells.get(k, 0) + 1
    return [{"dow": k[0], "hour": k[1], "value": v} for k, v in sorted(cells.items())]


async def top(tenant_id: str, date_from: date | None, date_to: date | None, *, dim: str,
              limit: int = 6) -> list[dict[str, Any]]:
    """Κορυφαίοι γιατροί ή σκευάσματα κατά αξία στην περίοδο."""
    base = [{"$match": window(date_from, date_to)}] if (date_from or date_to) else []
    repo = CyDispensingRepository(tenant_id=tenant_id)
    if dim == "doctors":
        rows = await repo.aggregate([*base, {"$group": {
            "_id": "$doctor.id", "name": {"$last": "$doctor.name"}, "rx": {"$sum": 1},
            "value": {"$sum": "$totals.total"}}}, {"$sort": {"value": -1}}, {"$limit": limit}])
    else:   # products
        rows = await repo.aggregate([*base, {"$unwind": "$lines"}, {"$match": {"lines.qty_disp": {"$gt": 0}}},
            {"$group": {"_id": {"$ifNull": ["$lines.barcode", "$lines.code"]},
                        "name": {"$last": "$lines.description"}, "rx": {"$sum": 1},
                        "value": {"$sum": "$lines.amounts.total"}}},
            {"$sort": {"value": -1}}, {"$limit": limit}])
    return [{"_id": r["_id"], "name": r.get("name"), "rx": r["rx"], "value": r["value"]} for r in rows]


# ── Λίστα εκτελέσεων (όπως οι «Συνταγές» στην Ελλάδα) ─────────────────────────

async def dispensings(tenant_id: str, *, date_from: date | None = None, date_to: date | None = None,
                      q: str | None = None, doctor_id: str | None = None, kind: str | None = None,
                      patient_ref: str | None = None, sort: str = "dispensed_at", direction: int = -1,
                      page: int = 1, page_size: int = 50) -> dict[str, Any]:
    match: dict[str, Any] = window(date_from, date_to)
    if doctor_id:
        match["doctor.id"] = doctor_id
    if kind in ("drug", "consumable"):
        match["kind"] = kind
    if patient_ref:
        match["patient_ref"] = patient_ref
    if q and q.strip():
        s = q.strip()
        refs = await _refs_by_name(tenant_id, s)
        match["$or"] = [{"patient_ref": {"$in": refs}}, {"prescription_id": s}, {"dispensing_id": s},
                        {"lines.description": {"$regex": re.escape(s), "$options": "i"}}]
    key = {"dispensed_at": "dispensed_at", "total": "totals.total", "hio": "totals.hio",
           "beneficiary": "totals.beneficiary"}[sort if sort in SORTS else "dispensed_at"]
    repo = CyDispensingRepository(tenant_id=tenant_id)
    page, page_size = max(1, page), max(1, min(page_size, 300))
    total = await repo.count(match)
    rows = await repo.find(match, sort=[(key, -1 if direction < 0 else 1), ("_id", -1)],
                           skip=(page - 1) * page_size, limit=page_size)
    names = await ch.names_of(tenant_id, {r["patient_ref"] for r in rows if r.get("patient_ref")})
    return {"total": total, "page": page, "page_size": page_size, "items": [{
        "dispensing_id": r["dispensing_id"], "prescription_id": r["prescription_id"], "kind": r["kind"],
        "dispensed_at": r["dispensed_at"], "patient_ref": r.get("patient_ref"),
        "patient_name": (names.get(r.get("patient_ref")) or {}).get("full_name"),
        "doctor_id": (r.get("doctor") or {}).get("id"), "doctor": (r.get("doctor") or {}).get("name"),
        "user": (r.get("user") or {}).get("name"),
        "instance": r.get("instance"), "instances": r.get("instances"),
        "lines": len(r.get("lines") or []),
        "not_dispensed": sum(1 for ln in r.get("lines") or [] if not ln.get("qty_disp")),
        "items": [ln.get("description") for ln in (r.get("lines") or [])][:4],
        "totals": r.get("totals"), "versions": r.get("versions", 1),
    } for r in rows]}


async def dispensing(tenant_id: str, dispensing_id: str) -> dict[str, Any] | None:
    """Μία εκτέλεση με όλες τις γραμμές της, τη συνταγή της (όλες οι φάσεις εδώ) και την κατάστασή της."""
    repo = CyDispensingRepository(tenant_id=tenant_id)
    d = await repo.find_one({"dispensing_id": dispensing_id})
    if not d:
        return None
    phases = await repo.find({"prescription_id": d["prescription_id"]}, sort=[("dispensed_at", 1)], limit=50)
    chain = next(iter(await ch.chains(tenant_id, match={"prescription_id": d["prescription_id"]})), None)
    p = await CyPatientRepository(tenant_id=tenant_id).find_one({"pseudo_id": d.get("patient_ref")}) or {}
    return {
        "dispensing_id": d["dispensing_id"], "prescription_id": d["prescription_id"], "kind": d["kind"],
        "dispensed_at": d["dispensed_at"], "effective_date": d.get("effective_date"),
        "patient": {"ref": d.get("patient_ref"), "full_name": p.get("full_name"), "dob": p.get("dob"),
                    "gender": p.get("gender")},
        "doctor": d.get("doctor"), "user": (d.get("user") or {}).get("name"),
        "instance": d.get("instance"), "instances": d.get("instances"), "totals": d.get("totals"),
        "versions": d.get("versions", 1), "corrected_at": d.get("corrected_at"),
        "lines": [{
            "description": ln.get("description"), "barcode": ln.get("barcode"), "code": ln.get("code"),
            "package": ln.get("package"), "qty_presc": ln.get("qty_presc"), "qty_disp": ln.get("qty_disp"),
            "covered": ln.get("covered"), "amounts": ln.get("amounts"), "days_covered": ln.get("days_covered"),
            "dosage": {k: (ln.get("dosage") or {}).get(k) for k in ("raw_amount", "raw_frequency", "timing",
                                                                     "duration_days", "route")},
            "lots": sorted({e.get("lot") for e in ln.get("emvs") or [] if e.get("lot")}),
            "doctor_instructions": ln.get("doctor_instructions"),
        } for ln in d.get("lines") or []],
        "phases": [{"dispensing_id": x["dispensing_id"], "dispensed_at": x["dispensed_at"],
                    "instance": x.get("instance"), "total": (x.get("totals") or {}).get("total", 0)}
                   for x in phases],
        "chain": None if chain is None else {k: chain[k] for k in (
            "status", "next_due", "days_to_due", "remaining", "value_at_stake_cents")},
    }


# ── Λίστα πελατών (όπως οι «Ασφαλισμένοι») ───────────────────────────────────

async def patients(tenant_id: str, *, date_from: date | None = None, date_to: date | None = None,
                   q: str | None = None, sort: str = "value", limit: int = 300) -> dict[str, Any]:
    match: dict[str, Any] = window(date_from, date_to)
    if q and q.strip():
        match["patient_ref"] = {"$in": await _refs_by_name(tenant_id, q)}
    rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        *([{"$match": match}] if match else []),
        {"$group": {"_id": "$patient_ref", "rx": {"$sum": 1}, "value": {"$sum": "$totals.total"},
                    "beneficiary": {"$sum": "$totals.beneficiary"},
                    "last": {"$max": "$dispensed_at"},
                    "consumables": {"$sum": {"$cond": [{"$eq": ["$kind", "consumable"]}, 1, 0]}}}},
        {"$match": {"_id": {"$ne": None}}}])
    worst: dict[str, str] = {}
    for c in await ch.chains(tenant_id):
        cur = worst.get(c["patient_ref"])
        if cur is None or ch.STATUS_ORDER.index(c["status"]) < ch.STATUS_ORDER.index(cur):
            worst[c["patient_ref"]] = c["status"]
    key = {"rx": "rx", "last": "last", "value": "value"}.get(sort, "value")
    rows.sort(key=lambda r: r[key], reverse=True)
    rows = rows[:max(1, min(limit, 1000))]
    names = await ch.names_of(tenant_id, {r["_id"] for r in rows})
    items = []
    for r in rows:
        p = names.get(r["_id"]) or {}
        items.append({"patient_ref": r["_id"], "full_name": p.get("full_name"), "gender": p.get("gender"),
                      "dob": p.get("dob"), "rx": r["rx"], "value": r["value"],
                      "beneficiary": r["beneficiary"], "last": r["last"],
                      "consumables": r["consumables"] > 0, "status": worst.get(r["_id"], "closed")})
    return {"items": items, "total": len(items)}


# ── Καρτέλα γιατρού ──────────────────────────────────────────────────────────

async def doctor(tenant_id: str, doctor_id: str, *, today: date | None = None) -> dict[str, Any] | None:
    """Ό,τι φέρνει ένας γιατρός στο φαρμακείο: τάση 12 μηνών, πελάτες, συχνότερα σκευάσματα."""
    today = today or datetime.now(tz=ch.TZ).date()
    repo = CyDispensingRepository(tenant_id=tenant_id)
    match = {"doctor.id": doctor_id}
    head = await repo.find(match, sort=[("dispensed_at", -1)], limit=1)
    if not head:
        return None
    since = (today.replace(day=1) - timedelta(days=335)).replace(day=1)
    monthly = await timeseries(tenant_id, since, today + timedelta(days=1), metric="value", grain="month",
                               match=match)
    monthly_n = await timeseries(tenant_id, since, today + timedelta(days=1), metric="executions",
                                 grain="month", match=match)
    tot = await summary(tenant_id, None, None, doctor_id=doctor_id)
    pats = await repo.aggregate([{"$match": match}, {"$group": {
        "_id": "$patient_ref", "rx": {"$sum": 1}, "value": {"$sum": "$totals.total"},
        "last": {"$max": "$dispensed_at"}}}, {"$sort": {"value": -1}}, {"$limit": 200}])
    items = await repo.aggregate([{"$match": match}, {"$unwind": "$lines"},
        {"$match": {"lines.qty_disp": {"$gt": 0}}},
        {"$group": {"_id": {"$ifNull": ["$lines.barcode", "$lines.code"]},
                    "name": {"$last": "$lines.description"}, "times": {"$sum": 1},
                    "value": {"$sum": "$lines.amounts.total"}}},
        {"$sort": {"value": -1}}, {"$limit": 15}])
    cs = await ch.chains(tenant_id, today=today, match=match)
    names = await ch.names_of(tenant_id, {r["_id"] for r in pats if r["_id"]})
    d = head[0].get("doctor") or {}
    return {
        "doctor": {"id": doctor_id, "name": d.get("name"), "phones": d.get("phones") or []},
        "totals": tot,
        "open_prescriptions": sum(1 for c in cs if c["status"] not in ("closed", "lost")),
        "lost_prescriptions": sum(1 for c in cs if c["status"] == "lost"),
        "monthly": [{"bucket": a["bucket"], "value": a["value"], "executions": b["value"]}
                    for a, b in zip(monthly, monthly_n)],
        "patients": [{"patient_ref": r["_id"], "full_name": (names.get(r["_id"]) or {}).get("full_name"),
                      "rx": r["rx"], "value": r["value"], "last": r["last"]} for r in pats if r["_id"]],
        "items": [{"key": r["_id"], "name": r.get("name"), "times": r["times"], "value": r["value"]}
                  for r in items],
    }


# ── Κερδοφορία (χονδρική από την Αποθήκη) ─────────────────────────────────────

CY_VAT = {"drug": 5.0, "consumable": 19.0}   # Κύπρος: φάρμακα 5%, αναλώσιμα 19% (όπως το PharmacyOne)


async def profitability(tenant_id: str, date_from: date | None, date_to: date | None) -> dict[str, Any]:
    """Κέρδος = έσοδα ΧΩΡΙΣ ΦΠΑ − χονδρική (ίδιος κανόνας με την Ελλάδα, services/vat.py).

    Έσοδα = σύνολο γραμμής (ΟΑΥ + πελάτης). Χονδρική = `wholesale_cents` της Αποθήκης × τεμάχια,
    ταίριασμα με barcode. Το XML ΓεΣΥ δεν έχει χονδρική: όπου η Αποθήκη δεν την ξέρει, το είδος
    μετρά στα έσοδα αλλά ΟΧΙ στο κέρδος, και το λέμε («κάλυψη»). Ποτέ εκτίμηση."""
    from app.core.db import shared_db
    from app.services import vat
    rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        *([{"$match": window(date_from, date_to)}] if (date_from or date_to) else []),
        {"$unwind": "$lines"}, {"$match": {"lines.qty_disp": {"$gt": 0}}},
        {"$group": {"_id": {"$ifNull": ["$lines.barcode", "$lines.code"]},
                    "barcode": {"$last": "$lines.barcode"}, "name": {"$last": "$lines.description"},
                    "kind": {"$last": "$lines.kind"}, "units": {"$sum": "$lines.qty_disp"},
                    "revenue": {"$sum": "$lines.amounts.total"}, "times": {"$sum": 1}}}])
    bcs = [r["barcode"] for r in rows if r.get("barcode")]
    wh: dict[str, dict] = {}
    if bcs:
        async for p in shared_db()["pharmacy_products"].find(  # tenant-ok: tenant_id στο φίλτρο
                {"tenant_id": tenant_id, "barcode": {"$in": bcs}}, {"barcode": 1, "wholesale_cents": 1, "vat_rate": 1}):
            wh[p["barcode"]] = p
    items, tot = [], {"revenue": 0, "revenue_net": 0, "covered_revenue_net": 0, "cost": 0, "profit": 0}
    for r in rows:
        p = wh.get(r.get("barcode") or "") or {}
        pct = float(p["vat_rate"]) if p.get("vat_rate") is not None else CY_VAT.get(r.get("kind"), 5.0)
        net = round(vat.net(r["revenue"], pct))
        cost = int(p.get("wholesale_cents") or 0) * r["units"] if p.get("wholesale_cents") else None
        profit = net - cost if cost is not None else None
        items.append({"key": r["_id"], "barcode": r.get("barcode"), "name": r.get("name"), "kind": r.get("kind"),
                      "units": r["units"], "times": r["times"], "revenue": r["revenue"], "revenue_net": net,
                      "vat_pct": pct, "cost": cost, "profit": profit,
                      "margin_pct": round(100 * profit / net, 1) if profit is not None and net else None})
        tot["revenue"] += r["revenue"]
        tot["revenue_net"] += net
        if cost is not None:
            tot["covered_revenue_net"] += net
            tot["cost"] += cost
            tot["profit"] += profit
    items.sort(key=lambda i: (i["profit"] is None, -(i["profit"] or 0), -i["revenue"]))
    return {"totals": {**tot,
                       "margin_pct": round(100 * tot["profit"] / tot["covered_revenue_net"], 1) if tot["covered_revenue_net"] else None,
                       "coverage_pct": round(100 * tot["covered_revenue_net"] / tot["revenue_net"]) if tot["revenue_net"] else 0},
            "items": items, "missing_cost": sum(1 for i in items if i["cost"] is None)}
