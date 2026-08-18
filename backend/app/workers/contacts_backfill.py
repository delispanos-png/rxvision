"""Μαζική αρχικοποίηση στοιχείων επικοινωνίας από ΗΔΥΚΑ (Φάση A). Τρέχει ΜΟΝΟ για ασθενείς που
ΔΕΝ έχουν καθόλου email/κινητό, throttled (~1 αίτημα/δευτ.), με ΜΙΑ authentication, και σέβεται
πλήρως το ΗΔΥΚΑ auth-pause (μια αποτυχία → σταματά, ώστε να μη κλειδώσει ο λογαριασμός).
Γεμίζει μόνο κενά πεδία· ΠΟΤΕ consent/verified (GDPR — τα στοιχεία μένουν «ανεπιβεβαίωτα»)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from app.workers.celery_app import celery_app
from app.workers.ingestion import _hdika_auth_paused, _pause_hdika_auth, _run_async

# ΗΔΥΚΑ ~650 κλήσεις/ημέρα cap — cap ανά εκτέλεση (resumable: ξανατρέχει για τους υπόλοιπους).
_CAP_PER_RUN = 500
_THROTTLE_SEC = 1.0
_JOB = "contact_backfill_jobs"


async def _missing_contact_targets(db, tenant_id: str, cap: int) -> list[tuple]:
    """(patient_id, amka) για ενεργούς ασθενείς ΧΩΡΙΣ email ΚΑΙ ΧΩΡΙΣ κινητό, με έγκυρο ΑΜΚΑ."""
    rows = await db["patients_anonymized"].aggregate([
        {"$match": {"tenant_id": tenant_id, "amka": {"$nin": [None, ""]}}},
        {"$lookup": {"from": "patient_contacts", "localField": "_id",
                     "foreignField": "_id", "as": "c"}},
        {"$set": {"c": {"$first": "$c"}}},
        {"$match": {"$expr": {"$and": [
            {"$in": [{"$ifNull": ["$c.email", ""]}, ["", None]]},
            {"$in": [{"$ifNull": ["$c.mobile", ""]}, ["", None]]},
            {"$ne": [{"$ifNull": ["$c.active", True]}, False]},   # όχι ανενεργοί/αποβιώσαντες
        ]}}},
        {"$limit": cap},
        {"$project": {"_id": 1, "amka": 1}},
    ], allowDiskUse=True).to_list(length=cap)
    return [(r["_id"], str(r["amka"]).strip()) for r in rows if str(r.get("amka") or "").strip()]


async def _set_job(db, tenant_id: str, **fields) -> None:
    fields["updated_at"] = datetime.now(tz=timezone.utc)
    await db[_JOB].update_one({"_id": tenant_id}, {"$set": fields}, upsert=True)


@celery_app.task(name="app.workers.contacts_backfill.backfill_contacts_from_hdika")
def backfill_contacts_from_hdika(tenant_id: str) -> dict:
    """Αρχικοποίηση επικοινωνίας από ΗΔΥΚΑ για όσους ασθενείς λείπουν στοιχεία (ένα batch)."""
    async def _run() -> dict:
        from app.core.db import shared_db
        from app.repositories.contacts import PatientContactRepository
        from app.services.patient_lookup import normalize_hdika_patient
        from app.services.ingestion.hdika_client import (
            HdikaClient, HdikaAuthError, HdikaInvalidAmka, PatientDeceased,
        )
        from app.api.v1.routers.ingestion import _effective_hdika_creds

        db = shared_db()
        if await _hdika_auth_paused(db, tenant_id):
            await _set_job(db, tenant_id, status="paused", note="auth_paused")
            return {"status": "skipped", "note": "auth_paused"}

        # Vault contention (πολλά tasks μαζί) → διαλείποντα άδεια creds· retry πριν το «μη ρυθμισμένο».
        creds: dict = {}
        for _attempt in range(4):
            creds = dict(await _effective_hdika_creds(tenant_id))
            if creds.get("username") and creds.get("api_key") and (creds.get("base_url") or creds.get("live_endpoint")):
                break
            await asyncio.sleep(1.5)
        else:
            await _set_job(db, tenant_id, status="error", note="not_configured")
            return {"status": "error", "note": "not_configured"}

        targets = await _missing_contact_targets(db, tenant_id, _CAP_PER_RUN)
        now = datetime.now(tz=timezone.utc)
        await _set_job(db, tenant_id, status="running", total=len(targets), done=0,
                       filled=0, note=None, started_at=now, finished_at=None)
        if not targets:
            await _set_job(db, tenant_id, status="done", finished_at=now)
            return {"status": "done", "total": 0}

        from app.services.patient_lifecycle import mark_deceased

        client = HdikaClient(creds)
        repo = PatientContactRepository(tenant_id=tenant_id)
        done = filled = deceased = 0
        try:
            await asyncio.to_thread(client.authenticate)
        except HdikaAuthError as e:
            await _pause_hdika_auth(db, tenant_id, str(e))
            await _set_job(db, tenant_id, status="paused", note="auth_error")
            client.close()
            return {"status": "paused", "note": "auth_error"}
        except Exception as e:  # noqa: BLE001 — δίκτυο/gateway → ξαναδοκίμασε αργότερα
            await _set_job(db, tenant_id, status="error", note=str(e)[:120])
            client.close()
            return {"status": "error"}

        try:
            for pid, amka in targets:
                if await _hdika_auth_paused(db, tenant_id):
                    await _set_job(db, tenant_id, status="paused", note="auth_paused", done=done, filled=filled)
                    break
                try:
                    raw = await asyncio.to_thread(client.get_patient, amka)
                    norm = normalize_hdika_patient(raw)
                    if norm.get("found"):
                        res = await repo.apply_idyka(pid, norm)
                        if res and res.get("filled"):
                            filled += 1
                except HdikaAuthError as e:                 # λάθος κωδικός/lockout → ΠΑΥΣΗ & stop
                    await _pause_hdika_auth(db, tenant_id, str(e))
                    await _set_job(db, tenant_id, status="paused", note="auth_error", done=done, filled=filled)
                    break
                except PatientDeceased:                      # η ΗΔΥΚΑ δηλώνει θάνατο → κάρτα ανενεργή «θανών»
                    try:
                        await mark_deceased(tenant_id, amka)
                        deceased += 1
                    except Exception:  # noqa: BLE001
                        pass
                except HdikaInvalidAmka:
                    pass                                     # μη έγκυρο ΑΜΚΑ — προσπέρασε
                except Exception:  # noqa: BLE001 — transient· προσπέρασε αυτόν τον ασθενή
                    pass
                done += 1
                if done % 10 == 0:
                    await _set_job(db, tenant_id, done=done, filled=filled, deceased=deceased)
                await asyncio.sleep(_THROTTLE_SEC)
            else:
                await _set_job(db, tenant_id, status="done", done=done, filled=filled,
                               deceased=deceased, finished_at=datetime.now(tz=timezone.utc))
        finally:
            client.close()
        return {"status": "done", "done": done, "filled": filled, "total": len(targets)}

    return _run_async(_run())
