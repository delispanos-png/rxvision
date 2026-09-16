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
from datetime import datetime, timezone

from app.core.db import shared_db
from app.repositories.base import BaseRepository, jsonsafe

# Human labels for the vaccine ATC groups actually present in the ΗΔΥΚΑ catalogue.
# Anything not listed still works — it just shows its raw ATC code.
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

_ATC_RE = re.compile(r"^J07[A-Z]{0,2}\d{0,2}$")


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


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
            {"$group": {"_id": {"$substr": ["$atc", 0, 5]},
                        "count": {"$sum": 1},
                        "examples": {"$push": "$name"}}},
            {"$sort": {"_id": 1}},
        ]
        out = []
        async for r in shared_db()["medicine_catalog"].aggregate(pipeline):
            code = r["_id"]
            out.append({
                "atc": code,
                "label": ATC_GROUP_LABELS.get(code, code),
                "count": r["count"],
                "examples": [n for n in (r.get("examples") or [])[:3] if n],
            })
        return out

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

    async def save(self, doc: dict, program_id: str | None = None) -> dict:
        """Create or update one programme. Validates the clinical fields rather than trusting the UI."""
        clean = self._validate(doc)
        clean["updated_at"] = _now()
        if program_id:
            await self.update_one({"_id": program_id}, {"$set": clean})
            return await self.find_one({"_id": program_id}) or {}
        clean["created_at"] = _now()
        new_id = await self.insert_one(clean)
        return jsonsafe(await self._coll.find_one({"_id": new_id})) or {}

    async def delete(self, program_id: str) -> int:
        res = await self.delete_many({"_id": program_id})
        return res.deleted_count

    async def resolve_codes(self, program: dict) -> set[str]:
        """Programme → the set of ΕΟΦ codes it watches (ATC groups expanded + explicit products).

        This is what the ingestion hook matches against, so it must be cheap and exact."""
        codes: set[str] = {str(c) for c in (program.get("eof_codes") or []) if c}
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

    # ── validation ───────────────────────────────────────────────────────────────────────────
    @staticmethod
    def _validate(doc: dict) -> dict:
        name = (doc.get("name") or "").strip()
        if not name:
            raise ValueError("name_required")

        prefixes = [p.strip().upper() for p in (doc.get("atc_prefixes") or []) if str(p).strip()]
        for p in prefixes:
            if not _ATC_RE.match(p):
                raise ValueError(f"bad_atc:{p}")          # only J07* — this circuit is vaccines
        codes = [str(c).strip() for c in (doc.get("eof_codes") or []) if str(c).strip()]
        if not prefixes and not codes:
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
