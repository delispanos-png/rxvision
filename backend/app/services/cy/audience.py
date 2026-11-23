"""RxVision Κύπρος: «Ομάδες πελατών» — οι ΙΔΙΟΙ κανόνες με την Ελλάδα (`services/audience.py`: πεδία, τελεστές,
έτοιμες ομάδες, δικλείδα κλινικών), με τιμές από τα δεδομένα ΓεΣΥ. Επιστρέφει ψευδώνυμα ΓεΣΥ.

Πεδία που ΔΕΝ υπάρχουν στην Κύπρο (κατάσταση κύκλου ζωής της ΗΔΥΚΑ, περιοχή κατοικίας, ICD-10, «δεν ολοκλήρωσε
αγωγή») δεν προσφέρονται — και αν ζητηθούν, ο κανόνας ΑΠΟΡΡΙΠΤΕΤΑΙ (ποτέ σιωπηλά «όλοι»).
Αποστολή: μέσω `campaign_engine` με `only_ids` (ίδια συγκατάθεση/όριο/«ποτέ σε όποιον απεβίωσε»).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from app.repositories.cy import CyDispensingRepository, CyPatientRepository, find_all

UNSUPPORTED = frozenset({"lifecycle", "area", "icd10", "unfinished_therapy"})


def fields() -> dict[str, dict]:
    from app.services.audience import FIELDS
    out = {k: v for k, v in FIELDS.items() if k not in UNSUPPORTED}
    out["therapy_atc"] = {**out["therapy_atc"], "label": "Θεραπευτική κατηγορία (ATC, π.χ. A10 = διαβήτης)"}
    return out


def supported(rules: dict) -> bool:
    return not any(c.get("field") in UNSUPPORTED for c in (rules or {}).get("conditions") or [])


def _age_group(dob: Any, now: datetime) -> str | None:
    s = str(dob or "")
    if len(s) < 10 or not s[:4].isdigit():
        return None
    y, m, d = int(s[:4]), int(s[5:7]), int(s[8:10])
    a = now.year - y - ((now.month, now.day) < (m, d))
    for lo, hi, g in ((0, 17, "0-17"), (18, 34, "18-34"), (35, 49, "35-49"), (50, 64, "50-64"), (65, 74, "65-74")):
        if lo <= a <= hi:
            return g
    return "75+" if a >= 75 else None


async def resolve(tenant_id: str, conds: list[dict], *, match_all: bool, used: set, purpose: str) -> set[str]:
    from app.repositories.patient_portal import PatientAccountRepository
    from app.services.audience import _cmp, loyalty_maps
    bad = sorted(used & UNSUPPORTED)
    if bad:
        raise ValueError(f"unknown_field:{bad[0]}")
    now = datetime.now(tz=timezone.utc)
    stats = {r["_id"]: r for r in await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}, "v": {"$sum": "$totals.total"},
                    "last": {"$max": "$dispensed_at"}}}])}
    accounts = PatientAccountRepository()
    shell_to_pseudo: dict[str, str] = {}
    if used & {"is_loyalty", "loyalty_points", "orders_count", "days_since_order"}:
        shell_to_pseudo = await accounts.cy_shell_map(tenant_id)
    enrolled, points = await loyalty_maps(tenant_id, used)
    loyal = {shell_to_pseudo[r] for r in enrolled if r in shell_to_pseudo}
    pts = {shell_to_pseudo[r]: p for r, p in points.items() if r in shell_to_pseudo}
    portal = {m["cy_pseudo"] for m in await accounts.cy_members(tenant_id)} if "has_portal" in used else set()
    orders: dict[str, dict] = {}
    if used & {"orders_count", "days_since_order"}:
        from app.repositories.orders_delivery import OrdersDeliveryRepository
        for r in await OrdersDeliveryRepository(tenant_id=tenant_id).aggregate([
                {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}, "last": {"$max": "$created_at"}}}]):
            ps = shell_to_pseudo.get(str(r["_id"]))
            if ps:
                orders[ps] = r
    atc: dict[str, set[str]] = defaultdict(set)
    if purpose == "care" and "therapy_atc" in used:
        from app.services.cy import atc_link
        lk = await atc_link.lookup()
        for r in await CyDispensingRepository(tenant_id=tenant_id).aggregate([
                {"$unwind": "$lines"}, {"$match": {"lines.qty_disp": {"$gt": 0}}},
                {"$project": {"_id": 0, "p": "$patient_ref", "ln": "$lines"}}]):
            info = lk.for_line(r["ln"])
            if info and r.get("p"):
                atc[r["p"]].add(str(info.get("atc") or "").upper())

    def _aware(d):
        return d if not isinstance(d, datetime) or d.tzinfo else d.replace(tzinfo=timezone.utc)

    out: set[str] = set()
    for p in await find_all(CyPatientRepository(tenant_id=tenant_id),
                            {"erased": {"$ne": True}, "deceased.at": {"$exists": False}}):
        ps = p["pseudo_id"]
        st = stats.get(ps) or {}
        last = _aware(st.get("last") or p.get("last_seen"))
        n, v = int(st.get("n") or 0), int(st.get("v") or 0)
        o = orders.get(ps) or {}
        vals = {
            "days_since_visit": (now - last).days if isinstance(last, datetime) else None,
            "rx_count": n, "rx_value_total": v / 100, "avg_per_visit": (v / 100) / max(1, n),
            "age_group": _age_group(p.get("dob"), now),
            "has_portal": ps in portal, "is_loyalty": ps in loyal, "loyalty_points": pts.get(ps, 0),
            "orders_count": int(o.get("n") or 0),
            "days_since_order": (now - _aware(o["last"])).days if o.get("last") else None,
        }
        res = []
        for c in conds:
            if c.get("field") == "therapy_atc":
                want = str(c.get("value") or "").strip().upper()
                res.append(bool(want) and any(a.startswith(want) for a in atc.get(ps, ())))
            else:
                res.append(_cmp(c.get("op", "eq"), vals.get(c.get("field")), c.get("value")))
        if (all(res) if match_all else any(res)) if res else True:
            out.add(ps)
    return out
