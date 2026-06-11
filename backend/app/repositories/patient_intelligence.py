"""RxVision Patient Intelligence — turns prescription data into patient-level business
intelligence: KPIs, compliance scoring, recall, win-back, VIP tiers, risk detection,
revenue opportunities, segmentation and AI insights.

Leverages the rich `patients_anonymized` profile (lifecycle / rx_count / rx_value_total /
last_seen) + the ΗΔΙΚΑ repeat chains (repeat_root windows). One chain pass feeds compliance +
recall + win-back-recoverable; patient aggregates feed the rest.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from app.repositories.base import BaseRepository, jsonsafe


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _addm(d: datetime, n: int) -> datetime:
    y, mo = d.year + (d.month - 1 + n) // 12, (d.month - 1 + n) % 12 + 1
    return d.replace(year=y, month=mo, day=min(d.day, calendar.monthrange(y, mo)[1]))


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
        return [p async for p in self._db["patients_anonymized"].find({"tenant_id": self.tenant_id})]

    # ── 1. DASHBOARD overview ───────────────────────────────────────────────
    async def overview(self) -> dict:
        now = _now()
        d30, d60 = now - timedelta(days=30), now - timedelta(days=60)
        mstart = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        pmstart = _addm(mstart, -1)
        pats = await self._patients()
        chain = await self._chain_analysis()

        def seen_after(p, dt):
            ls = p.get("last_seen_at")
            return isinstance(ls, datetime) and ls >= dt

        active30 = sum(1 for p in pats if seen_after(p, d30))
        active30_prev = sum(1 for p in pats if (isinstance(p.get("last_seen_at"), datetime) and d60 <= p["last_seen_at"] < d30))
        new_month = sum(1 for p in pats if isinstance(p.get("first_seen_at"), datetime) and p["first_seen_at"] >= mstart)
        new_prev = sum(1 for p in pats if isinstance(p.get("first_seen_at"), datetime) and pmstart <= p["first_seen_at"] < mstart)
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
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": pmstart, "$lt": mstart}}},
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
            "active_30d": {"value": active30, "delta": _pct(active30, active30_prev)},
            "new_month": {"value": new_month, "delta": _pct(new_month, new_prev)},
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
        return jsonsafe({"tiers": self._vip_tiers(pats), "items": items})

    # ── 7. RISK detection ───────────────────────────────────────────────────
    async def risk(self) -> dict:
        pats = {p["_id"]: p for p in await self._patients()}
        chain = await self._chain_analysis()
        now = _now()
        items = []
        for pref, c in chain.items():
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
        return jsonsafe({"items": items[:300], "count": len(items)})

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
            if c.get("compliance") is None:
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
        return jsonsafe({"distribution": self._compliance_dist(chain), "items": items[:400]})

    # ── TODAY (live daily operations) ───────────────────────────────────────
    async def today(self) -> dict:
        db = self._db
        now = _now()
        tstart = now.replace(hour=0, minute=0, second=0, microsecond=0)
        # active day = today if it has activity, else the latest day with data (demo-friendly)
        if not await db["prescription_executions"].count_documents(
                {"tenant_id": self.tenant_id, "executed_at": {"$gte": tstart}}):
            last = await db["prescription_executions"].find_one(
                {"tenant_id": self.tenant_id}, sort=[("executed_at", -1)])
            if last and last.get("executed_at"):
                tstart = last["executed_at"].replace(hour=0, minute=0, second=0, microsecond=0)
        tend = tstart + timedelta(days=1)
        is_live = tstart.date() == now.date()
        match = {"tenant_id": self.tenant_id, "executed_at": {"$gte": tstart, "$lt": tend}}

        tot = await db["prescription_executions"].aggregate([
            {"$match": match},
            {"$group": {"_id": None, "rx": {"$sum": 1}, "value": {"$sum": "$amount_total"},
                        "patients": {"$addToSet": "$patient_ref"}}},
        ]).to_list(1)
        t0 = tot[0] if tot else {}
        day_rx, day_value = t0.get("rx", 0), t0.get("value", 0)
        day_patients = len(t0.get("patients", []) or [])

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

        new_today = await db["patients_anonymized"].count_documents(
            {"tenant_id": self.tenant_id, "first_seen_at": {"$gte": tstart, "$lt": tend}})

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

        return jsonsafe({
            "day": tstart.date().isoformat(), "is_live": is_live,
            "rx": day_rx, "value": day_value, "patients": day_patients, "new_patients": new_today,
            "avg_day_rx": avg_day, "vs_avg": _pct(day_rx, avg_day),
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
        return jsonsafe({"items": items[:limit], "total": len(pats)})

    # ── 10. AI INSIGHTS ─────────────────────────────────────────────────────
    def _ai_insights(self, kpis, recall_patients, recall_recoverable, winback_revenue, chain, pats) -> list[dict]:
        out = []
        if recall_patients:
            out.append({"icon": "phone-call", "severity": "opportunity",
                        "title": "Ασθενείς προς ανάκτηση",
                        "text": f"Έχετε {recall_patients} ασθενείς με καθυστερημένη/διαθέσιμη ανανέωση θεραπείας. "
                                f"Η πιθανή αξία ανάκτησης εκτιμάται σε €{recall_recoverable/100:,.0f}.",
                        "cta": {"label": "Recall Center", "href": "/intelligence/recall"}})
        if winback_revenue:
            out.append({"icon": "rotate-ccw", "severity": "opportunity",
                        "title": "Δυνητικός τζίρος επανενεργοποίησης",
                        "text": f"Από ανενεργούς ασθενείς εκτιμάται ανακτήσιμος τζίρος €{winback_revenue/100:,.0f}.",
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
