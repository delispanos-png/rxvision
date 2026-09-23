"""Ανάκληση προσθέτων που ενεργοποιήθηκαν χωρίς να μπορούν να εισπραχθούν.

ΤΟ ΙΣΤΟΡΙΚΟ: μέχρι τις 23/09/2026 η ενεργοποίηση προσθέτου ΔΕΝ χρέωνε κάρτα — απλώς πρόσθετε
την τιμή στο `addons_total`, που εισπράττεται στην επόμενη ανανέωση. Πελάτης χωρίς αποθηκευμένη
κάρτα μπορούσε έτσι να ενεργοποιήσει χρεώσιμο πρόσθετο που δεν θα πληρωνόταν ποτέ.

ΓΙΑΤΙ ΤΑ ΚΡΙΤΗΡΙΑ ΕΙΝΑΙ ΤΟΣΟ ΣΤΕΝΑ — μετρημένο 23/09/2026: από τα 6 φαρμακεία με ενεργά
χρεώσιμα modules, τα 3 τα έχουν επειδή **τα περιλαμβάνει το πακέτο που πληρώνουν**, 1 είναι
δωρεάν συνδρομή και 1 τα έχει σε δοκιμή. Ένα αφελές «απενεργοποίησε ό,τι χρεώσιμο είναι
enabled» θα αφαιρούσε δυνατότητες από πελάτες που πληρώνουν κανονικά ΚΑΙ θα τους έστελνε
μήνυμα για δήθεν αποτυχία πληρωμής. Ανακαλούμε ΜΟΝΟ ό,τι:
  · είναι χρεώσιμο (price_monthly > 0)
  · είναι `enabled` (ΟΧΙ `trial` — η δοκιμή είναι νόμιμη και έχει λήξη)
  · βρίσκεται στη λίστα `subscriptions.addons`, δηλαδή αγοράστηκε ως πρόσθετο
  · ΔΕΝ περιλαμβάνεται στο πακέτο (`modules_included`)
  · ο πελάτης ΔΕΝ έχει δωρεάν συνδρομή (`complimentary`)
  · ΔΕΝ υπάρχει ΚΑΜΙΑ πληρωμή γι' αυτό: ούτε γραμμή `addon:<id>` σε παραστατικό, ούτε απόδειξη

⚠ ΤΟ ΚΡΙΤΗΡΙΟ ΔΕΝ ΕΙΝΑΙ «ΔΕΝ ΕΧΕΙ ΚΑΡΤΑ». Επαληθευμένο στον ΜΠΙΝΙΚΟ: το `card_on_file()`
γυρίζει False επειδή το `payment_status` είναι `card_pending`, ΕΝΩ ο πελάτης έχει
`viva_transaction_id` και έχει πληρώσει κανονικά τη συνδρομή του (παραστατικό 970 € καθαρά με
ΑΑΔΕ MARK). Η απουσία κάρτας ΔΕΝ αποδεικνύει απουσία πληρωμής — το μόνο που την αποδεικνύει
είναι η απουσία παραστατικού/απόδειξης για ΤΟ ΣΥΓΚΕΚΡΙΜΕΝΟ πρόσθετο.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db

MESSAGE_TITLE = "Πρόβλημα με την πληρωμή του πρόσθετου"
MESSAGE_BODY = (
    "Δεν καταφέραμε να ολοκληρώσουμε την πληρωμή για το πρόσθετο «{names}», οπότε "
    "απενεργοποιήθηκε προσωρινά.\n\n"
    "Για να το ενεργοποιήσεις ξανά, πήγαινε στις Ρυθμίσεις → Χρέωση, καταχώρησε την κάρτα σου "
    "και μετά στο Modules / Πλάνο πάτα ξανά «Ενεργοποίηση». Η χρέωση γίνεται αναλογικά για τις "
    "ημέρες που απομένουν στην περίοδό σου."
)


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def scan(*, dry_run: bool = True) -> dict:
    """Βρες (και προαιρετικά ανάκλησε) πρόσθετα που δεν μπορούν να εισπραχθούν."""
    from app.services import billing_service
    db = shared_db()
    paid = {a["_id"] async for a in db["addons"].find({"price_monthly": {"$gt": 0}}, {"_id": 1})}
    names = {a["_id"]: a.get("name") or a["_id"]
             async for a in db["addons"].find({}, {"name": 1})}

    revoked: list[dict] = []
    kept: list[dict] = []
    async for t in db["tenants"].find({}, {"name": 1, "modules": 1}):
        mods = t.get("modules") or {}
        enabled_paid = [m for m, v in mods.items() if v == "enabled" and m in paid]
        if not enabled_paid:
            continue
        sub = await db["subscriptions"].find_one({"tenant_id": t["_id"]}) or {}
        included = set(sub.get("modules_included") or [])
        bought = set(sub.get("addons") or [])
        if sub.get("complimentary"):
            kept.append({"tenant": t.get("name"), "why": "δωρεάν συνδρομή"})
            continue
        candidates = [m for m in enabled_paid if m in bought and m not in included]
        if not candidates:
            kept.append({"tenant": t.get("name"), "why": "περιλαμβάνεται στο πακέτο"})
            continue
        targets = []
        for m in candidates:
            if await _paid_for(db, t["_id"], m):
                kept.append({"tenant": t.get("name"),
                             "why": f"υπάρχει πληρωμή για «{names.get(m, m)}»"})
            else:
                targets.append(m)
        if not targets:
            continue
        has_card = await billing_service.card_on_file(t["_id"])
        revoked.append({"tenant_id": t["_id"], "tenant": t.get("name"), "modules": targets,
                        "labels": [names.get(m, m) for m in targets], "card_on_file": has_card})
        if not dry_run:
            await db["tenants"].update_one({"_id": t["_id"]}, {
                "$unset": {f"modules.{m}": "" for m in targets},
                "$set": {"updated_at": _now()}})
            await db["subscriptions"].update_one({"tenant_id": t["_id"]}, {
                "$pull": {"addons": {"$in": targets}}})
            from app.services.addon_service import _recompute_total
            await _recompute_total(t["_id"])
            await _announce(db, t["_id"], [names.get(m, m) for m in targets])
    return {"ok": True, "dry_run": dry_run, "revoked": revoked, "kept": kept,
            "count": len(revoked)}


async def _paid_for(db, tenant_id: str, addon_id: str) -> bool:
    """Υπάρχει ΠΡΑΓΜΑΤΙΚΗ πληρωμή για αυτό το πρόσθετο;

    Ψάχνουμε γραμμή παραστατικού με `item_key = addon:<id>` (έτσι τιμολογείται η ενεργοποίηση)
    ή απόδειξη που το αναφέρει. Δεν αρκεί να υπάρχει τιμολόγιο συνδρομής: στον ΜΠΙΝΙΚΟ το
    τιμολόγιο των 970 € είχε ΜΟΝΟ τη γραμμή του πακέτου (`pkg:pro`) — το πρόσθετο μπήκε μετά.
    """
    key = f"addon:{addon_id}"
    if await db["invoices"].count_documents(
            {"tenant_id": tenant_id, "lines.item_key": key}):
        return True
    return bool(await db["receipts"].count_documents(
        {"tenant_id": tenant_id, "item_key": key}))


async def _announce(db, tenant_id: str, labels: list[str]) -> None:
    """Στοχευμένη ανακοίνωση ΜΟΝΟ σ' αυτό το φαρμακείο — όχι μαζικό μήνυμα."""
    await db["announcements"].insert_one({
        "title": MESSAGE_TITLE,
        "body": MESSAGE_BODY.format(names=", ".join(labels)),
        "audience": {"mode": "tenants", "tenant_ids": [tenant_id], "packages": []},
        "frequency": "every_login", "priority": 100, "active": True,
        "cta": "info", "created_at": _now(), "source": "addon_payment_amnesty"})
