"""RxVision Loop — automated patient pushes:
 • dispatch_med_reminders  — «💊 ώρα για το φάρμακό σου» at each enabled therapy's slot time (hourly).
 • dispatch_refill_radar   — «🔁 τελειώνει σε N μέρες, κράτησε επανάληψη» when a course is running out.
Reuses the patient schedule logic, VAPID push, and the per-process Mongo/loop pool from ingestion.
"""

from __future__ import annotations

from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
    _ATH = ZoneInfo("Europe/Athens")
except Exception:  # noqa: BLE001
    _ATH = timezone.utc

from app.workers.celery_app import celery_app
from app.workers.ingestion import _fresh_db, _run_async


async def _account_for(db, accrepo, patient_ref):
    pat = await db["patients_anonymized"].find_one({"_id": patient_ref}, {"amka": 1})
    amka = (pat or {}).get("amka")
    return await accrepo.get_by_amka(amka) if amka else None


@celery_app.task(name="app.workers.reminders.dispatch_med_reminders")
def dispatch_med_reminders() -> dict:
    async def _run() -> dict:
        from app.repositories.patient_portal import PatientRxRepository, PatientAccountRepository
        from app.services import push_service
        from app.services import med_schedule as ms
        client, db = _fresh_db()
        now = datetime.now(_ATH)
        hh, today, dow = now.strftime("%H"), now.strftime("%Y-%m-%d"), now.weekday()
        accrepo = PatientAccountRepository()
        sent = 0
        for tid in await db["med_reminders"].distinct("tenant_id", {"enabled": True}):
            for pref in await db["med_reminders"].distinct("patient_ref", {"tenant_id": tid, "enabled": True}):
                try:
                    acc = await _account_for(db, accrepo, pref)
                    if not acc:
                        continue
                    sched = await PatientRxRepository(tenant_id=tid).medication_schedule(str(pref))
                    st = sched.get("slot_times") or ms.SLOT_TIMES
                    for t in sched.get("therapies", []):
                        if not t.get("enabled"):
                            continue
                        plan = t.get("plan") or {}
                        days = plan.get("days")
                        if not (days == "all" or (isinstance(days, list) and dow in days)):
                            continue
                        for slot in plan.get("slots", []):
                            if (st.get(slot, "") or "")[:2] != hh:
                                continue
                            dk = f"rem:{pref}:{t['med_key']}:{slot}:{today}"
                            if await db["reminder_sent"].find_one({"_id": dk}):
                                continue
                            await db["reminder_sent"].insert_one({"_id": dk, "at": datetime.now(timezone.utc)})
                            n = await push_service.send_to_account(
                                str(acc["_id"]), title="💊 Ώρα για το φάρμακό σου",
                                body=t["name"] + (f" — {t['dose']}" if t.get("dose") else ""), url="/portal")
                            sent += n
                except Exception:  # noqa: BLE001
                    continue
        return {"sent": sent}
    return _run_async(_run())


@celery_app.task(name="app.workers.reminders.dispatch_order_subscriptions")
def dispatch_order_subscriptions() -> dict:
    """Create the next order for every due recurring subscription (across tenants)."""
    async def _run() -> dict:
        from app.repositories.orders_delivery import OrdersDeliveryRepository
        client, db = _fresh_db()
        now = datetime.now(timezone.utc)
        due = [s async for s in db["order_subscriptions"].find(
            {"active": True, "next_run": {"$lte": now}}).limit(500)]
        ran = 0
        for sub in due:
            try:
                await OrdersDeliveryRepository(tenant_id=sub["tenant_id"]).run_subscription(sub)
                ran += 1
            except Exception:  # noqa: BLE001
                continue
        return {"ran": ran, "due": len(due)}
    return _run_async(_run())


@celery_app.task(name="app.workers.reminders.dispatch_refill_radar")
def dispatch_refill_radar() -> dict:
    async def _run() -> dict:
        from app.repositories.patient_portal import PatientRxRepository, PatientAccountRepository
        from app.services import push_service
        client, db = _fresh_db()
        today = datetime.now(_ATH).strftime("%Y-%m-%d")
        accrepo = PatientAccountRepository()
        sent = 0
        for tid in await db["med_reminders"].distinct("tenant_id", {"enabled": True}):
            for pref in await db["med_reminders"].distinct("patient_ref", {"tenant_id": tid, "enabled": True}):
                try:
                    acc = await _account_for(db, accrepo, pref)
                    if not acc:
                        continue
                    sched = await PatientRxRepository(tenant_id=tid).medication_schedule(str(pref))
                    for t in sched.get("therapies", []):
                        dl = t.get("days_left")
                        if not t.get("enabled") or dl is None or dl < 0 or dl > 3:
                            continue
                        dk = f"radar:{pref}:{t['med_key']}:{today}"
                        if await db["reminder_sent"].find_one({"_id": dk}):
                            continue
                        await db["reminder_sent"].insert_one({"_id": dk, "at": datetime.now(timezone.utc)})
                        n = await push_service.send_to_account(
                            str(acc["_id"]), title="🔁 Η αγωγή σου τελειώνει",
                            body=f"{t['name']}: απομένουν {dl} ημέρες — κράτησε την επανάληψη με 1 κλικ.",
                            url="/portal")
                        sent += n
                except Exception:  # noqa: BLE001
                    continue
        return {"sent": sent}
    return _run_async(_run())
