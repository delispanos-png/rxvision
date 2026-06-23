"""Vaccination campaign («κύκλωμα εμβολιασμών») — campaign config + the patient-targeting engine.

A campaign defines the season, the period, and an age-group ROLLOUT schedule (older bands open
first, younger later — the way the Greek flu programme actually opens). The targeting engine walks
the tenant's patient base and produces a PRIORITISED worklist of who still needs the vaccine, ranking
respiratory / serious-chronic patients (by their prescription ICD-10 history) above everyone else,
then by age (older first), then by the currently-open rollout band.

Cross-collection facts this relies on (verified in the codebase):
  • patients_anonymized: _id(ObjectId), pseudo_id, amka, full_name, age_group, last_seen_at, lifecycle
  • vaccinations.patient_ref == patients_anonymized.pseudo_id  (a STRING, not the ObjectId)
  • prescription_executions.patient_ref == patients_anonymized._id (ObjectId); has icd10[] array
  • patient_contacts._id == patients_anonymized._id; has mobile/email/marketing_consent/active
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.repositories.base import BaseRepository, jsonsafe

# Age bands oldest → youngest, matching utils.anonymization.age_group() output strings.
AGE_ORDER = ["75+", "65-74", "50-64", "35-49", "18-34", "0-17", "unknown"]
_AGE_RANK = {ag: len(AGE_ORDER) - i for i, ag in enumerate(AGE_ORDER)}  # 75+ highest

# Default TOP-priority ICD-10 patterns (anchored prefixes): respiratory (J), diabetes (E10–E14),
# circulatory/hypertension (I), chronic kidney disease (N18). Configurable per campaign.
DEFAULT_PRIORITY_ICD = ["^J", "^E1[0-4]", "^I", "^N18"]


def _icd_category(code: str) -> str:
    """Human label for why an ICD-10 code grants vaccination priority (Greek)."""
    c = (code or "").upper()
    if c.startswith("J"):
        return "Αναπνευστικό"
    if c[:3] in ("E10", "E11", "E12", "E13", "E14"):
        return "Διαβήτης"
    if c.startswith("I"):
        return "Καρδιαγγειακό"
    if c.startswith("N18"):
        return "Χρόνια νεφρική"
    if c.startswith("C"):
        return "Ογκολογικό"
    return "Χρόνια πάθηση"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _default_season(today: datetime) -> tuple[str, datetime, datetime]:
    """Flu season runs Sep→Aug. Returns (label, start, end) for the season `today` falls in."""
    y = today.year if today.month >= 9 else today.year - 1
    start = datetime(y, 9, 1, tzinfo=timezone.utc)
    end = datetime(y + 1, 9, 1, tzinfo=timezone.utc)
    return f"{y}-{y + 1}", start, end


def _default_rollout(start: datetime, end: datetime) -> list[dict]:
    """Older bands open first; each younger band opens two weeks later. Every band stays open until
    the campaign period ends (από = opens_at, έως = closes_at). Pharmacist can override both."""
    offsets = {"75+": 0, "65-74": 0, "50-64": 14, "35-49": 28, "18-34": 42, "0-17": 42}
    return [{"age_group": ag, "opens_at": start + timedelta(days=d), "closes_at": end}
            for ag, d in offsets.items()]


class VaccinationCampaignRepository(BaseRepository):
    """One 'current' campaign per tenant (the latest active season). Tenant-scoped by construction."""

    collection_name = "vaccination_campaigns"

    # ── campaign config ───────────────────────────────────────
    async def get_current(self) -> dict:
        """The active campaign, or a sensible default built from the current flu season."""
        doc = await self.find_one({"active": True})
        if doc:
            return doc
        label, start, end = _default_season(_now())
        return {
            "name": f"Αντιγριπικός εμβολιασμός {label}", "season": label,
            "vaccine_kind": "flu", "period_start": start, "period_end": end,
            "rollout": _default_rollout(start, end), "priority_icd": list(DEFAULT_PRIORITY_ICD),
            "active": True, "_default": True,
        }

    async def upsert_current(self, fields: dict) -> dict:
        """Create/update the tenant's current campaign. Fills defaults for anything omitted."""
        cur = await self.get_current()
        merged = {**{k: v for k, v in cur.items() if not k.startswith("_") and k != "_id"}, **fields}
        merged.pop("_id", None)
        merged["active"] = True
        merged["updated_at"] = _now()
        existing = await self.find_one({"active": True})
        if existing:
            await self.update_one({"_id": ObjectId(existing["_id"])}, {"$set": merged})
        else:
            merged["created_at"] = _now()
            await self.insert_one(merged)
        return await self.get_current()

    # ── targeting helpers ─────────────────────────────────────
    async def _vaccinated_map(self, start: datetime, end: datetime) -> dict[str, datetime]:
        """pseudo_id → most-recent vaccination date this season (non-cancelled)."""
        rows = await self._db["vaccinations"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "cancelled": {"$ne": True},
                        "executed_at": {"$gte": start, "$lt": end}}},
            {"$group": {"_id": "$patient_ref", "last": {"$max": "$executed_at"}}},
        ]).to_list(length=None)
        return {r["_id"]: r["last"] for r in rows if r["_id"]}

    async def _high_risk_reasons(self, patterns: list[str]) -> dict[ObjectId, list[str]]:
        """patients_anonymized._id → list of priority reasons (e.g. «Αναπνευστικό: J45 — Άσθμα»)
        from their prescription ICD-10 history. Keys are exactly the high-risk patients."""
        if not patterns:
            return {}
        regexes = [re.compile(p) for p in patterns]
        rows = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "icd10": {"$in": regexes}}},
            {"$unwind": "$icd10"},
            {"$match": {"icd10": {"$in": regexes}}},
            {"$group": {"_id": "$patient_ref", "codes": {"$addToSet": "$icd10"}}},
        ]).to_list(length=None)

        want: set[str] = set()
        for r in rows:
            for c in r["codes"]:
                want.add(c)
                if "." in c:
                    want.add(c.split(".")[0])
        titles: dict[str, str] = {}
        if want:
            async for d in self._db["icd10_codes"].find({"_id": {"$in": list(want)}}):
                titles[d["_id"]] = d.get("title_el") or d.get("description")

        out: dict[ObjectId, list[str]] = {}
        for r in rows:
            if not isinstance(r["_id"], ObjectId):
                continue
            reasons: list[str] = []
            for c in sorted(r["codes"])[:4]:  # cap to keep the tooltip readable
                nm = titles.get(c) or (titles.get(c.split(".")[0]) if "." in c else None)
                reasons.append(f"{_icd_category(c)}: {c}" + (f" — {nm}" if nm else ""))
            out[r["_id"]] = reasons
        return out

    @staticmethod
    def _open_bands(camp: dict, now: datetime) -> set[str]:
        """Age bands whose rollout window is currently open (opens_at <= now < closes_at)."""
        open_ags: set[str] = set()
        for r in camp.get("rollout") or []:
            oa, ca = r.get("opens_at"), r.get("closes_at")
            opened = oa is None or (isinstance(oa, datetime) and oa <= now)
            not_closed = ca is None or not (isinstance(ca, datetime) and ca <= now)
            if opened and not_closed:
                open_ags.add(r.get("age_group"))
        return open_ags

    # ── the worklist ──────────────────────────────────────────
    async def worklist(self, *, page: int = 1, page_size: int = 50, age_groups: list[str] | None = None,
                       status: str = "pending", open_only: bool = False, high_risk_only: bool = False,
                       search: str | None = None, vacc_from: datetime | None = None,
                       vacc_to: datetime | None = None) -> dict:
        """Prioritised list of patients for the campaign. status: pending|done|all.
        vacc_from/vacc_to narrow the DISPLAYED rows by vaccination date (only vaccinated patients
        match a date-of-vaccination window). Counts stay campaign-wide."""
        camp = await self.get_current()
        start, end = camp["period_start"], camp["period_end"]
        now = _now()
        vacc = await self._vaccinated_map(start, end)
        hr_reasons = await self._high_risk_reasons(camp.get("priority_icd") or [])
        high = set(hr_reasons.keys())
        open_ags = self._open_bands(camp, now)

        contacts: dict[ObjectId, dict] = {}
        async for c in self._db["patient_contacts"].find(
                {"tenant_id": self.tenant_id},
                {"mobile": 1, "phone": 1, "email": 1, "marketing_consent": 1, "active": 1}):
            contacts[c["_id"]] = c

        ag_filter = set(age_groups) if age_groups else None
        needle = (search or "").strip().lower()
        rows: list[dict] = []
        counts = {"pending": 0, "vaccinated": 0, "high_risk_pending": 0}
        by_age: dict[str, dict] = {}

        async for p in self._db["patients_anonymized"].find(
                {"tenant_id": self.tenant_id},
                {"pseudo_id": 1, "amka": 1, "full_name": 1, "age_group": 1, "last_seen_at": 1}):
            c = contacts.get(p["_id"]) or {}
            if c.get("active") is False:  # deceased / moved / stopped → never target
                continue
            ag = p.get("age_group") or "unknown"
            done = p.get("pseudo_id") in vacc
            is_high = p["_id"] in high
            ab = by_age.setdefault(ag, {"age_group": ag, "pending": 0, "vaccinated": 0,
                                        "open": ag in open_ags})
            if done:
                counts["vaccinated"] += 1
                ab["vaccinated"] += 1
            else:
                counts["pending"] += 1
                ab["pending"] += 1
                if is_high:
                    counts["high_risk_pending"] += 1

            if status == "pending" and done:
                continue
            if status == "done" and not done:
                continue
            if ag_filter and ag not in ag_filter:
                continue
            if open_only and ag not in open_ags:
                continue
            if high_risk_only and not is_high:
                continue
            if vacc_from or vacc_to:  # date-of-vaccination window ⇒ only vaccinated patients match
                va = vacc.get(p.get("pseudo_id"))
                if not va or (vacc_from and va < vacc_from) or (vacc_to and va >= vacc_to):
                    continue
            if needle:
                hay = f"{p.get('full_name') or ''} {p.get('amka') or ''}".lower()
                if needle not in hay:
                    continue
            reasons = list(hr_reasons.get(p["_id"], []))
            if ag in ("65-74", "75+"):
                reasons.append(f"Ηλικία {ag} (≥65)")
            score = (1000 if is_high else 0) + _AGE_RANK.get(ag, 0) * 10 + (5 if ag in open_ags else 0)
            rows.append({
                "patient_ref": str(p["_id"]), "name": p.get("full_name"), "amka": p.get("amka"),
                "age_group": ag, "high_risk": is_high, "priority_reasons": reasons, "vaccinated": done,
                "vaccinated_at": vacc.get(p.get("pseudo_id")) if done else None,
                "open": ag in open_ags, "last_seen": p.get("last_seen_at"),
                "mobile": c.get("mobile"), "phone": c.get("phone"), "email": c.get("email"),
                "consent": bool(c.get("marketing_consent")),
                "has_contact": bool(c.get("mobile") or c.get("phone") or c.get("email")),
                "_score": score,
            })

        rows.sort(key=lambda r: (r["_score"], r["last_seen"] or datetime.min.replace(tzinfo=timezone.utc)),
                  reverse=True)
        total = len(rows)
        page_rows = rows[(page - 1) * page_size: page * page_size]
        for r in page_rows:
            r.pop("_score", None)
        age_summary = sorted(by_age.values(), key=lambda a: _AGE_RANK.get(a["age_group"], 0), reverse=True)
        return jsonsafe({
            "page": page, "page_size": page_size, "total": total, "items": page_rows,
            "counts": counts, "by_age": age_summary,
        })
