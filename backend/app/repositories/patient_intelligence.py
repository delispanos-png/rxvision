"""RxVision Patient Intelligence — turns prescription data into patient-level business
intelligence: KPIs, compliance scoring, recall, win-back, VIP tiers, risk detection,
revenue opportunities, segmentation and AI insights.

Leverages the rich `patients_anonymized` profile (lifecycle / rx_count / rx_value_total /
last_seen) + the ΗΔΥΚΑ repeat chains (repeat_root windows). One chain pass feeds compliance +
recall + win-back-recoverable; patient aggregates feed the rest.
"""

from __future__ import annotations

import calendar
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from app.repositories.base import BaseRepository, jsonsafe
from app.utils.format import eur_gr
from app.utils.masking import mask_amka, mask_name, mask_rows


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _addm(d: datetime, n: int) -> datetime:
    y, mo = d.year + (d.month - 1 + n) // 12, (d.month - 1 + n) % 12 + 1
    return d.replace(year=y, month=mo, day=min(d.day, calendar.monthrange(y, mo)[1]))


def _yago(d: datetime) -> datetime:
    """'Last year' = exactly 52 weeks (364 days) earlier — same WEEKDAY, NOT same calendar date.
    A Friday must compare to a Friday: weekday dynamics (e.g. a recurring Friday local event, or
    just weekday vs weekend traffic) otherwise distort YoY deltas and lead to wrong decisions
    (12/6/2026 Fri vs 12/6/2025 Thu is misleading). 364d also keeps the ordinal week (2nd Friday of
    June ↔ 2nd Friday of June)."""
    return d - timedelta(days=364)


def _pct(a: float, b: float) -> float | None:
    return ((a - b) / b * 100) if b else None


# therapeutic segments by ATC prefix (Greek pharmacy chronic-care lenses)
SEGMENTS = [
    {"key": "diabetes", "label": "Διαβήτης", "en": "Diabetes", "atc": ["A10"]},
    {"key": "hypertension", "label": "Υπέρταση", "en": "Hypertension", "atc": ["C03", "C07", "C08", "C09"]},
    {"key": "cardio", "label": "Καρδιολογικά", "en": "Cardiovascular", "atc": ["C01", "B01"]},
    {"key": "cholesterol", "label": "Χοληστερίνη", "en": "Cholesterol", "atc": ["C10"]},
    {"key": "thyroid", "label": "Θυρεοειδής", "en": "Thyroid", "atc": ["H03"]},
    {"key": "respiratory", "label": "Αναπνευστικά", "en": "Respiratory", "atc": ["R03"]},
    {"key": "psych", "label": "Νευρ./Ψυχ.", "en": "Neuro/Psych", "atc": ["N05", "N06"]},
]

COMPLIANCE_BANDS = [
    (90, "excellent", "Άριστη"), (75, "good", "Καλή"), (50, "medium", "Μέτρια"),
    (25, "risk", "Ρίσκο"), (0, "critical", "Κρίσιμη"),
]


def _band(score: float) -> tuple[str, str]:
    for lo, key, label in COMPLIANCE_BANDS:
        if score >= lo:
            return key, label
    return "critical", "Κρίσιμη"


class PatientIntelligenceRepository(BaseRepository):
    collection_name = "prescription_executions"

    # ── shared chain analysis (compliance + recall + recoverable) ───────────
    async def _chain_analysis(self) -> dict:
        """Per patient_ref → {compliance, missed, available, recoverable, chains, value}."""
        now = _now()
        chains: dict = defaultdict(list)
        async for e in self._db["prescription_executions"].find(
                {"tenant_id": self.tenant_id},
                {"repeat_root": 1, "external_id": 1, "executed_at": 1, "valid_from": 1,
                 "valid_until": 1, "amount_total": 1, "patient_ref": 1}):
            chains[e.get("repeat_root")].append(e)
        per: dict = defaultdict(lambda: {"executed": 0, "expected": 0, "missed": 0,
                                         "available": 0, "recoverable": 0, "chains": 0})
        for exs in chains.values():
            vf = min((e["valid_from"] for e in exs if e.get("valid_from")), default=None)
            vu = max((e["valid_until"] for e in exs if e.get("valid_until")), default=None)
            if not vf or not vu or (vu - vf).days < 40:
                continue
            pat = exs[0].get("patient_ref")
            if not pat:
                continue
            avg = sum(e.get("amount_total", 0) for e in exs) / max(len(exs), 1)
            p = per[pat]
            p["chains"] += 1
            i = 0
            while i < 18 and _addm(vf, i) <= vu:
                wopen, wclose = _addm(vf, i), _addm(vf, i + 1)
                if wclose <= now:  # a window that should have been filled
                    p["expected"] += 1
                    done = any(e.get("executed_at") and wopen <= e["executed_at"] < wclose for e in exs)
                    if done:
                        p["executed"] += 1
                    else:
                        p["missed"] += 1
                        p["recoverable"] += avg
                elif wopen <= now < wclose:  # open now → available for recall
                    p["available"] += 1
                    p["recoverable"] += avg
                i += 1
        for p in per.values():
            p["compliance"] = round(p["executed"] / p["expected"] * 100) if p["expected"] else None
        return per

    async def _patients(self) -> list[dict]:
        # Εξαιρούμε θανόντες (deceased) από κάθε patient-level ανάλυση/λίστα — δεν τους «κυνηγάμε».
        return [p async for p in self._db["patients_anonymized"].find(
            {"tenant_id": self.tenant_id, "deceased": {"$ne": True}})]

    async def _timeline(self) -> dict:
        """patient_ref → sorted [(executed_at, amount_total)]. The earliest entry is the patient's
        first-EVER execution we hold (basis for the 'never executed before' new-patient rule)."""
        by: dict = defaultdict(list)
        async for e in self._db["prescription_executions"].find(
                {"tenant_id": self.tenant_id},
                {"patient_ref": 1, "executed_at": 1, "amount_total": 1}):
            if e.get("patient_ref") and e.get("executed_at"):
                by[e["patient_ref"]].append((e["executed_at"], e.get("amount_total", 0)))
        for evs in by.values():
            evs.sort()
        return by

    # ── RETURNS (reactivation) ──────────────────────────────────────────────
    # A returned patient = was dormant ≥ RETURN_GAP days, then came back. "Recent" returns are
    # comebacks within the last RECENT_DAYS — what we want to learn the reason for.
    RETURN_GAP = 90
    RECENT_DAYS = 120

    def _returns_from(self, by: dict, now: datetime) -> list[dict]:
        recent = now - timedelta(days=self.RECENT_DAYS)
        out = []
        for pref, evs in by.items():
            for i in range(len(evs) - 1, 0, -1):  # most-recent gap first
                gap = (evs[i][0] - evs[i - 1][0]).days
                if gap >= self.RETURN_GAP:
                    if evs[i][0] >= recent:
                        out.append({"patient_ref": pref, "returned_at": evs[i][0], "gap_days": gap,
                                    "dormant_since": evs[i - 1][0],
                                    "value": sum(v for _, v in evs)})
                    break  # only the latest dormancy matters
        out.sort(key=lambda x: x["returned_at"], reverse=True)
        return out

    async def returns(self) -> dict:
        now = _now()
        by = await self._timeline()
        rets = self._returns_from(by, now)
        prefs = [r["patient_ref"] for r in rets]
        pats = {p["_id"]: p async for p in self._db["patients_anonymized"].find(
            {"_id": {"$in": prefs}, "tenant_id": self.tenant_id})} if prefs else {}
        cts = {c["_id"]: c async for c in self._db["patient_contacts"].find(
            {"_id": {"$in": prefs}, "tenant_id": self.tenant_id})} if prefs else {}
        items = []
        for r in rets:
            pa = pats.get(r["patient_ref"], {}); ct = cts.get(r["patient_ref"], {})
            items.append({
                "patient_id": str(r["patient_ref"]), "name": pa.get("full_name"), "amka": pa.get("amka"),
                "returned_at": r["returned_at"], "gap_days": r["gap_days"], "value": r["value"],
                "reactivation_reason": ct.get("reactivation_reason"),
                "mobile": ct.get("mobile"), "phone": ct.get("phone"),
            })
        return jsonsafe({"items": mask_rows(items, self.demo), "count": len(items),
                         "recovered_value": round(sum(r["value"] for r in rets))})

    # ── 1. DASHBOARD overview ───────────────────────────────────────────────
    async def overview(self) -> dict:
        now = _now()
        # "Active" window = 60 days (not 30): a monthly chronic Rx opens every ~30d and the patient
        # has up to ~20d to execute → a loyal monthly customer can return up to ~50d apart. A 30-day
        # window would wrongly drop them; 60 days keeps the genuinely-active base.
        d_active = now - timedelta(days=60)
        mstart = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        # ALL deltas are YEAR-OVER-YEAR — compared to the SAME calendar window one year ago.
        yago = _yago(now)                                    # same moment last year (today-1y)
        yact_lo, yact_hi = yago - timedelta(days=60), yago   # same 60-day window, last year
        mstart_y = _yago(mstart)                             # same month START last year — the
        # current month is compared MONTH-TO-DATE (mstart→now) vs the same span last year
        # (mstart_y→yago), so a half-finished month isn't unfairly compared to a full one.
        pats = await self._patients()
        chain = await self._chain_analysis()
        tl = await self._timeline()  # patient → sorted executions (first entry = first-EVER)

        def seen_after(p, dt):
            ls = p.get("last_seen_at")
            return isinstance(ls, datetime) and ls >= dt

        active60 = sum(1 for p in pats if seen_after(p, d_active))
        # YoY: distinct patients with an execution in the SAME 60-day window last year
        ya = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": yact_lo, "$lt": yact_hi}}},
            {"$group": {"_id": "$patient_ref"}}, {"$count": "n"}]).to_list(1)
        active60_prev = ya[0]["n"] if ya else 0
        # NEW = the patient's first-EVER execution falls in the period (never executed before)
        new_month = sum(1 for evs in tl.values() if evs and evs[0][0] >= mstart)
        new_prev = sum(1 for evs in tl.values() if evs and mstart_y <= evs[0][0] < yago)
        returns_count = len(self._returns_from(tl, now))
        lost = sum(1 for p in pats if not seen_after(p, now - timedelta(days=120)))
        total_rev = sum(p.get("rx_value_total", 0) for p in pats)
        rev_per_patient = round(total_rev / len(pats)) if pats else 0

        # prescriptions this month + avg value
        agg = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": mstart}}},
            {"$group": {"_id": None, "n": {"$sum": 1}, "val": {"$sum": "$amount_total"}}},
        ]).to_list(1)
        rx_month = (agg[0]["n"] if agg else 0)
        avg_rx = round((agg[0]["val"] / agg[0]["n"]) if agg and agg[0]["n"] else 0)
        aggp = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": mstart_y, "$lt": yago}}},
            {"$group": {"_id": None, "n": {"$sum": 1}}},
        ]).to_list(1)
        rx_prev = (aggp[0]["n"] if aggp else 0)

        # compliance (patients with recurring chains)
        comp_scores = [c["compliance"] for c in chain.values() if c.get("compliance") is not None]
        avg_compliance = round(sum(comp_scores) / len(comp_scores)) if comp_scores else 0

        # recall + win-back recoverable
        recall_patients = sum(1 for c in chain.values() if c["missed"] or c["available"])
        recall_recoverable = round(sum(c["recoverable"] for c in chain.values()))
        winback = self._winback_buckets(pats, now)
        winback_revenue = sum(b["recoverable"] for b in winback)

        # VIP
        vip = self._vip_tiers(pats)
        vip_count = sum(t["count"] for t in vip if t["tier"] in ("platinum", "gold"))

        kpis = {
            "active_60d": {"value": active60, "delta": _pct(active60, active60_prev)},
            "new_month": {"value": new_month, "delta": _pct(new_month, new_prev)},
            "returns": {"value": returns_count, "delta": None},
            "lost_patients": {"value": lost, "delta": None},
            "rx_month": {"value": rx_month, "delta": _pct(rx_month, rx_prev)},
            "avg_rx_value": {"value": avg_rx, "delta": None},
            "revenue_per_patient": {"value": rev_per_patient, "delta": None},
            "compliance_score": {"value": avg_compliance, "delta": None},
            "recall_patients": {"value": recall_patients, "delta": None},
            "winback_revenue": {"value": round(winback_revenue), "delta": None},
            "vip_patients": {"value": vip_count, "delta": None},
        }
        return jsonsafe({
            "kpis": kpis,
            "total_patients": len(pats),
            "recall_recoverable": recall_recoverable,
            "winback": winback,
            "vip": vip,
            "compliance_distribution": self._compliance_dist(chain),
            "trend": await self._trend(),
            "insights": self._ai_insights(kpis, recall_patients, recall_recoverable, winback_revenue, chain, pats),
        })

    async def _trend(self) -> dict:
        """Daily (30d), weekly (12w), monthly (12m) prescription counts + value."""
        now = _now()
        async def buckets(fmt, since):
            rows = await self._db["prescription_executions"].aggregate([
                {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": since}}},
                {"$group": {"_id": {"$dateToString": {"format": fmt, "date": "$executed_at"}},
                            "rx": {"$sum": 1}, "value": {"$sum": "$amount_total"}}},
                {"$sort": {"_id": 1}},
            ]).to_list(None)
            return [{"label": r["_id"], "rx": r["rx"], "value": r["value"]} for r in rows]
        return {
            "daily": await buckets("%Y-%m-%d", now - timedelta(days=30)),
            "weekly": await buckets("%Y-W%V", now - timedelta(weeks=12)),
            "monthly": await buckets("%Y-%m", now - timedelta(days=370)),
        }

    # ── 5. WIN-BACK ─────────────────────────────────────────────────────────
    def _winback_buckets(self, pats: list[dict], now: datetime) -> list[dict]:
        out = []
        prev_cut = 30
        for days in (60, 90, 180, 365):
            lo, hi = now - timedelta(days=days), now - timedelta(days=prev_cut)
            grp = [p for p in pats if isinstance(p.get("last_seen_at"), datetime) and lo <= p["last_seen_at"] < hi]
            lost_rev = sum(p.get("rx_value_total", 0) for p in grp)
            # recoverable: a fraction of historical value, decaying with inactivity
            factor = {60: 0.45, 90: 0.35, 180: 0.20, 365: 0.10}[days]
            out.append({"bucket": days, "count": len(grp), "lost_revenue": round(lost_rev),
                        "recoverable": round(lost_rev * factor)})
            prev_cut = days
        return out

    async def winback(self) -> dict:
        pats = await self._patients()
        now = _now()
        buckets = self._winback_buckets(pats, now)
        return jsonsafe({"buckets": buckets,
                         "total_recoverable": sum(b["recoverable"] for b in buckets),
                         "total_lost": sum(b["lost_revenue"] for b in buckets)})

    # ── 6. VIP tiers ────────────────────────────────────────────────────────
    def _vip_tiers(self, pats: list[dict]) -> list[dict]:
        ranked = sorted([p for p in pats if p.get("rx_value_total", 0) > 0],
                        key=lambda p: p.get("rx_value_total", 0), reverse=True)
        n = len(ranked)
        tiers = [("platinum", "Platinum", 0.05), ("gold", "Gold", 0.15),
                 ("silver", "Silver", 0.35), ("bronze", "Bronze", 1.0)]
        out, idx = [], 0
        for key, label, cum in tiers:
            end = round(n * cum)
            grp = ranked[idx:end]
            out.append({"tier": key, "label": label, "count": len(grp),
                        "revenue": round(sum(p.get("rx_value_total", 0) for p in grp))})
            idx = end
        return out

    async def vip(self) -> dict:
        pats = await self._patients()
        ranked = sorted([p for p in pats if p.get("rx_value_total", 0) > 0],
                        key=lambda p: p.get("rx_value_total", 0), reverse=True)
        n = len(ranked)
        def tier_of(i):
            r = (i + 1) / n
            return "platinum" if r <= 0.05 else "gold" if r <= 0.15 else "silver" if r <= 0.35 else "bronze"
        items = [{
            "patient_id": str(p["_id"]), "name": p.get("full_name"), "amka": p.get("amka"),
            "value": p.get("rx_value_total", 0), "rx_count": p.get("rx_count", 0),
            "last_seen": p.get("last_seen_at"), "tier": tier_of(i),
        } for i, p in enumerate(ranked[:300])]
        return jsonsafe({"tiers": self._vip_tiers(pats), "items": mask_rows(items, self.demo)})

    # ── 7. RISK detection ───────────────────────────────────────────────────
    async def risk(self) -> dict:
        pats = {p["_id"]: p for p in await self._patients()}
        chain = await self._chain_analysis()
        now = _now()
        items = []
        for pref, c in chain.items():
            if pref not in pats:        # θανών/εξαιρεθείς → εκτός λίστας ρίσκου
                continue
            pa = pats.get(pref, {})
            score = c.get("compliance")
            ls = pa.get("last_seen_at")
            gap_days = (now - ls).days if isinstance(ls, datetime) else 999
            reasons = []
            if score is not None and score < 50:
                reasons.append("low_compliance")
            if c["missed"] >= 3:
                reasons.append("missed_renewals")
            if gap_days > 90:
                reasons.append("long_gap")
            if not reasons:
                continue
            items.append({
                "patient_id": str(pref), "name": pa.get("full_name"), "amka": pa.get("amka"),
                "compliance": score, "missed": c["missed"], "gap_days": gap_days,
                "value": pa.get("rx_value_total", 0), "reasons": reasons,
                "recoverable": round(c["recoverable"]),
            })
        items.sort(key=lambda x: x["recoverable"], reverse=True)
        return jsonsafe({"items": mask_rows(items[:300], self.demo), "count": len(items)})

    # ── 360° SINGLE-PATIENT PROFILE («Εικόνα Πελάτη», by ΑΜΚΑ) ───────────────
    async def advice_signature(self, amka: str | None = None, patient_id: str | None = None,
                               barcode: str | None = None, date_from: datetime | None = None,
                               date_to: datetime | None = None) -> tuple:
        """Φθηνή υπογραφή κλινικών συνθηκών (παθήσεις/φάρμακα/δημογραφικά/G6PD) ΧΩΡΙΣ το βαρύ προφίλ
        360° — για άμεσο cache-hit στις AI συμβουλές. Επιστρέφει (patient_id_str, sig_src) ή (None, None)."""
        from bson import ObjectId

        def _aware(d):
            return d.replace(tzinfo=timezone.utc) if d and d.tzinfo is None else d
        date_from, date_to = _aware(date_from), _aware(date_to)
        pa = None
        if barcode:
            bc = (barcode or "").strip().split(":")[0]
            if bc:
                ex = await self._db["prescription_executions"].find_one(
                    {"tenant_id": self.tenant_id, "external_id": {"$regex": "^" + re.escape(bc)}},
                    {"patient_ref": 1})
                if ex and ex.get("patient_ref"):
                    patient_id = str(ex["patient_ref"])
        if patient_id:
            try:
                pa = await self._db["patients_anonymized"].find_one(
                    {"tenant_id": self.tenant_id, "_id": ObjectId(patient_id)})
            except Exception:  # noqa: BLE001
                pa = None
        if pa is None and (amka or "").strip():
            pa = await self._db["patients_anonymized"].find_one(
                {"tenant_id": self.tenant_id, "amka": amka.strip()})
        if not pa:
            return None, None, None
        pid = pa["_id"]
        q: dict = {"tenant_id": self.tenant_id, "patient_ref": pid}
        if date_from or date_to:
            q["executed_at"] = {}
            if date_from:
                q["executed_at"]["$gte"] = date_from
            if date_to:
                q["executed_at"]["$lte"] = date_to
        codes: set = set()
        exec_ids: list = []
        async for e in self._db["prescription_executions"].find(q, {"icd10": 1}):
            exec_ids.append(e["_id"])
            for c in (e.get("icd10") or []):
                codes.add(c)
        meds: set = set()
        if exec_ids:
            async for it in self._db["prescription_items"].find(
                    {"tenant_id": self.tenant_id, "execution_id": {"$in": exec_ids}}, {"product_id": 1}):
                if it.get("product_id"):
                    meds.add(str(it["product_id"]))
        ct = await self._db["patient_contacts"].find_one(
            {"tenant_id": self.tenant_id, "_id": pid}, {"g6pd_deficiency": 1}) or {}
        sig_src = {"age": pa.get("age_group"), "sex": pa.get("sex"),
                   "conditions": sorted(codes), "medicines": sorted(meds),
                   "g6pd": bool(ct.get("g6pd_deficiency"))}
        return str(pid), (pa.get("amka") or None), sig_src

    async def patient_profile(self, amka: str | None = None, patient_id: str | None = None,
                              barcode: str | None = None, date_from: datetime | None = None,
                              date_to: datetime | None = None) -> dict:
        # Το date range περιορίζει ΜΟΝΟ τα κλινικά (διαγνώσεις/φάρμακα/segments & άρα το AI) ώστε να
        # μη «θολώνουν» παλιές διαγνώσεις 1-2 ετών· financials/εκτελέσεις/γραφήματα μένουν πλήρη.
        def _aware(d):
            return d.replace(tzinfo=timezone.utc) if d and d.tzinfo is None else d
        date_from, date_to = _aware(date_from), _aware(date_to)
        pa = None
        if barcode:   # σάρωση συνταγής/εμβολίου στο φαρμακείο → βρες τον πελάτη ΧΩΡΙΣ να ζητήσεις ΑΜΚΑ
            bc = (barcode or "").strip().split(":")[0]
            if bc:
                ex = await self._db["prescription_executions"].find_one(
                    {"tenant_id": self.tenant_id, "external_id": {"$regex": "^" + re.escape(bc)}},
                    {"patient_ref": 1})
                if ex and ex.get("patient_ref"):
                    patient_id = str(ex["patient_ref"])
                else:   # ίσως barcode εμβολιασμού (ξεχωριστό registry, κρατά raw ΑΜΚΑ)
                    v = await self._db["vaccinations"].find_one(
                        {"tenant_id": self.tenant_id, "$or": [{"barcode": bc}, {"external_id": bc}]},
                        {"amka": 1})
                    if v and v.get("amka"):
                        amka = v["amka"]
        if patient_id:   # από την αναζήτηση ονόματος/ΑΜΚΑ (το ΑΜΚΑ μπορεί να είναι masked σε demo)
            from bson import ObjectId
            try:
                pa = await self._db["patients_anonymized"].find_one(
                    {"tenant_id": self.tenant_id, "_id": ObjectId(patient_id)})
            except Exception:  # noqa: BLE001
                pa = None
        if pa is None:
            amka = (amka or "").strip()
            if amka:
                pa = await self._db["patients_anonymized"].find_one(
                    {"tenant_id": self.tenant_id, "amka": amka})
        if not pa:
            return {"found": False}
        pid = pa["_id"]
        amka = pa.get("amka") or ""   # πραγματικό ΑΜΚΑ για τα downstream (matching εμβολιασμών)
        now = _now()
        ct = await self._db["patient_contacts"].find_one(
            {"tenant_id": self.tenant_id, "_id": pid}) or {}

        exs = [e async for e in self._db["prescription_executions"].find(
            {"tenant_id": self.tenant_id, "patient_ref": pid},
            {"repeat_root": 1, "executed_at": 1, "valid_from": 1, "valid_until": 1,
             "amount_total": 1, "amount_claimed": 1, "patient_share": 1, "wholesale_cost": 1,
             "icd10": 1, "doctor_id": 1, "next_open_date": 1})]
        value = sum(e.get("amount_total", 0) for e in exs)
        claimed = sum(e.get("amount_claimed", 0) for e in exs)
        paid = sum(e.get("patient_share", 0) for e in exs)
        cost = sum(e.get("wholesale_cost", 0) for e in exs)
        rx_count = len(exs)

        # medicines per repeat-chain (so the missed/available drill-downs name the actual therapy)
        rm_rows = await self.aggregate([
            {"$match": {"patient_ref": pid, "repeat_root": {"$ne": None}}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$lookup": {"from": "products", "localField": "it.product_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"pname": {"$first": "$p.name"}}},
            {"$group": {"_id": "$repeat_root", "meds": {"$addToSet": "$pname"}}},
        ])
        root_meds = {r["_id"]: [m for m in r["meds"] if m][:5] for r in rm_rows}

        # repeat-chain windows → compliance + the actual missed / available-now prescriptions
        chains: dict = defaultdict(list)
        for e in exs:
            chains[e.get("repeat_root")].append(e)
        # Data floor: we have NO data before the patient's FIRST execution we actually hold. A repeat
        # chain whose validity began earlier (e.g. the customer was active in 2024 but we only ingested
        # from 2025) must NOT count those pre-data windows as "missed" — that would be a false miss.
        # Computed straight from the loaded executions (more reliable than the stored first_seen_at).
        data_floor = min((e["executed_at"] for e in exs if e.get("executed_at")), default=None)
        missed = available = expected = executed = 0
        recoverable = 0.0
        missed_items: list = []
        available_items: list = []
        for root, cexs in chains.items():
            vf = min((e["valid_from"] for e in cexs if e.get("valid_from")), default=None)
            vu = max((e["valid_until"] for e in cexs if e.get("valid_until")), default=None)
            if not vf or not vu or (vu - vf).days < 40:
                continue
            avg = sum(e.get("amount_total", 0) for e in cexs) / max(len(cexs), 1)
            cm = ca = 0
            last_due = avail_until = None
            i = 0
            while i < 18 and _addm(vf, i) <= vu:
                wopen, wclose = _addm(vf, i), _addm(vf, i + 1)
                if data_floor and wopen < data_floor:  # window before we had any data → unknown, skip
                    i += 1
                    continue
                done = any(e.get("executed_at") and wopen <= e["executed_at"] < wclose for e in cexs)
                if wclose <= now:
                    expected += 1
                    if done:
                        executed += 1
                    else:
                        missed += 1; recoverable += avg; cm += 1; last_due = wopen
                elif wopen <= now < wclose and not done:  # open & NOT yet dispensed → available now
                    available += 1; recoverable += avg; ca += 1; avail_until = wclose
                i += 1
            if cm or ca:
                meds = root_meds.get(root, [])
                last_exec = max((e["executed_at"] for e in cexs if e.get("executed_at")), default=None)
                if cm:
                    missed_items.append({"root": root, "medicines": meds, "count": cm,
                                         "value": round(cm * avg), "last_executed": last_exec,
                                         "due": last_due})
                if ca:
                    available_items.append({"root": root, "medicines": meds, "count": ca,
                                            "value": round(ca * avg), "until": avail_until,
                                            "last_executed": last_exec})
        missed_items.sort(key=lambda x: x["value"], reverse=True)
        available_items.sort(key=lambda x: x["value"], reverse=True)
        compliance = round(executed / expected * 100) if expected else None
        next_open = min((e["next_open_date"] for e in exs
                         if e.get("next_open_date") and e["next_open_date"] >= now), default=None)

        # flu vaccination of the CURRENT season (Sep→Aug); matched by pseudonym or ΑΜΚΑ
        fy = now.year if now.month >= 9 else now.year - 1
        s_start = datetime(fy, 9, 1, tzinfo=timezone.utc)
        s_end = datetime(fy + 1, 9, 1, tzinfo=timezone.utc)
        flu_doc = await self._db["vaccinations"].find_one(
            {"tenant_id": self.tenant_id, "cancelled": {"$ne": True},
             "executed_at": {"$gte": s_start, "$lt": s_end},
             "$or": [{"patient_ref": pa.get("pseudo_id")}, {"amka": amka}]},
            sort=[("executed_at", -1)])
        flu = {"season": f"{fy}-{fy + 1}", "vaccinated": bool(flu_doc),
               "date": flu_doc.get("executed_at") if flu_doc else None,
               "vaccine": flu_doc.get("vaccine_name") if flu_doc else None}

        # κλινικό date-scope (διαγνώσεις/φάρμακα): match εκτελέσεων εντός περιόδου, αν δόθηκε
        clin_match: dict = {"patient_ref": pid}
        if date_from or date_to:
            rng: dict = {}
            if date_from:
                rng["$gte"] = date_from
            if date_to:
                rng["$lt"] = date_to
            clin_match["executed_at"] = rng

        # medicines (top) + ATC-derived therapeutic segments
        med_rows = await self.aggregate([
            {"$match": clin_match},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$lookup": {"from": "products", "localField": "it.product_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"pname": {"$first": "$p.name"}, "subst": {"$first": "$p.substance"},
                      "atc": {"$toUpper": {"$ifNull": [{"$first": "$p.atc"}, ""]}}}},
            {"$group": {"_id": "$pname", "atc": {"$first": "$atc"}, "subst": {"$first": "$subst"},
                        "times": {"$sum": 1},
                        "value": {"$sum": {"$multiply": ["$it.retail_price",
                                                         {"$ifNull": ["$it.quantity", 1]}]}}}},
            {"$sort": {"times": -1}},
        ])
        medicines = [{"name": m["_id"], "atc": m.get("atc"), "substance": m.get("subst"),
                      "times": m["times"], "value": m["value"]} for m in med_rows if m["_id"]]
        segments = [{"key": s["key"], "label": s["label"]} for s in SEGMENTS
                    if any(any((m.get("atc") or "").startswith(pfx) for pfx in s["atc"])
                           for m in medicines)]

        # top doctors
        doc_rows = await self.aggregate([
            {"$match": {"patient_ref": pid, "doctor_id": {"$ne": None}}},
            {"$group": {"_id": "$doctor_id", "times": {"$sum": 1}}},
            {"$sort": {"times": -1}}, {"$limit": 5},
            {"$lookup": {"from": "doctors", "localField": "_id", "foreignField": "_id", "as": "d"}},
            {"$set": {"name": {"$first": "$d.full_name"}, "spec": {"$first": "$d.specialty"}}},
        ])
        doctors = [{"name": d.get("name"), "specialty": d.get("spec"), "times": d["times"]}
                   for d in doc_rows if d.get("name")]

        # full execution list (the «Επισκέψεις» KPI drills into this) — newest first
        exec_rows = await self.aggregate([
            {"$match": {"patient_ref": pid}},
            {"$sort": {"executed_at": -1}}, {"$limit": 2000},  # «όλες οι συνταγές του πελάτη»
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$lookup": {"from": "products", "localField": "it.product_id",
                         "foreignField": "_id", "as": "prods"}},
            {"$lookup": {"from": "doctors", "localField": "doctor_id",
                         "foreignField": "_id", "as": "doc"}},
            {"$project": {"_id": 0, "barcode": "$external_id", "executed_at": 1,
                          "amount_total": 1, "patient_share": 1,
                          "doctor": {"$ifNull": [{"$first": "$doc.full_name"}, None]},
                          "medicines": {"$map": {"input": "$prods", "as": "p", "in": "$$p.name"}}}},
        ])
        # keep the FULL external_id ("barcode:execNo") — the detail endpoint matches it EXACTLY
        executions = [{"kind": "rx", "barcode": str(e.get("barcode", "")), "executed_at": e.get("executed_at"),
                       "amount_total": e.get("amount_total", 0), "patient_share": e.get("patient_share", 0),
                       "doctor": e.get("doctor"), "cancelled": False,
                       "medicines": [m for m in (e.get("medicines") or []) if m]}
                      for e in exec_rows]
        # ALSO merge the patient's flu vaccinations (separate ΗΔΥΚΑ INFLUENZA registry) so the execution
        # list is complete. Ο εμβολιασμός έχει ΔΙΚΗ του τιμή (total_price / insurance_part / patient_part)·
        # μετρά κανονικά ως τζίρος του πελάτη — μην το μηδενίζεις (αλλιώς εμφανίζεται «—»).
        vac_value = vac_claimed = vac_paid = 0
        async for v in self._db["vaccinations"].find(
                {"tenant_id": self.tenant_id,
                 "$or": [{"patient_ref": pa.get("pseudo_id")}, {"amka": amka}]},
                {"barcode": 1, "external_id": 1, "executed_at": 1, "vaccine_name": 1, "cancelled": 1,
                 "total_price": 1, "insurance_part": 1, "patient_part": 1}):
            ve = v.get("executed_at")
            if data_floor and ve and ve < data_floor:  # only the window we monitor (same as prescriptions)
                continue
            cancelled = bool(v.get("cancelled"))
            vt = (v.get("total_price") or 0) if not cancelled else 0
            vp = (v.get("patient_part") or 0) if not cancelled else 0
            if not cancelled:
                vac_value += vt
                vac_claimed += v.get("insurance_part") or 0
                vac_paid += vp
            executions.append({
                "kind": "vaccine", "barcode": v.get("barcode") or v.get("external_id") or "",
                "executed_at": v.get("executed_at"), "amount_total": vt, "patient_share": vp,
                "doctor": None, "cancelled": cancelled,
                "medicines": [v.get("vaccine_name") or "Εμβόλιο γρίπης"]})
        # εμβολιασμοί → στον τζίρο/αιτούμενο/συμμετοχή του πελάτη (LTV, μέσος όρος ανά εκτέλεση)
        value += vac_value; claimed += vac_claimed; paid += vac_paid
        executions.sort(key=lambda x: x.get("executed_at") or datetime(1970, 1, 1, tzinfo=timezone.utc),
                        reverse=True)
        rx_count = len(executions)  # «Αριθμός εκτελέσεων» = συνταγές + εμβολιασμοί (εντός παραθύρου)

        # ICD-10 conditions with titles — εντός της επιλεγμένης περιόδου (αν δόθηκε)
        icd_count: dict = defaultdict(int)
        for e in exs:
            ea = e.get("executed_at")
            if (date_from and (ea is None or ea < date_from)) or (date_to and (ea is None or ea >= date_to)):
                continue
            for c in (e.get("icd10") or []):
                icd_count[c] += 1
        want = set(icd_count)
        for c in list(icd_count):
            if "." in c:
                want.add(c.split(".")[0])
        titles: dict = {}
        if want:
            async for d in self._db["icd10_codes"].find({"_id": {"$in": list(want)}}):
                titles[d["_id"]] = d.get("title_el") or d.get("description")
        conditions = []
        for c, n in sorted(icd_count.items(), key=lambda x: -x[1])[:12]:
            title = titles.get(c) or (titles.get(c.split(".")[0]) if "." in c else None)
            conditions.append({"code": c, "title": title, "times": n})

        # VIP tier by value percentile
        total_pat = await self._db["patients_anonymized"].count_documents(
            {"tenant_id": self.tenant_id, "rx_value_total": {"$gt": 0}})
        higher = await self._db["patients_anonymized"].count_documents(
            {"tenant_id": self.tenant_id, "rx_value_total": {"$gt": pa.get("rx_value_total", 0)}})
        rank = higher + 1
        r = rank / total_pat if total_pat else 1
        tier = ("platinum" if r <= 0.05 else "gold" if r <= 0.15
                else "silver" if r <= 0.35 else "bronze")

        ls = pa.get("last_seen_at")
        gap_days = (now - ls).days if isinstance(ls, datetime) else None
        return jsonsafe({
            "found": True,
            "patient": {"id": str(pid), "name": mask_name(pa.get("full_name"), self.demo),
                        "amka": mask_amka(pa.get("amka"), self.demo),
                        "age_group": pa.get("age_group"), "sex": pa.get("sex"),
                        "area": pa.get("residence_area"), "birth_year": pa.get("birth_year"),
                        "lifecycle": pa.get("lifecycle"), "deceased": bool(pa.get("deceased")),
                        "first_seen": pa.get("first_seen_at"), "last_seen": ls, "gap_days": gap_days},
            # GDPR: σε demo/περιορισμένο χρήστη μηδενίζουμε τα στοιχεία επικοινωνίας
            "contact": {"mobile": None if self.demo else ct.get("mobile"),
                        "phone": None if self.demo else ct.get("phone"),
                        "email": None if self.demo else ct.get("email"),
                        "consent": bool(ct.get("marketing_consent")),
                        "active": ct.get("active", True),
                        "has_contact": (not self.demo) and bool(ct.get("mobile") or ct.get("phone") or ct.get("email"))},
            "financials": {"rx_count": rx_count, "value": value, "claimed": claimed, "paid": paid,
                           "profit": value - cost,
                           "avg_per_visit": round(value / rx_count) if rx_count else 0},
            "vip": {"tier": tier, "rank": rank, "of": total_pat,
                    "percentile": round((1 - r) * 100), "value": pa.get("rx_value_total", 0)},
            "adherence": {"compliance": compliance,
                          "band": _band(compliance)[1] if compliance is not None else None,
                          "executed": executed, "expected": expected, "missed": missed,
                          "available": available, "lost_value": round(recoverable),
                          "next_open": next_open},
            "missed_items": missed_items, "available_items": available_items, "flu": flu,
            "clinical": {"g6pd_deficiency": bool(ct.get("g6pd_deficiency"))},
            "segments": segments, "conditions": conditions,
            "medicines": medicines[:15], "doctors": doctors, "executions": executions,
        })

    # ── pharmacist notes / comments on a patient («σχόλια πελάτη») ───────────
    async def _patient_by_amka(self, amka: str):
        return await self._db["patients_anonymized"].find_one(
            {"tenant_id": self.tenant_id, "amka": (amka or "").strip()})

    async def list_notes(self, amka: str) -> list[dict]:
        pa = await self._patient_by_amka(amka)
        if not pa:
            return []
        rows = [n async for n in self._db["patient_notes"].find(
            {"tenant_id": self.tenant_id, "patient_ref": pa["_id"]}).sort("at", -1).limit(200)]
        return jsonsafe([{"id": str(n["_id"]), "text": n.get("text"), "by": n.get("by"),
                          "at": n.get("at")} for n in rows])

    async def add_note(self, amka: str, text: str, by: str | None = None) -> dict:
        pa = await self._patient_by_amka(amka)
        if not pa:
            return {"ok": False, "error": "patient_not_found"}
        text = (text or "").strip()[:2000]
        if not text:
            return {"ok": False, "error": "empty"}
        res = await self._db["patient_notes"].insert_one({
            "tenant_id": self.tenant_id, "patient_ref": pa["_id"], "text": text,
            "by": by, "at": _now()})
        return {"ok": True, "id": str(res.inserted_id)}

    async def delete_note(self, note_id: str) -> dict:
        from bson import ObjectId
        try:
            oid = ObjectId(note_id)
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": "bad_id"}
        await self._db["patient_notes"].delete_one({"_id": oid, "tenant_id": self.tenant_id})
        return {"ok": True}

    async def set_g6pd(self, amka: str, value: bool) -> dict:
        """Pharmacist-set clinical flag: G6PD enzyme deficiency. Stored in the protected
        patient_contacts doc (survives ΗΔΥΚΑ re-ingest); fed to the AI advice."""
        pa = await self._patient_by_amka(amka)
        if not pa:
            return {"ok": False, "error": "patient_not_found"}
        await self._db["patient_contacts"].update_one(
            {"tenant_id": self.tenant_id, "_id": pa["_id"]},
            {"$set": {"tenant_id": self.tenant_id, "g6pd_deficiency": bool(value), "updated_at": _now()}},
            upsert=True)
        return {"ok": True, "g6pd_deficiency": bool(value)}

    # ── 9. SEGMENTATION ─────────────────────────────────────────────────────
    async def segments(self) -> dict:
        out = []
        for seg in SEGMENTS:
            regex = "^(" + "|".join(seg["atc"]) + ")"
            rows = await self._db["prescription_executions"].aggregate([
                {"$match": {"tenant_id": self.tenant_id}},
                {"$lookup": {"from": "prescription_items", "localField": "_id",
                             "foreignField": "execution_id", "as": "it"}},
                {"$unwind": "$it"},
                {"$lookup": {"from": "products", "localField": "it.product_id",
                             "foreignField": "_id", "as": "p"}},
                {"$set": {"atc": {"$toUpper": {"$ifNull": [{"$first": "$p.atc"}, ""]}}}},
                {"$match": {"atc": {"$regex": regex}}},
                {"$group": {"_id": "$patient_ref", "value": {"$sum": "$amount_total"}}},
            ]).to_list(None)
            out.append({"key": seg["key"], "label": seg["label"], "en": seg["en"],
                        "patients": len(rows), "value": round(sum(r["value"] for r in rows))})
        out.sort(key=lambda s: s["patients"], reverse=True)
        return jsonsafe({"segments": out})

    # ── 3. COMPLIANCE ───────────────────────────────────────────────────────
    def _compliance_dist(self, chain: dict) -> list[dict]:
        counts: dict = defaultdict(int)
        for c in chain.values():
            if c.get("compliance") is None:
                continue
            key, _ = _band(c["compliance"])
            counts[key] += 1
        order = [("excellent", "Άριστη"), ("good", "Καλή"), ("medium", "Μέτρια"),
                 ("risk", "Ρίσκο"), ("critical", "Κρίσιμη")]
        return [{"band": k, "label": lbl, "count": counts.get(k, 0)} for k, lbl in order]

    async def compliance(self) -> dict:
        pats = {p["_id"]: p for p in await self._patients()}
        chain = await self._chain_analysis()
        items = []
        for pref, c in chain.items():
            if c.get("compliance") is None or pref not in pats:   # θανών/εξαιρεθείς → εκτός
                continue
            band, label = _band(c["compliance"])
            pa = pats.get(pref, {})
            items.append({
                "patient_id": str(pref), "name": pa.get("full_name"), "amka": pa.get("amka"),
                "compliance": c["compliance"], "band": band, "band_label": label,
                "executed": c["executed"], "expected": c["expected"], "missed": c["missed"],
                "value": pa.get("rx_value_total", 0),
            })
        items.sort(key=lambda x: x["compliance"])
        return jsonsafe({"distribution": self._compliance_dist(chain), "items": mask_rows(items[:400], self.demo)})

    # ── TODAY (live daily operations) ───────────────────────────────────────
    async def today(self) -> dict:
        db = self._db
        now = _now()
        tstart = now.replace(hour=0, minute=0, second=0, microsecond=0)
        tend = tstart + timedelta(days=1)
        match = {"tenant_id": self.tenant_id, "executed_at": {"$gte": tstart, "$lt": tend}}
        # latest execution + last sync (for the "as of" / freshness hint, esp. on a quiet morning)
        latest = await db["prescription_executions"].find_one(
            {"tenant_id": self.tenant_id}, sort=[("executed_at", -1)], projection={"executed_at": 1})
        last_activity = latest.get("executed_at") if latest else None
        last_job = await db["sync_jobs"].find_one(
            {"tenant_id": self.tenant_id, "source": "HDIKA"}, sort=[("finished_at", -1)])
        last_sync = (last_job or {}).get("finished_at") or (last_job or {}).get("started_at")

        tot = await db["prescription_executions"].aggregate([
            {"$match": match},
            {"$group": {"_id": None, "rx": {"$sum": 1}, "value": {"$sum": "$amount_total"},
                        "patients": {"$addToSet": "$patient_ref"}}},
        ]).to_list(1)
        t0 = tot[0] if tot else {}
        day_rx, day_value = t0.get("rx", 0), t0.get("value", 0)
        day_patients = len(t0.get("patients", []) or [])

        # YoY: SAME day last year, time-aligned (midnight→same moment) so a half-day isn't
        # compared to a full one. executed_at carries Athens local time, like `now`.
        yday = await db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id,
                        "executed_at": {"$gte": _yago(tstart), "$lt": _yago(now)}}},
            {"$group": {"_id": None, "rx": {"$sum": 1}, "value": {"$sum": "$amount_total"}}},
        ]).to_list(1)
        y0 = yday[0] if yday else {}
        rx_yoy, value_yoy = y0.get("rx", 0), y0.get("value", 0)

        bh = await db["prescription_executions"].aggregate([
            {"$match": match},
            {"$group": {"_id": {"$hour": "$executed_at"}, "rx": {"$sum": 1}, "value": {"$sum": "$amount_total"}}},
            {"$sort": {"_id": 1}},
        ]).to_list(None)
        by_hour = [{"hour": r["_id"], "rx": r["rx"], "value": r["value"]} for r in bh]

        cats = await db["prescription_executions"].aggregate([
            {"$match": match},
            {"$lookup": {"from": "prescription_items", "localField": "_id", "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$group": {"_id": "$it.category", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
        ]).to_list(None)
        categories = [{"category": (r["_id"] or "—"), "count": r["n"]} for r in cats]

        meds = await db["prescription_executions"].aggregate([
            {"$match": match},
            {"$lookup": {"from": "prescription_items", "localField": "_id", "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$lookup": {"from": "products", "localField": "it.product_id", "foreignField": "_id", "as": "p"}},
            {"$group": {"_id": {"$first": "$p.name"}, "n": {"$sum": 1}}},
            {"$sort": {"n": -1}}, {"$limit": 8},
        ]).to_list(None)
        top_meds = [{"name": r["_id"], "count": r["n"]} for r in meds if r["_id"]]

        # NEW today = patient whose first-EVER execution we hold falls today (never executed before)
        new_rows = await db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id}},
            {"$group": {"_id": "$patient_ref", "first": {"$min": "$executed_at"}}},
            {"$match": {"first": {"$gte": tstart, "$lt": tend}}},
            {"$count": "n"},
        ]).to_list(1)
        new_today = new_rows[0]["n"] if new_rows else 0

        d30 = await db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": tstart - timedelta(days=30), "$lt": tstart}}},
            {"$group": {"_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$executed_at"}}, "rx": {"$sum": 1}}},
        ]).to_list(None)
        avg_day = round(sum(r["rx"] for r in d30) / len(d30)) if d30 else 0

        # expected but not arrived: overdue + pending repeats (backlog), and due this week
        overdue = await db["future_prescriptions"].count_documents(
            {"tenant_id": self.tenant_id, "status": "pending", "expected_open_date": {"$lte": now}})
        week = await db["future_prescriptions"].count_documents(
            {"tenant_id": self.tenant_id, "status": "pending",
             "expected_open_date": {"$gte": now - timedelta(days=7), "$lte": now}})

        # ΗΔΥΚΑ executed_at carries Athens local time → current hour must be Athens too, or the
        # live axis cap would hide today's (afternoon) executions.
        from zoneinfo import ZoneInfo
        athens_hour = now.astimezone(ZoneInfo("Europe/Athens")).hour
        return jsonsafe({
            "day": tstart.date().isoformat(), "is_live": True, "current_hour": athens_hour,
            "last_activity": last_activity, "last_sync": last_sync,
            "rx": day_rx, "value": day_value, "patients": day_patients, "new_patients": new_today,
            "avg_day_rx": avg_day, "vs_avg": _pct(day_rx, avg_day),
            "rx_yoy": rx_yoy, "value_yoy": value_yoy,
            "vs_yoy_rx": _pct(day_rx, rx_yoy), "vs_yoy_value": _pct(day_value, value_yoy),
            "by_hour": by_hour, "categories": categories, "top_meds": top_meds,
            "expected_absent": overdue, "expected_week": week,
        })

    # ── 2. PATIENT ANALYTICS ────────────────────────────────────────────────
    async def patients_table(self, *, sort: str = "value", limit: int = 300) -> dict:
        pats = await self._patients()
        now = _now()
        items = []
        for p in pats:
            fs, ls = p.get("first_seen_at"), p.get("last_seen_at")
            tenure_days = (ls - fs).days if isinstance(fs, datetime) and isinstance(ls, datetime) else 0
            rx = p.get("rx_count", 0) or 0
            freq = round(rx / (tenure_days / 30), 1) if tenure_days >= 30 else rx
            items.append({
                "patient_id": str(p["_id"]), "name": p.get("full_name"), "amka": p.get("amka"),
                "age_group": p.get("age_group"), "sex": p.get("sex"), "area": p.get("residence_area"),
                "rx_count": rx, "value": p.get("rx_value_total", 0),
                "avg_value": round(p.get("rx_value_total", 0) / rx) if rx else 0,
                "last_seen": ls, "first_seen": fs, "frequency": freq, "ltv": p.get("rx_value_total", 0),
                "gap_days": (now - ls).days if isinstance(ls, datetime) else None,
            })
        key = {"value": "value", "rx": "rx_count", "frequency": "frequency", "recent": "gap_days"}.get(sort, "value")
        items.sort(key=lambda x: (x[key] is None, x[key]), reverse=(sort != "recent"))
        return jsonsafe({"items": mask_rows(items[:limit], self.demo), "total": len(pats)})

    # ── 10. AI INSIGHTS ─────────────────────────────────────────────────────
    def _ai_insights(self, kpis, recall_patients, recall_recoverable, winback_revenue, chain, pats) -> list[dict]:
        out = []
        if recall_patients:
            out.append({"icon": "phone-call", "severity": "opportunity",
                        "title": "Ασθενείς προς ανάκτηση",
                        "text": f"Έχετε {recall_patients} ασθενείς με καθυστερημένη/διαθέσιμη ανανέωση θεραπείας. "
                                f"Η πιθανή αξία ανάκτησης εκτιμάται σε €{eur_gr(recall_recoverable)}.",
                        "cta": {"label": "Recall Center", "href": "/intelligence/recall"}})
        if winback_revenue:
            out.append({"icon": "rotate-ccw", "severity": "opportunity",
                        "title": "Δυνητικός τζίρος επανενεργοποίησης",
                        "text": f"Από ανενεργούς ασθενείς εκτιμάται ανακτήσιμος τζίρος €{eur_gr(winback_revenue)}.",
                        "cta": {"label": "Win-Back Center", "href": "/intelligence/winback"}})
        crit = sum(1 for c in chain.values() if c.get("compliance") is not None and c["compliance"] < 25)
        if crit:
            out.append({"icon": "alert-triangle", "severity": "critical",
                        "title": "Κρίσιμη συμμόρφωση",
                        "text": f"{crit} ασθενείς έχουν κρίσιμα χαμηλό compliance (<25%) — υψηλός κίνδυνος διακοπής θεραπείας.",
                        "cta": {"label": "Compliance", "href": "/intelligence/compliance"}})
        if kpis["new_month"]["value"]:
            out.append({"icon": "user-plus", "severity": "positive",
                        "title": "Νέοι ασθενείς",
                        "text": f"{kpis['new_month']['value']} νέοι ασθενείς αυτόν τον μήνα.",
                        "cta": None})
        return out
