"""Ο Σύμβουλος — πρωινό μήνυμα στον φαρμακοποιό.

Ένα κύκλωμα που πρέπει να το ΘΥΜΗΘΕΙΣ για να το ανοίξεις, δεν αξίζει τα λεφτά του. Οπότε κάθε
πρωί (07:30 Αθήνας) ο σύμβουλος στέλνει ΕΝΑ email με τα 3 σημαντικότερα — και τον καλεί μέσα.

Κανόνες:
 · ΜΟΝΟ στα φαρμακεία με ενεργό το add-on `daily_coach`·
 · μία φορά την ημέρα, στο email της καρτέλας·
 · κεντρικό SMTP της πλατφόρμας — ΠΟΤΕ από το πορτοφόλι μηνυμάτων του φαρμακείου·
 · αν δεν υπάρχει τίποτα να πει, ΔΕΝ στέλνει τίποτα (εκτός από το εβδομαδιαίο «μπράβο»).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.workers.celery_app import celery_app
from app.workers.ingestion import _fresh_db, _pharmacy_email, _run_async

_APP_URL = "https://app.rxvision.gr/coach"
_TONE_COLOR = {"hard": "#e11d48", "firm": "#d97706", "soft": "#0284c7"}


def _html(day: dict, pharmacy: str) -> str:
    rows = "".join(
        f"""<tr><td style="padding:0 0 14px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-left:4px solid {_TONE_COLOR.get(i['tone'], '#0284c7')};
               background:#f8fafc;border-radius:0 10px 10px 0;">
            <tr><td style="padding:12px 16px;">
              <div style="font-weight:700;color:#0f172a;font-size:15px;">{i['title']}</div>
              <div style="color:#334155;font-size:14px;line-height:1.55;margin-top:4px;">{i['body']}</div>
            </td></tr></table></td></tr>"""
        for i in day["items"][:3])
    wins = "".join(
        f"""<div style="color:#065f46;font-size:14px;line-height:1.55;margin:0 0 8px;">✅ {w['text']}</div>"""
        for w in day["wins"][:2])
    wins_block = (f"""<div style="background:#ecfdf5;border-radius:10px;padding:14px 16px;margin:4px 0 18px;">
        <div style="font-weight:700;color:#047857;font-size:14px;margin-bottom:8px;">Αυτά τα πήγες σωστά</div>
        {wins}</div>""" if wins else "")
    more = (f"""<div style="color:#64748b;font-size:13px;margin:0 0 18px;">
        …και άλλα {len(day['items']) - 3} μέσα στην εφαρμογή.</div>"""
            if len(day["items"]) > 3 else "")
    return f"""<div style="background:#f1f5f9;padding:26px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
    <div style="background:linear-gradient(135deg,#4f46e5,#0284c7);padding:20px 26px;color:#fff;">
      <div style="font-size:19px;font-weight:800;">Ο Σύμβουλός σου</div>
      <div style="font-size:13px;opacity:.9;">{pharmacy}</div></div>
    <div style="padding:22px 26px;">
      <p style="font-size:15px;color:#0f172a;line-height:1.6;margin:0 0 18px;">{day['greeting']}</p>
      <table width="100%" cellpadding="0" cellspacing="0">{rows}</table>
      {more}{wins_block}
      <a href="{_APP_URL}" style="background:#4f46e5;color:#fff;padding:11px 20px;border-radius:9px;
         text-decoration:none;display:inline-block;font-weight:700;font-size:14px;">Δες τα όλα</a>
      <p style="color:#94a3b8;font-size:12px;margin-top:18px;line-height:1.5;">
        Το λαμβάνεις επειδή το φαρμακείο σου έχει ενεργό τον Σύμβουλο. Μπορείς να το
        απενεργοποιήσεις από τις Ρυθμίσεις → Πλάνο &amp; Modules.</p>
    </div></div></div>"""


@celery_app.task(name="app.workers.coach.daily_briefing")
def daily_briefing() -> dict:
    async def _run() -> dict:
        from app.repositories.daily_coach import DailyCoachRepository
        from app.services import mailer
        from app.services.auth_service import resolve_tenant_modules, tenant_has
        client, db = _fresh_db()
        now = datetime.now(tz=timezone.utc)
        sent = skipped = 0
        try:
            async for t in db["tenants"].find({"status": {"$in": ["active", "trial"]}}):
                tid = t["_id"]
                if not tenant_has(await resolve_tenant_modules(tid), "daily_coach"):
                    continue
                email = _pharmacy_email(t)
                if not email:
                    skipped += 1
                    continue
                last = (t.get("coach") or {}).get("briefed_at")
                if last and (now - last.replace(tzinfo=timezone.utc)) < timedelta(hours=20):
                    continue                                   # ήδη στάλθηκε σήμερα
                try:
                    day = await DailyCoachRepository(tenant_id=tid, demo=bool(t.get("demo"))).build()
                except Exception:                              # noqa: BLE001
                    import logging
                    logging.getLogger(__name__).exception("coach build failed for %s", tid)
                    continue
                # Τίποτα να πει; Μη στέλνεις. Εκτός αν είναι σερί καθαρών ημερών που αξίζει «μπράβο».
                if not day["items"] and not (day["wins"] and day["clean_streak"] in (5, 10, 20, 30)):
                    continue
                subject = ("RxVision — καθαρή εβδομάδα 👏" if not day["items"]
                           else f"RxVision — {len(day['items'])} πράγματα για σήμερα")
                try:
                    await mailer.send_email(email, subject, _html(day, t.get("name") or ""))
                    await db["tenants"].update_one({"_id": tid}, {"$set": {"coach.briefed_at": now}})
                    sent += 1
                except Exception:                              # noqa: BLE001
                    import logging
                    logging.getLogger(__name__).exception("coach email failed for %s", tid)
        finally:
            client.close()
        return {"sent": sent, "skipped_no_email": skipped}

    return _run_async(_run())
