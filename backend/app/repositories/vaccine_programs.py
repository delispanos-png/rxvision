"""Periodic vaccination programmes («περιοδικά εμβόλια») — the pharmacist-defined watch list.

The seasonal-flu circuit (`vaccination_campaigns.py`) answers «who needs THIS season's flu shot».
This one answers a different question: «which of my patients is DUE for a vaccine that repeats
every N years» — herpes zoster, tetanus, pneumococcal… The pharmacist picks WHICH vaccines to
watch (by ATC group or individual product), and for each one defines the dose series and the
booster interval. Nothing is pre-filled: intervals are a clinical decision, not ours.

Design notes:
  • Vaccines are identifiable by ATC `J07*` — 146 products in 14 groups in `medicine_catalog`,
    so the pharmacist picks a GROUP in one click instead of hunting barcodes.
  • `medicine_catalog` is SHARED (not tenant-scoped); `vaccine_programs` is per-tenant.
  • `doses_required` (a SERIES, e.g. Shingrix = 2) is deliberately separate from `repeat_years`
    (a BOOSTER, e.g. tetanus = 10y). They are different clinical concepts and one field cannot
    express both — see docs/vaccination-periodic-design.md §6.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db
from app.repositories.base import BaseRepository, jsonsafe
from app.utils.masking import mask_amka, mask_name

# Ονόματα των ATC ομάδων — ΟΥΔΕΤΕΡΗ περιγραφή του διεθνούς προτύπου ATC (WHO), όχι σύσταση
# χρήσης. ΔΕΝ γνωρίζουμε ποια σκευάσματα εγκρίνονται/συνιστώνται στην ελληνική αγορά για κάθε
# εμβολιαστική κατηγορία — αυτό το ξέρει ο φαρμακοποιός και το ορίζει ο ίδιος.
# Χρησιμεύουν μόνο για να αναγνωρίζει τι βλέπει· η επιλογή είναι πάντα δική του.
ATC_GROUP_LABELS: dict[str, str] = {
    "J07AG": "Αιμόφιλος ινφλουέντζας b",
    "J07AH": "Μηνιγγιτιδόκοκκος",
    "J07AJ": "Κοκκύτης",
    "J07AL": "Πνευμονιόκοκκος",
    "J07AM": "Τέτανος / Διφθερίτιδα",
    "J07BB": "Γρίπη (εποχικό)",
    "J07BC": "Ηπατίτιδα",
    "J07BD": "Ιλαρά / Παρωτίτιδα / Ερυθρά",
    "J07BH": "Ροταϊός",
    "J07BK": "Έρπης ζωστήρας / Ανεμευλογιά",
    "J07BM": "HPV",
    "J07BX": "Λοιπά ιικά",
    "J07CA": "Συνδυασμένα",
    "J07X": "Λοιπά",
}

# Πλήρεις ATC κωδικοί όπου η 5-ψήφια ομάδα ΕΝΩΝΕΙ άσχετα εμβόλια. Π.χ. στο J07BK συνυπάρχουν
# ο έρπης ζωστήρας (ενήλικες 60+) και η ανεμευλογιά (παιδικό) — χωρίς διαχωρισμό η λίστα του
# ζωστήρα γέμιζε παιδιά.
ATC_EXACT_LABELS: dict[str, str] = {
    "J07BK01": "Ανεμευλογιά",
    "J07BK02": "Έρπης ζωστήρας (ζωντανό εξασθενημένο)",
    "J07BK03": "Έρπης ζωστήρας (ανασυνδυασμένο)",
}

# ΚΑΘΕ ομάδα ATC, όχι μόνο J07. Το κύκλωμα ξεκίνησε για εμβόλια, αλλά ο μηχανισμός ποτέ δεν
# ήταν δεμένος μαζί τους: ταιριάζει ό,τι κωδικό ΕΟΦ/ATC ορίσει το πρόγραμμα. Οι θεραπείες
# με μεγάλο μεσοδιάστημα (Prolia M05BX04, Stelara L04AC05, Eylea S01LA05) έχουν ΑΚΡΙΒΩΣ την
# ίδια ανάγκη με μια αναμνηστική δόση — και ο φαρμακοποιός τις ξεχνά με τον ίδιο τρόπο.
def _add_months(dt, months: int):
    """Ημερολογιακή πρόσθεση μηνών στην ημερομηνία μιας δόσης.

    ΟΧΙ «μήνες × 30»: σε εξάμηνο σχήμα (Prolia) η απόκλιση φτάνει τις έξι μέρες και η
    υπενθύμιση πέφτει σε λάθος μέρα — ακριβώς εκεί που ο ασθενής περιμένει ακρίβεια.
    Η μέρα «σφίγγεται» στον μήνα προορισμού (31 Ιαν + 1 μήνας → 28/29 Φεβ).
    """
    total = dt.month - 1 + int(months)
    y, m = dt.year + total // 12, total % 12 + 1
    leap = y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
    last = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return dt.replace(year=y, month=m, day=min(dt.day, last))


_ATC_RE = re.compile(r"^[A-Z]\d{2}[A-Z]{0,2}\d{0,2}$")   # J07BK03 · M05BX04 · L04AC05


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(value):
    """Το `_id` των προγραμμάτων είναι ObjectId, αλλά από το URL έρχεται ΠΑΝΤΑ string.
    Χωρίς αυτή τη μετατροπή κάθε PUT/DELETE/λίστα ασθενών γύριζε 404 (fix 16/09/2026)."""
    if isinstance(value, ObjectId):
        return value
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError):
        return None


class VaccineProgramRepository(BaseRepository):
    """CRUD over the tenant's watched-vaccine programmes."""

    collection_name = "vaccine_programs"

    # ── catalogue (shared, read-only) ────────────────────────────────────────────────────────
    @staticmethod
    async def atc_groups() -> list[dict]:
        """Vaccine groups available for selection, from the shared ΗΔΥΚΑ catalogue (ATC J07*).

        Returns one row per ATC group with its product count and a couple of example names —
        enough for the pharmacist to recognise it without opening the full list."""
        pipeline = [
            {"$match": {"atc": {"$regex": "^J07"}}},
            # Γκρουπάρουμε στον ΠΛΗΡΗ ATC· παρακάτω τα ενώνουμε σε 5-ψήφιες ομάδες εκτός από
            # όσα έχουν ρητό label (εκεί ο διαχωρισμός είναι κλινικά σημαντικός).
            {"$group": {"_id": "$atc", "count": {"$sum": 1}, "examples": {"$push": "$name"}}},
            {"$sort": {"_id": 1}},
        ]
        merged: dict[str, dict] = {}
        async for r in shared_db()["medicine_catalog"].aggregate(pipeline):
            full = r["_id"] or ""
            key = full if full in ATC_EXACT_LABELS else full[:5]
            label = ATC_EXACT_LABELS.get(full) or ATC_GROUP_LABELS.get(key, key)
            slot = merged.setdefault(key, {"atc": key, "label": label, "count": 0, "examples": []})
            slot["count"] += r["count"]
            slot["examples"] += [n for n in (r.get("examples") or []) if n]
        for v in merged.values():
            v["examples"] = v["examples"][:3]
        return sorted(merged.values(), key=lambda x: x["atc"])

    @staticmethod
    async def products(atc_prefix: str | None = None, search: str | None = None) -> list[dict]:
        """Μεμονωμένα σκευάσματα — για όποιον θέλει ακρίβεια αντί για ολόκληρη ομάδα.

        ⚠️ ΟΤΑΝ ΨΑΧΝΕΙ ΜΕ ΟΝΟΜΑ, ΔΕΝ ΠΕΡΙΟΡΙΖΟΥΜΕ ΣΕ J07. Οι ομάδες που προσφέρονται στην οθόνη
        είναι εμβολίων· οι θεραπείες με επανάληψη (Prolia M05BX04, Ajovy N02CD03) ΔΕΝ ανήκουν σε
        καμία από αυτές. Με το παλιό `^J07` η αναζήτηση «Prolia» γύριζε πάντα κενή και το
        σκεύασμα ήταν αδύνατο να επιλεγεί — δυνατότητα πληρωμένη και ανέφικτη.
        """
        q: dict = {}
        if atc_prefix:
            q["atc"] = {"$regex": f"^{re.escape(atc_prefix)}"}
        elif not search:
            q["atc"] = {"$regex": "^J07"}      # χωρίς όρο αναζήτησης → οι γνωστές ομάδες εμβολίων
        if search:
            q["name"] = {"$regex": re.escape(search.strip()), "$options": "i"}
        cur = shared_db()["medicine_catalog"].find(
            q, {"name": 1, "atc": 1, "barcode": 1}).sort("name", 1).limit(200)
        return [{"eof_code": str(d["_id"]), "name": d.get("name"),
                 "atc": d.get("atc"), "barcode": d.get("barcode")} async for d in cur]

    # ── programmes (per tenant) ──────────────────────────────────────────────────────────────
    @staticmethod
    def kind_of(program: dict) -> str:
        """«vaccine» ή «therapy» — το κρίνει ο ΚΩΔΙΚΟΣ, όχι ο χρήστης.

        Τα εμβόλια ζουν όλα στο J07. Ένα πρόγραμμα με ρητούς κωδικούς ΕΟΦ κρίνεται από το ATC
        του πρώτου σκευάσματος. Έτσι ο διαχωρισμός των δύο κυκλωμάτων δεν χρειάζεται ούτε
        επιπλέον πεδίο ούτε μετάπτωση παλιών προγραμμάτων.
        """
        for a in (program.get("atc_prefixes") or []):
            if not str(a).upper().startswith("J07"):
                return "therapy"
        if program.get("atc_prefixes"):
            return "vaccine"
        return program.get("kind") or "therapy"      # μόνο ρητά σκευάσματα → το λέει το ίδιο

    async def list(self, kind: str | None = None) -> list[dict]:
        """`kind`: "vaccine" | "therapy" | None (όλα).

        Όταν το πρόγραμμα έχει ΜΟΝΟ κωδικούς ΕΟΦ (χωρίς ATC), το είδος βγαίνει από τον κατάλογο.
        """
        rows = await self.find(sort=[("name", 1)], limit=200)
        if not kind:
            return rows
        # Συμπλήρωση είδους για όσα δηλώνουν μόνο σκευάσματα
        unknown = [r for r in rows if not (r.get("atc_prefixes") or []) and r.get("eof_codes")]
        if unknown:
            codes = {str(c) for r in unknown for c in (r.get("eof_codes") or [])}
            atc_by_code = {str(d["_id"]): (d.get("atc") or "") async for d in
                           shared_db()["medicine_catalog"].find({"_id": {"$in": sorted(codes)}},
                                                                {"atc": 1})}
            for r in unknown:
                first = next((atc_by_code.get(str(c), "") for c in (r.get("eof_codes") or [])), "")
                r["kind"] = "vaccine" if first.upper().startswith("J07") else "therapy"
        return [r for r in rows if self.kind_of(r) == kind]

    async def get(self, program_id) -> dict | None:
        """Ένα πρόγραμμα με το id του (δέχεται string από URL ή ObjectId)."""
        oid = _oid(program_id)
        return await self.find_one({"_id": oid}) if oid else None

    async def save(self, doc: dict, program_id: str | None = None) -> dict:
        """Create or update one programme. Validates the clinical fields rather than trusting the UI."""
        # Σε ΕΠΕΞΕΡΓΑΣΙΑ το εμβόλιο είναι κλειδωμένο και το αγνοούμε (βλ. παρακάτω) — άρα δεν
        # έχει νόημα να απαιτούμε να σταλεί. Χωρίς αυτό, ένα PUT που δεν έστελνε atc_prefixes
        # έπαιρνε 400 «Επίλεξε τουλάχιστον μία ομάδα» και ΚΑΜΙΑ αλλαγή δεν αποθηκευόταν.
        clean = self._validate(doc, require_vaccine=not program_id)
        clean["updated_at"] = _now()
        if program_id:
            oid = _oid(program_id)
            if not oid:
                raise ValueError("not_found")
            # ΤΟ ΕΜΒΟΛΙΟ ΔΕΝ ΑΛΛΑΖΕΙ ΜΕΤΑ ΤΗ ΔΗΜΙΟΥΡΓΙΑ. Αλλαγή του θα άλλαζε αναδρομικά ποιοι
            # ασθενείς ανήκουν στο πρόγραμμα και τι σημαίνει το ιστορικό τους — για άλλο εμβόλιο
            # φτιάχνεται νέο πρόγραμμα. Το UI το κλειδώνει· εδώ επιβάλλεται.
            clean.pop("atc_prefixes", None)
            clean.pop("eof_codes", None)
            await self.update_one({"_id": oid}, {"$set": clean})
            return await self.find_one({"_id": oid}) or {}
        clean["created_at"] = _now()
        new_id = await self.insert_one(clean)
        return jsonsafe(await self._coll.find_one({"_id": new_id})) or {}

    async def delete(self, program_id: str) -> int:
        oid = _oid(program_id)
        if not oid:
            return 0
        res = await self.delete_many({"_id": oid})
        return res.deleted_count

    async def resolve_codes(self, program: dict) -> set[str]:
        """Programme → the set of ΕΟΦ codes it watches (ATC groups expanded + explicit products).

        This is what the ingestion hook matches against, so it must be cheap and exact."""
        codes: set[str] = {str(c) for c in (program.get("eof_codes") or []) if c}
        # ΣΥΓΚΕΚΡΙΜΕΝΑ ΣΚΕΥΑΣΜΑΤΑ ΥΠΕΡΙΣΧΥΟΥΝ της ομάδας: στον πνευμονιόκοκκο π.χ. δίνεται άλλο
        # σκεύασμα ανά ηλικία (PNEUMOVAX 23 vs PREVENAR 20 vs SYNFLORIX παιδικό), οπότε όποιος
        # διάλεξε ρητά σκευάσματα ΔΕΝ θέλει όλη την ομάδα από πάνω.
        if codes:
            return codes
        prefixes = [p for p in (program.get("atc_prefixes") or []) if p]
        if prefixes:
            rx = "|".join(f"^{re.escape(p)}" for p in prefixes)
            cur = shared_db()["medicine_catalog"].find({"atc": {"$regex": rx}}, {"_id": 1})
            codes |= {str(d["_id"]) async for d in cur}
        return codes

    async def watched_codes(self) -> dict[str, str]:
        """{eof_code → program_id} for every ACTIVE programme — the ingestion lookup table."""
        table: dict[str, str] = {}
        for p in await self.find({"active": True}, limit=200):
            for code in await self.resolve_codes(p):
                table[code] = str(p["_id"])
        return table

    # ── δόσεις που έγιναν ΑΛΛΟΥ ────────────────────────────────────────────────────────────
    # Ο ασθενής μπορεί να έκανε τη θεραπεία σε άλλο φαρμακείο ή στο νοσοκομείο. Χωρίς αυτό, ο
    # φαρμακοποιός τον βλέπει «εκπρόθεσμο» για πάντα, τον καλεί άδικα, και σταματά να εμπιστεύεται
    # τη λίστα. Κρατιέται ΧΩΡΙΣΤΑ από τις συνταγές: δεν είναι δική μας εκτέλεση και δεν πρέπει
    # ΠΟΤΕ να μετρήσει σε τζίρο ή αποζημίωση — μόνο στην κάλυψη του ασθενή.
    async def add_manual_dose(self, *, program_id: str, patient_id: str, at: datetime,
                              note: str = "", by: str | None = None) -> dict:
        doc = {"tenant_id": self.tenant_id, "program_id": str(program_id),
               "patient_id": str(patient_id), "at": at, "note": (note or "")[:300],
               "by": by, "created_at": datetime.now(tz=timezone.utc)}
        res = await self._db["program_doses_manual"].insert_one(doc)
        return {"_id": str(res.inserted_id)}

    async def remove_manual_dose(self, dose_id: str) -> int:
        try:
            oid = ObjectId(dose_id)
        except Exception:                                    # noqa: BLE001
            return 0
        res = await self._db["program_doses_manual"].delete_one(
            {"_id": oid, "tenant_id": self.tenant_id})        # ΠΑΝΤΑ scoped στον πελάτη
        return res.deleted_count

    async def _manual_doses(self, program_id: str, patient_ids: list[str]) -> dict[str, list[dict]]:
        """{patient_id → [δόσεις]} για τους ασθενείς της λίστας."""
        if not program_id or not patient_ids:
            return {}
        out: dict[str, list[dict]] = {}
        async for d in self._db["program_doses_manual"].find(
                {"tenant_id": self.tenant_id, "program_id": str(program_id),
                 "patient_id": {"$in": patient_ids}}):
            out.setdefault(d["patient_id"], []).append(
                {"_id": str(d["_id"]), "at": d.get("at"), "note": d.get("note") or "",
                 "elsewhere": True})
        return out

    async def coverage_for_patient(self, program: dict, patient_id: str) -> dict | None:
        """Η κάλυψη ΕΝΟΣ ασθενή — για την Εικόνα Πελάτη.

        ΓΙΑΤΙ ΞΕΧΩΡΙΣΤΗ ΑΠΟ ΤΟ `patients_for`: εκείνο συγκεντρώνει ΟΛΟΥΣ τους ασθενείς του
        προγράμματος. Καλώντας το για μία καρτέλα, κάθε άνοιγμα καρτέλας θα έτρεχε τόσες πλήρεις
        συγκεντρώσεις όσα και τα ενεργά προγράμματα — για να κρατήσει μία γραμμή. Εδώ διαβάζουμε
        μόνο τις εκτελέσεις ΑΥΤΟΥ του ασθενή.
        """
        codes = await self.resolve_codes(program)
        if not codes:
            return None
        # Το `patient_ref` άλλοτε είναι ObjectId και άλλοτε ψευδώνυμο-κείμενο, ανάλογα με την πηγή
        # (ΗΔΥΚΑ vs πύλη). Η λίστα το επιστρέφει πάντα ως κείμενο, οπότε εδώ δοκιμάζουμε ΚΑΙ ΤΑ ΔΥΟ
        # — αλλιώς η καρτέλα δείχνει «καμία θεραπεία» σε ασθενή που έχει κάνει πέντε δόσεις.
        cands: list = [patient_id]
        try:
            cands.append(ObjectId(patient_id))
        except (InvalidId, TypeError):
            pass
        ex_ids = await self._db["prescription_executions"].distinct(
            "_id", {"tenant_id": self.tenant_id, "patient_ref": {"$in": cands}})
        shots: list[dict] = []
        if ex_ids:
            async for it in self._db["prescription_items"].find(
                    {"tenant_id": self.tenant_id, "execution_id": {"$in": ex_ids},
                     "details.eof_code": {"$in": sorted(codes)}, "is_executed": {"$ne": False}},
                    {"executed_at": 1, "details.eof_code": 1}):
                shots.append({"at": it.get("executed_at"),
                              "code": (it.get("details") or {}).get("eof_code"),
                              "elsewhere": False, "note": ""})
        for d in (await self._manual_doses(str(program.get("_id") or ""), [str(patient_id)])
                  ).get(str(patient_id), []):
            shots.append({"at": d["at"], "code": None, "elsewhere": True, "note": d["note"]})
        if not shots:
            return None
        dates = sorted([s["at"] for s in shots if s.get("at")])
        now = datetime.now(tz=timezone.utc)
        st, due = self._coverage(dates[0] if dates else None, self.repeat_months_of(program),
                                 int(program.get("notify_before_days") or 30), now,
                                 len(shots), int(program.get("doses_required") or 1),
                                 last_at=dates[-1] if dates else None,
                                 dose_interval_days=program.get("dose_interval_days"),
                                 repeat_from=program.get("repeat_from") or "first")
        return {"status": st, "due_at": due, "doses": len(shots),
                "doses_required": int(program.get("doses_required") or 1),
                "last_at": dates[-1] if dates else None,
                "shots": sorted(shots, key=lambda x: x.get("at") or now)}

    # ── λίστα ασφαλισμένων ανά πρόγραμμα ─────────────────────────────────────────────────────
    async def patients_for(self, program: dict, *, status: str = "all",
                           q: str | None = None, limit: int = 200, skip: int = 0) -> dict:
        """Ποιοι ασφαλισμένοι «ανήκουν» σε ένα πρόγραμμα: όσοι έχουν λάβει κάποιο από τα
        παρακολουθούμενα σκευάσματα, με την κατάσταση της κάλυψής τους.

        Πηγή = οι ΕΚΤΕΛΕΣΜΕΝΕΣ συνταγές που ήδη έχουμε στη βάση (καμία κλήση ΗΔΥΚΑ). Οι θανόντες
        ΔΕΝ εμφανίζονται ποτέ — είναι λίστα που καταλήγει σε επικοινωνία."""
        codes = await self.resolve_codes(program)
        if not codes:
            return {"items": [], "total": 0, "counts": {}}

        repeat_months = self.repeat_months_of(program)
        doses_required = int(program.get("doses_required") or 1)
        notify_before = int(program.get("notify_before_days") or 30)
        max_age = program.get("max_age")
        now = datetime.now(tz=timezone.utc)

        pipeline: list[dict] = [
            {"$match": {"tenant_id": self.tenant_id, "details.eof_code": {"$in": sorted(codes)},
                        "is_executed": {"$ne": False}}},
            # item → εκτέλεση (εκεί ζει ο ασθενής)
            {"$lookup": {"from": "prescription_executions", "localField": "execution_id",
                         "foreignField": "_id", "as": "ex"}},
            {"$set": {"patient": {"$first": "$ex.patient_ref"}}},
            {"$match": {"patient": {"$ne": None}}},
            {"$group": {"_id": "$patient",
                        "last_at": {"$max": "$executed_at"},
                        "first_at": {"$min": "$executed_at"},
                        "doses": {"$sum": 1},
                        "codes": {"$addToSet": "$details.eof_code"},
                        "lots": {"$addToSet": "$details.lot"},
                        "shots": {"$push": {"at": "$executed_at", "code": "$details.eof_code",
                                            "lot": "$details.lot"}}}},
            # ασθενής → όνομα/ΑΜΚΑ/ηλικία (+ θανών)
            {"$lookup": {"from": "patients_anonymized", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.full_name"}, "amka": {"$first": "$p.amka"},
                      "age_group": {"$first": "$p.age_group"},
                      "birth_year": {"$first": "$p.birth_year"},
                      "sex": {"$first": "$p.sex"},
                      "deceased": {"$first": "$p.deceased"}}},
            {"$match": {"deceased": {"$ne": True}}},     # ΠΟΤΕ θανόντες σε λίστα επικοινωνίας
            # Στοιχεία επικοινωνίας — η λίστα καταλήγει σε μήνυμα, άρα χρειάζεται να ξέρουμε
            # ποιος είναι προσβάσιμος ΚΑΙ ποιος έχει δώσει συγκατάθεση.
            {"$lookup": {"from": "patient_contacts", "localField": "_id",
                         "foreignField": "_id", "as": "c"}},
            {"$set": {"mobile": {"$first": "$c.mobile"}, "email": {"$first": "$c.email"},
                      "consent": {"$first": "$c.marketing_consent"},
                      "contact_active": {"$first": "$c.active"}}},
            {"$set": {"age": {"$cond": [{"$gt": ["$birth_year", 0]},
                                        {"$subtract": [now.year, "$birth_year"]}, None]}}},
        ]
        # ΗΛΙΚΙΑΚΟ ΕΥΡΟΣ του προγράμματος. Υπήρχε στις παραμέτρους αλλά ΔΕΝ εφαρμοζόταν ποτέ:
        # η ομάδα J07BK π.χ. περιέχει ΚΑΙ ανεμευλογιά (παιδικό) μαζί με τον έρπη ζωστήρα, οπότε
        # η λίστα γέμιζε παιδιά. Όποιος δεν έχει έτος γέννησης ΔΕΝ κόβεται (δεν τον κρύβουμε
        # επειδή λείπει η πληροφορία) — φαίνεται με ηλικία «—».
        age_cond: list[dict] = []
        if program.get("min_age") is not None:
            age_cond.append({"$or": [{"age": None}, {"age": {"$gte": int(program["min_age"])}}]})
        if program.get("max_age") is not None:
            age_cond.append({"$or": [{"age": None}, {"age": {"$lte": int(program["max_age"])}}]})
        if age_cond:
            pipeline.append({"$match": {"$and": age_cond}})
        # ΦΥΛΟ — μόνο αν το πρόγραμμα το ορίζει ρητά. Όποιος δεν έχει καταγεγραμμένο φύλο ΔΕΝ
        # κόβεται: δεν τον κρύβουμε από τον φαρμακοποιό επειδή λείπει μια πληροφορία από την ΗΔΥΚΑ.
        if program.get("sex"):
            pipeline.append({"$match": {"$or": [{"sex": None}, {"sex": ""},
                                                {"sex": str(program["sex"])[:1].upper()}]}})
        if q and q.strip():
            rx = re.escape(q.strip())
            pipeline.append({"$match": {"$or": [{"name": {"$regex": rx, "$options": "i"}},
                                                {"amka": {"$regex": rx}}]}})
        pipeline.append({"$sort": {"last_at": -1}})
        rows = await self._db["prescription_items"].aggregate(pipeline).to_list(length=None)

        # ΔΟΣΕΙΣ ΠΟΥ ΕΓΙΝΑΝ ΑΛΛΟΥ — μπαίνουν ΠΡΙΝ υπολογιστεί η κάλυψη, αλλιώς ο ασθενής θα
        # έβγαινε εκπρόθεσμος παρότι ο φαρμακοποιός μόλις κατέγραψε ότι έκανε τη δόση.
        manual = await self._manual_doses(str(program.get("_id") or ""),
                                          [str(r["_id"]) for r in rows])
        for r in rows:
            extra = manual.get(str(r["_id"]))
            if not extra:
                continue
            dates = [d["at"] for d in extra if d.get("at")]
            r["doses"] = int(r.get("doses") or 0) + len(extra)
            if dates:
                _floor = datetime.min.replace(tzinfo=timezone.utc)
                r["last_at"] = max([r.get("last_at")] + dates, key=lambda x: x or _floor)
                r["first_at"] = min([d for d in [r.get("first_at")] + dates if d])
            r["shots"] = (r.get("shots") or []) + [
                {"at": d["at"], "code": None, "lot": None, "elsewhere": True, "note": d["note"]}
                for d in extra]
            r["manual"] = extra

        # ΕΟΦ κωδικοί → εμπορικά ονόματα. Η ίδια ATC ομάδα μπορεί να περιέχει κλινικά διαφορετικά
        # εμβόλια (π.χ. ζωστήρας vs ανεμευλογιά), οπότε ο φαρμακοποιός πρέπει να βλέπει ΤΙ ακριβώς
        # έκανε ο καθένας — όχι μόνο ότι «ανήκει στο πρόγραμμα».
        used = {c for r in rows for c in (r.get("codes") or []) if c}
        names_by_code: dict[str, str] = {}
        if used:
            async for d in shared_db()["medicine_catalog"].find(
                    {"_id": {"$in": sorted(used)}}, {"name": 1}):
                names_by_code[str(d["_id"])] = (d.get("name") or "").strip()

        items, counts = [], {"covered": 0, "due_soon": 0, "expired": 0, "incomplete": 0}
        for r in rows:
            st, due_at = self._coverage(r.get("first_at"), repeat_months, notify_before, now,
                                        int(r.get("doses") or 0), doses_required,
                                        last_at=r.get("last_at"),
                                        dose_interval_days=program.get("dose_interval_days"),
                                        repeat_from=program.get("repeat_from") or "first")
            # Αν ο ασθενής θα έχει ΞΕΠΕΡΑΣΕΙ το ηλικιακό όριο όταν έρθει η αναμνηστική, δεν
            # υπάρχει επόμενη δόση να προτείνουμε — τον βγάζουμε από τη λίστα. ΕΞΑΙΡΕΣΗ: όποιος
            # δεν έχει ολοκληρώσει τη σειρά χρειάζεται δόση ΤΩΡΑ, άρα μένει.
            if (st != "incomplete" and due_at and max_age is not None
                    and r.get("age") is not None
                    and (int(r["age"]) + (due_at.year - now.year)) > max_age):
                continue
            counts[st] = counts.get(st, 0) + 1
            items.append({
                "patient_id": str(r["_id"]),
                "name": mask_name(r.get("name"), self.demo) or "—",
                "amka": mask_amka(r.get("amka"), self.demo),
                "age_group": r.get("age_group"), "age": r.get("age"),
                "last_at": r.get("last_at"), "first_at": r.get("first_at"),
                "doses": int(r.get("doses") or 0), "doses_required": doses_required,
                "status": st, "due_at": due_at,
                "vaccines": sorted({names_by_code.get(c, c) for c in (r.get("codes") or []) if c}),
                # Αναλυτικά, ώστε ο φαρμακοποιός να απαντά «πότε έκανες τι» χωρίς να ψάχνει.
                "shots": [{"at": sh.get("at"),
                           "vaccine": (names_by_code.get(str(sh.get("code")), sh.get("code"))
                                       if sh.get("code") else "— εκτός φαρμακείου —"),
                           "lot": sh.get("lot"), "elsewhere": bool(sh.get("elsewhere")),
                           "note": sh.get("note") or ""}
                          for sh in sorted((r.get("shots") or []), key=lambda x: x.get("at") or now)],
                "lots": sorted({str(x) for x in (r.get("lots") or []) if x})[:3],
                "mobile": None if self.demo else (r.get("mobile") or None),
                "email": None if self.demo else (r.get("email") or None),
                "consent": bool(r.get("consent")),
                "has_contact": bool(r.get("mobile") or r.get("email")),
            })
        if status != "all":
            items = [i for i in items if i["status"] == status]
        total = len(items)
        return {"items": items[skip:skip + limit], "total": total, "counts": counts}

    @staticmethod
    def repeat_months_of(program: dict) -> int | None:
        """Μεσοδιάστημα επανάληψης ΣΕ ΜΗΝΕΣ, από όποιο πεδίο υπάρχει.

        Τα προγράμματα που φτιάχτηκαν πριν υπάρξουν οι μήνες κρατούν `repeat_years` και
        συνεχίζουν να δουλεύουν αυτούσια — καμία μετάπτωση, κανένα ρίσκο σε ζωντανά δεδομένα.
        """
        m = program.get("repeat_months")
        if m:
            return int(m)
        y = program.get("repeat_years")
        return int(y) * 12 if y else None

    @staticmethod
    def _coverage(first_at, repeat_months, notify_before_days, now, doses, doses_required,
                  last_at=None, dose_interval_days=None, repeat_from="first"):
        """Κατάσταση κάλυψης ενός ασθενή + πότε οφείλεται η επόμενη δόση.

        Ο κύκλος μετράει από την ΠΡΩΤΗ δόση (όχι την τελευταία): σε πενταετή σχήματα η επόμενη
        αναμνηστική οφείλεται 5 έτη μετά την έναρξη του κύκλου, ανεξάρτητα από το πότε έγινε η
        δεύτερη δόση της σειράς.

        ΔΥΟ ΔΙΑΦΟΡΕΤΙΚΕΣ «επόμενες δόσεις»:
          • incomplete → η επόμενη δόση ΤΗΣ ΣΕΙΡΑΣ (τελευταία + dose_interval_days)
          • covered    → η ΑΝΑΜΝΗΣΤΙΚΗ (πρώτη + repeat_months)

        Αν η θεραπεία ΔΕΝ επαναλαμβάνεται (κενό μεσοδιάστημα — π.χ. Shingrix), όποιος
        ολοκλήρωσε τη σειρά ΔΕΝ έχει επόμενη δόση: η ημερομηνία μένει κενή."""
        if doses < doses_required:
            # Η επόμενη δόση ΤΗΣ ΣΕΙΡΑΣ οφείλεται μετά το μεσοδιάστημα δόσεων — αν δεν έχει
            # οριστεί, δεν επινοούμε ημερομηνία.
            if last_at and dose_interval_days:
                return "incomplete", last_at + timedelta(days=int(dose_interval_days))
            return "incomplete", None
        anchor = last_at if (repeat_from == "last" and last_at) else first_at
        if not repeat_months or not anchor:
            return "covered", None
        due = _add_months(anchor, repeat_months)
        if now >= due:
            return "expired", due
        if (due - now).days <= notify_before_days:
            return "due_soon", due
        return "covered", due

    # ── validation ───────────────────────────────────────────────────────────────────────────
    @staticmethod
    def _validate(doc: dict, *, require_vaccine: bool = True) -> dict:
        name = (doc.get("name") or "").strip()
        if not name:
            raise ValueError("name_required")

        prefixes = [p.strip().upper() for p in (doc.get("atc_prefixes") or []) if str(p).strip()]
        for p in prefixes:
            if not _ATC_RE.match(p):
                raise ValueError(f"bad_atc:{p}")          # only J07* — this circuit is vaccines
        codes = [str(c).strip() for c in (doc.get("eof_codes") or []) if str(c).strip()]
        if require_vaccine and not prefixes and not codes:
            raise ValueError("no_vaccine_selected")

        def _posint(key, lo, hi, default=None):
            v = doc.get(key)
            if v in (None, ""):
                return default
            try:
                n = int(v)
            except (TypeError, ValueError):
                raise ValueError(f"bad_{key}") from None
            if not lo <= n <= hi:
                raise ValueError(f"bad_{key}")
            return n

        return {
            "name": name[:120],
            "atc_prefixes": prefixes,
            "eof_codes": codes,
            # A dose SERIES (how many shots make one complete course) …
            "doses_required": _posint("doses_required", 1, 6, 1),
            "dose_interval_days": _posint("dose_interval_days", 1, 3650),
            # … is NOT the same as a BOOSTER interval. null = does not repeat.
            "repeat_years": _posint("repeat_years", 1, 50),
            # ΣΕ ΜΗΝΕΣ — γιατί έξι στις εφτά θεραπείες του πίνακα επαναλαμβάνονται ΥΠΟ-ΕΤΗΣΙΑ:
            # Prolia 6μ, Ajovy 3μ, Stelara 2–3μ, Eylea 2–4μ. Με μόνο «χρόνια» δεν εκφράζονται.
            # Το `repeat_years` ΔΕΝ καταργείται: τα υπάρχοντα προγράμματα συνεχίζουν αυτούσια
            # (δες `repeat_months_of`) — καμία μετάπτωση δεδομένων, κανένα ρίσκο.
            "repeat_months": _posint("repeat_months", 1, 600),
            # ΑΠΟ ΠΟΥ ΜΕΤΡΑΕΙ Ο ΕΠΟΜΕΝΟΣ ΚΥΚΛΟΣ — η διαφορά ΕΜΒΟΛΙΟΥ από ΘΕΡΑΠΕΙΑΣ:
            #  · "first" (αναμνηστική): από την ΕΝΑΡΞΗ του κύκλου — έτσι δούλευε πάντα το
            #    κύκλωμα στα εμβόλια, και ΔΕΝ το αλλάζουμε (μένει προεπιλογή).
            #  · "last"  (επαναλαμβανόμενη θεραπεία): από την ΤΕΛΕΥΤΑΙΑ δόση. Το Prolia κάθε 6
            #    μήνες δεν «λήγει» ποτέ· κάθε δόση ορίζει την επόμενη. Με το "first" μια ασθενής
            #    που εμβολιάστηκε χθες εμφανιζόταν εκπρόθεσμη από το 2025.
            "repeat_from": "last" if (doc.get("repeat_from") == "last") else "first",
            # «Γυναίκες & Άνδρες» = κενό. Τιμή μπαίνει μόνο όταν η θεραπεία αφορά ρητά ένα φύλο
            # (π.χ. μετεμμηνοπαυσιακή οστεοπόρωση) — αλλιώς κρύβουμε ασθενείς χωρίς λόγο.
            "sex": (doc.get("sex") or "").strip().upper()[:1] or None,
            "min_age": _posint("min_age", 0, 120),
            "max_age": _posint("max_age", 0, 120),
            # How far back the one-off historical sweep should look (§3 of the design doc).
            "lookback_years": _posint("lookback_years", 1, 10, 5),
            "notify_before_days": _posint("notify_before_days", 0, 365, 30),
            "active": bool(doc.get("active", True)),
            "notes": (doc.get("notes") or "").strip()[:500],
        }
