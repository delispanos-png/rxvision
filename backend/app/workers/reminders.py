"""RxVision Loop — automated patient pushes:
 • dispatch_med_reminders  — «💊 ώρα για το φάρμακό σου» at each enabled therapy's slot time (hourly).
 • dispatch_refill_radar   — «🔁 τελειώνει σε N μέρες, κράτησε επανάληψη» when a course is running out.
Reuses the patient schedule logic, VAPID push, and the per-process Mongo/loop pool from ingestion.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    _ATH = ZoneInfo("Europe/Athens")
except Exception:  # noqa: BLE001
    _ATH = timezone.utc

from app.workers.celery_app import celery_app
from app.workers.ingestion import _fresh_db, _run_async


async def _account_for(db, accrepo, patient_ref, tenant_id=None):
    # tenant_id: defense-in-depth — ο patient_ref προέρχεται από tenant-scoped δεδομένα, αλλά δεν
    # στηριζόμαστε στο «είναι ασφαλές επειδή το input τυχαίνει να είναι έμπιστο».
    q = {"_id": patient_ref}
    if tenant_id:
        q["tenant_id"] = tenant_id
    pat = await db["patients_anonymized"].find_one(q, {"amka": 1})
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
                    acc = await _account_for(db, accrepo, pref, tid)
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
                    acc = await _account_for(db, accrepo, pref, tid)
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


@celery_app.task(name="app.workers.reminders.auto_cancel_stale_requests")
def auto_cancel_stale_requests() -> dict:
    """Αυτόματη ακύρωση αιτημάτων πελατών που ΔΕΝ αποδέχτηκε ο φαρμακοποιός εντός του καθολικού
    ορίου (platform_settings.notifications.auto_cancel_minutes) — ΟΛΟΙ οι tenants, ίδια συνθήκη.
    Ειδοποιεί τον ασθενή. Τρέχει κάθε λεπτό από το beat."""
    async def _run() -> dict:
        from app.services import push_service
        _client, db = _fresh_db()
        cfg = await db["platform_settings"].find_one({"_id": "notifications"}) or {}
        now = datetime.now(timezone.utc)
        # (collection, open-status, status-on-cancel, μήνυμα, cutoff)·
        # ΑΙΤΗΜΑΤΑ πελατών → auto_cancel_minutes· ΠΑΡΑΓΓΕΛΙΕΣ (παραφάρμακα/OTC) → ξεχωριστό όριο.
        specs = []
        mins = int(cfg.get("auto_cancel_minutes", 5) or 5)
        if cfg.get("auto_cancel_enabled", True) and mins > 0:
            req_cut = now - timedelta(minutes=mins)
            specs += [
                ("availability_requests", "open", "cancelled",
                 "Η ερώτηση διαθεσιμότητας ακυρώθηκε αυτόματα — δεν απαντήθηκε εγκαίρως.", req_cut),
                ("appointments", "requested", "cancelled",
                 "Το αίτημά σου ακυρώθηκε αυτόματα — δεν επιβεβαιώθηκε εγκαίρως.", req_cut),
                ("rx_requests", "new", "rejected",
                 "Η ανάθεση συνταγής ακυρώθηκε αυτόματα — δεν αναλήφθηκε εγκαίρως.", req_cut),
            ]
        omins = int(cfg.get("order_auto_cancel_minutes", 30) or 30)
        if cfg.get("order_auto_cancel_enabled", True) and omins > 0:
            specs.append(("orders_delivery", "new", "cancelled",
                          "Η παραγγελία σου ακυρώθηκε αυτόματα — δεν επιβεβαιώθηκε εγκαίρως από το φαρμακείο.",
                          now - timedelta(minutes=omins)))
        total = 0
        for coll, open_status, new_status, msg, cutoff in specs:
            stale = [d async for d in db[coll].find(
                {"status": open_status, "created_at": {"$lt": cutoff}})]
            if not stale:
                continue
            await db[coll].update_many(
                {"_id": {"$in": [d["_id"] for d in stale]}},
                {"$set": {"status": new_status, "updated_at": datetime.now(timezone.utc),
                          "auto_cancelled": True}})
            total += len(stale)
            for d in stale:
                if d.get("account_id"):
                    try:
                        await push_service.send_to_account(
                            d["account_id"], title="🏥 Φαρμακείο", body=msg, url="/portal")
                    except Exception:  # noqa: BLE001
                        pass
        return {"cancelled": total, "minutes": mins}
    return _run_async(_run())


@celery_app.task(name="app.workers.reminders.renew_vault_token")
def renew_vault_token() -> dict:
    """Καθημερινή ανανέωση του Vault token της εφαρμογής (periodic) ώστε να μη λήγει ποτέ —
    το ληγμένο token σταματά ΣΙΩΠΗΛΑ όλους τους ΗΔΥΚΑ syncs (incident 2026-07-08)."""
    from app.services.vault_service import vault
    return {"renewed": vault.renew_self()}


@celery_app.task(name="app.workers.reminders.dispatch_abandoned_carts")
def dispatch_abandoned_carts() -> dict:
    """Υπενθύμιση «ξεχασμένου καλαθιού»: καλάθι που έμεινε ασυμπλήρωτο πέρα από το όριο του
    φαρμακείου → ΕΝΑ push. Opt-in ανά φαρμακείο (abandoned_cart_enabled)· στέλνεται μία φορά
    ανά καλάθι (reminded_at) και μηδενίζεται σε κάθε αλλαγή του καλαθιού."""
    async def _run() -> dict:
        from app.repositories.orders_delivery import OrdersDeliveryRepository
        from app.services import push_service
        client, db = _fresh_db()
        now = datetime.now(timezone.utc)
        sent = 0
        carts = [c async for c in db["shop_carts"].find({"reminded_at": None}).limit(1000)]
        settings_cache: dict[str, dict] = {}
        for c in carts:
            try:
                tid = c["tenant_id"]
                if tid not in settings_cache:
                    settings_cache[tid] = await OrdersDeliveryRepository(tenant_id=tid).settings()
                st = settings_cache[tid]
                if not st.get("abandoned_cart_enabled"):
                    continue
                hours = max(1, int(st.get("abandoned_cart_hours") or 6))
                if c.get("updated_at") and c["updated_at"] > now - timedelta(hours=hours):
                    continue                       # δεν «ωρίμασε» ακόμη
                n = int(sum(i.get("qty", 1) for i in c.get("items", [])))
                if n <= 0:
                    continue
                await push_service.send_to_account(
                    str(c["account_id"]), title="🛒 Ξέχασες κάτι στο καλάθι σου",
                    body=f"{n} {'είδος' if n == 1 else 'είδη'} σε περιμένουν. Ολοκλήρωσε την παραγγελία σου!",
                    url="/portal?tab=shop")
                await db["shop_carts"].update_one({"_id": c["_id"]}, {"$set": {"reminded_at": now}})
                sent += 1
            except Exception:  # noqa: BLE001
                continue
        return {"sent": sent, "carts": len(carts)}
    return _run_async(_run())


@celery_app.task(name="app.workers.reminders.dispatch_loyalty_rewards")
def dispatch_loyalty_rewards() -> dict:
    """«🎁 Έχεις πόντους — εξαργύρωσέ τους»: εβδομαδιαία υπενθύμιση σε εγγεγραμμένα μέλη πιστότητας
    που ΜΠΟΡΟΥΝ ήδη να εξαργυρώσουν τουλάχιστον ένα ενεργό δώρο και δεν έχουν εκκρεμή κράτηση.
    Ένα push ανά μέλος/εβδομάδα ανά «κατώφλι δώρου» (dedup key με το κόστος του καλύτερου δώρου),
    ώστε να ξαναειδοποιείται όταν ξεκλειδώσει ακριβότερο δώρο, χωρίς spam. Opt-in = το ίδιο το module."""
    async def _run() -> dict:
        from app.repositories.patient_portal import PatientAccountRepository
        from app.repositories.loyalty import LoyaltyRepository
        from app.services import push_service
        _client, db = _fresh_db()
        accrepo = PatientAccountRepository()
        yr, wk, _ = datetime.now(_ATH).isocalendar()
        stamp = f"{yr}-{wk:02d}"
        sent = 0
        for cfg in [c async for c in db["loyalty_config"].find({"enabled": True})]:
            tid = cfg["tenant_id"]
            try:
                repo = LoyaltyRepository(tenant_id=tid)
                rewards = [r for r in await repo.rewards() if r.get("active", True) and r.get("cost_cents", 0) > 0]
                if not rewards:
                    continue
                ov = await repo.overview()
                for m in ov.get("members", []):
                    try:
                        pref = m["patient_ref"]
                        bal = m.get("balance_cents", 0)
                        affordable = [r for r in rewards if bal >= r["cost_cents"]]
                        if not affordable:
                            continue
                        if await repo.active_reservation(pref):
                            continue                       # έχει ήδη δεσμεύσει δώρο
                        acc = await _account_for(db, accrepo, pref, tid)
                        if not acc:
                            continue                       # χωρίς λογαριασμό πύλης — δεν λαμβάνει push
                        best = max(affordable, key=lambda r: r["cost_cents"])
                        dk = f"loyalty:{pref}:{best['cost_cents']}:{stamp}"
                        if await db["reminder_sent"].find_one({"_id": dk}):
                            continue
                        await db["reminder_sent"].insert_one({"_id": dk, "at": datetime.now(timezone.utc)})
                        eur = f"{bal / 100:.2f}".replace(".", ",")
                        n = await push_service.send_to_account(
                            str(acc["_id"]), title="🎁 Έχεις πόντους πιστότητας!",
                            body=f"{m.get('points', 0)} πόντοι ({eur}€) — εξαργύρωσέ τους σε «{best['title']}». Δες τα δώρα σου!",
                            url="/portal?tab=wallet")
                        sent += n
                    except Exception:  # noqa: BLE001
                        continue
            except Exception:  # noqa: BLE001
                continue
        return {"sent": sent}
    return _run_async(_run())


@celery_app.task(name="app.workers.reminders.dispatch_birthday_bonus")
def dispatch_birthday_bonus() -> dict:
    """«🎂 Χρόνια πολλά» — bonus πόντων στα μέλη πιστότητας με γενέθλια αυτόν τον μήνα (μία φορά/έτος,
    dedup στον repo). Ο μήνας προκύπτει από το ωμό ΑΜΚΑ (ΗΗΜΜΕΕ). Opt-in ανά φαρμακείο. Τρέχει
    καθημερινά (φθηνό) → πιάνει & όσους εγγράφονται μέσα στον μήνα των γενεθλίων τους."""
    async def _run() -> dict:
        from app.repositories.patient_portal import PatientAccountRepository
        from app.repositories.loyalty import LoyaltyRepository
        from app.services import push_service
        _client, db = _fresh_db()
        accrepo = PatientAccountRepository()
        now = datetime.now(_ATH)
        month, year = now.month, now.year
        credited = 0
        for cfg in [c async for c in db["loyalty_config"].find({"enabled": True, "birthday_enabled": True})]:
            tid = cfg["tenant_id"]
            try:
                refs = await LoyaltyRepository(tenant_id=tid).award_birthdays(month, year)
                for pref in refs:
                    credited += 1
                    try:
                        acc = await _account_for(db, accrepo, pref, tid)
                        if acc:
                            await push_service.send_to_account(
                                str(acc["_id"]), title="🎂 Χρόνια πολλά!",
                                body="Σου χαρίσαμε πόντους πιστότητας για τα γενέθλιά σου. Δες το πορτοφόλι σου!",
                                url="/portal?tab=wallet")
                    except Exception:  # noqa: BLE001
                        continue
            except Exception:  # noqa: BLE001
                continue
        return {"credited": credited}
    return _run_async(_run())


@celery_app.task(name="app.workers.reminders.purge_old_data")
def purge_old_data() -> dict:
    """Μηνιαίος καθαρισμός δεδομένων εκτός του παραθύρου διατήρησης ΑΝΑ φαρμακείο (rolling,
    default 36μ· μεγαλύτερο για όσους το έχουν αγοράσει). Οριστική διαγραφή — GDPR minimization."""
    async def _run() -> dict:
        from app.services.data_retention import purge_old
        client, db = _fresh_db()
        return await purge_old(db)
    return _run_async(_run())
