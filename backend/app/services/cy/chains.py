"""Αλυσίδες συνταγών ΓεΣΥ — ο ΕΝΑΣ ορισμός για «ανοιχτή», «αναμένεται», «καθυστερεί», «χάθηκε».

Τον χρησιμοποιούν ΟΛΕΣ οι οθόνες (Επισκόπηση, Ανοιχτές συνταγές, Χαμένοι πελάτες) — αλλιώς οι
αριθμοί θα διέφεραν από οθόνη σε οθόνη (μάθημα από την Ελλάδα: «ένας ορισμός»).

Μία συνταγή (PrescriptionId) εκτελείται σε `instances` φάσεις. Από τις εκτελέσεις που βλέπουμε σε ΕΜΑΣ:
- `instance` = η μεγαλύτερη φάση που εκτελέστηκε εδώ· `closed` όταν instance ≥ instances.
- Επόμενη επίσκεψη = τελευταία εκτέλεση + διάστημα. Διάστημα = η μεγαλύτερη `DosageDurationDays`
  των γραμμών (συνήθως 28)· αν λείπει (π.χ. αναλώσιμα), DEFAULT_INTERVAL.

ΥΠΟΘΕΣΕΙΣ ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ στην πύλη (Discovery): ότι οι φάσεις έχουν σταθερό διάστημα και ότι μια
φάση που δεν εκτελέστηκε «χάνεται». Τα όρια ζουν ΕΔΩ μόνο — αλλάζουν σε ένα σημείο.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.repositories.cy import CyDispensingRepository, CyPatientRepository

TZ = ZoneInfo("Asia/Nicosia")
# Προεπιλογές. Οι ΙΣΧΥΟΥΣΕΣ τιμές έρχονται από το adminpanel (gate.cy_rules) σε κάθε υπολογισμό.
DEFAULT_INTERVAL = {"drug": 28, "consumable": 30}
LOST_AFTER_DAYS = 14  # τόσες ημέρες μετά την αναμενόμενη επίσκεψη → «χάθηκε»
SOON_DAYS = 7         # αναμένεται μέσα στις επόμενες 7 ημέρες → «έρχεται σύντομα»

STATUS_ORDER = ("late", "soon", "upcoming", "lost", "closed")


def local_day(dt: datetime) -> date:
    return dt.astimezone(TZ).date()


def classify(*, instance: int, instances: int, due: date, today: date,
             lost_after: int = LOST_AFTER_DAYS, soon: int = SOON_DAYS) -> str:
    if instance >= instances:
        return "closed"
    overdue = (today - due).days
    if overdue > lost_after:
        return "lost"
    if overdue > 0:
        return "late"
    if -overdue <= soon:
        return "soon"
    return "upcoming"


async def chains(tenant_id: str, *, today: date | None = None,
                 match: dict | None = None) -> list[dict[str, Any]]:
    """Μία εγγραφή ανά συνταγή, με κατάσταση και αναμενόμενη επόμενη επίσκεψη."""
    from app.services.cy.gate import cy_rules
    today = today or datetime.now(tz=TZ).date()
    rules = await cy_rules()
    default_interval = {"drug": rules["drug_interval_days"], "consumable": rules["consumable_interval_days"]}
    rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        *([{"$match": match}] if match else []),
        {"$sort": {"dispensed_at": 1}},
        {"$group": {
            "_id": "$prescription_id",
            "kind": {"$last": "$kind"},
            "patient_ref": {"$last": "$patient_ref"},
            "doctor": {"$last": "$doctor.name"},
            "last_at": {"$last": "$dispensed_at"},
            "first_at": {"$first": "$dispensed_at"},
            "instance": {"$max": "$instance"},
            "first_instance": {"$min": "$instance"},
            "instances": {"$max": "$instances"},
            "durations": {"$last": "$lines.dosage.duration_days"},
            "items": {"$last": "$lines.description"},
            "visits": {"$sum": 1},
            "value": {"$sum": "$totals.total"},
        }},
    ])
    out = []
    for r in rows:
        last_at = r["last_at"] if isinstance(r["last_at"], datetime) else datetime.fromisoformat(str(r["last_at"]))
        durs = [d for d in (r.get("durations") or []) if isinstance(d, int) and d > 0]
        interval = max(durs) if durs else default_interval.get(r.get("kind"), rules["drug_interval_days"])
        due = local_day(last_at) + timedelta(days=interval)
        instance, instances = int(r.get("instance") or 0), int(r.get("instances") or 0)
        remaining = max(0, instances - instance)
        avg = round((r.get("value") or 0) / max(1, r.get("visits") or 1))
        out.append({
            "prescription_id": r["_id"], "kind": r.get("kind"), "patient_ref": r.get("patient_ref"),
            "doctor": r.get("doctor"), "last_at": last_at, "first_at": r.get("first_at"),
            "first_instance": int(r.get("first_instance") or instance), "visits": r.get("visits") or 0,
            "next_due": due.isoformat(),
            "days_to_due": (due - today).days, "interval_days": interval,
            "instance": instance, "instances": instances, "remaining": remaining,
            "items": [i for i in (r.get("items") or []) if i][:6],
            "avg_value_cents": avg, "value_at_stake_cents": avg * remaining,
            "lost_after_days": rules["lost_after_days"],
            "status": classify(instance=instance, instances=instances, due=due, today=today,
                               lost_after=rules["lost_after_days"], soon=rules["soon_days"]),
        })
    return out


def adherence(cs: list[dict[str, Any]], today: date) -> dict[str, Any]:
    """Συμμόρφωση πελάτη = φάσεις που εκτέλεσε ΕΔΩ / φάσεις που έπρεπε να είχε εκτελέσει ως σήμερα.

    Μετράμε από την πρώτη φάση που είδαμε εδώ (ό,τι έγινε πριν, αλλού, δεν μας αφορά). Μια φάση
    «έπρεπε να γίνει» όταν πέρασε η ημερομηνία της ΚΑΙ το περιθώριο LOST_AFTER_DAYS: ίδιο όριο με
    το «χάθηκε», ώστε μια συνταγή που απλώς καθυστερεί λίγο να μη ρίχνει τη συμμόρφωση."""
    expected = done = 0
    for c in cs:
        if not c.get("instances") or not c.get("first_at"):
            continue
        first = c["first_at"] if isinstance(c["first_at"], datetime) else datetime.fromisoformat(str(c["first_at"]))
        elapsed = (today - local_day(first)).days - c.get("lost_after_days", LOST_AFTER_DAYS) - 1
        possible = c["instances"] - c["first_instance"] + 1
        exp = min(possible, 1 + (elapsed // c["interval_days"] if elapsed >= 0 else 0))
        got = min(possible, c["visits"])   # φάσεις που εκτελέστηκαν ΕΔΩ (μία εκτέλεση = μία φάση)
        expected += exp
        done += min(got, exp)
    open_ = [c for c in cs if c["status"] in ("soon", "upcoming", "late")]
    return {
        "compliance": round(100 * done / expected) if expected else None,
        "missed": expected - done,
        "open": len(open_),
        "lost_value_cents": sum(c["value_at_stake_cents"] for c in cs if c["status"] == "lost"),
        "next_due": min((c["next_due"] for c in open_), default=None),
    }


async def names_of(tenant_id: str, refs: set[str]) -> dict[str, dict]:
    if not refs:
        return {}
    pats = await CyPatientRepository(tenant_id=tenant_id).find(
        {"pseudo_id": {"$in": list(refs)}}, limit=min(500, len(refs)))
    found = {p["pseudo_id"]: p for p in pats}
    missing = [r for r in refs if r not in found]
    # >500 πελάτες: δεύτερο πέρασμα σε κομμάτια (το find έχει ανώτατο όριο σελίδας)
    for i in range(0, len(missing), 500):
        for p in await CyPatientRepository(tenant_id=tenant_id).find(
                {"pseudo_id": {"$in": missing[i:i + 500]}}, limit=500):
            found[p["pseudo_id"]] = p
    return found


async def open_prescriptions(tenant_id: str, *, status: str | None = None,
                             today: date | None = None) -> dict[str, Any]:
    allc = [c for c in await chains(tenant_id, today=today) if c["status"] != "closed"]
    counts = {s: sum(1 for c in allc if c["status"] == s) for s in STATUS_ORDER if s != "closed"}
    items = [c for c in allc if not status or c["status"] == status]
    items.sort(key=lambda c: (STATUS_ORDER.index(c["status"]), c["days_to_due"]))
    names = await names_of(tenant_id, {c["patient_ref"] for c in items if c["patient_ref"]})
    for c in items:
        p = names.get(c["patient_ref"]) or {}
        c["patient_name"] = p.get("full_name")
        c["patient_dob"] = p.get("dob")
    return {"counts": counts, "total": len(allc), "items": items}


async def lost_customers(tenant_id: str, *, today: date | None = None) -> dict[str, Any]:
    """Πελάτες με τουλάχιστον μία «χαμένη» συνταγή.

    - `lost`: δεν ξαναήρθαν ΚΑΘΟΛΟΥ μετά την ημέρα που περιμέναμε την πρώτη χαμένη συνταγή.
    - `leak`: έρχονται ακόμη για άλλες συνταγές — αυτή όμως εκτελείται αλλού ή σταμάτησε.
    """
    allc = await chains(tenant_id, today=today)
    by_patient: dict[str, list[dict]] = {}
    for c in allc:
        if c["patient_ref"]:
            by_patient.setdefault(c["patient_ref"], []).append(c)
    items = []
    for ref, cs in by_patient.items():
        lost = [c for c in cs if c["status"] == "lost"]
        if not lost:
            continue
        last_visit = max(c["last_at"] for c in cs)
        first_lost_due = min(date.fromisoformat(c["next_due"]) for c in lost)
        kind = "lost" if local_day(last_visit) < first_lost_due else "leak"
        items.append({
            "patient_ref": ref, "kind": kind, "last_visit": last_visit,
            "days_since_visit": ((today or datetime.now(tz=TZ).date()) - local_day(last_visit)).days,
            "lost_prescriptions": len(lost),
            "value_at_stake_cents": sum(c["value_at_stake_cents"] for c in lost),
            "monthly_value_cents": sum(c["avg_value_cents"] for c in lost),
            "doctors": sorted({c["doctor"] for c in lost if c["doctor"]}),
            "items": sorted({i for c in lost for i in c["items"]})[:8],
        })
    items.sort(key=lambda x: (x["kind"] != "lost", -x["monthly_value_cents"]))
    names = await names_of(tenant_id, {i["patient_ref"] for i in items})
    for i in items:
        p = names.get(i["patient_ref"]) or {}
        i["patient_name"] = p.get("full_name")
        i["patient_dob"] = p.get("dob")
    summary = {
        "lost": sum(1 for i in items if i["kind"] == "lost"),
        "leak": sum(1 for i in items if i["kind"] == "leak"),
        "monthly_value_cents": sum(i["monthly_value_cents"] for i in items),
        "value_at_stake_cents": sum(i["value_at_stake_cents"] for i in items),
    }
    from app.services.cy.gate import cy_rules
    return {"summary": summary, "items": items, "lost_after_days": (await cy_rules())["lost_after_days"]}


async def overview(tenant_id: str, *, today: date | None = None) -> dict[str, Any]:
    """Σύνολα + καταστάσεις συνταγών από τον ΙΔΙΟ ορισμό που βλέπουν οι υπόλοιπες οθόνες."""
    o = await CyDispensingRepository(tenant_id=tenant_id).overview()
    cs = await chains(tenant_id, today=today)
    open_ = [c for c in cs if c["status"] != "closed"]
    o["open_prescriptions"] = len(open_)
    o["chains"] = {s: sum(1 for c in cs if c["status"] == s) for s in STATUS_ORDER}
    lost = await lost_customers(tenant_id, today=today)
    o["lost_customers"] = lost["summary"]
    return o
