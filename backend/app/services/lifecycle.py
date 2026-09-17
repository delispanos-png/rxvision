"""Κύκλος ζωής λογαριασμού μετά τη λήξη: ειδοποίηση → παύση → προειδοποίηση → διαγραφή.

ΤΟ ΚΕΝΟ ΠΟΥ ΚΛΕΙΝΕΙ: υπήρχε κανόνας διαγραφής ΜΟΝΟ για δοκιμαστικές (20 ημέρες). Ένας
ΠΛΗΡΩΜΕΝΟΣ πελάτης που σταμάτησε να πληρώνει έμενε **για πάντα**, με όλα του τα δεδομένα —
κανένας μηχανισμός δεν τον άγγιζε ποτέ.

ΔΥΟ ΧΡΟΝΟΜΕΤΡΑ, ΕΝΑΣ ΚΑΝΟΝΑΣ: ο πελάτης που **πλήρωνε** αξίζει μεγαλύτερο παράθυρο από
κάποιον που απλώς δοκίμασε. Τα δεδομένα είναι δικά του (συνταγές, ασθενείς) και δεν
πετιούνται σε τρεις εβδομάδες επειδή καθυστέρησε μια χρέωση.

Ο ΣΚΛΗΡΟΣ ΚΑΝΟΝΑΣ: **κανείς δεν διαγράφεται χωρίς να έχει σταλεί τελική προειδοποίηση και
να έχει περάσει το περιθώριό της.** Δεν είναι ρύθμιση — είναι προϋπόθεση στον κώδικα. Αν η
προειδοποίηση δεν έφυγε (π.χ. χαλασμένο SMTP), η διαγραφή ΔΕΝ γίνεται.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db

SETTINGS_ID = "lifecycle"
COLL = "lifecycle_notices"

DEFAULTS: dict = {
    "enabled": True,
    # Πόσες ημέρες ΜΕΤΑ τη λήξη διαγράφεται ο λογαριασμός
    "trial_delete_days": 20,      # όπως ίσχυε ήδη για τις δοκιμαστικές
    "paid_delete_days": 90,       # ΝΕΟ — πληρωμένος πελάτης που έφυγε
    # Κλιμάκωση ειδοποιήσεων μετά τη λήξη (ημέρες από τη λήξη). ΟΧΙ καθημερινά:
    # 30 συνεχόμενα email εκπαιδεύουν τον παραλήπτη να τα αγνοεί.
    "notice_days": [1, 7, 21, 45],
    "final_notice_days": 7,       # πόσες ημέρες ΠΡΙΝ τη διαγραφή φεύγει η τελική προειδοποίηση
}

STAGE_LABEL = {
    "ok": "Κανονικά",
    "grace": "Σε περιθώριο πληρωμής",
    "expired": "Έληξε — τα δεδομένα κρατιούνται",
    "final_notice": "Τελική προειδοποίηση διαγραφής",
    "deletable": "Έτοιμο για διαγραφή",
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _aware(dt):
    if isinstance(dt, datetime):
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None


async def config() -> dict:
    db = shared_db()
    doc = await db["platform_settings"].find_one({"_id": SETTINGS_ID}) or {}
    out = {**DEFAULTS, **{k: v for k, v in doc.items() if k in DEFAULTS and v is not None}}
    # Συμβατότητα: οι δοκιμαστικές είχαν ήδη ρύθμιση αλλού — αυτή παραμένει η πηγή αλήθειας
    # ώστε να μην υπάρχουν δύο νούμερα που λένε διαφορετικά πράγματα.
    legacy = await db["platform_settings"].find_one({"_id": "trial_leads"}) or {}
    if legacy.get("purge_days"):
        out["trial_delete_days"] = int(legacy["purge_days"])
    if legacy.get("purge_enabled") is False:
        out["enabled"] = False
    return out


async def save_config(data: dict, *, by: str | None = None) -> dict:
    upd = {k: v for k, v in (data or {}).items() if k in DEFAULTS and v is not None}
    if not upd:
        return await config()
    upd.update({"updated_at": _now(), "updated_by": by})
    await shared_db()["platform_settings"].update_one(
        {"_id": SETTINGS_ID}, {"$set": upd}, upsert=True)
    # Το νούμερο των δοκιμαστικών κρατιέται συγχρονισμένο με το παλιό κλειδί.
    if "trial_delete_days" in upd:
        await shared_db()["platform_settings"].update_one(
            {"_id": "trial_leads"}, {"$set": {"purge_days": int(upd["trial_delete_days"])}},
            upsert=True)
    return await config()


def _is_trial(sub: dict) -> bool:
    return (sub or {}).get("plan") in ("trial", "free_trial", None)


async def plan_for(tenant: dict, sub: dict | None, cfg: dict) -> dict:
    """Πού βρίσκεται αυτός ο λογαριασμός και τι του μέλλεται."""
    from app.services.billing_service import effective_status
    sub = sub or {}
    st = effective_status(sub or None)
    now = _now()
    tid = tenant["_id"]

    base = {"tenant_id": tid, "tenant_name": tenant.get("name"),
            "plan": sub.get("plan"), "is_trial": _is_trial(sub), "status": st,
            "stage": "ok", "expired_at": None, "delete_at": None, "days_left": None,
            "notices": [], "final_notice_at": None, "can_delete": False, "blocked": None}

    if sub.get("complimentary"):
        return {**base, "blocked": "δωρεάν πελάτης — δεν λήγει ποτέ"}
    if sub.get("revolut_customer_id") or sub.get("viva_transaction_id"):
        # Έχει κάρτα: η χρέωση είναι αυτόματη· η διαγραφή δεν είναι δική μας απόφαση εδώ.
        if st in ("expired", "cancelled"):
            base["blocked"] = "έχει αποθηκευμένη κάρτα — χειροκίνητος έλεγχος"
    if st in ("active", "trial"):
        return base
    if st == "past_due":
        return {**base, "stage": "grace"}
    if st not in ("expired", "cancelled"):
        return base

    expired_at = _aware(sub.get("expired_at")) or _aware(sub.get("current_period_end")) \
        or _aware(sub.get("trial_ends_at"))
    if not expired_at:
        return {**base, "blocked": "άγνωστη ημερομηνία λήξης"}

    window = int(cfg["trial_delete_days"] if _is_trial(sub) else cfg["paid_delete_days"])
    delete_at = expired_at + timedelta(days=window)
    days_left = (delete_at.date() - now.date()).days

    notices = [n async for n in shared_db()[COLL].find({"tenant_id": tid}).sort("at", 1)]
    final = next((n for n in notices if n.get("kind") == "final"), None)
    final_at = _aware((final or {}).get("at"))

    stage = "expired"
    if days_left <= 0:
        stage = "deletable"
    elif days_left <= int(cfg["final_notice_days"]):
        stage = "final_notice"

    # Ο ΣΚΛΗΡΟΣ ΚΑΝΟΝΑΣ: διαγραφή μόνο αν έφυγε τελική προειδοποίηση ΚΑΙ πέρασε το περιθώριό της.
    can_delete = bool(
        days_left <= 0 and final_at
        and (now - final_at).days >= max(1, int(cfg["final_notice_days"]) - 1)
        and not base["blocked"])
    blocked = base["blocked"]
    if days_left <= 0 and not final_at and not blocked:
        blocked = "δεν έχει σταλεί τελική προειδοποίηση"

    return {**base, "stage": stage, "expired_at": expired_at, "delete_at": delete_at,
            "days_left": days_left, "notices": [n.get("kind") for n in notices],
            "final_notice_at": final_at, "can_delete": can_delete, "blocked": blocked}


async def schedule() -> dict:
    """Τι λήγει, τι κρατιέται, τι θα διαγραφεί και πότε — με το κόστος σε δεδομένα."""
    db = shared_db()
    cfg = await config()
    rows: list[dict] = []
    async for t in db["tenants"].find({}):
        sub = await db["subscriptions"].find_one({"tenant_id": t["_id"]})
        p = await plan_for(t, sub, cfg)
        if p["stage"] == "ok":
            continue
        p["executions"] = await db["prescription_executions"].count_documents(
            {"tenant_id": t["_id"]})
        p["stage_label"] = STAGE_LABEL[p["stage"]]
        rows.append(p)
    rows.sort(key=lambda r: (r["days_left"] if r["days_left"] is not None else 9999))
    return {"items": rows, "config": cfg,
            "freeable_executions": sum(r["executions"] for r in rows if r["stage"] == "deletable")}


# ── ειδοποιήσεις ────────────────────────────────────────────────────────────────────────────
def _email_html(name: str, *, kind: str, days_left: int, delete_at: datetime) -> tuple[str, str]:
    when = delete_at.strftime("%d/%m/%Y")
    if kind == "final":
        subj = f"RxVision — τα δεδομένα του «{name}» διαγράφονται στις {when}"
        body = (f"Η συνδρομή σας έχει λήξει και τα δεδομένα σας διαγράφονται οριστικά στις "
                f"<b>{when}</b> (σε {days_left} ημέρες).<br/><br/>"
                "Αν ανανεώσετε πριν από αυτή την ημερομηνία, ο λογαριασμός σας συνεχίζει "
                "ακριβώς από εκεί που έμεινε — δεν χάνεται τίποτα.<br/><br/>"
                "Μετά τη διαγραφή η επαναφορά δεν είναι δυνατή.")
    else:
        subj = f"RxVision — η συνδρομή του «{name}» έχει λήξει"
        body = (f"Η συνδρομή σας έχει λήξει. Τα δεδομένα σας κρατιούνται μέχρι τις "
                f"<b>{when}</b> και ο λογαριασμός σας είναι έτοιμος να συνεχίσει μόλις "
                "ανανεώσετε.<br/><br/>"
                "Ο συγχρονισμός με την ΗΔΥΚΑ είναι προσωρινά σταματημένος· όταν ανανεώσετε, "
                "συμπληρώνεται αυτόματα ό,τι μεσολάβησε.")
    html = ('<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">'
            '<div style="background:#4f46e5;padding:16px 22px;color:#fff;font-size:18px;font-weight:700;">RxVision</div>'
            f'<div style="padding:22px;font-size:15px;line-height:1.6;">{body}</div>'
            '<div style="padding:14px 22px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">'
            'Λειτουργικό μήνυμα για τη συνδρομή σας.</div></div>')
    return subj, html


async def _notify(db, p: dict, kind: str, cfg: dict) -> bool:
    """Στέλνει ΜΙΑ ειδοποίηση ανά είδος. Το μοναδικό κλειδί είναι η ιδεμποτεντότητα."""
    key = f"{p['tenant_id']}|{kind}"
    try:
        await db[COLL].insert_one({"_id": key, "tenant_id": p["tenant_id"], "kind": kind,
                                   "at": _now(), "delete_at": p["delete_at"]})
    except Exception:                                    # noqa: BLE001 — έχει ήδη σταλεί
        return False
    from app.services import mailer
    from app.services.billing_service import _billing_email
    tenant = await db["tenants"].find_one({"_id": p["tenant_id"]}) or {}
    email = await _billing_email(db, p["tenant_id"], tenant)
    if not email:
        await db[COLL].update_one({"_id": key}, {"$set": {"failed": "no_email"}})
        return False
    subj, html = _email_html(tenant.get("name") or p["tenant_id"], kind=kind,
                             days_left=max(0, p["days_left"] or 0), delete_at=p["delete_at"])
    try:
        await mailer.send_email(email, subj, html)
    except Exception:                                    # noqa: BLE001
        # Απέτυχε η αποστολή → ΣΒΗΣΕ το σημάδι ώστε να ξαναδοκιμάσει αύριο. Αλλιώς θα
        # θεωρούσαμε ότι ειδοποιήθηκε και θα διαγράφαμε λογαριασμό χωρίς προειδοποίηση.
        await db[COLL].delete_one({"_id": key})
        return False
    return True


async def run(*, dry_run: bool = False) -> dict:
    """Ημερήσιο πέρασμα: στέλνει ό,τι οφείλεται και διαγράφει ό,τι επιτρέπεται."""
    db = shared_db()
    cfg = await config()
    if not cfg["enabled"] and not dry_run:
        return {"enabled": False}
    sched = await schedule()
    sent, deleted, blocked = 0, [], []
    for p in sched["items"]:
        if p["stage"] == "grace" or p["expired_at"] is None:
            continue
        days_over = (_now().date() - p["expired_at"].date()).days

        # 1) κλιμακωτές ειδοποιήσεις μετά τη λήξη
        for d in sorted(int(x) for x in cfg["notice_days"]):
            if days_over >= d and p["days_left"] and p["days_left"] > int(cfg["final_notice_days"]):
                if not dry_run and await _notify(db, p, f"after_{d}", cfg):
                    sent += 1

        # 2) τελική προειδοποίηση
        if p["stage"] in ("final_notice", "deletable") and "final" not in p["notices"]:
            if not dry_run and await _notify(db, p, "final", cfg):
                sent += 1
            continue                      # ΠΟΤΕ διαγραφή την ίδια μέρα με την προειδοποίηση

        # 3) διαγραφή
        if p["stage"] == "deletable":
            if not p["can_delete"]:
                blocked.append({"tenant_id": p["tenant_id"], "name": p["tenant_name"],
                                "why": p["blocked"]})
                continue
            if dry_run:
                deleted.append(p["tenant_id"])
                continue
            from app.services import trial_leads
            from app.services.billing_service import delete_tenant_fully
            await trial_leads.archive_from_tenant(p["tenant_id"], db=db,
                                                  reason="lifecycle_deleted")
            await delete_tenant_fully(p["tenant_id"])
            await db["lifecycle_deletions"].insert_one({
                "tenant_id": p["tenant_id"], "name": p["tenant_name"], "at": _now(),
                "was_trial": p["is_trial"], "expired_at": p["expired_at"],
                "executions": p.get("executions")})
            deleted.append(p["tenant_id"])
    return {"enabled": cfg["enabled"], "dry_run": dry_run, "notices_sent": sent,
            "deleted": deleted, "blocked": blocked}
