"""Patient repository — anonymized aggregates + retention cohorts.

Reads only from patients_anonymized (no PII). Tenant-scoped by construction.
"""

from __future__ import annotations

import re
from datetime import datetime

from app.repositories.base import BaseRepository, jsonsafe
from app.utils.masking import mask_amka, mask_name

_DIM_FIELD = {
    "age_group": "$age_group",
    "sex": "$sex",
    "area": "$residence_area",
    "lifecycle": "$lifecycle",
}


class PatientRepository(BaseRepository):
    collection_name = "patients_anonymized"

    async def get_amka(self, patient_id: str) -> str | None:
        """Raw ΑΜΚΑ ενός ασθενή (για κλήση ΗΔΥΚΑ getpatient). Ο φαρμακοποιός είναι data controller."""
        from bson import ObjectId
        from bson.errors import InvalidId
        try:
            oid = ObjectId(patient_id)
        except (InvalidId, TypeError):
            return None
        doc = await self._coll.find_one({"_id": oid, "tenant_id": self.tenant_id}, {"amka": 1})
        amka = str((doc or {}).get("amka") or "").strip()
        return amka or None

    async def onboard(self, *, amka: str, full_name: str | None = None, sex: str | None = None,
                      birth_year: int | None = None, area: str | None = None,
                      mobile: str | None = None, phone: str | None = None, email: str | None = None,
                      address: str | None = None, city: str | None = None,
                      postal_code: str | None = None) -> dict:
        """Δημιουργεί/ενημερώνει «καρτέλα χωρίς κίνηση» (patients_anonymized, rx_count μένει 0) για έναν
        ΑΜΚΑ — ώστε ο πελάτης να συνδεθεί & να χρησιμοποιήσει την πύλη ΧΩΡΙΣ εκτέλεση συνταγής. Ίδιο
        κλειδί (pseudo_id) με τις εγγραφές από συνταγές → αν υπάρχει ήδη, απλώς ενημερώνεται (χωρίς διπλό)."""
        from datetime import timezone
        from bson import ObjectId  # noqa: F401
        from pymongo import ReturnDocument
        from app.utils.anonymization import age_group, pseudonymize
        from app.services.vault_service import vault

        amka = (amka or "").strip()
        pseudo = pseudonymize(amka, tenant_pepper=vault.tenant_pepper(self.tenant_id))
        now = datetime.now(tz=timezone.utc)
        ag = age_group(birth_year, today=now.date()) if birth_year else "unknown"
        set_fields: dict = {"age_group": ag}
        if sex:
            set_fields["sex"] = sex
        if birth_year:
            set_fields["birth_year"] = birth_year
        if area:
            set_fields["residence_area"] = area
        if full_name:
            set_fields["full_name"] = full_name
        if amka.isdigit():            # controller-φαρμακείο βλέπει τα δικά του (tenant-isolated, όπως το ingestion)
            set_fields["amka"] = amka
        existing = await self._db["patients_anonymized"].find_one(
            self._scope({"pseudo_id": pseudo}), {"_id": 1})
        res = await self._db["patients_anonymized"].find_one_and_update(
            self._scope({"pseudo_id": pseudo}),
            {"$set": set_fields,
             "$min": {"first_seen_at": now}, "$max": {"last_seen_at": now},
             "$setOnInsert": {"tenant_id": self.tenant_id, "pseudo_id": pseudo,
                              "rx_count": 0, "rx_value_total": 0, "lifecycle": "new",
                              "source": "onboarded", "created_at": now}},
            upsert=True, return_document=ReturnDocument.AFTER)
        pid = res["_id"]
        # Στοιχεία επικοινωνίας/διεύθυνσης (από ΗΔΥΚΑ ή χειροκίνητα) → patient_contacts. Το κινητό
        # επιτρέπει self-εγγραφή στην πύλη (OTP στο on-file κινητό).
        contact = {k: v.strip() for k, v in {
            "mobile": mobile, "phone": phone, "email": email,
            "address": address, "city": city, "postal_code": postal_code,
        }.items() if v and v.strip()}
        if contact:
            contact["updated_at"] = now
            await self._db["patient_contacts"].update_one(
                self._scope({"_id": pid}),
                {"$set": contact,
                 "$setOnInsert": {"tenant_id": self.tenant_id, "_id": pid, "created_at": now}},
                upsert=True)
        return {"ok": True, "patient_ref": str(pid), "already_existed": existing is not None}

    async def aggregate_by(self, *, by: str) -> list[dict]:
        field = _DIM_FIELD.get(by, "$lifecycle")
        # Περιοχή: ομαδοποίηση στο ΚΑΝΟΝΙΚΟΠΟΙΗΜΕΝΟ τοπωνύμιο (μία περιοχή = μία γραμμή)· fallback στο
        # raw για ασθενείς που δεν έχουν ακόμη canonical (ο βρόχος refresh τους πιάνει σύντομα).
        if by == "area":
            field = {"$ifNull": ["$residence_area_canonical", "$residence_area"]}
        pipeline = [
            {"$group": {
                "_id": field,
                "patients": {"$sum": 1},
                "rx_count": {"$sum": "$rx_count"},
                "rx_value_total": {"$sum": "$rx_value_total"},
            }},
            {"$sort": {"patients": -1}},
            {"$project": {"_id": 0, "key": "$_id", "patients": 1,
                          "rx_count": 1, "rx_value_total": 1}},
        ]
        return await self.aggregate(pipeline)

    async def retention(self, *, cohort: str | None = None) -> list[dict]:
        """Καμπύλη διατήρησης: % ασθενών που παρέμειναν ΕΝΕΡΓΟΙ στους 1/3/6/12 μήνες από την ΠΡΩΤΗ
        τους εμφάνιση. «Ενεργός στον ορίζοντα Η» = διάρκεια ζωής (last−first) ≥ Η μήνες. Ο παρονομαστής
        ΚΑΘΕ ορίζοντα μετρά ΜΟΝΟ όσους είχαν αρκετό χρόνο (age ≥ Η) → αμερόληπτη καμπύλη (όχι
        παραμόρφωση από πρόσφατους πελάτες). Προαιρετικά περιορίζεται σε ένα cohort (YYYY-MM)."""
        from datetime import datetime, timezone
        now = datetime.now(tz=timezone.utc)
        horizons = [1, 3, 6, 12]
        match: dict = {"first_seen_at": {"$ne": None}, "last_seen_at": {"$ne": None}}
        if cohort:
            match["$expr"] = {"$eq": [
                {"$dateToString": {"format": "%Y-%m", "date": "$first_seen_at"}}, cohort]}
        grp: dict = {"_id": None, "total": {"$sum": 1}}
        for h in horizons:
            grp[f"e{h}"] = {"$sum": {"$cond": [{"$gte": ["$age_m", h]}, 1, 0]}}
            grp[f"r{h}"] = {"$sum": {"$cond": [
                {"$and": [{"$gte": ["$age_m", h]}, {"$gte": ["$span_m", h]}]}, 1, 0]}}
        pipeline = [
            {"$match": match},
            {"$project": {
                "age_m": {"$dateDiff": {"startDate": "$first_seen_at", "endDate": now, "unit": "month"}},
                "span_m": {"$dateDiff": {"startDate": "$first_seen_at", "endDate": "$last_seen_at", "unit": "month"}}}},
            {"$group": grp},
        ]
        res = await self.aggregate(pipeline)
        d = res[0] if res else {}
        out = [{"months": 0, "pct": 100.0, "eligible": int(d.get("total", 0))}]
        for h in horizons:
            e, r = int(d.get(f"e{h}", 0)), int(d.get(f"r{h}", 0))
            out.append({"months": h, "pct": round(r / e * 100, 1) if e else 0.0, "eligible": e})
        return out


_PATIENT_SORT = {"value": "value", "claimed": "claimed", "profit": "profit", "rx": "rx"}


class PatientExecutionsRepository(BaseRepository):
    """Per-patient analytics from prescription_executions (concept doc §2):
    πλήθος/αξία/αιτούμενο/κερδοφορία ανά ασφαλισμένο + «ενεργός από» (first rx)."""

    collection_name = "prescription_executions"

    async def per_patient(self, *, date_from: datetime, date_to: datetime,
                          sort: str = "value", limit: int = 100,
                          filters: dict | None = None) -> list[dict]:
        """Per-patient rx/value/claimed/profit + demographics + contact, with rich filtering.
        Filters are applied BEFORE the limit so "top N matching" is correct (not top-N-then-filter)."""
        f = filters or {}
        sort_field = _PATIENT_SORT.get(sort, "value")
        pipeline: list[dict] = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {
                "_id": "$patient_ref",
                "rx": {"$sum": 1},
                "value": {"$sum": "$amount_total"},
                "claimed": {"$sum": "$amount_claimed"},
                "cost": {"$sum": "$wholesale_cost"},
                "active_since": {"$min": "$executed_at"},
                "last_seen": {"$max": "$executed_at"},
            }},
            {"$set": {"profit": {"$subtract": ["$value", "$cost"]}}},  # retail − wholesale
        ]
        # numeric filters on the grouped totals (cheap, before the demographics/contact lookups)
        num: dict = {}
        if f.get("rx_min") is not None:
            num["rx"] = {"$gte": int(f["rx_min"])}
        if f.get("value_min") is not None:
            num["value"] = {"$gte": int(f["value_min"])}        # cents
        if f.get("profit_min") is not None:
            num["profit"] = {"$gte": int(f["profit_min"])}      # cents (may be negative)
        if num:
            pipeline.append({"$match": num})
        # demographics (anonymized profile — no PII)
        pipeline += [
            {"$lookup": {"from": "patients_anonymized", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"pseudo_id": {"$first": "$p.pseudo_id"},
                      "full_name": {"$first": "$p.full_name"},
                      "age_group": {"$first": "$p.age_group"},
                      "sex": {"$first": "$p.sex"},
                      "area": {"$first": "$p.residence_area"},
                      "area_canonical": {"$first": "$p.residence_area_canonical"},
                      "lifecycle": {"$first": "$p.lifecycle"}}},
            {"$set": {"area_eff": {"$ifNull": ["$area_canonical", "$area"]}}},
        ]
        demo: dict = {}
        if f.get("sex"):
            demo["sex"] = f["sex"]
        if f.get("age_groups"):
            demo["age_group"] = {"$in": list(f["age_groups"])}
        if f.get("lifecycle"):
            demo["lifecycle"] = f["lifecycle"]
        if f.get("area"):
            # φιλτράρισμα στο ΚΑΝΟΝΙΚΟΠΟΙΗΜΕΝΟ τοπωνύμιο (το dropdown στέλνει canonical label)
            demo["area_eff"] = str(f["area"])
        if demo:
            pipeline.append({"$match": demo})
        # contact + pharmacist lifecycle (separate collection, survives ΗΔΙΚΑ re-ingest)
        pipeline += [
            {"$lookup": {"from": "patient_contacts", "localField": "_id",
                         "foreignField": "_id", "as": "ct"}},
            {"$set": {"ct": {"$first": "$ct"}}},
        ]
        cf: dict = {}
        status = f.get("status")
        if status == "inactive":
            cf["ct.active"] = False
        elif status == "active":
            cf["ct.active"] = {"$ne": False}     # missing contact or active=true
        if f.get("reason"):
            cf["ct.inactive_reason"] = f["reason"]
        if f.get("has_contact"):
            cf["$or"] = [{"ct.mobile": {"$nin": [None, ""]}}, {"ct.phone": {"$nin": [None, ""]}},
                         {"ct.email": {"$nin": [None, ""]}}]
        if f.get("consent"):
            cf["ct.marketing_consent"] = True
        if cf:
            pipeline.append({"$match": cf})
        pipeline += [
            {"$sort": {sort_field: -1}},
            {"$limit": limit},
            {"$project": {"_id": 0, "patient_ref": "$_id",
                          "rx": 1, "value": 1, "claimed": 1, "cost": 1, "profit": 1,
                          "active_since": 1, "last_seen": 1, "pseudo_id": 1, "full_name": 1,
                          "age_group": 1, "sex": 1, "area": 1, "lifecycle": 1,
                          "mobile": "$ct.mobile", "phone": "$ct.phone", "email": "$ct.email",
                          "consent": {"$ifNull": ["$ct.marketing_consent", False]},
                          "contact_active": {"$ifNull": ["$ct.active", True]},
                          "inactive_reason": "$ct.inactive_reason"}},
        ]
        rows = await self.aggregate(pipeline)
        for r in rows:
            r["full_name"] = mask_name(r.get("full_name"), self.demo)
            if self.demo:
                r["mobile"] = r["phone"] = r["email"] = None  # contact = PII
        return rows

    async def search(self, q: str, limit: int = 25) -> list[dict]:
        """Find patients by name / ΑΜΚΑ / phone / email (any stored detail)."""
        db = self._db
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        ids = set()
        async for d in db["patients_anonymized"].find(
                self._scope({"$or": [{"full_name": rx}, {"amka": rx}]}), {"_id": 1}).limit(60):
            ids.add(d["_id"])
        async for d in db["patient_contacts"].find(
                {"tenant_id": self.tenant_id, "$or": [{"mobile": rx}, {"phone": rx}, {"email": rx}]},
                {"_id": 1}).limit(60):
            ids.add(d["_id"])
        if not ids:
            return []
        rows = await db["patients_anonymized"].aggregate([
            {"$match": {"_id": {"$in": list(ids)}, "tenant_id": self.tenant_id}},
            {"$lookup": {"from": "patient_contacts", "localField": "_id",
                         "foreignField": "_id", "as": "ct"}},
            {"$set": {"ct": {"$first": "$ct"}}},
            {"$project": {"_id": 0, "patient_id": {"$toString": "$_id"},
                          "name": "$full_name", "amka": 1, "age_group": 1, "sex": 1, "birth_year": 1,
                          "last_seen": "$last_seen_at", "rx_count": 1,
                          "mobile": "$ct.mobile", "phone": "$ct.phone", "email": "$ct.email",
                          "consent": {"$ifNull": ["$ct.marketing_consent", False]}}},
            {"$sort": {"last_seen": -1}},
            {"$limit": limit},
        ]).to_list(length=None)
        if self.demo:
            for r in rows:
                r["name"] = mask_name(r.get("name"), True)
                r["amka"] = mask_amka(r.get("amka"), True)
                r["mobile"] = r["phone"] = r["email"] = None   # στοιχεία επικοινωνίας = PII
        return jsonsafe(rows)

    async def patient_detail(self, patient_id: str) -> dict | None:
        """Drill-down for one patient: profile + every therapeutic category / ICD-10 /
        medicine they have been prescribed (concept doc §2)."""
        from bson import ObjectId
        try:
            oid = ObjectId(patient_id)
        except Exception:  # noqa: BLE001
            return None
        prof = await self._db["patients_anonymized"].find_one(self._scope({"_id": oid}))
        if not prof:
            return None
        # ICD-10 frequency across this patient's executions
        icd = await self.aggregate([
            {"$match": {"patient_ref": oid}},
            {"$unwind": "$icd10"},
            {"$group": {"_id": "$icd10", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
            {"$lookup": {"from": "icd10_codes", "localField": "_id",
                         "foreignField": "_id", "as": "c"}},
            {"$set": {"title": {"$first": "$c.title_el"}}},
            {"$project": {"_id": 0, "code": "$_id", "count": 1, "title": 1}},
        ])
        # medicines (therapeutic items) this patient received, with spend
        meds = await self.aggregate([
            {"$match": {"patient_ref": oid}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$group": {"_id": "$it.product_id", "times": {"$sum": "$it.quantity"},
                        "value": {"$sum": "$it.amount_claimed"},
                        "category": {"$first": "$it.category"}}},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.name"}, "barcode": {"$first": "$p.barcode"},
                      "_atc": {"$first": "$p.substance"}}},
            # join the price catalog by barcode for the human substance name + ATC code
            {"$lookup": {"from": "medicine_catalog", "localField": "barcode",
                         "foreignField": "barcode", "as": "mc"}},
            {"$set": {"substance": {"$first": "$mc.substance_name"},
                      "atc": {"$ifNull": [{"$first": "$mc.atc"}, "$_atc"]}}},
            {"$sort": {"times": -1}},
            {"$project": {"_id": 0, "name": 1, "barcode": 1, "substance": 1, "atc": 1,
                          "category": 1, "times": 1, "value": 1}},
        ])
        totals = await self.aggregate([
            {"$match": {"patient_ref": oid}},
            {"$group": {"_id": None, "rx": {"$sum": 1}, "value": {"$sum": "$amount_total"},
                        "first": {"$min": "$executed_at"}, "last": {"$max": "$executed_at"}}},
        ])
        t = totals[0] if totals else {}
        from app.repositories.base import jsonsafe
        return jsonsafe({
            "patient_id": patient_id,
            "full_name": mask_name(prof.get("full_name"), self.demo),
            "amka": mask_amka(prof.get("amka"), self.demo),
            "sex": prof.get("sex"), "age_group": prof.get("age_group"),
            "birth_year": prof.get("birth_year"), "area": prof.get("residence_area"),
            "lifecycle": prof.get("lifecycle"),
            "rx_count": t.get("rx", 0), "value_total": t.get("value", 0),
            "first_seen": t.get("first"), "last_seen": t.get("last"),
            "icd10": icd, "medicines": meds,
        })
