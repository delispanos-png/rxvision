"""RxVision Κύπρος: οι ενεργές αγωγές του πελάτη ΓεΣΥ για το «Πρόγραμμα λήψης» της πύλης.

Ίδιο σχήμα «therapy» με την Ελλάδα (`PatientRxRepository.medication_schedule`), ώστε ΟΛΟ το υπόλοιπο
κύκλωμα να δουλεύει αυτούσιο: υπενθυμίσεις ανά ώρα, «✓ Το πήρα», σερί, πόντοι συμμόρφωσης,
προσωπικά σχήματα, ημερολόγιο ICS. Η μόνη διαφορά είναι η ΠΗΓΗ: η δοσολογία έρχεται από το XML
ΓεΣΥ (DosageAmount / DosageFrequency / DosageDurationDays), όχι από την ΗΔΥΚΑ.

Ό,τι δεν αναγνωρίζεται ΔΕΝ μαντεύεται: χωρίς συχνότητα → σχέδιο «unknown» (μία πρωινή δόση,
όπως και στην Ελλάδα) και ο πελάτης βλέπει δίπλα το κείμενο του γιατρού όπως γράφτηκε.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from app.repositories.cy import CyDispensingRepository
from app.services import med_schedule as ms

HORIZON_DAYS = 180   # ίδιο παράθυρο με την Ελλάδα
FALLBACK_ACTIVE_DAYS = 90


def _dt(v: Any) -> datetime | None:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def key_of(line: dict) -> str | None:
    """Ταυτότητα φαρμάκου για πρόγραμμα λήψης & συνέπεια: ο κωδικός ΓεΣΥ ΧΩΡΙΣ την κατάληξη συσκευασίας."""
    from app.services.cy.atc_link import norm_code
    ident = norm_code(line.get("code")) or str(line.get("barcode") or "").strip() or line.get("description")
    return f"cy:{ident}" if ident else None


def plan_for(per_day: float | None, timing: str | None = None) -> dict:
    """Δόσεις/ημέρα του ΓεΣΥ → σχέδιο λήψης στο ίδιο σχήμα με `med_schedule.frequency_plan`."""
    if not per_day or per_day <= 0:
        return ms.frequency_plan(None)                       # unknown → όπως στην Ελλάδα
    if per_day >= 1:
        n = max(1, min(4, round(per_day)))
        plan = ms.frequency_plan(f"{round(24 / n)} h")
        t = (timing or "").lower()
        if n == 1 and any(w in t for w in ("evening", "night", "bed", "dinner", "βράδ", "νύχτ", "ύπνο", "δείπν")):
            plan = {**plan, "slots": ["evening"]}            # «1 το βράδυ» → βραδινή δόση
        return plan
    per_week = per_day * 7
    if per_week >= 1:
        times = max(1, min(4, round(per_week)))
        return {"kind": "weekly", "per_day": 1, "days": ms._WEEKLY_DAYS.get(times, [0]),
                "slots": ["morning"], "times_per_week": times}
    return ms.frequency_plan(f"{max(1, round(1 / (per_day * 30)))} mo")


def _dosage_text(dose: dict) -> str | None:
    parts = [dose.get("raw_amount"), dose.get("raw_frequency")]
    if dose.get("duration_days"):
        parts.append(f"για {dose['duration_days']} ημέρες")
    if dose.get("timing"):
        parts.append(str(dose["timing"]))
    return " · ".join(str(p) for p in parts if p) or None


async def therapies(tenant_id: str, cy_pseudo: str, now: datetime | None = None) -> dict[str, dict]:
    """med_key → therapy, για όσα σκευάσματα ο πελάτης ΠΗΡΕ και η αγωγή τους τρέχει ακόμη.
    Κρατά μόνο την πιο πρόσφατη εκτέλεση ανά σκεύασμα. Αναλώσιμα (ταινίες κ.λπ.) δεν μπαίνουν."""
    from app.services.cy.atc_link import lookup
    lk = await lookup()
    now = now or datetime.now(tz=timezone.utc)
    disp = await CyDispensingRepository(tenant_id=tenant_id).find(
        {"patient_ref": cy_pseudo, "dispensed_at": {"$gte": now - timedelta(days=HORIZON_DAYS)}},
        sort=[("dispensed_at", -1)], limit=500)
    out: dict[str, dict] = {}
    for d in disp:
        at = _dt(d.get("dispensed_at"))
        for ln in d.get("lines") or []:
            if ln.get("kind") != "drug" or not ln.get("qty_disp"):
                continue
            # ΙΔΙΟ φάρμακο σε άλλη συσκευασία («2300316/1» και «/2») = ΜΙΑ αγωγή (έβγαινε διπλό, 18/11/2026)
            ident = key_of(ln)
            if not ident:
                continue
            key = ident
            if key in out:
                continue
            dose = ln.get("dosage") or {}
            days = ln.get("days_covered") or dose.get("duration_days")
            ro = (at + timedelta(days=int(days))) if (at and days) else None
            active = (ro >= now) if ro else bool(at and at >= now - timedelta(days=FALLBACK_ACTIVE_DAYS))
            if not active:
                continue
            plan = plan_for(dose.get("per_day"), dose.get("timing"))
            out[key] = {
                "med_key": key, "name": ln.get("description") or "Φάρμακο", "eof": None,
                "atc": (info := lk.for_line(ln) or {}).get("atc"),   # για Διατροφή / αλληλεπιδράσεις
                "substance": info.get("substance"),   # δραστική: ο έλεγχος αλληλεπιδράσεων δουλεύει με αυτή
                "dose": dose.get("raw_amount"), "dosage_text": _dosage_text(dose),
                "plan": plan, "kind": plan["kind"], "per_day": plan["per_day"],
                "runout": ro, "last_dispensed": at, "days_left": ((ro - now).days if ro else None)}
    return out
