"""Νυχτερινός αυτοέλεγχος συνέπειας (beat, 04:40 Αθήνας) — services/integrity_checks.py.

Αποθηκεύει ΚΑΘΕ εκτέλεση στο `integrity_runs` (και όταν όλα είναι καθαρά — η σιωπή πρέπει να
διακρίνεται από το «δεν έτρεξε»), και στέλνει email στους διαχειριστές της πλατφόρμας για ό,τι ΝΕΟ
βρέθηκε. Ίδιο εύρημα δεν ξαναστέλνεται για 7 ημέρες (ops_alerts), αλλά μένει στο ιστορικό.
Αποτυχία αποστολής καταγράφεται στο ίδιο το run — δεν καταπίνεται ([[alert-blindness-three-layers]]).
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.workers.celery_app import celery_app
from app.workers.ingestion import _fresh_db, _run_async

_ADMIN_FALLBACK = ["cloudon@rxvision.gr"]
_RENOTIFY_S = 7 * 24 * 3600


@celery_app.task(name="app.workers.integrity.nightly")
def nightly() -> dict:
    async def _run() -> dict:
        from app.services import integrity_checks as ic
        from app.services import mailer
        client, db = _fresh_db()
        try:
            now = datetime.now(tz=timezone.utc)
            findings: list[dict] = []
            errors: list[str] = []
            names: dict = {}
            async for t in db["tenants"].find({}, {"_id": 1, "name": 1}):
                names[t["_id"]] = t.get("name") or t["_id"]
                try:
                    findings += [f.as_dict() for f in await ic.check_tenant(db, t["_id"], now)]
                except Exception as e:  # noqa: BLE001 — ένα φαρμακείο δεν σταματά τους υπόλοιπους
                    errors.append(f"{t['_id']}: {type(e).__name__}: {e}"[:300])
            try:
                findings += [f.as_dict() for f in await ic.check_platform(db, now)]
            except Exception as e:  # noqa: BLE001
                errors.append(f"platform: {type(e).__name__}: {e}"[:300])

            # Παραστατικά Viva: η ΙΔΙΑ η Viva πρέπει να επιβεβαιώνει κάθε «Πληρωμένο» (ποσό ≥ σύνολο).
            # Ό,τι δεν επιβεβαιώνεται γίνεται «Απλήρωτο (Viva)» στην οθόνη και έρχεται εδώ ως εύρημα.
            try:
                from app.services import invoice_service
                bad = await invoice_service.reverify_viva_invoices(db)
                from app.services import billing_service
                for b in bad:   # απλήρωτη συνδρομή που φαινόταν πληρωμένη → κλείδωμα + «πληρώστε ξανά»
                    doc = await db["invoices"].find_one({"_id": __import__("bson").ObjectId(b["invoice"])})
                    if doc:
                        await billing_service.lock_for_unverified_invoice(doc)
                total = await db["invoices"].count_documents(
                    {"payment.provider": "viva", "payment.transaction_id": {"$nin": [None, ""]}})
                if bad:
                    findings.append(ic.Finding(
                        "viva_invoice_unpaid", "Παραστατικό «πληρωμένο» με Viva που η Viva ΔΕΝ επιβεβαιώνει "
                        "(ποσό/είδος συναλλαγής) — έλεγξε πριν γίνει ΤΠΥ", len(bad), total, None,
                        [f"{b['number']} {b['tenant_id']} {(b['paid'] or 0)/100:.2f}/{(b['total'] or 0)/100:.2f}€"
                         for b in bad][:5]).as_dict())
            except Exception as e:  # noqa: BLE001
                errors.append(f"viva invoices: {type(e).__name__}: {e}"[:300])

            # τι είναι ΝΕΟ (ή ξαναγύρισε μετά από 7 ημέρες) → email
            fresh: list[dict] = []
            for f in findings:
                key = {"_id": f"integrity:{f['check']}:{f.get('tenant_id') or '*'}"}
                last = await db["ops_alerts"].find_one(key)
                lt = (last or {}).get("ts")
                if lt and lt.tzinfo is None:
                    lt = lt.replace(tzinfo=timezone.utc)
                if lt and (now - lt).total_seconds() < _RENOTIFY_S:
                    continue
                await db["ops_alerts"].update_one(key, {"$set": {"ts": now, "msg": f["title"]}}, upsert=True)
                fresh.append(f)

            mail_error = None
            if fresh or errors:
                admins = [a["email"] async for a in db["platform_admins"].find({}, {"email": 1})
                          if a.get("email")] or _ADMIN_FALLBACK
                rows = "".join(
                    f"<li><b>{names.get(f.get('tenant_id'), 'Πλατφόρμα') if f.get('tenant_id') else 'Πλατφόρμα'}</b>: "
                    f"{f['title']} — {f['bad']} από {f['total']}"
                    + (f" <span style='color:#888'>(π.χ. {', '.join(map(str, f['sample'][:3]))})</span>"
                       if f.get("sample") else "") + "</li>" for f in fresh)
                rows += "".join(f"<li>⚠️ Ο έλεγχος απέτυχε: {e}</li>" for e in errors)
                html = ("<h3>🔎 RxVision — Νυχτερινός έλεγχος δεδομένων</h3>"
                        "<p>Βρέθηκε κάτι που δεν στέκει, πριν το δει πελάτης:</p><ul>" + rows + "</ul>"
                        f"<p style='color:#888;font-size:12px'>{now.isoformat()}</p>")
                try:
                    await mailer.send_bulk(admins, "🔎 RxVision — Έλεγχος δεδομένων", html)
                except Exception as e:  # noqa: BLE001
                    mail_error = f"{type(e).__name__}: {e}"[:300]

            run = {"_id": now.strftime("%Y-%m-%d"), "at": now, "ok": not findings and not errors,
                   "findings": findings, "errors": errors, "notified": len(fresh),
                   "mail_error": mail_error}
            await db["integrity_runs"].replace_one({"_id": run["_id"]}, run, upsert=True)
            return {"ok": run["ok"], "findings": len(findings), "notified": len(fresh),
                    "errors": len(errors), "mail_error": mail_error}
        finally:
            client.close()

    return _run_async(_run())


@celery_app.task(name="app.workers.integrity.refresh_patient_lifecycle")
def refresh_patient_lifecycle() -> dict:
    """Κάθε βράδυ: κατάσταση πελάτη από την τελευταία επίσκεψη (services/patient_status.py) — αλλιώς
    το πεδίο μένει «active» για πάντα και το κοινό «σε κίνδυνο/χαμένοι» είναι άδειο."""
    async def _run() -> dict:
        from app.services import patient_status
        client, db = _fresh_db()
        try:
            out: dict = {}
            async for t in db["tenants"].find({}, {"_id": 1}):
                for k, v in (await patient_status.refresh(db, t["_id"])).items():
                    out[k] = out.get(k, 0) + v
            return out
        finally:
            client.close()

    return _run_async(_run())
