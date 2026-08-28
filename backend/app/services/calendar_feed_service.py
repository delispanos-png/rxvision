"""Read-only calendar feeds (iCalendar/ICS) that pharmacists & patients subscribe to from
Google Calendar / Outlook 365 / Apple Calendar. The secret token in the URL IS the credential
— external calendar servers fetch the feed WITHOUT auth headers — so tokens are long, random &
revocable (regenerating one instantly invalidates the calendars still pointing at the old link).

Two feed kinds:
  • pharmacy → all the pharmacy's customer appointments (tenant-scoped; demo-masked names).
  • patient  → the patient's medication schedule (δοσοληψία, recurring per dose-slot) + their
               appointments with the pharmacy/-ies.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.core.db import shared_db
from app.services import ics
from app.services import med_schedule as ms

_COLL = "calendar_feeds"
ATHENS = ZoneInfo("Europe/Athens")
_BYDAY = {0: "MO", 1: "TU", 2: "WE", 3: "TH", 4: "FR", 5: "SA", 6: "SU"}
# appointments: how far back to keep past events in the feed
_PAST_WINDOW = timedelta(days=30)
# recurring meds with no run-out date: cap the horizon so we never emit an endless series
_MED_HORIZON = timedelta(days=120)


# ── token lifecycle ──────────────────────────────────────────────────────────
def _new_token() -> str:
    return secrets.token_urlsafe(24)


def _match(kind: str, *, tenant_id: str, account_id=None) -> dict:
    q: dict = {"kind": kind, "tenant_id": tenant_id, "revoked_at": None}
    if kind == "patient":
        q["account_id"] = account_id
    return q


async def get_or_create(kind: str, *, tenant_id: str, account_id=None, patient_ref=None) -> str:
    db = shared_db()
    existing = await db[_COLL].find_one(_match(kind, tenant_id=tenant_id, account_id=account_id))
    if existing:
        # the patient's active pharmacy (and thus patient_ref for meds) can change — keep it fresh
        if kind == "patient" and patient_ref and existing.get("patient_ref") != patient_ref:
            await db[_COLL].update_one({"_id": existing["_id"]},
                                       {"$set": {"patient_ref": patient_ref}})
        return existing["token"]
    token = _new_token()
    await db[_COLL].insert_one({
        "token": token, "kind": kind, "tenant_id": tenant_id,
        "account_id": account_id, "patient_ref": patient_ref,
        "created_at": datetime.now(tz=timezone.utc), "revoked_at": None})
    return token


async def regenerate(kind: str, *, tenant_id: str, account_id=None, patient_ref=None) -> str:
    """Revoke the current link(s) and mint a fresh one — used if a subscription URL leaks."""
    db = shared_db()
    await db[_COLL].update_many(_match(kind, tenant_id=tenant_id, account_id=account_id),
                                {"$set": {"revoked_at": datetime.now(tz=timezone.utc)}})
    return await get_or_create(kind, tenant_id=tenant_id, account_id=account_id,
                               patient_ref=patient_ref)


async def resolve(token: str) -> dict | None:
    if not token:
        return None
    return await shared_db()[_COLL].find_one({"token": token, "revoked_at": None})


def feed_path(kind: str, token: str) -> str:
    from app.core.config import settings
    return f"{settings.API_V1_PREFIX}/calendar/{kind}/{token}.ics"


# ── helpers ──────────────────────────────────────────────────────────────────
def _to_dt(v) -> datetime | None:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _parse_hm(s) -> tuple[int, int]:
    try:
        h, m = str(s).split(":")[:2]
        return max(0, min(23, int(h))), max(0, min(59, int(m)))
    except (ValueError, TypeError):
        return 8, 0


_APPT_STATUS = {"confirmed": "CONFIRMED", "ready": "CONFIRMED", "done": "CONFIRMED",
                "requested": "TENTATIVE", "pending": "TENTATIVE",
                "cancelled": "CANCELLED", "declined": "CANCELLED", "rejected": "CANCELLED"}


def _appt_event(a: dict, *, uid: str, title_extra: str, location: str,
                include_phone: bool) -> ics.Event | None:
    when = _to_dt(a.get("requested_at"))
    if not when or when < datetime.now(tz=timezone.utc) - _PAST_WINDOW:
        return None
    svc = a.get("service_name") or ("Παραλαβή" if a.get("kind") == "pickup" else "Ραντεβού")
    summary = f"{svc} — {title_extra}".strip(" —") if title_extra else svc
    status = _APPT_STATUS.get((a.get("status") or "").lower(), "TENTATIVE")
    desc = []
    if a.get("note"):
        desc.append(str(a["note"]))
    if include_phone and a.get("patient_phone"):
        desc.append(f"Τηλ: {a['patient_phone']}")
    return ics.Event(
        uid=uid, summary=summary, start=when, end=when + timedelta(minutes=30),
        description="  ·  ".join(desc), location=location, status=status,
        categories="Ραντεβού φαρμακείου")


# ── pharmacy feed: all customer appointments ─────────────────────────────────
async def pharmacy_ics(feed: dict) -> str:
    from app.repositories.patient_portal import AppointmentRepository
    from app.utils.masking import mask_name
    tid = feed["tenant_id"]
    db = shared_db()
    tenant = await db["tenants"].find_one({"_id": tid}, {"name": 1, "company": 1, "demo": 1})
    demo = bool((tenant or {}).get("demo"))
    pharm = (((tenant or {}).get("company") or {}).get("name")
             or (tenant or {}).get("name") or "Φαρμακείο")
    appts = await AppointmentRepository(tenant_id=tid).find(
        {}, sort=[("requested_at", 1)], limit=500)
    events: list[ics.Event] = []
    for a in appts:
        name = a.get("patient_name") or ""
        if demo:
            name = mask_name(name, True) or ""
        ev = _appt_event(a, uid=f"appt-{a['_id']}@rxvision.gr", title_extra=name,
                         location=pharm, include_phone=not demo)
        if ev:
            events.append(ev)
    return ics.build_calendar(f"Ραντεβού πελατών — {pharm}", events)


# ── patient feed: medication schedule (recurring) + appointments ─────────────
def _med_events(therapies: list[dict], slot_times: dict, patient_ref: str,
                today: datetime) -> list[ics.Event]:
    events: list[ics.Event] = []
    horizon_default = today + _MED_HORIZON
    for th in therapies:
        plan = th.get("plan") or {}
        kind = plan.get("kind")
        if kind in ("prn", "once"):          # no fixed recurring schedule → nothing to sync
            continue
        slots = plan.get("slots") or ["morning"]
        days = plan.get("days")
        ro = _to_dt(th.get("runout"))
        # normalise run-out to the same naive Athens wall-clock basis as `today` for comparison
        ro_local = ro.astimezone(ATHENS).replace(tzinfo=None) if ro else None
        until = ro_local if (ro_local and ro_local > today) else horizon_default
        until_str = until.strftime("%Y%m%dT235959")
        if isinstance(days, list) and days:
            byday = ",".join(_BYDAY[d] for d in days if d in _BYDAY) or "MO"
            rrule = f"FREQ=WEEKLY;BYDAY={byday};UNTIL={until_str}"
        else:
            rrule = f"FREQ=DAILY;UNTIL={until_str}"
        name = th.get("name") or "Φάρμακο"
        dose = th.get("dose")
        for slot in slots:
            tstr = th.get("time") or slot_times.get(slot) or ms.SLOT_TIMES.get(slot, "08:00")
            hh, mm = _parse_hm(tstr)
            start = datetime(today.year, today.month, today.day, hh, mm)   # floating local
            label = ms.SLOT_LABEL.get(slot, "")
            summary = "💊 " + name + (f" — {label}" if len(slots) > 1 and label else "")
            desc = []
            if dose:
                desc.append(f"Δόση: {dose}")
            if th.get("dosage_text"):
                desc.append(str(th["dosage_text"]))
            if th.get("meal") == "before":
                desc.append("Πριν το φαγητό")
            elif th.get("meal") == "after":
                desc.append("Μετά το φαγητό")
            events.append(ics.Event(
                uid=f"med-{patient_ref}-{th.get('med_key')}-{slot}@rxvision.gr",
                summary=summary, start=start, end=start + timedelta(minutes=15),
                floating=True, rrule=rrule, description="  ·  ".join(desc),
                categories="Φαρμακευτική αγωγή"))
    return events


async def patient_ics(feed: dict) -> str:
    from app.repositories.patient_portal import PatientAccountRepository, PatientRxRepository
    tid = feed["tenant_id"]
    account_id = feed.get("account_id")
    patient_ref = feed.get("patient_ref")
    now_athens = datetime.now(tz=ATHENS)
    today = now_athens.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)

    events: list[ics.Event] = []
    # medication schedule (tenant + patient scoped) → recurring dose events
    if patient_ref:
        sched = await PatientRxRepository(tenant_id=tid).medication_schedule(patient_ref)
        slot_times = sched.get("slot_times") or dict(ms.SLOT_TIMES)
        events += _med_events(sched.get("therapies") or [], slot_times, str(patient_ref), today)

    # appointments (account-scoped: across all the patient's pharmacies, with each pharmacy's name)
    if account_id:
        appts = await PatientAccountRepository().my_appointments(account_id)
        for a in appts:
            pharm = a.get("pharmacy_name") or "Φαρμακείο"
            ev = _appt_event(a, uid=f"pappt-{a['_id']}@rxvision.gr", title_extra=pharm,
                             location=pharm, include_phone=False)
            if ev:
                events.append(ev)
    return ics.build_calendar("Το ημερολόγιό μου — RxVision", events)
