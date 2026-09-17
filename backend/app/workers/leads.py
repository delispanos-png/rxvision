"""Εργασίες Lead Engine.

ΚΑΜΙΑ ΑΠΟΣΤΟΛΗ ΣΕ ΦΑΡΜΑΚΕΙΟ στη Φάση 1. Η μόνη επικοινωνία που φεύγει είναι η ημερήσια
περίληψη **προς τον ιδιοκτήτη** — και μόνο όταν όντως υπάρχει κάτι να πει.
"""

from __future__ import annotations

import asyncio

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.leads.project")
def project() -> dict:
    """Ξαναχτίζει την προβολή leads από tenants/subscriptions/audit/εγγραφές."""
    from app.services.leads import projection

    async def _run() -> dict:
        return await projection.project()

    return asyncio.run(_run())


@celery_app.task(name="app.workers.leads.digest")
def digest() -> dict:
    """Ημερήσιο email στον ιδιοκτήτη: τι χρειάζεται προσοχή σήμερα.

    Αν δεν υπάρχει τίποτα, ΔΕΝ στέλνει. Ένα «δεν έχεις τίποτα» κάθε πρωί εκπαιδεύει τον
    παραλήπτη να αγνοεί το επόμενο — και τότε χάνεται και αυτό που μετράει.
    """
    from app.services import mailer
    from app.services.leads import board

    async def _run() -> dict:
        rows = await board.today()
        urgent = [r for r in rows if r["tone"] in ("red", "orange", "yellow")]
        if not urgent:
            return {"sent": 0, "reason": "nothing_to_say"}
        cfg = await mailer.get_smtp(masked=True)
        to = (cfg or {}).get("from_email") or (cfg or {}).get("username")
        if not to:
            return {"sent": 0, "reason": "no_recipient"}
        items = "".join(
            f'<li style="margin:6px 0;">{r["icon"]} {r["text"]}</li>' for r in rows)
        html = (
            '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">'
            '<div style="background:#4f46e5;padding:16px 22px;color:#fff;font-size:18px;font-weight:700;">RxVision</div>'
            '<div style="padding:22px;font-size:15px;line-height:1.6;">'
            '<p style="margin:0 0 12px;">Τι χρειάζεται την προσοχή σου σήμερα:</p>'
            f'<ul style="padding-left:18px;margin:0 0 16px;">{items}</ul>'
            '<a href="https://adminpanel.rxvision.gr/admin/leads" '
            'style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;'
            'padding:10px 18px;border-radius:8px;font-weight:700;">Άνοιξε τη λίστα</a>'
            '</div></div>')
        try:
            await mailer.send_email(to, "RxVision — τι χρειάζεται προσοχή σήμερα", html)
        except Exception:                                    # noqa: BLE001
            return {"sent": 0, "reason": "smtp_failed"}
        return {"sent": 1, "items": len(rows)}

    return asyncio.run(_run())
