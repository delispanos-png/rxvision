"""Ειδοποίηση πύλης για πελάτες ΓεΣΥ: «η επόμενη φάση της συνταγής σου πλησιάζει».

Το κυπριακό ισοδύναμο των ελληνικών υπενθυμίσεων αγωγής (εκείνες στηρίζονται στο θεραπευτικό
πρόγραμμα της ΗΔΥΚΑ, που δεν υπάρχει στο ΓεΣΥ). Η ημερομηνία βγαίνει από τον ΙΔΙΟ ορισμό των
αλυσίδων (`chains.py`) που βλέπει ο φαρμακοποιός στις «Ανοιχτές συνταγές», άρα πελάτης και
φαρμακείο βλέπουν την ίδια μέρα.

- Μία φορά ανά συνταγή και φάση (κλειδί στο `reminder_sent`), ό,τι κι αν ξανατρέξει.
- Στέλνεται όταν η φάση αναμένεται σε 0 έως NOTIFY_DAYS ημέρες.
- Σέβεται τις προτιμήσεις του πελάτη: είναι ενημέρωση, όχι απάντηση σε δική του ενέργεια.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from app.core.db import shared_db
from app.services.cy import chains as ch

NOTIFY_DAYS = 2


def message(c: dict, pharmacy: str | None) -> tuple[str, str]:
    d = date.fromisoformat(c["next_due"])
    items = c.get("items") or []
    what = items[0] + (f" (+{len(items) - 1})" if len(items) > 1 else "") if items else "η συνταγή σου"
    when = "σήμερα" if c["days_to_due"] <= 0 else f"στις {d.strftime('%d/%m')}"
    body = (f"{what}: η φάση {c['instance'] + 1}/{c['instances']} αναμένεται {when}."
            f"{f' Σε περιμένουμε στο {pharmacy}.' if pharmacy else ''}")
    return "🔁 Η επόμενη φάση της συνταγής σου", body


async def next_step_pushes(*, today: date | None = None) -> dict[str, Any]:
    from app.repositories.patient_portal import PatientAccountRepository
    from app.services import push_service
    from app.services.cy.gate import cy_enabled
    if not await cy_enabled():
        return {"sent": 0, "skipped": "disabled"}
    today = today or datetime.now(tz=ch.TZ).date()
    db = shared_db()
    repo = PatientAccountRepository()
    sent = due = 0
    async for t in db["tenants"].find({"country": "CY"}, {"name": 1, "company": 1}):
        tid = t["_id"]
        pharmacy = (t.get("company") or {}).get("name") or t.get("name")
        for m in await repo.cy_members(tid):
            for c in await ch.chains(tid, today=today, match={"patient_ref": m["cy_pseudo"]}):
                if c["status"] == "closed" or not (0 <= c["days_to_due"] <= NOTIFY_DAYS):
                    continue
                key = f"cynext:{tid}:{c['prescription_id']}:{c['instance'] + 1}"
                try:
                    await db["reminder_sent"].insert_one({"_id": key, "at": datetime.now(timezone.utc)})
                except Exception:   # noqa: BLE001 — υπάρχει ήδη: έχει σταλεί
                    continue
                due += 1
                title, body = message(c, pharmacy)
                sent += await push_service.send_to_account(
                    str(m["account_id"]), title=title, body=body, url="/portal?tab=cyrx", kind="reminder")
    return {"due": due, "sent": sent}
