"""Κυπριακές οθόνες ανάλυσης πάνω στα XML ΓεΣΥ: καρτέλα πελάτη, μη εκτελεσμένα είδη, διαφορά τιμής.

Οι καταστάσεις συνταγών (ανοιχτή/χαμένη) έρχονται ΠΑΝΤΑ από `chains.py` — ένας ορισμός.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Any

from app.repositories.cy import CyDispensingRepository, CyPatientRepository
from app.services.cy import chains as ch

# Αναλώσιμα που μαρτυρούν διαβήτη (ταινίες γλυκόζης, σκαρφιστήρες). Υποκατάστατο διάγνωσης —
# το XML ΓεΣΥ δεν έχει ICD-10.
_DIABETES = re.compile(r"ταινί|strip|σκαρφιστ|lancet|γλυκοζ|γλυκόζ|glucose|glucometer", re.I)


def exemption(dispensings: list[dict]) -> str:
    """«exempt» αν σε ΚΑΘΕ είδος που δόθηκε η συμμετοχή ήταν 0 € · «pays» αν πλήρωσε έστω μία
    φορά · «unknown» αν δεν δόθηκε ποτέ τίποτα. (Το XML δεν λέει ρητά την κατηγορία δικαιούχου.)"""
    given = [ln for d in dispensings for ln in d.get("lines") or [] if ln.get("qty_disp")]
    if not given:
        return "unknown"
    return "exempt" if all(ln["amounts"]["copay"] == 0 for ln in given) else "pays"


def is_diabetic(dispensings: list[dict]) -> bool:
    return any(ln.get("kind") == "consumable" and _DIABETES.search(ln.get("description") or "")
               for d in dispensings for ln in d.get("lines") or [])


async def patient_card(tenant_id: str, ref: str, *, today: date | None = None) -> dict[str, Any] | None:
    p = await CyPatientRepository(tenant_id=tenant_id).find_one({"pseudo_id": ref})
    if not p:
        return None
    disp = await CyDispensingRepository(tenant_id=tenant_id).find(
        {"patient_ref": ref}, sort=[("dispensed_at", -1)], limit=500)
    cs = await ch.chains(tenant_id, today=today, match={"patient_ref": ref})
    totals = {k: sum((d.get("totals") or {}).get(k, 0) for d in disp)
              for k in ("hio", "beneficiary", "pc2", "total")}
    doctors: dict[str, dict[str, Any]] = {}
    for d in disp:
        doc = d.get("doctor") or {}
        k = doc.get("id") or doc.get("name")
        if k:
            e = doctors.setdefault(k, {"id": doc.get("id"), "name": doc.get("name") or k, "visits": 0})
            e["visits"] += 1
    today = today or datetime.now(tz=ch.TZ).date()
    return {
        **await _profile(tenant_id, ref, disp, cs, totals["total"], today),
        "patient": {"ref": ref, "full_name": p.get("full_name"), "gender": p.get("gender"),
                    "dob": p.get("dob"), "hio_code": p.get("hio_code"),
                    "first_seen": p.get("first_seen"), "last_seen": p.get("last_seen")},
        "flags": {"exemption": exemption(disp), "diabetic": is_diabetic(disp)},
        "totals": {**totals, "visits": len(disp)},
        "doctors": sorted(doctors.values(), key=lambda x: -x["visits"]),
        "prescriptions": sorted(cs, key=lambda c: (ch.STATUS_ORDER.index(c["status"]), c["days_to_due"])),
        "history": [{
            "dispensing_id": d["dispensing_id"], "prescription_id": d["prescription_id"],
            "kind": d["kind"], "dispensed_at": d["dispensed_at"], "doctor": (d.get("doctor") or {}).get("name"),
            "instance": d.get("instance"), "instances": d.get("instances"), "totals": d.get("totals"),
            "lines": [{"description": ln.get("description"), "qty_presc": ln.get("qty_presc"),
                       "qty_disp": ln.get("qty_disp"), "total": ln["amounts"]["total"],
                       "pc2": ln["amounts"]["pc2"], "days_covered": ln.get("days_covered")}
                      for ln in d.get("lines") or []],
        } for d in disp],
    }


def _day(v: Any) -> date:
    return ch.local_day(v if isinstance(v, datetime) else datetime.fromisoformat(str(v)))


async def _profile(tenant_id: str, ref: str, disp: list[dict], cs: list[dict], ltv: int,
                   today: date) -> dict[str, Any]:
    """Τα στοιχεία της ελληνικής «Εικόνας Πελάτη», από τα δεδομένα ΓεΣΥ: δείκτες, μηνιαία πορεία,
    συμμόρφωση, συχνότερα σκευάσματα, κατάταξη αξίας."""
    days = sorted(_day(d["dispensed_at"]) for d in disp)
    months = max(1.0, ((today - days[0]).days / 30.44)) if days else 1.0
    this_month = sum(1 for x in days if (x.year, x.month) == (today.year, today.month))
    # μηνιαία πορεία 12 μηνών (κενοί μήνες = 0)
    keys, m = [], today.replace(day=1)
    for _ in range(12):
        keys.append(m.strftime("%Y-%m"))
        m = (m - timedelta(days=1)).replace(day=1)
    per: dict[str, list[int]] = {k: [0, 0] for k in keys}
    for d in disp:
        k = _day(d["dispensed_at"]).strftime("%Y-%m")
        if k in per:
            per[k][0] += 1
            per[k][1] += (d.get("totals") or {}).get("total", 0)
    # συχνότερα σκευάσματα: πόσες φορές, πότε τελευταία, η τελευταία δοσολογία
    meds: dict[str, dict[str, Any]] = {}
    for d in disp:   # το disp είναι ταξινομημένο από το νεότερο → η 1η εμφάνιση = η τελευταία λήψη
        for ln in d.get("lines") or []:
            if not ln.get("qty_disp"):
                continue
            k = ln.get("barcode") or ln.get("code") or ln.get("description")
            m_ = meds.setdefault(k, {"name": ln.get("description"), "kind": ln.get("kind"), "times": 0,
                                     "value": 0, "last": d["dispensed_at"],
                                     "dosage": " ".join(x for x in (
                                         (ln.get("dosage") or {}).get("raw_amount"),
                                         (ln.get("dosage") or {}).get("raw_frequency")) if x) or None})
            m_["times"] += 1
            m_["value"] += ln["amounts"]["total"]
    for m_ in meds.values():
        m_["days_since"] = (today - _day(m_["last"])).days
    # κατάταξη αξίας μέσα στο φαρμακείο (όπως «Κατάταξη αξίας» στην Ελλάδα)
    ranks = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        {"$group": {"_id": "$patient_ref", "v": {"$sum": "$totals.total"}}},
        {"$group": {"_id": None, "of": {"$sum": 1}, "above": {"$sum": {"$cond": [{"$gt": ["$v", ltv]}, 1, 0]}}}}])
    r = ranks[0] if ranks else {"of": 0, "above": 0}
    return {
        "kpis": {"ltv": ltv, "visits": len(disp), "per_month": round(len(disp) / months, 1),
                 "value_per_month": round(ltv / months), "this_month": this_month,
                 "gap_days": (today - days[-1]).days if days else None,
                 "rank": {"rank": r["above"] + 1, "of": r["of"]} if r["of"] else None},
        "monthly": [{"month": k, "visits": per[k][0], "value": per[k][1]} for k in reversed(keys)],
        "adherence": ch.adherence(cs, today),
        "medicines": sorted(meds.values(), key=lambda x: (-x["times"], x["days_since"]))[:12],
    }


async def not_dispensed(tenant_id: str) -> dict[str, Any]:
    """Είδη που συνταγογραφήθηκαν αλλά ΔΕΝ δόθηκαν (QtyDisp = 0), ανά σκεύασμα.

    - `mid`: στη μέση της συνταγής → πιθανή έλλειψη αποθέματος (αξίζει παραγγελία)
    - `last`: στην τελευταία φάση → οριστικά χαμένη πώληση
    Αξία = τεμάχια που δεν δόθηκαν × τιμή μονάδας από τις φορές που το ΙΔΙΟ είδος δόθηκε εδώ.
    """
    rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        {"$unwind": "$lines"},
        {"$group": {
            "_id": {"$ifNull": ["$lines.barcode", "$lines.code"]},
            "description": {"$last": "$lines.description"},
            "kind": {"$last": "$lines.kind"},
            "units_given": {"$sum": "$lines.qty_disp"},
            "value_given": {"$sum": "$lines.amounts.total"},
            "mid": {"$sum": {"$cond": [{"$and": [{"$eq": ["$lines.qty_disp", 0]},
                                                  {"$lt": ["$lines.instance", "$lines.instances"]}]}, 1, 0]}},
            "last": {"$sum": {"$cond": [{"$and": [{"$eq": ["$lines.qty_disp", 0]},
                                                   {"$gte": ["$lines.instance", "$lines.instances"]}]}, 1, 0]}},
            "units_missed": {"$sum": {"$cond": [{"$eq": ["$lines.qty_disp", 0]}, "$lines.qty_presc", 0]}},
            "patients": {"$addToSet": {"$cond": [{"$eq": ["$lines.qty_disp", 0]}, "$patient_ref", None]}},
        }},
        {"$match": {"$expr": {"$gt": [{"$add": ["$mid", "$last"]}, 0]}}},
    ])
    items = []
    for r in rows:
        unit = round(r["value_given"] / r["units_given"]) if r["units_given"] else None
        items.append({
            "key": r["_id"], "description": r.get("description"), "kind": r.get("kind"),
            "mid": r["mid"], "last": r["last"], "units_missed": r["units_missed"],
            "patients": len([x for x in r.get("patients") or [] if x]),
            "unit_price_cents": unit,
            "value_missed_cents": (unit or 0) * r["units_missed"],
        })
    items.sort(key=lambda x: (-x["value_missed_cents"], -(x["mid"] + x["last"])))
    return {
        "summary": {"products": len(items), "mid": sum(i["mid"] for i in items),
                    "last": sum(i["last"] for i in items),
                    "value_missed_cents": sum(i["value_missed_cents"] for i in items),
                    "unpriced": sum(1 for i in items if i["unit_price_cents"] is None)},
        "items": items,
    }


async def pc2(tenant_id: str, *, days: int = 90, today: date | None = None) -> dict[str, Any]:
    """Διαφορά τιμής (PC2): ό,τι πληρώνει ο πελάτης επειδή πήρε σκεύασμα ακριβότερο από την τιμή
    αναφοράς του ΟΑΥ. Τελευταίες `days` ημέρες, ανά σκεύασμα και ανά πελάτη."""
    today = today or datetime.now(tz=ch.TZ).date()
    since = datetime.combine(today - timedelta(days=days), datetime.min.time(), tzinfo=ch.TZ)
    base = [{"$match": {"dispensed_at": {"$gte": since}}}, {"$unwind": "$lines"},
            {"$match": {"lines.amounts.pc2": {"$gt": 0}}}]
    repo = CyDispensingRepository(tenant_id=tenant_id)
    by_product = await repo.aggregate([*base, {"$group": {
        "_id": {"$ifNull": ["$lines.barcode", "$lines.code"]},
        "description": {"$last": "$lines.description"},
        "pc2": {"$sum": "$lines.amounts.pc2"}, "times": {"$sum": 1},
        "patients": {"$addToSet": "$patient_ref"}}}, {"$sort": {"pc2": -1}}])
    by_patient = await repo.aggregate([*base, {"$group": {
        "_id": "$patient_ref", "pc2": {"$sum": "$lines.amounts.pc2"}, "times": {"$sum": 1},
        "products": {"$addToSet": "$lines.description"}}}, {"$sort": {"pc2": -1}}])
    names = await ch.names_of(tenant_id, {r["_id"] for r in by_patient if r["_id"]})
    total = sum(r["pc2"] for r in by_product)
    return {
        "days": days, "total_cents": total,
        "monthly_cents": round(total * 30 / days),
        "patients": len(by_patient),
        "by_product": [{"key": r["_id"], "description": r.get("description"), "pc2_cents": r["pc2"],
                        "times": r["times"], "patients": len(r.get("patients") or [])} for r in by_product],
        "by_patient": [{"patient_ref": r["_id"], "patient_name": (names.get(r["_id"]) or {}).get("full_name"),
                        "pc2_cents": r["pc2"], "times": r["times"],
                        "products": sorted(r.get("products") or [])[:5]} for r in by_patient],
    }


# ── Βήμα 4: γιατροί, υπάλληλοι, αναλώσιμα/διαβητικοί, ανάκληση παρτίδας ──────

def _since(days: int, today: date | None) -> datetime:
    today = today or datetime.now(tz=ch.TZ).date()
    return datetime.combine(today - timedelta(days=days), datetime.min.time(), tzinfo=ch.TZ)


async def doctors(tenant_id: str, *, days: int = 365, today: date | None = None,
                  date_from: date | None = None, date_to: date | None = None) -> dict[str, Any]:
    """Ποιοι γιατροί συνταγογραφούν στους πελάτες μου και τι αξία φέρνουν: στην περίοδο του φίλτρου
    ή, χωρίς φίλτρο, στις τελευταίες `days` ημέρες. Το XML δεν έχει ειδικότητα (μόνο κωδικό,
    όνομα και τηλέφωνα)."""
    from app.services.cy.analytics import window
    match = window(date_from, date_to) if (date_from or date_to) else {
        "dispensed_at": {"$gte": _since(days, today)}}
    rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        {"$match": match},
        {"$group": {"_id": "$doctor.id", "name": {"$last": "$doctor.name"},
                    "phones": {"$last": "$doctor.phones"}, "dispensings": {"$sum": 1},
                    "prescriptions": {"$addToSet": "$prescription_id"},
                    "patients": {"$addToSet": "$patient_ref"},
                    "total": {"$sum": "$totals.total"}, "hio": {"$sum": "$totals.hio"},
                    "items": {"$push": "$lines.description"}}},
        {"$sort": {"total": -1}}])
    grand = sum(r["total"] for r in rows) or 1
    out = []
    for r in rows:
        counts: dict[str, int] = {}
        for lst in r.get("items") or []:
            for d in lst or []:
                counts[d] = counts.get(d, 0) + 1
        out.append({"doctor_id": r["_id"], "name": r.get("name"), "phones": r.get("phones") or [],
                    "dispensings": r["dispensings"], "prescriptions": len(r.get("prescriptions") or []),
                    "patients": len(r.get("patients") or []), "total_cents": r["total"],
                    "hio_cents": r["hio"], "share_pct": round(100 * r["total"] / grand, 1),
                    "top_items": [k for k, _ in sorted(counts.items(), key=lambda x: -x[1])[:5]]})
    return {"days": days, "items": out}


async def staff(tenant_id: str, *, days: int = 90, today: date | None = None) -> dict[str, Any]:
    """Εκτελέσεις ανά χρήστη της πύλης ΓεΣΥ (UserDetails του XML)."""
    rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        {"$match": {"dispensed_at": {"$gte": _since(days, today)}}},
        {"$group": {"_id": "$user.username", "name": {"$last": "$user.name"},
                    "dispensings": {"$sum": 1}, "total": {"$sum": "$totals.total"},
                    "lines": {"$sum": {"$size": {"$ifNull": ["$lines", []]}}},
                    "first": {"$min": "$dispensed_at"}, "last": {"$max": "$dispensed_at"}}},
        {"$sort": {"dispensings": -1}}])
    return {"days": days, "items": [{
        "username": r["_id"], "name": r.get("name"), "dispensings": r["dispensings"],
        "lines": r["lines"], "total_cents": r["total"], "first": r.get("first"), "last": r.get("last"),
    } for r in rows]}


async def consumables(tenant_id: str, *, today: date | None = None) -> dict[str, Any]:
    """Αναλώσιμα (Type 02) ανά είδος + οι πελάτες που τα παίρνουν, με την κατάσταση της συνταγής τους.
    Ταινίες γλυκόζης / σκαρφιστήρες → «διαβητικός» (υποκατάστατο διάγνωσης, το XML δεν έχει ICD-10)."""
    repo = CyDispensingRepository(tenant_id=tenant_id)
    by_item = await repo.aggregate([
        {"$match": {"kind": "consumable"}}, {"$unwind": "$lines"},
        {"$group": {"_id": "$lines.code", "description": {"$last": "$lines.description"},
                    "times": {"$sum": 1}, "units": {"$sum": "$lines.qty_disp"},
                    "total": {"$sum": "$lines.amounts.total"},
                    "patients": {"$addToSet": "$patient_ref"}}},
        {"$sort": {"total": -1}}])
    per_patient = await repo.aggregate([
        {"$match": {"kind": "consumable"}}, {"$unwind": "$lines"},
        {"$group": {"_id": "$patient_ref", "last": {"$max": "$dispensed_at"},
                    "descriptions": {"$addToSet": "$lines.description"},
                    "total": {"$sum": "$lines.amounts.total"}}}])
    cs = await ch.chains(tenant_id, today=today, match={"kind": "consumable"})
    status: dict[str, str] = {}
    for c in cs:   # η «χειρότερη» κατάσταση ανά πελάτη: χάθηκε > καθυστερεί > σύντομα > αναμένεται > κλειστή
        cur = status.get(c["patient_ref"])
        order = ["lost", "late", "soon", "upcoming", "closed"]
        if cur is None or order.index(c["status"]) < order.index(cur):
            status[c["patient_ref"]] = c["status"]
    names = await ch.names_of(tenant_id, {r["_id"] for r in per_patient if r["_id"]})
    patients = [{
        "patient_ref": r["_id"], "patient_name": (names.get(r["_id"]) or {}).get("full_name"),
        "diabetic": any(_DIABETES.search(d or "") for d in r.get("descriptions") or []),
        "last": r["last"], "total_cents": r["total"], "status": status.get(r["_id"], "closed"),
        "items": sorted(r.get("descriptions") or [])[:4],
    } for r in per_patient]
    patients.sort(key=lambda p: (["lost", "late", "soon", "upcoming", "closed"].index(p["status"]),
                                 -p["total_cents"]))
    return {
        "summary": {"patients": len(patients), "diabetic": sum(1 for p in patients if p["diabetic"]),
                    "late": sum(1 for p in patients if p["status"] in ("late", "lost"))},
        "items": [{"code": r["_id"], "description": r.get("description"), "times": r["times"],
                   "units": r["units"], "total_cents": r["total"],
                   "patients": len(r.get("patients") or [])} for r in by_item],
        "patients": patients,
    }


async def recall(tenant_id: str, *, lot: str, gtin: str | None = None) -> dict[str, Any]:
    """Ανάκληση παρτίδας: ποιοι πελάτες πήραν τη συγκεκριμένη παρτίδα (από το EMVS του XML).
    Η παρτίδα κρατιέται χωρίς σειριακό — αρκεί για ανάκληση, δεν αναγνωρίζει μεμονωμένο κουτί."""
    lot = (lot or "").strip()
    if not lot:
        return {"lot": lot, "items": []}
    match: dict[str, Any] = {"lot": lot}
    if gtin:
        match["gtin"] = gtin.strip()
    rows = await CyDispensingRepository(tenant_id=tenant_id).find(
        {"lines.emvs": {"$elemMatch": match}}, sort=[("dispensed_at", -1)], limit=500)
    names = await ch.names_of(tenant_id, {r["patient_ref"] for r in rows if r.get("patient_ref")})
    items = []
    for r in rows:
        for ln in r.get("lines") or []:
            packs = [e for e in ln.get("emvs") or []
                     if e.get("lot") == lot and (not gtin or e.get("gtin") == gtin.strip())]
            if packs:
                items.append({
                    "dispensed_at": r["dispensed_at"], "patient_ref": r.get("patient_ref"),
                    "patient_name": (names.get(r.get("patient_ref")) or {}).get("full_name"),
                    "description": ln.get("description"), "gtin": packs[0].get("gtin"),
                    "expiry": packs[0].get("expiry"), "packs": len(packs),
                    "doctor": (r.get("doctor") or {}).get("name")})
    return {"lot": lot, "gtin": gtin, "patients": len({i["patient_ref"] for i in items}),
            "packs": sum(i["packs"] for i in items), "items": items}
