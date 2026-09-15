"""Convert the doctor's ΗΔΥΚΑ posology (dose / frequency / duration, as stored on
prescription_items.details) into a concrete intake plan: how many doses, on which weekdays,
in which time-slots, plus the predicted run-out date. Pure functions — no DB, easy to test.

The frequency strings follow the ΗΔΥΚΑ CDA PIVL_TS convention (e.g. «8 h» = every 8h = 3×/day,
«1 d» = once/day, «2 d» = 3×/week, «4 d» = 2×/week, «1 wk» = once/week, «1 once» = single dose,
«1 pain» = PRN). See patient_portal._FREQ_MAP for the canonical table.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

# Default clock time for each named slot (the patient can personalise these later).
SLOT_TIMES = {"morning": "08:00", "noon": "14:00", "evening": "20:00", "night": "23:00"}
SLOT_LABEL = {"morning": "Πρωί", "noon": "Μεσημέρι", "evening": "Βράδυ", "night": "Νύχτα"}
SLOTS_ORDER = ["morning", "noon", "evening", "night"]
_SLOTS_BY_COUNT = {
    1: ["morning"],
    2: ["morning", "evening"],
    3: ["morning", "noon", "evening"],
    4: ["morning", "noon", "evening", "night"],
}
# weekday patterns (0=Mon … 6=Sun) for the sub-daily ΗΔΥΚΑ codes
_WEEKLY_DAYS = {1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 2, 4, 6]}


def _qty(val) -> tuple[int, str] | None:
    m = re.match(r"\s*([\d.]+)\s*([A-Za-z]+)", str(val or ""))
    if not m:
        return None
    try:
        return int(float(m.group(1))), m.group(2)
    except ValueError:
        return None


def frequency_plan(freq) -> dict:
    """→ {kind, per_day, days, slots, times_per_week}. `days`='all' (every day) or a weekday list.
    kind ∈ daily|weekly|once|prn|unknown."""
    q = _qty(freq)
    if not q:
        return {"kind": "unknown", "per_day": 1, "days": "all", "slots": ["morning"], "times_per_week": 7}
    n, unit = q
    if unit == "h" and n > 0:
        per = max(1, min(4, round(24 / n)))
        return {"kind": "daily", "per_day": per, "days": "all",
                "slots": _SLOTS_BY_COUNT[per], "times_per_week": per * 7}
    if unit == "d":
        if n <= 1:
            return {"kind": "daily", "per_day": 1, "days": "all", "slots": ["morning"], "times_per_week": 7}
        # ΗΔΥΚΑ: «2 d»→3×/wk, «4 d»→2×/wk — approximate with spread weekdays
        times = 3 if n == 2 else 2 if n == 4 else max(1, 7 // n)
        return {"kind": "weekly", "per_day": 1, "days": _WEEKLY_DAYS.get(times, [0]),
                "slots": ["morning"], "times_per_week": times}
    if unit == "wk":
        return {"kind": "weekly", "per_day": 1, "days": [0], "slots": ["morning"],
                "times_per_week": 1 if n == 1 else 0.5}
    if unit == "mo":
        # ΜΗΝΙΑΙΑ λήψη (π.χ. ενέσιμα οστεοπόρωσης, B12): «1 mo» = μία φορά τον μήνα.
        # ΠΡΙΝ: το «mo» δεν αναγνωριζόταν εδώ και έπεφτε σε `prn` — δηλαδή μηνιαία φάρμακα
        # εμφανίζονταν ως «όποτε χρειάζεται» και ΔΕΝ έμπαιναν ποτέ στο ημερολόγιο.
        return {"kind": "monthly", "per_day": 1, "days": "all", "slots": ["morning"],
                "every_months": max(1, n), "day_of_month": None, "qty": 1,
                "times_per_week": round(7 / (30.0 * max(1, n)), 3)}
    if unit == "once":
        return {"kind": "once", "per_day": 1, "days": "all", "slots": ["morning"], "times_per_week": 0}
    return {"kind": "prn", "per_day": 0, "days": "all", "slots": [], "times_per_week": 0}


def runout_date(start: datetime | None, duration) -> datetime | None:
    """start (dispense date) + duration → when the course/pack runs out."""
    if not start:
        return None
    q = _qty(duration)
    if not q:
        return None
    n, unit = q
    days = {"d": n, "wk": n * 7, "mo": n * 30, "h": max(1, round(n / 24))}.get(unit)
    if not days:
        return None
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    return start + timedelta(days=days)


def weekly_grid(plans: list[dict], slot_times: dict | None = None, today=None) -> list[dict]:
    """7 ΠΡΑΓΜΑΤΙΚΕΣ ημέρες (από σήμερα) × slots, με την ΠΟΣΟΤΗΤΑ κάθε δόσης.

    ΓΙΑΤΙ ΗΜΕΡΟΜΗΝΙΕΣ ΚΑΙ ΟΧΙ ΑΦΗΡΗΜΕΝΕΣ ΗΜΕΡΕΣ ΕΒΔΟΜΑΔΑΣ: μια φθίνουσα αγωγή («3 χάπια για 2
    ημέρες, μετά 2, μετά 1») ή μια μηνιαία λήψη («στις 5 κάθε μήνα») ΔΕΝ επαναλαμβάνονται
    εβδομαδιαία — δεν μπορούν να περιγραφούν με «Δευτέρα/Τρίτη». Κάθε κελί υπολογίζεται με το
    `dose_on`, οπότε ημερολόγιο και υπενθυμίσεις λένε πάντα το ίδιο πράγμα.

    Κάθε plan μπορεί να φέρει `start` (date) — η ημέρα έναρξης της αγωγής του.
    Διατηρείται το `dow` για συμβατότητα· προστίθενται `date` και `qty`.
    """
    from datetime import date as _date
    st = {**SLOT_TIMES, **(slot_times or {})}
    base = today or _date.today()
    week: list[dict] = []
    for offset in range(7):
        day = base + timedelta(days=offset)
        slots: dict = {}
        for p in plans:
            plan = p["plan"]
            qty = dose_on(plan, day, p.get("start"))
            if qty <= 0:
                continue
            for s in plan.get("slots") or ["morning"]:
                slots.setdefault(s, []).append({
                    "med_key": p["med_key"], "name": p["name"], "dose": p.get("dose"),
                    "qty": qty, "qty_label": _num(qty), "time": st.get(s)})
        ordered = [{"slot": s, "label": SLOT_LABEL[s], "time": st.get(s), "meds": slots[s]}
                   for s in SLOTS_ORDER if s in slots]
        week.append({"dow": day.weekday(), "date": day.isoformat(), "slots": ordered})
    return week


# ── ΠΡΟΣΩΠΙΚΑ ΣΧΗΜΑΤΑ ΔΟΣΟΛΟΓΙΑΣ ────────────────────────────────────────────────────────────────
# Η συχνότητα της ΗΔΥΚΑ περιγράφει «κάθε πόσο», αλλά ΔΕΝ μπορεί να περιγράψει δύο πολύ συνηθισμένα
# πραγματικά σχήματα:
#   • ΜΗΝΙΑΙΑ λήψη σε ΣΥΓΚΕΚΡΙΜΕΝΗ ημέρα του μήνα (π.χ. «1 χάπι κάθε 5 του μήνα»)
#   • ΦΘΙΝΟΥΣΑ/κλιμακωτή αγωγή (π.χ. κορτιζόνη: 3 χάπια για 2 ημέρες, μετά 2 για 2 ημέρες,
#     μετά 1 για 2 ημέρες, και από εκεί και πέρα 1 μόνιμα)
# Αυτά ορίζονται χειροκίνητα και υπερισχύουν της συχνότητας του γιατρού.

def monthly_plan(*, every_months: int = 1, day_of_month: int = 1, qty: float = 1,
                 slot: str = "morning") -> dict:
    """Λήψη κάθε N μήνες, σε συγκεκριμένη ημέρα του μήνα."""
    return {"kind": "monthly", "per_day": qty, "days": "all", "slots": [slot or "morning"],
            "every_months": max(1, int(every_months or 1)),
            "day_of_month": max(1, min(31, int(day_of_month or 1))),
            "qty": qty, "times_per_week": round(7 / (30.0 * max(1, int(every_months or 1))), 3)}


def taper_plan(phases: list[dict], *, maintenance_qty: float = 0, slot: str = "morning") -> dict:
    """Φθίνουσα αγωγή: διαδοχικές φάσεις «X ημέρες με Y δόση», και μετά σταθερή δόση συντήρησης.

    `phases` = [{"days": 2, "qty": 3}, {"days": 2, "qty": 2}, …] — με τη σειρά που εκτελούνται.
    `maintenance_qty` = δόση ΜΕΤΑ το τέλος των φάσεων· **0 = η αγωγή σταματά**.
    """
    clean = []
    for ph in phases or []:
        d, q = int(ph.get("days") or 0), float(ph.get("qty") or 0)
        if d > 0:
            clean.append({"days": d, "qty": q})
    return {"kind": "taper", "phases": clean, "maintenance_qty": float(maintenance_qty or 0),
            "per_day": (clean[0]["qty"] if clean else maintenance_qty),
            "days": "all", "slots": [slot or "morning"],
            "total_days": sum(p["days"] for p in clean),
            "times_per_week": 7}


def dose_on(plan: dict, day, start=None) -> float:
    """Πόση δόση παίρνει ο ασθενής ΑΥΤΗ τη συγκεκριμένη ημέρα (0 = καμία).

    Μία συνάρτηση για ΟΛΑ τα σχήματα — ώστε ημερολόγιο, υπενθυμίσεις και υπολογισμός
    εξάντλησης να συμφωνούν πάντα μεταξύ τους.
    """
    kind = plan.get("kind")
    if kind == "prn":
        return 0.0
    if kind == "taper":
        if not start:
            return float(plan.get("per_day") or 0)
        elapsed = (day - start).days
        if elapsed < 0:
            return 0.0
        for ph in plan.get("phases") or []:
            if elapsed < ph["days"]:
                return float(ph["qty"])
            elapsed -= ph["days"]
        return float(plan.get("maintenance_qty") or 0)      # 0 → τέλος αγωγής
    if kind == "monthly":
        dom = plan.get("day_of_month")
        every = max(1, int(plan.get("every_months") or 1))
        if dom is None:                                      # χωρίς ορισμένη ημέρα → από την έναρξη
            dom = start.day if start else 1
        # τελευταία ημέρα του μήνα: αν ο μήνας δεν έχει 31, λήψη την τελευταία του (να μη χαθεί δόση)
        import calendar
        last = calendar.monthrange(day.year, day.month)[1]
        target = min(int(dom), last)
        if day.day != target:
            return 0.0
        if every > 1 and start:
            months = (day.year - start.year) * 12 + (day.month - start.month)
            if months % every != 0:
                return 0.0
        return float(plan.get("qty") or 1)
    if kind == "weekly":
        days = plan.get("days")
        if isinstance(days, list) and day.weekday() not in days:
            return 0.0
        return float(plan.get("per_day") or 1)
    if kind == "once":
        return float(plan.get("per_day") or 1) if (start and day == start) else 0.0
    return float(plan.get("per_day") or 1)                   # daily / unknown


def plan_summary(plan: dict) -> str:
    """Ανθρώπινη περιγραφή του σχήματος — μπαίνει στην κάρτα του φαρμάκου."""
    k = plan.get("kind")
    if k == "monthly":
        every = int(plan.get("every_months") or 1)
        dom = plan.get("day_of_month")
        q = plan.get("qty") or 1
        when = f"στις {dom} του μήνα" if dom else "μία φορά τον μήνα"
        cadence = "κάθε μήνα" if every == 1 else f"κάθε {every} μήνες"
        return f"{_num(q)} {cadence}, {when}"
    if k == "taper":
        parts = [f"{_num(p['qty'])} για {p['days']} {'ημέρα' if p['days'] == 1 else 'ημέρες'}"
                 for p in (plan.get("phases") or [])]
        m = plan.get("maintenance_qty") or 0
        parts.append(f"μετά {_num(m)} μόνιμα" if m else "μετά διακοπή")
        return " → ".join(parts)
    return ""


def _num(v) -> str:
    """1.0 → «1», 0.5 → «½» — όπως το γράφει ο φαρμακοποιός."""
    f = float(v or 0)
    if abs(f - 0.5) < 1e-6:
        return "½"
    if abs(f - round(f)) < 1e-6:
        return str(int(round(f)))
    return f"{f:g}"
