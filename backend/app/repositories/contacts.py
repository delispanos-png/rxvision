"""Patient contact details — pharmacist-entered PII (phone/email/address) kept in a
SEPARATE collection from `patients_anonymized`, so ΗΔΥΚΑ re-ingestion never touches it.
The pharmacist is the data controller; `marketing_consent` gates newsletters/SMS."""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository, jsonsafe
from app.utils.masking import pseudo_name

CONTACT_FIELDS = (
    "phone", "mobile", "email", "address", "city", "postal_code",
    "notes", "observations", "marketing_consent", "preferred_channel",
    "reactivation_reason", "discontinuation_reason",
    "g6pd_deficiency",   # clinical flag (pharmacist-set) — έλλειψη ενζύμου G6PD
    "height_cm",         # ύψος (cm) — σταθερό· για υπολογισμό ΔΜΣ/BMI
)

# Πεδία που θεωρούνται «στοιχεία επικοινωνίας» — άγγιγμά τους σφραγίζει προέλευση/επιβεβαίωση.
CONTACT_DATA_FIELDS = ("phone", "mobile", "email", "address", "city", "postal_code")

# Προέλευση στοιχείων επικοινωνίας & προτεραιότητα (patient > pharmacist > idyka).
# ΗΔΥΚΑ = «παγωμένα» στοιχεία εγγραφής (ο ασφαλισμένος δεν μπορεί να τα αλλάξει εκεί) → ανεπιβεβαίωτα.
CONTACT_SOURCES = ("idyka", "pharmacist", "patient")
STALE_MONTHS = 12   # μετά από 12 μήνες, ακόμη κι επιβεβαιωμένα στοιχεία θέλουν επανεπιβεβαίωση

_MEASURE_KINDS = ("bp", "glucose", "weight")


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(v)
    except (InvalidId, TypeError):
        return None


class PatientContactRepository(BaseRepository):
    collection_name = "patient_contacts"

    async def get(self, patient_id: str) -> dict | None:
        oid = _oid(patient_id)
        if not oid:
            return None
        doc = await self._coll.find_one({"_id": oid, "tenant_id": self.tenant_id})
        # GDPR: σε «πελάτη παρουσίασης» ή περιορισμένο χρήστη (mask_pii) κρύβουμε ΟΛΑ τα
        # προσωπικά στοιχεία επικοινωνίας — όχι μόνο τηλέφωνο/email αλλά & διεύθυνση/σημειώσεις.
        if doc and self.demo:
            for k in ("phone", "mobile", "email", "address", "city", "postal_code", "notes"):
                if doc.get(k):
                    doc[k] = None
        return jsonsafe(doc)

    def _build_payload(self, data: dict) -> dict:
        payload = {k: data.get(k) for k in CONTACT_FIELDS if k in data}
        # pharmacist-controlled lifecycle (deceased / moved / stopped) — kept in THIS protected
        # collection so a ΗΔΥΚΑ re-ingest can never resurrect an inactive patient.
        if "active" in data:
            active = bool(data.get("active"))
            payload["active"] = active
            payload["inactive_reason"] = (data.get("inactive_reason") or None) if not active else None
            payload["inactive_at"] = datetime.now(tz=timezone.utc) if not active else None
        return payload

    async def upsert(self, patient_id: str, data: dict) -> dict | None:
        oid = _oid(patient_id)
        if not oid:
            return None
        payload = self._build_payload(data)
        payload["tenant_id"] = self.tenant_id
        payload["updated_at"] = datetime.now(tz=timezone.utc)
        await self._coll.update_one(
            {"_id": oid, "tenant_id": self.tenant_id},
            {"$set": payload, "$setOnInsert": {"_id": oid}},
            upsert=True,
        )
        return await self.get(patient_id)

    async def save_contact(self, patient_id: str, data: dict, *, source: str = "pharmacist",
                           verify: bool = True) -> dict | None:
        """Χειροκίνητη αποθήκευση στοιχείων επικοινωνίας (φαρμακοποιός ή πελάτης). Όταν το save
        αγγίζει πεδία επικοινωνίας, σφραγίζει προέλευση + ημ/νία + επιβεβαίωση (GDPR: ρητή ενέργεια
        ανθρώπου). `source` ∈ CONTACT_SOURCES· `verify` → μαρκάρει τα στοιχεία ως επιβεβαιωμένα."""
        oid = _oid(patient_id)
        if not oid:
            return None
        if source not in CONTACT_SOURCES:
            source = "pharmacist"
        now = datetime.now(tz=timezone.utc)
        payload = self._build_payload(data)
        payload["tenant_id"] = self.tenant_id
        payload["updated_at"] = now
        # Σφράγισε προέλευση/επιβεβαίωση μόνο όταν το save περιλαμβάνει ΤΙΜΗ επικοινωνίας
        # (ώστε αποθήκευση π.χ. μόνο «active/παρατηρήσεις» να μη μαρκάρει ψευδώς verified).
        if any(data.get(k) for k in CONTACT_DATA_FIELDS):
            payload["contact_source"] = source
            payload["contact_updated_at"] = now
            if verify:
                payload["contact_verified"] = True
                payload["contact_verified_at"] = now
        await self._coll.update_one(
            {"_id": oid, "tenant_id": self.tenant_id},
            {"$set": payload, "$setOnInsert": {"_id": oid, "created_at": now}},
            upsert=True,
        )
        return await self.get(patient_id)

    async def apply_idyka(self, patient_id: str, fields: dict) -> dict | None:
        """Αρχικοποίηση από ΗΔΥΚΑ: γεμίζει ΜΟΝΟ κενά πεδία επικοινωνίας. ΠΟΤΕ δεν πατάει υπάρχουσα
        τιμή, ΠΟΤΕ δεν δίνει marketing_consent, ΠΟΤΕ δεν μαρκάρει verified. Έτσι η προτεραιότητα
        patient > pharmacist > idyka διατηρείται by construction. Επιστρέφει {filled:[...]}."""
        oid = _oid(patient_id)
        if not oid:
            return None
        now = datetime.now(tz=timezone.utc)
        existing = await self._coll.find_one({"_id": oid, "tenant_id": self.tenant_id}) or {}
        to_set: dict = {}
        for k in CONTACT_DATA_FIELDS:
            new = fields.get(k)
            new = new.strip() if isinstance(new, str) else new
            cur = existing.get(k)
            cur = cur.strip() if isinstance(cur, str) else cur
            if new and not cur:
                to_set[k] = new
        setd: dict = {"tenant_id": self.tenant_id, "idyka_fetched_at": now, **to_set}
        # source=idyka μόνο αν δεν υπάρχει ήδη επιβεβαιωμένο από άνθρωπο (μη υποβαθμίζεις προέλευση)
        if not existing.get("contact_verified") and existing.get("contact_source") not in ("pharmacist", "patient"):
            setd["contact_source"] = "idyka"
        await self._coll.update_one(
            {"_id": oid, "tenant_id": self.tenant_id},
            {"$set": setd, "$setOnInsert": {"_id": oid, "created_at": now}}, upsert=True)
        return {"patient_id": str(oid), "filled": list(to_set.keys())}

    @staticmethod
    def _needs_confirmation(doc: dict) -> bool:
        """True αν τα στοιχεία επικοινωνίας θέλουν (επαν)επιβεβαίωση: ανεπιβεβαίωτα, μόνο-ΗΔΥΚΑ,
        ή επιβεβαιωμένα αλλά παλαιότερα των STALE_MONTHS μηνών."""
        from datetime import timedelta
        if not doc.get("contact_verified"):
            return True
        va = doc.get("contact_verified_at")
        if not va:
            return True
        cutoff = datetime.now(tz=timezone.utc) - timedelta(days=STALE_MONTHS * 30)
        if va.tzinfo is None:
            va = va.replace(tzinfo=timezone.utc)
        return va < cutoff

    async def contact_status(self, patient_id: str) -> dict:
        """Κατάσταση στοιχείων επικοινωνίας ενός ασθενή — για badge καρτέλας + απόφαση pop-up ταμείου."""
        oid = _oid(patient_id)
        doc = await self._coll.find_one({"_id": oid, "tenant_id": self.tenant_id}) if oid else None
        doc = doc or {}
        has_email = bool((doc.get("email") or "").strip()) if isinstance(doc.get("email"), str) else bool(doc.get("email"))
        has_mobile = bool((doc.get("mobile") or "").strip()) if isinstance(doc.get("mobile"), str) else bool(doc.get("mobile"))
        # Φωτογραφία προφίλ που ανέβασε ο πελάτης από την πύλη my.rxvision (patient_accounts.avatar_id).
        avatar_url = None
        if oid and not self.demo:
            try:
                pa = await self._db["patients_anonymized"].find_one(
                    {"_id": oid, "tenant_id": self.tenant_id}, {"amka": 1})
                amka = str((pa or {}).get("amka") or "").strip()
                if amka:
                    acc = await self._db["patient_accounts"].find_one({"amka": amka}, {"avatar_id": 1})
                    if acc and acc.get("avatar_id"):
                        avatar_url = f"/patient/avatar/{acc['avatar_id']}"
            except Exception:  # noqa: BLE001
                pass
        return {
            "verified": bool(doc.get("contact_verified")),
            "needs_confirmation": self._needs_confirmation(doc),
            "source": doc.get("contact_source"),
            "contact_updated_at": jsonsafe(doc.get("contact_updated_at")),
            "idyka_fetched_at": jsonsafe(doc.get("idyka_fetched_at")),
            "has_email": has_email,
            "has_mobile": has_mobile,
            "has_contact": has_email or has_mobile,
            "avatar_url": avatar_url,
        }

    async def needs_confirmation_list(self, *, limit: int = 300, skip: int = 0,
                                      q: str | None = None) -> dict:
        """Λίστα ασθενών που θέλουν (επαν)επιβεβαίωση στοιχείων επικοινωνίας: ανεπιβεβαίωτα,
        μόνο-ΗΔΥΚΑ, ή παλαιότερα των STALE_MONTHS. Join με όνομα από patients_anonymized."""
        from datetime import timedelta
        cutoff = datetime.now(tz=timezone.utc) - timedelta(days=STALE_MONTHS * 30)
        match: dict = {"tenant_id": self.tenant_id, "$or": [
            {"contact_verified": {"$ne": True}},
            {"contact_verified_at": None},
            {"contact_verified_at": {"$lt": cutoff}},
        ]}
        pipeline: list[dict] = [
            {"$match": match},
            {"$lookup": {"from": "patients_anonymized", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.full_name"}, "amka": {"$first": "$p.amka"}}},
        ]
        if q:
            import re
            rx = re.escape(q.strip())
            pipeline.append({"$match": {"name": {"$regex": rx, "$options": "i"}}})
        pipeline += [
            {"$sort": {"contact_updated_at": 1, "_id": 1}},
            {"$facet": {
                "items": [{"$skip": skip}, {"$limit": limit},
                          {"$project": {"p": 0}}],
                "total": [{"$count": "n"}],
            }},
        ]
        res = await self._coll.aggregate(pipeline).to_list(length=1)
        facet = res[0] if res else {"items": [], "total": []}
        total = (facet["total"][0]["n"] if facet.get("total") else 0)
        items = []
        for d in facet.get("items", []):
            email, mobile = d.get("email"), d.get("mobile")
            name = d.get("name") or "—"
            if self.demo:                       # GDPR: κρύψε PII σε demo/περιορισμένο χρήστη
                email = mobile = None
                name = pseudo_name(name, True)  # ψευδώνυμο ονόματος (η λίστα μένει πλοηγήσιμη)
            items.append({
                "patient_id": str(d["_id"]),
                "name": name,
                "email": email or None,
                "mobile": mobile or None,
                "source": d.get("contact_source"),
                "verified": bool(d.get("contact_verified")),
                "contact_updated_at": jsonsafe(d.get("contact_updated_at")),
                "marketing_consent": bool(d.get("marketing_consent")),
            })
        return {"items": items, "total": total, "limit": limit, "skip": skip}

    async def import_insured(self, rows: list[dict]) -> dict:
        """Ταίριασμα κάθε γραμμής με υπάρχοντα ασθενή βάσει ΑΜΚΑ → ενημέρωση στοιχείων
        επικοινωνίας (+ ονόματος). Όσοι ΑΜΚΑ δεν αντιστοιχούν παραλείπονται (μόνο ενημέρωση
        υπαρχόντων — δεν δημιουργούνται νέοι ασθενείς)."""
        updated = skipped = 0
        skipped_sample: list[str] = []
        pa = self._db["patients_anonymized"]
        now = datetime.now(tz=timezone.utc)
        for row in rows:
            amka = (row.get("amka") or "").strip()
            if not amka:
                continue
            cand = [amka]
            if len(amka) == 10:                       # Excel μπορεί να έκοψε ένα αρχικό μηδενικό
                cand.append("0" + amka)
            patient = await pa.find_one(
                {"tenant_id": self.tenant_id, "amka": {"$in": cand}}, {"_id": 1})
            if not patient:
                skipped += 1
                if len(skipped_sample) < 20:
                    skipped_sample.append(amka)
                continue
            pid = patient["_id"]
            contact = {k: row[k] for k in CONTACT_FIELDS if k in row}
            if contact:
                contact["tenant_id"] = self.tenant_id
                contact["updated_at"] = now
                await self._coll.update_one(
                    {"_id": pid, "tenant_id": self.tenant_id},
                    {"$set": contact, "$setOnInsert": {"_id": pid}}, upsert=True)
            name = (row.get("full_name") or "").strip()
            if name:
                await pa.update_one({"_id": pid, "tenant_id": self.tenant_id},
                                    {"$set": {"full_name": name}})
            updated += 1
        return {"updated": updated, "skipped": skipped,
                "skipped_sample": skipped_sample, "total": len(rows)}

    # ── κλινικές μετρήσεις (πίεση / ζάχαρο / βάρος) με ημερομηνία + ιστορικό ──
    async def add_measurement(self, patient_id: str, kind: str, *, systolic=None,
                              diastolic=None, value=None, at=None, note=None) -> dict | None:
        oid = _oid(patient_id)
        if not oid or kind not in _MEASURE_KINDS:
            return None
        now = datetime.now(tz=timezone.utc)
        doc = {"tenant_id": self.tenant_id, "patient_ref": oid, "kind": kind,
               "at": at or now, "note": (note or "")[:200], "created_at": now}
        if kind == "bp":
            if systolic is None or diastolic is None:
                return None
            doc["systolic"], doc["diastolic"] = int(systolic), int(diastolic)
        else:
            if value is None:
                return None
            doc["value"] = float(value)
        await self._db["patient_measurements"].insert_one(doc)
        return await self.measurements(patient_id)

    async def delete_measurement(self, patient_id: str, measurement_id: str) -> dict | None:
        oid, mid = _oid(patient_id), _oid(measurement_id)
        if not oid or not mid:
            return None
        await self._db["patient_measurements"].delete_one(
            {"_id": mid, "tenant_id": self.tenant_id, "patient_ref": oid})
        return await self.measurements(patient_id)

    async def measurements(self, patient_id: str) -> dict:
        """Latest + last-10 history per kind (newest first)."""
        oid = _oid(patient_id)
        if not oid:
            return {"latest": {}, "history": {}}
        latest, history = {}, {}
        for kind in _MEASURE_KINDS:
            rows = [r async for r in self._db["patient_measurements"].find(
                {"tenant_id": self.tenant_id, "patient_ref": oid, "kind": kind})
                .sort("at", -1).limit(10)]
            history[kind] = jsonsafe(rows)
            if rows:
                latest[kind] = jsonsafe(rows[0])
        return {"latest": latest, "history": history}
