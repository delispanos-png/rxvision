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


def weekly_grid(plans: list[dict], slot_times: dict | None = None) -> list[dict]:
    """Build a 7-day × slot grid. `plans` = [{med_key, name, plan}]. Returns one entry per
    (weekday) with the meds due in each slot — ready to render as a calendar."""
    st = {**SLOT_TIMES, **(slot_times or {})}
    week: list[dict] = []
    for dow in range(7):
        slots: dict = {}
        for p in plans:
            plan = p["plan"]
            active = plan["days"] == "all" or dow in (plan["days"] if isinstance(plan["days"], list) else [])
            if not active or plan["kind"] == "prn":
                continue
            for s in plan["slots"]:
                slots.setdefault(s, []).append({"med_key": p["med_key"], "name": p["name"],
                                                "dose": p.get("dose"), "time": st.get(s)})
        ordered = [{"slot": s, "label": SLOT_LABEL[s], "time": st.get(s), "meds": slots[s]}
                   for s in SLOTS_ORDER if s in slots]
        week.append({"dow": dow, "slots": ordered})
    return week
