"""Δοκιμαστικές περίοδοι ανά λογαριασμό: πόσες δόθηκαν και επανα-χορήγηση κατ' εξαίρεση.

ΓΙΑΤΙ ΥΠΑΡΧΕΙ: η δωρεάν δοκιμή δίνεται ΜΙΑ φορά ανά ΑΦΜ (`trial_leads.afm_had_trial`).
Υπάρχουν όμως περιπτώσεις που αξίζει δεύτερη ευκαιρία — κάποιος που δεν πρόλαβε, που είχε
τεχνικό πρόβλημα ή που επιστρέφει μετά από μήνες. Αυτή η εξαίρεση πρέπει να είναι:
  1) ΡΗΤΗ — την παίρνει άνθρωπος, με λόγο,
  2) ΜΕΤΡΗΣΙΜΗ — να φαίνεται πόσες φορές έχει δοθεί σε κάθε λογαριασμό,
  3) ΚΑΤΑΓΕΓΡΑΜΜΕΝΗ — στο χρονολόγιο του lead και στο audit.
Χωρίς το (2), «κατ' εξαίρεση» γίνεται σιωπηλά «όποτε ρωτήσει».
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.services.leads import timeline
from app.services.leads.projection import COLL

GRANTS = "lead_trial_grants"
DEFAULT_DAYS = 15
MAX_DAYS = 90


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _aware(dt):
    if isinstance(dt, datetime):
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None


async def history(lead_key: str) -> list[dict]:
    rows = [r async for r in shared_db()[GRANTS].find({"lead_key": lead_key}).sort("at", -1)]
    for r in rows:
        r["_id"] = str(r["_id"])
    return rows


async def summary(lead_key: str, sub: dict | None, lead: dict | None = None) -> dict:
    """Πόσες δοκιμαστικές έχει πάρει ΣΥΝΟΛΙΚΑ αυτός ο λογαριασμός.

    = η αρχική (αν ξεκίνησε ποτέ με δοκιμή) + όσες δώσαμε εμείς κατ' εξαίρεση.
    Το «ξεκίνησε ποτέ με δοκιμή» το ξέρουμε είτε από τη ζωντανή συνδρομή είτε — για
    διαγραμμένους λογαριασμούς — από το `trial_started` που κρατήθηκε στην αρχειοθέτηση.
    """
    db = shared_db()
    grants = await db[GRANTS].count_documents({"lead_key": lead_key})
    lead = lead or await db[COLL].find_one({"_id": lead_key}) or {}
    had_original = bool(
        (sub or {}).get("trial_ends_at")
        or (sub or {}).get("plan") == "trial"
        or (sub or {}).get("status") in ("trial", "trialing")
        or lead.get("trial_started") or lead.get("purged_at")
        or ((lead.get("trial") or {}).get("started_at") and lead.get("stage", "").startswith("trial")))
    last = await db[GRANTS].find_one({"lead_key": lead_key}, sort=[("at", -1)])
    return {
        "count": (1 if had_original else 0) + grants,
        "granted": grants,                       # μόνο οι δικές μας εξαιρέσεις
        "last_granted_at": (last or {}).get("at"),
        "last_granted_by": (last or {}).get("by"),
    }


async def grant(lead_key: str, *, days: int = DEFAULT_DAYS, by: str,
                reason: str | None = None) -> dict:
    """Δώσε ξανά δοκιμαστική. Δύο περιπτώσεις, ανάλογα με το αν ζει ο λογαριασμός."""
    days = max(1, min(MAX_DAYS, int(days or DEFAULT_DAYS)))
    if not (reason or "").strip():
        # Χωρίς λόγο, σε τρεις μήνες κανείς δεν θυμάται γιατί δόθηκε δεύτερη δωρεάν δοκιμή.
        return {"ok": False, "error": "reason_required"}
    db = shared_db()
    lead = await db[COLL].find_one({"_id": lead_key})
    if not lead:
        return {"ok": False, "error": "not_found"}

    tid = lead.get("tenant_id")
    now = _now()
    ends = now + timedelta(days=days)

    if tid:
        sub = await db["subscriptions"].find_one({"tenant_id": tid})
        if not sub:
            return {"ok": False, "error": "no_subscription"}
        if (sub.get("price_per_pharmacy") or 0) > 0 and sub.get("plan") != "trial":
            # Πληρωμένη συνδρομή δεν γίνεται «δοκιμαστική» — θα έσβηνε χρέωση σε ισχύ.
            return {"ok": False, "error": "paid_subscription"}
        await db["subscriptions"].update_one({"tenant_id": tid}, {"$set": {
            "status": "trialing", "trial_ends_at": ends, "current_period_end": ends,
            "payment_status": "trial", "updated_at": now,
            "last_reminder_date": None,          # να ξαναρχίσουν οι υπενθυμίσεις λήξης
        }})
        # Ο λογαριασμός ξαναγίνεται προσβάσιμος — αλλιώς η δοκιμή θα ήταν στα χαρτιά μόνο.
        await db["tenants"].update_one({"_id": tid}, {"$set": {"status": "trial", "updated_at": now}})
        kind, note = "extend", f"Δόθηκε ξανά δοκιμαστική {days} ημερών (έως {ends.strftime('%d/%m/%Y')})"
    else:
        # Διαγραμμένος λογαριασμός: δεν υπάρχει τι να παρατείνουμε. Ξεκλειδώνουμε το ΑΦΜ ώστε
        # να μπορέσει να γραφτεί ΞΑΝΑ και να πάρει κανονικά δοκιμή από την εγγραφή.
        await db[COLL].update_one({"_id": lead_key}, {"$set": {
            "trial_allowed": True, "updated_at": now}})
        kind, note = "unblock", f"Ξεκλειδώθηκε για νέα εγγραφή με δοκιμαστική {days} ημερών"

    await db[GRANTS].insert_one({
        "lead_key": lead_key, "tenant_id": tid, "days": days, "kind": kind,
        "reason": (reason or "").strip()[:400], "by": by, "at": now, "ends_at": ends,
    })
    await timeline.record(lead_key, "trial.started", f"{note} — {reason}", by=by,
                          data={"days": days, "kind": kind})

    # Ανανέωσε αμέσως την προβολή αυτού του lead, να μη δείχνει «έληξε» μέχρι το επόμενο πέρασμα.
    from app.services.leads import projection
    await projection.project()
    return {"ok": True, "kind": kind, "days": days, "ends_at": ends,
            "trials": await summary(lead_key, await db["subscriptions"].find_one({"tenant_id": tid})
                                    if tid else None)}
