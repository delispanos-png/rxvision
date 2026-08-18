"""Death-sweep ΗΔΥΚΑ: περιοδικός έλεγχος αν κάποιος ασθενής έχει αποβιώσει (η ΗΔΥΚΑ το επιστρέφει
μόνο μέσω getpatient → `PatientDeceased`). Ελέγχει ΟΛΟΥΣ τους (μη-θανόντες) ασθενείς, με σειρά
«ό,τι ελέγχθηκε πιο παλιά πρώτο» (`death_checked_at` rotation), throttled (~1/δευτ.), ΜΙΑ
authentication, cap ανά εκτέλεση (resumable), και σέβεται πλήρως το ΗΔΥΚΑ auth-pause (μία αποτυχία
→ σταματά, να μη κλειδώσει ο λογαριασμός). Θανών → `mark_deceased` (κάρτα ανενεργή + ακύρωση εκκρεμών)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from app.workers.celery_app import celery_app
from app.workers.ingestion import _hdika_auth_paused, _pause_hdika_auth, _run_async

# Catch-up ρυθμίσεις: γρήγορη αρχική πλήρης κάλυψη. Μετά την κάλυψη μπορούμε να τα χαλαρώσουμε.
_CAP_PER_RUN = 1500         # ανά εκτέλεση (resumable rotation με death_checked_at)
_THROTTLE_SEC = 0.5         # 2 κλήσεις/δευτ. — τα rate-limit/transient σφάλματα προσπερνώνται (retry), δεν κάνουν pause
_JOB = "death_sweep_jobs"


async def _candidates(db, tenant_id: str, cap: int) -> list[tuple]:
    """(patient_id, amka) μη-θανόντων ασθενών, «ό,τι ελέγχθηκε πιο παλιά πρώτο» (nulls → ποτέ-ελεγμένοι)."""
    rows = await db["patients_anonymized"].find(
        {"tenant_id": tenant_id, "amka": {"$nin": [None, ""]}, "deceased": {"$ne": True}},
        {"_id": 1, "amka": 1},
    ).sort("death_checked_at", 1).limit(cap).to_list(length=cap)
    return [(r["_id"], str(r["amka"]).strip()) for r in rows if str(r.get("amka") or "").strip()]


async def _set_job(db, tenant_id: str, **fields) -> None:
    fields["updated_at"] = datetime.now(tz=timezone.utc)
    await db[_JOB].update_one({"_id": tenant_id}, {"$set": fields}, upsert=True)


@celery_app.task(name="app.workers.death_sweep.death_sweep")
def death_sweep(tenant_id: str) -> dict:
    """Ένα batch ελέγχου θανόντων για έναν tenant."""
    async def _run() -> dict:
        from app.core.db import shared_db
        from app.services.patient_lifecycle import mark_deceased
        from app.services.patient_lookup import normalize_hdika_patient
        from app.services.ingestion.hdika_client import (
            HdikaClient, HdikaAuthError, HdikaInvalidAmka, PatientDeceased,
        )
        from app.api.v1.routers.ingestion import _effective_hdika_creds
        from app.utils.anonymization import age_group

        db = shared_db()
        if await _hdika_auth_paused(db, tenant_id):
            await _set_job(db, tenant_id, status="paused", note="auth_paused")
            return {"status": "skipped", "note": "auth_paused"}
        # Το Vault επιστρέφει ΔΙΑΛΕΙΠΤΟΝΤΩΣ άδεια creds υπό ταυτόχρονο φορτίο (πολλά tasks μαζί) →
        # retry λίγες φορές πριν το θεωρήσουμε «μη ρυθμισμένο», ώστε να μη προσπερνάμε φαρμακεία που ΕΧΟΥΝ creds.
        creds: dict = {}
        for _attempt in range(4):
            creds = dict(await _effective_hdika_creds(tenant_id))
            if creds.get("username") and creds.get("api_key") and (creds.get("base_url") or creds.get("live_endpoint")):
                break
            await asyncio.sleep(1.5)
        else:
            await _set_job(db, tenant_id, status="error", note="not_configured")
            return {"status": "error", "note": "not_configured"}

        targets = await _candidates(db, tenant_id, _CAP_PER_RUN)
        now = datetime.now(tz=timezone.utc)
        await _set_job(db, tenant_id, status="running", total=len(targets), done=0,
                       deceased_found=0, note=None, started_at=now, finished_at=None)
        if not targets:
            await _set_job(db, tenant_id, status="done", finished_at=now)
            return {"status": "done", "total": 0}

        client = HdikaClient(creds)
        try:
            await asyncio.to_thread(client.authenticate)
        except HdikaAuthError as e:
            await _pause_hdika_auth(db, tenant_id, str(e))
            await _set_job(db, tenant_id, status="paused", note="auth_error")
            client.close()
            return {"status": "paused", "note": "auth_error"}
        except Exception as e:  # noqa: BLE001
            await _set_job(db, tenant_id, status="error", note=str(e)[:120])
            client.close()
            return {"status": "error"}

        done = deceased_found = age_filled = 0
        pa = db["patients_anonymized"]
        try:
            for pid, amka in targets:
                if await _hdika_auth_paused(db, tenant_id):
                    await _set_job(db, tenant_id, status="paused", note="auth_paused",
                                   done=done, deceased_found=deceased_found, age_filled=age_filled)
                    break
                checked = True
                try:
                    raw = await asyncio.to_thread(client.get_patient, amka)   # ζωντανός → ΟΚ
                    # Bonus (ΙΔΙΑ κλήση, μηδέν επιπλέον φορτίο): συμπλήρωσε ηλικία αν λείπει.
                    by = normalize_hdika_patient(raw).get("birth_year")
                    if by:
                        ag = age_group(int(by), today=datetime.now(tz=timezone.utc).date())
                        r = await pa.update_one(
                            {"_id": pid, "tenant_id": tenant_id, "$or": [
                                {"age_group": {"$in": [None, "", "unknown"]}}, {"birth_year": {"$in": [None, 0]}}]},
                            {"$set": {"birth_year": int(by), "age_group": ag}})
                        if r.modified_count:
                            age_filled += 1
                except PatientDeceased:
                    try:
                        await mark_deceased(tenant_id, amka)
                        deceased_found += 1
                    except Exception:  # noqa: BLE001
                        pass
                except HdikaAuthError as e:
                    await _pause_hdika_auth(db, tenant_id, str(e))
                    await _set_job(db, tenant_id, status="paused", note="auth_error",
                                   done=done, deceased_found=deceased_found, age_filled=age_filled)
                    break
                except HdikaInvalidAmka:
                    pass                                                # μη έγκυρο ΑΜΚΑ → μαρκάρισε ελεγμένο
                except Exception:  # noqa: BLE001 — transient· ΜΗΝ το μαρκάρεις ελεγμένο (retry αργότερα)
                    checked = False
                if checked:
                    await pa.update_one({"_id": pid, "tenant_id": tenant_id},
                                        {"$set": {"death_checked_at": datetime.now(tz=timezone.utc)}})
                done += 1
                if done % 10 == 0:
                    await _set_job(db, tenant_id, done=done, deceased_found=deceased_found, age_filled=age_filled)
                await asyncio.sleep(_THROTTLE_SEC)
            else:
                await _set_job(db, tenant_id, status="done", done=done, deceased_found=deceased_found,
                               age_filled=age_filled, finished_at=datetime.now(tz=timezone.utc))
        finally:
            client.close()
        return {"status": "done", "done": done, "deceased_found": deceased_found,
                "age_filled": age_filled, "total": len(targets)}

    return _run_async(_run())


@celery_app.task(name="app.workers.death_sweep.dispatch_death_sweep")
def dispatch_death_sweep() -> int:
    """Beat (εβδομαδιαία): ξεκινά death-sweep για κάθε tenant με ρυθμισμένη & μη-παυμένη ΗΔΥΚΑ."""
    async def _run() -> int:
        from app.core.db import shared_db
        db = shared_db()
        tids = [t["_id"] async for t in db["tenants"].find(
            {"ingestion_config.hdika": {"$exists": True},
             "ingestion_config.hdika.auth_paused": {"$ne": True}}, {"_id": 1})]
        for tid in tids:
            death_sweep.delay(tid)
        return len(tids)

    return _run_async(_run())
