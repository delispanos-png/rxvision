"""Ingestion persist engine — source-agnostic core (INGESTION.md).

Takes canonical executions and: anonymises the patient, resolves/creates doctor,
fund and product references, deduplicates by natural key + content hash, upserts the
execution and its items, runs post-processing (counters, future prescriptions), and
records a sync_jobs row with stats. Tenant-scoped on every operation.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from pymongo import ReturnDocument

from app.core.config import settings
from app.core.db import shared_db
from app.services.ingestion.canonical import CanonicalExecution, CanonicalItem
from app.services.ingestion.validate import validate_execution
from app.services.vault_service import vault
from app.services.wholesale import load_bands, markup_pct
from app.utils.anonymization import age_group, pseudonymize

_REPEAT_INTERVAL_DAYS = 30


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


# Bump όταν αλλάζει η ΔΟΜΗ των αποθηκευμένων items/details (όχι μόνο οι τιμές) ώστε ένα
# re-ingest να ΞΑΝΑΓΡΑΨΕΙ τα items αντί να κάνει skip-by-hash. v2: per-τεμάχιο coupons.
_PARSE_VERSION = "v7-galenic"


def _content_hash(ex: CanonicalExecution, amount_total: int, claimed: int) -> str:
    parts = [_PARSE_VERSION, ex.source, ex.external_id, ex.executed_at.isoformat(),
             str(amount_total), str(claimed), str(ex.repeat_current), str(ex.repeat_total),
             ",".join(sorted(ex.icd10)),
             ";".join(sorted(f"{i.barcode}:{i.quantity}:{i.retail_price}" for i in ex.items))]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


class IngestionEngine:
    def __init__(self, tenant_id: str, db=None) -> None:
        # db is injectable so Celery workers can pass a client bound to their own
        # event loop (Motor clients are loop-bound). Defaults to the shared client.
        self.tenant_id = tenant_id
        self.db = db if db is not None else shared_db()
        self.pepper = vault.tenant_pepper(tenant_id)
        self._bands: list[list[float]] | None = None   # κλιμακωτή διατίμηση (platform-global, lazy)

    async def ingest(self, *, source: str, job_type: str,
                     records: Iterable[CanonicalExecution],
                     window: tuple | None = None, task_id: str | None = None) -> dict:
        stats = {"fetched": 0, "inserted": 0, "updated": 0, "duplicates": 0, "invalid": 0}
        errors: list[dict] = []
        job_id = ObjectId()
        # window = (start, end) date range being ingested → enables a real % progress bar
        span = None
        if window and window[0] and window[1]:
            span = abs((window[1] - window[0]).total_seconds()) or None
        first_cursor: object = None
        cancelled = False
        await self.db["sync_jobs"].insert_one({
            "_id": job_id, "tenant_id": self.tenant_id, "source": source, "type": job_type,
            "status": "running", "cursor": {}, "stats": stats, "attempts": 1,
            "progress": 0.0, "cursor_date": None, "task_id": task_id,
            "window": ({"start": window[0], "end": window[1]} if window else None),
            "error": None, "started_at": _now(), "updated_at": _now(), "finished_at": None,
        })

        for ex in records:
            stats["fetched"] += 1
            verrs = validate_execution(ex)
            if verrs:
                stats["invalid"] += 1
                errors.append({"external_id": ex.external_id, "errors": verrs})
                continue
            try:
                outcome = await self._persist(ex, job_id)
                stats[outcome] += 1
            except Exception as exc:  # noqa: BLE001
                stats["invalid"] += 1
                errors.append({"external_id": ex.external_id, "errors": [f"persist: {exc}"]})
            # live progress so the UI can show a REAL % progress bar while it runs
            if first_cursor is None and getattr(ex, "executed_at", None):
                first_cursor = ex.executed_at
            if stats["fetched"] % 20 == 0:
                upd = {"stats": stats, "updated_at": _now()}  # heartbeat → detect orphans
                cur = getattr(ex, "executed_at", None)
                if cur is not None:
                    upd["cursor_date"] = cur
                    if span and first_cursor is not None:
                        upd["progress"] = min(1.0, abs((cur - first_cursor).total_seconds()) / span)
                await self.db["sync_jobs"].update_one({"_id": job_id}, {"$set": upd})
                # cooperative stop: the API sets cancel_requested on this running job
                j = await self.db["sync_jobs"].find_one({"_id": job_id}, {"cancel_requested": 1})
                if j and j.get("cancel_requested"):
                    cancelled = True
                    break

        # Keep products' catalog-derived fields fresh after any ingest that created/updated products
        # (atc/category/substance/πλήρες όνομα). Χωρίς αυτό, μετά από backfill τα products έχουν κενό
        # atc → ο Σύμβουλος Διατροφής / ATC analytics δεν βρίσκουν τίποτα. Best-effort, ποτέ δεν ρίχνει
        # το job. (Idempotent· τρέχει μόνο όταν μπήκαν/άλλαξαν είδη.)
        if not cancelled and (stats.get("inserted") or stats.get("updated")):
            try:
                from app.services.ingestion.hdika_catalog import enrich_product_categories
                await enrich_product_categories(self.db)
            except Exception:  # noqa: BLE001
                pass

        status = "cancelled" if cancelled else ("success" if not errors else "partial")
        final = {"status": status, "stats": stats, "errors": errors[:200], "finished_at": _now()}
        if not cancelled:
            final["progress"] = 1.0
        await self.db["sync_jobs"].update_one({"_id": job_id}, {"$set": final})
        job = await self.db["sync_jobs"].find_one({"_id": job_id})
        job["_id"] = str(job["_id"])
        return job

    # ── per-record persist ─────────────────────────────────
    async def _persist(self, ex: CanonicalExecution, job_id: ObjectId) -> str:
        patient_ref = await self._resolve_patient(ex)
        doctor_id = await self._resolve_doctor(ex)
        fund_id = await self._resolve_fund(ex)

        item_docs, amount_total, wholesale_cost = await self._resolve_items(ex)
        if ex.amount_total:                       # source-authoritative retail (ΗΔΥΚΑ) → exact totals
            # Κλιμάκωσε το χονδρικό στο ίδιο authoritative σύνολο ώστε ο λόγος χονδρ./λιαν. να
            # μένει σταθερός — αλλιώς (διπλός πολλαπλασιασμός qty) το μεικτό κέρδος βγαίνει αρνητικό.
            if amount_total > 0:
                wholesale_cost = round(wholesale_cost * ex.amount_total / amount_total)
            amount_total = ex.amount_total
        patient_share = ex.patient_share or 0
        amount_claimed = amount_total - patient_share
        chash = _content_hash(ex, amount_total, amount_claimed)

        nat_key = {"tenant_id": self.tenant_id, "source": ex.source, "external_id": ex.external_id}
        existing = await self.db["prescription_executions"].find_one(nat_key, {"hash": 1})  # tenant-ok: nat_key carries tenant_id
        if existing and existing.get("hash") == chash:
            return "duplicates"

        # «Επόμενη εκτέλεση» ΜΟΝΟ για γνήσια επαναλαμβανόμενη συνταγή (CDA 1.1.4 = 3/4/5/6 →
        # repeat_total>1, με σειρά < σύνολο). Μια ΑΠΛΗ συνταγή (1.1.4=1, rt=1) — ακόμη κι αν είναι
        # μηνιαία/δίμηνη (η μία εκτέλεση καλύπτει 1-2 μήνες) ΔΕΝ ξανανοίγει· δεν μπαίνει στην
        # πρόβλεψη. (Το παλιό valid_until heuristic φαβρικάριζε phantom επαναλήψεις για απλές.)
        next_open = None
        if ex.repeat_current < ex.repeat_total:           # ΗΔΥΚΑ: υπάρχουν κι άλλες εκτελέσεις
            det = ex.details or {}
            # Πραγματική περίοδος επανάληψης: CDA 1.1.4.4 (30/28/60 ημ.)· αλλιώς μηνιαία/δίμηνη
            # (interval_months·30)· αλλιώς 30. Βάση = ημ/νία εκτέλεσης αυτής της σειράς.
            period = det.get("repeat_period_days") or ((det.get("interval_months") or 1) * 30)
            next_open = ex.executed_at + timedelta(days=int(period))

        doc = {
            **nat_key, "pharmacy_id": None, "executed_at": ex.executed_at,
            "fund_id": fund_id, "doctor_id": doctor_id, "patient_ref": patient_ref,
            "repeat_current": ex.repeat_current, "repeat_total": ex.repeat_total,
            "repeat_root": ex.repeat_root, "valid_from": ex.valid_from, "valid_until": ex.valid_until,
            "icd10": ex.icd10, "amount_total": amount_total, "amount_claimed": amount_claimed,
            "patient_share": patient_share, "wholesale_cost": wholesale_cost,
            "status": ("partial" if any(not i.is_executed for i in ex.items) else "executed"),
            "has_unexecuted_substances": any(not i.is_executed for i in ex.items),
            "next_open_date": next_open, "hash": chash, "ingested_at": _now(),
            "sync_job_id": job_id, "details": ex.details or {},
        }
        res = await self.db["prescription_executions"].find_one_and_update(  # tenant-ok: nat_key carries tenant_id
            nat_key, {"$set": doc}, upsert=True, return_document=ReturnDocument.AFTER)
        exec_id = res["_id"]
        is_new = existing is None

        # replace items (idempotent)
        await self.db["prescription_items"].delete_many(
            {"tenant_id": self.tenant_id, "execution_id": exec_id})
        for it_doc in item_docs:
            it_doc.update({"tenant_id": self.tenant_id, "execution_id": exec_id,
                           "executed_at": ex.executed_at})
        if item_docs:
            await self.db["prescription_items"].insert_many(item_docs)  # tenant-ok: item_docs carry tenant_id

        await self._post_process(ex, exec_id, patient_ref, amount_total, next_open,
                                 item_docs, count_patient=is_new)
        return "inserted" if is_new else "updated"

    # ── reference resolution (upserts) ─────────────────────
    async def _resolve_patient(self, ex: CanonicalExecution) -> ObjectId:
        pseudo = pseudonymize(ex.patient.national_id, tenant_pepper=self.pepper)
        ag = age_group(ex.patient.birth_year, today=_now().date()) if ex.patient.birth_year else "unknown"
        set_fields = {"sex": ex.patient.sex, "age_group": ag,
                      "residence_area": ex.patient.area,
                      "birth_year": ex.patient.birth_year}
        # The pharmacy is the data controller of its own patients → store identifiers so
        # the (authorised) pharmacist can see who they are. Tenant-isolated.
        if ex.patient.full_name:
            set_fields["full_name"] = ex.patient.full_name
        if ex.patient.national_id and ex.patient.national_id.isdigit():
            set_fields["amka"] = ex.patient.national_id
        # first_seen_at = EARLIEST execution date, last_seen_at = LATEST — via $min/$max so they stay
        # correct regardless of INGESTION ORDER (e.g. May-2026 downloaded before a Jan-2025 backfill).
        res = await self.db["patients_anonymized"].find_one_and_update(
            {"tenant_id": self.tenant_id, "pseudo_id": pseudo},
            {"$set": set_fields,
             "$min": {"first_seen_at": ex.executed_at},
             "$max": {"last_seen_at": ex.executed_at},
             "$setOnInsert": {"tenant_id": self.tenant_id, "pseudo_id": pseudo,
                              "rx_count": 0, "rx_value_total": 0,
                              "lifecycle": "new", "created_at": _now()}},
            upsert=True, return_document=ReturnDocument.AFTER)
        return res["_id"]

    async def _resolve_doctor(self, ex: CanonicalExecution) -> ObjectId:
        set_fields: dict = {"specialty": ex.doctor.specialty}
        if ex.doctor.phone:                      # ΗΔΥΚΑ τηλέφωνο/email γιατρού (μη κενά μόνο)
            set_fields["phone"] = ex.doctor.phone
        if ex.doctor.email:
            set_fields["email"] = ex.doctor.email
        res = await self.db["doctors"].find_one_and_update(
            {"tenant_id": self.tenant_id, "full_name": ex.doctor.full_name},
            {"$set": set_fields,
             "$setOnInsert": {"tenant_id": self.tenant_id, "full_name": ex.doctor.full_name,
                              "first_seen_at": ex.executed_at, "created_at": _now()}},
            upsert=True, return_document=ReturnDocument.AFTER)
        return res["_id"]

    async def _resolve_fund(self, ex: CanonicalExecution) -> ObjectId:
        res = await self.db["insurance_funds"].find_one_and_update(
            {"tenant_id": self.tenant_id, "code": ex.fund.code},
            {"$set": {"name": ex.fund.name or ex.fund.code},
             "$setOnInsert": {"tenant_id": self.tenant_id, "code": ex.fund.code,
                              "created_at": _now()}},
            upsert=True, return_document=ReturnDocument.AFTER)
        return res["_id"]

    async def _effective_wholesale(self, it: CanonicalItem) -> tuple[int, str]:
        """Resolve an item's wholesale cost in cents (+ its source), so profitability is
        never computed against a 0 cost (which made gross_profit == amount_claimed for
        live ΗΔΥΚΑ — T-06). Priority:
          1. value from the source feed (ΓΕΣΥ / synthetic / PharmacyOne),
          2. a known *real* price already in product masterdata,
          3. an estimate from retail via WHOLESALE_FALLBACK_MARGIN_PCT (flagged 'estimated').
        """
        if it.wholesale_price > 0:
            return it.wholesale_price, "source"
        if it.barcode:
            prod = await self.db["products"].find_one(
                {"tenant_id": self.tenant_id, "barcode": it.barcode},
                {"wholesale_price": 1, "wholesale_source": 1})
            known = (prod or {}).get("wholesale_price", 0) or 0
            # Only trust a previously-stored price if it was real, not itself an estimate.
            if known > 0 and (prod or {}).get("wholesale_source") != "estimated":
                return known, "masterdata"
        # Γαληνικά/μαγιστρικά σκευάσματα: δεν ισχύει η κανονική διατίμηση & δεν έχουμε χονδρική →
        # Ν/Α (εξαιρούνται τελείως από κόστος/κέρδος αντί να φαβρικάρουμε νούμερο).
        if (it.details or {}).get("galenic"):
            return 0, "unavailable"
        # Εκτίμηση από την κλιμακωτή διατίμηση (platform-global, ρυθμιζόμενη από το admin).
        if it.retail_price > 0:
            if self._bands is None:
                self._bands = await load_bands(self.db)
            return round(it.retail_price * (1 - markup_pct(it.retail_price, self._bands) / 100)), "estimated"
        return 0, "unknown"

    async def _resolve_items(self, ex: CanonicalExecution) -> tuple[list[dict], int, int]:
        docs: list[dict] = []
        amount_total = wholesale_cost = 0
        for it in ex.items:
            wholesale, wsource = await self._effective_wholesale(it)
            margin = it.retail_price - wholesale
            margin_pct = round((margin / it.retail_price) * 100, 2) if it.retail_price else 0
            set_fields = {"name": it.name, "retail_price": it.retail_price, "margin": margin,
                          "margin_pct": margin_pct, "category": it.category,
                          "substance": it.substance, "updated_at": _now()}
            # Never clobber a known masterdata wholesale price with 0/unknown.
            if wholesale > 0:
                set_fields["wholesale_price"] = wholesale
                set_fields["wholesale_source"] = wsource
            res = await self.db["products"].find_one_and_update(
                {"tenant_id": self.tenant_id, "barcode": it.barcode},
                {"$set": set_fields,
                 "$setOnInsert": {"tenant_id": self.tenant_id, "barcode": it.barcode,
                                  "rx_frequency": 0}},
                upsert=True, return_document=ReturnDocument.AFTER)
            product_id = res["_id"]
            amount_total += it.retail_price * it.quantity
            wholesale_cost += wholesale * it.quantity
            docs.append({"product_id": product_id, "active_substance_id": None,
                         "quantity": it.quantity, "retail_price": it.retail_price,
                         "wholesale_price": wholesale, "wholesale_source": wsource,
                         "margin": margin,
                         "amount_claimed": it.retail_price * it.quantity, "patient_share": 0,
                         "is_executed": it.is_executed, "category": it.category,
                         "details": it.details or {}})
        return docs, amount_total, wholesale_cost

    async def _post_process(self, ex, exec_id, patient_ref, amount_total, next_open,
                            item_docs, *, count_patient: bool) -> None:
        if count_patient:
            await self.db["patients_anonymized"].update_one(
                {"tenant_id": self.tenant_id, "_id": patient_ref},
                {"$inc": {"rx_count": 1, "rx_value_total": amount_total},
                 "$set": {"lifecycle": "active"}})
        for it in item_docs:
            await self.db["products"].update_one(
                {"tenant_id": self.tenant_id, "_id": it["product_id"]},
                {"$inc": {"rx_frequency": 1}})
        if next_open:
            await self.db["future_prescriptions"].update_one(
                {"tenant_id": self.tenant_id, "source_execution_id": exec_id},
                {"$set": {"expected_open_date": next_open, "status": "pending",
                          "patient_ref": patient_ref,
                          "products": [{"product_id": it["product_id"], "expected_qty": it["quantity"]}
                                       for it in item_docs]},
                 "$setOnInsert": {"tenant_id": self.tenant_id, "source_execution_id": exec_id,
                                  "confidence": 0.9, "created_at": _now()}},
                upsert=True)
        else:
            # καμία επόμενη εκτέλεση (απλή συνταγή) → καθάρισε τυχόν παλιά phantom πρόβλεψη
            await self.db["future_prescriptions"].delete_one(
                {"tenant_id": self.tenant_id, "source_execution_id": exec_id})
