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

_ATC_RE = re.compile(r"^J07[A-Z]{0,2}\d{0,2}$")   # J07 … J07BK03


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
        """Individual vaccine products, for pharmacists who want finer control than a whole group."""
        q: dict = {"atc": {"$regex": f"^{re.escape(atc_prefix)}" if atc_prefix else "^J07"}}
        if search:
            q["name"] = {"$regex": re.escape(search.strip()), "$options": "i"}
        cur = shared_db()["medicine_catalog"].find(
            q, {"name": 1, "atc": 1, "barcode": 1}).sort("name", 1).limit(200)
        return [{"eof_code": str(d["_id"]), "name": d.get("name"),
                 "atc": d.get("atc"), "barcode": d.get("barcode")} async for d in cur]

    # ── programmes (per tenant) ──────────────────────────────────────────────────────────────
    async def list(self) -> list[dict]:
        return await self.find(sort=[("name", 1)], limit=200)

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

        repeat_years = program.get("repeat_years")
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
                        "lots": {"$addToSet": "$details.lot"}}},
            # ασθενής → όνομα/ΑΜΚΑ/ηλικία (+ θανών)
            {"$lookup": {"from": "patients_anonymized", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.full_name"}, "amka": {"$first": "$p.amka"},
                      "age_group": {"$first": "$p.age_group"},
                      "birth_year": {"$first": "$p.birth_year"},
                      "deceased": {"$first": "$p.deceased"}}},
            {"$match": {"deceased": {"$ne": True}}},     # ΠΟΤΕ θανόντες σε λίστα επικοινωνίας
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
        if q and q.strip():
            rx = re.escape(q.strip())
            pipeline.append({"$match": {"$or": [{"name": {"$regex": rx, "$options": "i"}},
                                                {"amka": {"$regex": rx}}]}})
        pipeline.append({"$sort": {"last_at": -1}})
        rows = await self._db["prescription_items"].aggregate(pipeline).to_list(length=None)

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
            st, due_at = self._coverage(r.get("first_at"), repeat_years, notify_before, now,
                                        int(r.get("doses") or 0), doses_required,
                                        last_at=r.get("last_at"),
                                        dose_interval_days=program.get("dose_interval_days"))
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
                "lots": sorted({str(x) for x in (r.get("lots") or []) if x})[:3],
            })
        if status != "all":
            items = [i for i in items if i["status"] == status]
        total = len(items)
        return {"items": items[skip:skip + limit], "total": total, "counts": counts}

    @staticmethod
    def _coverage(first_at, repeat_years, notify_before_days, now, doses, doses_required,
                  last_at=None, dose_interval_days=None):
        """Κατάσταση κάλυψης ενός ασθενή + πότε οφείλεται η επόμενη δόση.

        Ο κύκλος μετράει από την ΠΡΩΤΗ δόση (όχι την τελευταία): σε πενταετή σχήματα η επόμενη
        αναμνηστική οφείλεται 5 έτη μετά την έναρξη του κύκλου, ανεξάρτητα από το πότε έγινε η
        δεύτερη δόση της σειράς.

        ΔΥΟ ΔΙΑΦΟΡΕΤΙΚΕΣ «επόμενες δόσεις»:
          • incomplete → η επόμενη δόση ΤΗΣ ΣΕΙΡΑΣ (τελευταία + dose_interval_days)
          • covered    → η ΑΝΑΜΝΗΣΤΙΚΗ (πρώτη + repeat_years)

        Αν το εμβόλιο ΔΕΝ επαναλαμβάνεται (repeat_years κενό — π.χ. Shingrix), όποιος
        ολοκλήρωσε τη σειρά ΔΕΝ έχει επόμενη δόση: η ημερομηνία μένει κενή."""
        if doses < doses_required:
            # Η επόμενη δόση ΤΗΣ ΣΕΙΡΑΣ οφείλεται μετά το μεσοδιάστημα δόσεων — αν δεν έχει
            # οριστεί, δεν επινοούμε ημερομηνία.
            if last_at and dose_interval_days:
                return "incomplete", last_at + timedelta(days=int(dose_interval_days))
            return "incomplete", None
        if not repeat_years or not first_at:
            return "covered", None
        due = first_at + timedelta(days=int(repeat_years) * 365)
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
            "min_age": _posint("min_age", 0, 120),
            "max_age": _posint("max_age", 0, 120),
            # How far back the one-off historical sweep should look (§3 of the design doc).
            "lookback_years": _posint("lookback_years", 1, 10, 5),
            "notify_before_days": _posint("notify_before_days", 0, 365, 30),
            "active": bool(doc.get("active", True)),
            "notes": (doc.get("notes") or "").strip()[:500],
        }
