"""RxVision Reimbursement Intelligence — a digital ΕΟΠΥΥ auditor inside the pharmacy.

Turns the monthly claim/submission/reimbursement cycle into a controlled, data-driven workflow:
monthly closing financials, claim forecast, a per-prescription risk engine, expected-cuts
estimation, a pre-submission audit and an executive dashboard. Computed from the ΗΔΥΚΑ amount
model (amount_total = amount_claimed [fund] + patient_share) — see the hdika-amount-model note.

The optical/OCR half (mobile scan, coupon/QR/signature verification) is a separate subsystem;
scans land in `prescription_scans` and are surfaced in the Optical Audit queue.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timezone

from bson import ObjectId

from app.repositories.base import BaseRepository, jsonsafe
from app.services.reimbursement_finance import deductions
from app.utils.format import eur_gr

# ΕΟΠΥΥ splits into two distinct submissions (φάρμακα vs εμβόλια), per CDA root 1.1.24.
EOPYY_MED = "ΕΟΠΥΥ - Φάρμακα"
EOPYY_VAC = "ΕΟΠΥΥ - Εμβόλια"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _month_bounds(period: str) -> tuple[datetime, datetime]:
    y, m = int(period[:4]), int(period[5:7])
    start = datetime(y, m, 1, tzinfo=timezone.utc)
    end = datetime(y + (m // 12), (m % 12) + 1, 1, tzinfo=timezone.utc)
    return start, end


def _prev_period(period: str) -> str:
    y, m = int(period[:4]), int(period[5:7])
    m -= 1
    if m == 0:
        y, m = y - 1, 12
    return f"{y:04d}-{m:02d}"


def _yoy_period(period: str) -> str:
    return f"{int(period[:4]) - 1:04d}-{period[5:7]}"


def _pct(a: float, b: float) -> float | None:
    return ((a - b) / b * 100) if b else None


# risk weights (data-derivable factors; optical factors add on top once scans exist).
# NOTE: partial execution is NOT a cut reason — the patient may lawfully decline part of the Rx.
RISK_MISMATCH = 40     # amount_claimed + patient_share ≠ amount_total
RISK_NO_FUND = 35      # missing insurer
RISK_HIGH_COST = 15    # high-cost line → extra scrutiny


def _band(score: int) -> str:
    return "critical" if score >= 75 else "high" if score >= 50 else "medium" if score >= 25 else "low"


class ReimbursementRepository(BaseRepository):
    collection_name = "prescription_executions"

    async def _fund_names(self) -> dict:
        return {f["_id"]: f.get("name") or f.get("fund_name") or "—"
                async for f in self._db["insurance_funds"].find({"tenant_id": self.tenant_id})}

    async def _fund_meta(self) -> dict:
        """fund_id → {name, group, is_eopyy} using the admin fund-grouping (the 'ΕΟΠΥΥ' group
        lists every ΕΟΠΥΥ-administered fund). Funds not in any group map to themselves (standalone)."""
        grouping: dict = {}  # fund code → (group_name, is_eopyy)
        async for g in self._db["fund_groups"].find({}):  # tenant-ok: shared platform grouping
            gname = g.get("name") or ""
            is_eo = "ΕΟΠΥΥ" in gname.upper() or "EOPYY" in gname.upper()
            for code in g.get("codes", []):
                grouping[code] = (gname, is_eo)
        out = {}
        async for f in self._db["insurance_funds"].find({"tenant_id": self.tenant_id}):
            name = f.get("name") or f.get("fund_name") or "—"
            code = f.get("code") or name
            # ungrouped funds → ΗΔΥΚΑ SHORT name (the `code`, e.g. «Ο.Α.Ε.Ε.»), not the long official name
            grp, is_eo = grouping.get(code, (code or name, False))
            out[f["_id"]] = {"name": name, "group": grp, "is_eopyy": is_eo}
        return out

    # ── 1. MONTHLY CLOSING ──────────────────────────────────────────────────
    async def _period_money(self, period: str) -> dict:
        start, end = _month_bounds(period)
        rows = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}, "status": {"$ne": "cancelled"}}},
            {"$group": {"_id": None, "rx": {"$sum": 1},
                        "retail": {"$sum": "$amount_total"}, "claim": {"$sum": "$amount_claimed"},
                        "patient": {"$sum": "$patient_share"}, "cost": {"$sum": "$wholesale_cost"}}},
        ]).to_list(1)
        r = rows[0] if rows else {}
        return {"rx": r.get("rx", 0), "retail": r.get("retail", 0), "claim": r.get("claim", 0),
                "patient": r.get("patient", 0), "cost": r.get("cost", 0)}

    def _grp_label(self, meta: dict, fund_id, is_vaccine: bool) -> tuple[str, bool]:
        """Fold a (fund, vaccine?) into a display group. ΕΟΠΥΥ splits φάρμακα/εμβόλια; others keep
        their group name (standalone funds incl. ΕΤΥΑΠ map to themselves)."""
        m = meta.get(fund_id, {"group": "—", "is_eopyy": False})
        if m["is_eopyy"]:
            return (EOPYY_VAC if is_vaccine else EOPYY_MED), True
        return m["group"], False

    async def monthly_closing(self, period: str) -> dict:
        start, end = _month_bounds(period)
        meta = await self._fund_meta()
        # εξαιρούμε ακυρωμένες — το εμπορικό πρόγραμμα στα κλεισίματα δείχνει μόνο ενεργές
        match = {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end},
                 "status": {"$ne": "cancelled"}}

        by_day = [{"day": r["_id"], "rx": r["rx"], "claim": r["claim"]}
                  for r in await self._db["prescription_executions"].aggregate([
                      {"$match": match},
                      {"$group": {"_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$executed_at"}},
                                  "rx": {"$sum": 1}, "claim": {"$sum": "$amount_claimed"}}},
                      {"$sort": {"_id": 1}}]).to_list(None)]

        # per (fund, vaccine?, ΦΥΚ?) so we can split ΕΟΠΥΥ φάρμακα/εμβόλια and isolate the rebate base.
        # «Αμιγώς 100%» (ΔΕΝ υποβάλλονται στο ΕΟΠΥΥ) = συνταγές όπου ΟΛΑ τα φάρμακα έχουν συμμετοχή
        # ασθενή 100% (`details.full_participation=True`). Αν έστω ΕΝΑ φάρμακο <100% (0/10/20/12,5%…) →
        # υποβάλλεται κανονικά. ΔΕΝ κρίνεται από claim==0 (25% μπορεί να έχει claim=0) ούτε από narcotic.
        # Το flag υπολογίζεται στο ingest (_map_full) & backfilled από τα per-item participation_pct.
        # claim ανά ταμείο = ΚΑΘΑΡΟ πρωτεύον (ΕΟΠΥΥ) = amount_claimed − ΚΥΥΑΠ κάλυψη (το ΚΥΥΑΠ κομμάτι
        # εμφανίζεται ΜΟΝΟ στη ξεχωριστή γραμμή «ΕΤΥΑΠ»). ΤΟ ΚΥΥΑΠ ΕΙΝΑΙ ΑΝΑ ΣΥΝΤΑΓΗ (visit), γραμμένο
        # σε ΚΑΘΕ εκτέλεση/είδος → αφαιρείται ΜΙΑ φορά ανά visit (αλλιώς διπλή αφαίρεση σε πολυ-εκτελέσεις).
        by_fund_raw = await self._db["prescription_executions"].aggregate([
            {"$match": {**match, "amount_total": {"$gt": 0},
                        "details.full_participation": {"$ne": True}}},
            {"$group": {"_id": {"fund": "$fund_id",
                                "vac": {"$ifNull": ["$details.vaccines", False]},
                                "fyk": {"$ifNull": ["$details.n3816", False]},
                                "visit": {"$ifNull": ["$details.visit_id", "$_id"]}},
                        "rx": {"$sum": 1}, "retail": {"$sum": "$amount_total"},
                        "amount_claimed": {"$sum": "$amount_claimed"},
                        "kyyap": {"$max": {"$ifNull": ["$details.kyyap_covered", 0]}},
                        "patient": {"$sum": "$patient_share"}}},
            {"$group": {"_id": {"fund": "$_id.fund", "vac": "$_id.vac", "fyk": "$_id.fyk"},
                        "rx": {"$sum": "$rx"}, "retail": {"$sum": "$retail"},
                        "claim": {"$sum": {"$subtract": ["$amount_claimed", "$kyyap"]}},
                        "patient": {"$sum": "$patient"}}},
        ]).to_list(None)
        grouped: dict = defaultdict(lambda: {"rx": 0, "retail": 0, "claim": 0, "patient": 0,
                                             "is_eopyy": False, "is_vaccine": False})
        rebate_base = 0
        for f in by_fund_raw:
            fid, vac, fyk = f["_id"]["fund"], bool(f["_id"]["vac"]), bool(f["_id"]["fyk"])
            label, is_eo = self._grp_label(meta, fid, vac)
            g = grouped[label]
            g["rx"] += f["rx"]; g["retail"] += f["retail"]; g["claim"] += f["claim"]; g["patient"] += f["patient"]
            g["is_eopyy"] = is_eo; g["is_vaccine"] = is_eo and vac
            if is_eo and not vac and not fyk:  # rebate/discount base: ΕΟΠΥΥ φάρμακα, εκτός ΦΥΚ
                rebate_base += f["claim"]
        fin = deductions(rebate_base)

        by_fund = []
        for k, v in grouped.items():
            row = {"fund": k, "is_eopyy": v["is_eopyy"], "is_vaccine": v["is_vaccine"],
                   "rx": v["rx"], "retail": v["retail"], "claim": v["claim"], "patient": v["patient"],
                   "rebate": 0, "discount": 0, "receipt": v["claim"]}
            if k == EOPYY_MED:
                row.update(rebate=fin["rebate"], discount=fin["discount"], rebate_base=fin["base"],
                           receipt=v["claim"] - fin["rebate"] - fin["discount"])
            by_fund.append(row)
        # ΕΤΥΑΠ: secondary-fund coverage (details.kyyap_covered) — a SEPARATE αιτούμενο that
        # contracted pharmacies claim on top of ΕΟΠΥΥ. No rebate/discount, no patient share.
        # kyyap_covered = ποσό ΑΝΑ ΣΥΝΤΑΓΗ (visit), γραμμένο σε ΚΑΘΕ εκτέλεση/είδος της → το αιτούμενο
        # ΕΤΥΑΠ μετριέται ΜΙΑ φορά ανά visit (αλλιώς διπλομέτρηση όταν η συνταγή έχει >1 εκτελέσεις).
        # Το πλήθος (rx) παραμένει σε εκτελέσεις.
        et = await self._db["prescription_executions"].aggregate([
            {"$match": {**match, "details.kyyap_covered": {"$gt": 0}}},
            {"$group": {"_id": {"$ifNull": ["$details.visit_id", "$_id"]},
                        "kyyap": {"$first": "$details.kyyap_covered"}, "n": {"$sum": 1}}},
            {"$group": {"_id": None, "rx": {"$sum": "$n"}, "claim": {"$sum": "$kyyap"}}},
        ]).to_list(1)
        etyap_claim = (et[0]["claim"] if et else 0) or 0
        if etyap_claim > 0:
            by_fund.append({"fund": "ΕΤΥΑΠ", "is_eopyy": False, "is_vaccine": False,
                            "rx": et[0]["rx"], "retail": 0, "claim": etyap_claim, "patient": 0,
                            "rebate": 0, "discount": 0, "receipt": etyap_claim})

        # Αμιγώς 100% συμμετοχή — ΟΛΑ τα φάρμακα 100% συμμετοχή ασθενή (full_participation) → ΔΕΝ
        # υποβάλλονται (κρατούνται στο φαρμακείο). Αν έστω ένα φάρμακο <100% → πάει στο ΕΟΠΥΥ (πάνω).
        h = await self._db["prescription_executions"].aggregate([
            {"$match": {**match, "amount_total": {"$gt": 0}, "details.full_participation": True}},
            {"$group": {"_id": None, "rx": {"$sum": 1}, "retail": {"$sum": "$amount_total"},
                        "patient": {"$sum": "$patient_share"}}},
        ]).to_list(1)
        hundred = {"rx": (h[0]["rx"] if h else 0), "retail": (h[0]["retail"] if h else 0),
                   "patient": (h[0]["patient"] if h else 0)}
        if hundred["rx"]:
            by_fund.append({"fund": "Αμιγώς 100% (δεν υποβάλλονται)", "is_eopyy": False,
                            "is_vaccine": False, "not_submitted": True,
                            "rx": hundred["rx"], "retail": hundred["retail"], "claim": 0,
                            "patient": hundred["patient"], "rebate": 0, "discount": 0, "receipt": 0})

        by_fund.sort(key=lambda x: x["claim"], reverse=True)
        eopyy_claim = sum(b["claim"] for b in by_fund if b["is_eopyy"])
        other_claim = sum(b["claim"] for b in by_fund if not b["is_eopyy"])

        # executions ανά ταμείο ανά ημέρα (replaces the old by-category chart)
        by_fd_raw = await self._db["prescription_executions"].aggregate([
            {"$match": match},
            {"$group": {"_id": {"day": {"$dateToString": {"format": "%d", "date": "$executed_at"}},
                                "fund": "$fund_id",
                                "vac": {"$ifNull": ["$details.vaccines", False]}},
                        "rx": {"$sum": 1}}},
        ]).to_list(None)
        day_map: dict = defaultdict(lambda: defaultdict(int))
        fund_tot: dict = defaultdict(int)
        for r in by_fd_raw:
            label, _ = self._grp_label(meta, r["_id"]["fund"], bool(r["_id"]["vac"]))
            day_map[r["_id"]["day"]][label] += r["rx"]
            fund_tot[label] += r["rx"]
        top = [f for f, _ in sorted(fund_tot.items(), key=lambda x: -x[1])][:6]
        fd_rows = []
        spilled = False
        for day in sorted(day_map):
            counts: dict = defaultdict(int)
            total = 0
            for label, n in day_map[day].items():
                key = label if label in top else "Λοιπά"
                spilled = spilled or key == "Λοιπά"
                counts[key] += n
                total += n
            fd_rows.append({"day": day, "counts": dict(counts), "total": total})
        by_fund_day = {"funds": top + (["Λοιπά"] if spilled else []), "rows": fd_rows}

        cur = await self._period_money(period)
        prev = await self._period_money(_prev_period(period))
        yoy = await self._period_money(_yoy_period(period))
        return jsonsafe({
            "period": period,
            "totals": {**cur, "net_claim": cur["claim"], "eopyy_claim": eopyy_claim,
                       "other_claim": other_claim, "gross_profit": cur["retail"] - cur["cost"],
                       "rebate": fin["rebate"], "discount": fin["discount"], "etyap": etyap_claim,
                       "rebate_base": fin["base"], "hundred_rx": hundred["rx"], "hundred_retail": hundred["retail"],
                       # cur["claim"] (=Σ amount_claimed) ΠΕΡΙΕΧΕΙ ήδη το ΚΥΥΑΠ → ΔΕΝ ξαναπροσθέτουμε etyap
                       # (αλλιώς διπλομέτρημα). Είσπραξη = συνολικό αιτούμενο − rebate − έκπτωση.
                       "receipt": cur["claim"] - fin["rebate"] - fin["discount"]},
            "deductions": fin,  # base + per-bracket breakdown → KPI tooltip shows the formula
            "delta_prev": {k: _pct(cur[k], prev[k]) for k in ("rx", "retail", "claim", "patient")},
            "delta_yoy": {k: _pct(cur[k], yoy[k]) for k in ("rx", "retail", "claim", "patient")},
            "by_day": by_day, "by_fund": by_fund, "by_fund_day": by_fund_day,
        })

    @staticmethod
    def _invoice_line(row: dict) -> dict:
        """Οδηγία ΤΙΜΟΛΟΓΙΟΥ ανά ταμείο — τι Τ.Π.Υ. πρέπει να εκδώσει το φαρμακείο."""
        c = row.get("claim", 0) or 0
        if row.get("not_submitted"):
            return {"issue": False,
                    "text": "ΔΕΝ εκδίδεται τιμολόγιο ταμείου — κρατιέται στο φαρμακείο (100% συμμετοχή ασθενή)."}
        if row["fund"] == EOPYY_MED:
            net = row.get("receipt", c)
            return {"issue": True, "amount": net,
                    "text": (f"Τιμολόγιο προς ΕΟΠΥΥ (Φάρμακα): αιτούμενο €{eur_gr(c, 2)} − Rebate €{eur_gr(row.get('rebate', 0), 2)} "
                             f"− Έκπτωση τζίρου €{eur_gr(row.get('discount', 0), 2)} = καθαρό €{eur_gr(net, 2)}.")}
        if row["fund"] == EOPYY_VAC:
            return {"issue": True, "amount": c, "text": f"Τιμολόγιο προς ΕΟΠΥΥ (Εμβόλια): €{eur_gr(c, 2)} (χωρίς rebate/έκπτωση)."}
        if row["fund"] == "ΕΤΥΑΠ":
            return {"issue": True, "amount": c, "text": f"Τιμολόγιο προς ΕΤΥΑΠ (συμπληρωματική κάλυψη): €{eur_gr(c, 2)}."}
        return {"issue": True, "amount": c, "text": f"Τιμολόγιο προς {row['fund']}: €{eur_gr(c, 2)}."}

    async def closing_report(self, period: str) -> dict:
        """Αναλυτική εκτύπωση/άποψη κλεισίματος: ΑΝΑ ΤΑΜΕΙΟ × ΑΝΑ ΗΜΕΡΑ (πλήθος + αιτούμενο + λιανική +
        συμμετοχή), σύνολα ανά ταμείο, οδηγία ΤΙΜΟΛΟΓΙΟΥ ανά ταμείο, γενικό σύνολο. Ζωντανό — δουλεύει
        για τον τρέχοντα μήνα χωρίς να «κλείσει». Ίδιο κριτήριο υποβολής με το monthly_closing."""
        closing = await self.monthly_closing(period)
        start, end = _month_bounds(period)
        meta = await self._fund_meta()
        match = {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end},
                 "status": {"$ne": "cancelled"}}
        perfund: dict = defaultdict(lambda: defaultdict(lambda: {"rx": 0, "claim": 0, "retail": 0, "patient": 0}))
        # ΥΠΟΒΑΛΛΟΜΕΝΕΣ ανά (ταμείο, ημέρα)· claim = ΚΑΘΑΡΟ πρωτεύον (− ΚΥΥΑΠ)
        # claim = ΚΑΘΑΡΟ πρωτεύον (− ΚΥΥΑΠ)· το ΚΥΥΑΠ ανά ΣΥΝΤΑΓΗ (visit) → αφαιρείται ΜΙΑ φορά ανά visit
        for r in await self._db["prescription_executions"].aggregate([
            {"$match": {**match, "amount_total": {"$gt": 0}, "details.full_participation": {"$ne": True}}},
            {"$group": {"_id": {"fund": "$fund_id", "vac": {"$ifNull": ["$details.vaccines", False]},
                                "day": {"$dateToString": {"format": "%Y-%m-%d", "date": "$executed_at"}},
                                "visit": {"$ifNull": ["$details.visit_id", "$_id"]}},
                        "rx": {"$sum": 1}, "retail": {"$sum": "$amount_total"},
                        "amount_claimed": {"$sum": "$amount_claimed"},
                        "kyyap": {"$max": {"$ifNull": ["$details.kyyap_covered", 0]}},
                        "patient": {"$sum": "$patient_share"}}},
            {"$group": {"_id": {"fund": "$_id.fund", "vac": "$_id.vac", "day": "$_id.day"},
                        "rx": {"$sum": "$rx"}, "retail": {"$sum": "$retail"},
                        "claim": {"$sum": {"$subtract": ["$amount_claimed", "$kyyap"]}},
                        "patient": {"$sum": "$patient"}}},
        ]).to_list(None):
            label, _ = self._grp_label(meta, r["_id"]["fund"], bool(r["_id"]["vac"]))
            e = perfund[label][r["_id"]["day"]]
            for k in ("rx", "claim", "retail", "patient"):
                e[k] += r[k]
        # ΕΤΥΑΠ (ΚΥΥΑΠ κάλυψη — δευτερεύουσα υποβολή) ανά ημέρα
        # ΕΤΥΑΠ ανά ημέρα: το kyyap μετριέται ΜΙΑ φορά ανά ΣΥΝΤΑΓΗ (visit) — dedup· πλήθος σε εκτελέσεις.
        for r in await self._db["prescription_executions"].aggregate([
            {"$match": {**match, "details.kyyap_covered": {"$gt": 0}}},
            {"$group": {"_id": {"visit": {"$ifNull": ["$details.visit_id", "$_id"]},
                                "day": {"$dateToString": {"format": "%Y-%m-%d", "date": "$executed_at"}}},
                        "kyyap": {"$first": "$details.kyyap_covered"}, "n": {"$sum": 1}}},
            {"$group": {"_id": "$_id.day", "rx": {"$sum": "$n"}, "claim": {"$sum": "$kyyap"}}},
        ]).to_list(None):
            e = perfund["ΕΤΥΑΠ"][r["_id"]]
            e["rx"] += r["rx"]; e["claim"] += r["claim"]
        # Αμιγώς-100% ανά ημέρα (ενημερωτικά — δεν υποβάλλονται)
        for r in await self._db["prescription_executions"].aggregate([
            {"$match": {**match, "amount_total": {"$gt": 0}, "details.full_participation": True}},
            {"$group": {"_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$executed_at"}},
                        "rx": {"$sum": 1}, "retail": {"$sum": "$amount_total"}, "patient": {"$sum": "$patient_share"}}},
        ]).to_list(None):
            e = perfund["Αμιγώς 100% (δεν υποβάλλονται)"][r["_id"]]
            e["rx"] += r["rx"]; e["retail"] += r["retail"]; e["patient"] += r["patient"]
        funds_out = []
        for row in closing["by_fund"]:
            days = sorted(perfund.get(row["fund"], {}).items())
            funds_out.append({**row, "invoice": self._invoice_line(row),
                              "days": [{"date": d, **v} for d, v in days]})
        submitted = [f for f in closing["by_fund"] if not f.get("not_submitted")]
        grand = {"rx": sum(f["rx"] for f in submitted), "claim": sum(f["claim"] for f in submitted),
                 "retail": sum(f["retail"] for f in submitted),
                 "receipt": sum(f.get("receipt", f["claim"]) for f in submitted)}
        return jsonsafe({"period": period, "funds": funds_out, "grand": grand, "totals": closing["totals"]})

    # ── 2. CLAIM FORECAST ───────────────────────────────────────────────────
    async def _period_group_claims_split(self, period: str) -> dict:
        """{group → {claim, claim_reb, rx, is_eopyy, is_vaccine}} for one month, ΕΟΠΥΥ split
        φάρμακα/εμβόλια. `claim_reb` = the rebatable base (ΕΟΠΥΥ φάρμακα ΕΚΤΟΣ ΦΥΚ)."""
        start, end = _month_bounds(period)
        meta = await self._fund_meta()
        agg = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}, "status": {"$ne": "cancelled"}}},
            {"$group": {"_id": {"fund": "$fund_id",
                                "vac": {"$ifNull": ["$details.vaccines", False]},
                                "fyk": {"$ifNull": ["$details.n3816", False]}},
                        "claim": {"$sum": "$amount_claimed"}, "rx": {"$sum": 1}}},
        ]).to_list(None)
        out: dict = defaultdict(lambda: {"claim": 0, "claim_reb": 0, "rx": 0,
                                         "is_eopyy": False, "is_vaccine": False})
        for a in agg:
            vac, fyk = bool(a["_id"]["vac"]), bool(a["_id"]["fyk"])
            label, is_eo = self._grp_label(meta, a["_id"]["fund"], vac)
            o = out[label]
            o["claim"] += a["claim"]; o["rx"] += a["rx"]
            o["is_eopyy"] = is_eo; o["is_vaccine"] = is_eo and vac
            if is_eo and not vac and not fyk:  # rebatable base excludes ΦΥΚ
                o["claim_reb"] += a["claim"]
        return dict(out)

    async def forecast(self) -> dict:
        """Per-fund forecast of the CURRENT month's αιτούμενο using the pharmacist's method:
          Α = avg of the last 3 months · Β = avg of the SAME 3 months last year ·
          Γ = the corresponding month last year · Δ = (Γ−Β)/Β (last-year seasonal deviation) ·
          Forecast = Α × (1+Δ). Then rebate/discount → expected receipt (ΕΟΠΥΥ-Φάρμακα only)."""
        now = _now()
        target = f"{now.year:04d}-{now.month:02d}"

        def minus(period: str, k: int) -> str:
            y, m = int(period[:4]), int(period[5:7])
            for _ in range(k):
                m -= 1
                if m == 0:
                    y, m = y - 1, 12
            return f"{y:04d}-{m:02d}"

        a_months = [minus(target, i) for i in (1, 2, 3)]
        b_months = [_yoy_period(p) for p in a_months]
        target_ly = _yoy_period(target)
        needed = set(a_months) | set(b_months) | {target_ly}
        claims = {p: await self._period_group_claims_split(p) for p in needed}

        labels: set = set()
        for p in needed:
            labels |= set(claims[p].keys())
        rows = []
        for label in labels:
            def cl(p: str, key: str = "claim") -> int:
                return claims[p].get(label, {}).get(key, 0)
            info = next((claims[p][label] for p in needed if label in claims[p]), {})
            a_val = sum(cl(p) for p in a_months) / 3
            b_val = sum(cl(p) for p in b_months) / 3
            g_val = cl(target_ly)
            dev = ((g_val - b_val) / b_val) if b_val > 0 else 0.0
            fc = round(a_val * (1 + dev))
            # rebate/discount only on ΕΟΠΥΥ-Φάρμακα, computed on the rebatable base (excl. ΦΥΚ),
            # scaled by the same seasonal deviation.
            if label == EOPYY_MED:
                reb_base = round((sum(cl(p, "claim_reb") for p in a_months) / 3) * (1 + dev))
                ded = deductions(reb_base)
            else:
                ded = {"rebate": 0, "discount": 0}
            rows.append({
                "fund": label, "is_eopyy": info.get("is_eopyy", False),
                "is_vaccine": info.get("is_vaccine", False),
                "avg_3m": round(a_val), "avg_3m_ly": round(b_val), "ly_month": g_val,
                "deviation": dev, "forecast": fc,
                "rebate": ded["rebate"], "discount": ded["discount"],
                "receipt": fc - ded["rebate"] - ded["discount"]})
        rows.sort(key=lambda x: x["forecast"], reverse=True)
        return jsonsafe({
            "target": target, "a_months": a_months, "b_months": b_months, "ly_month": target_ly,
            "by_fund": rows,
            "forecast_total": sum(r["forecast"] for r in rows),
            "receipt_total": sum(r["receipt"] for r in rows),
            "rebate_total": sum(r["rebate"] for r in rows),
            "discount_total": sum(r["discount"] for r in rows)})

    # ── 5. RISK ENGINE + 6. EXPECTED CUTS + 3. AUDIT ────────────────────────
    async def _risk_rows(self, period: str) -> list[dict]:
        start, end = _month_bounds(period)
        rows = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}, "status": {"$ne": "cancelled"}}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
        ]).to_list(None)
        out = []
        for e in rows:
            score = 0
            flags = []
            retail, claim, patient = e.get("amount_total", 0), e.get("amount_claimed", 0), e.get("patient_share", 0)
            if abs((claim + patient) - retail) > 2:  # >2 cents → real mismatch
                score += RISK_MISMATCH; flags.append("amount_mismatch")
            if not e.get("fund_id"):
                score += RISK_NO_FUND; flags.append("missing_fund")
            if any((it.get("category") == "high_cost") for it in e.get("it", [])):
                score += RISK_HIGH_COST; flags.append("high_cost")
            score = min(score, 100)
            # expected cut: claim-at-risk weighted by score (capped)
            cut = round(claim * min(score, 80) / 100)
            out.append({"external_id": e.get("external_id"), "executed_at": e.get("executed_at"),
                        "fund_id": e.get("fund_id"), "claim": claim, "score": score,
                        "band": _band(score), "flags": flags, "expected_cut": cut})
        return out

    async def risk(self, period: str) -> dict:
        rows = await self._risk_rows(period)
        names = await self._fund_names()
        dist = defaultdict(int)
        for r in rows:
            dist[r["band"]] += 1
        items = sorted([r for r in rows if r["score"] >= 25], key=lambda x: x["expected_cut"], reverse=True)
        for r in items:
            r["fund"] = names.get(r["fund_id"], "—")
        return jsonsafe({
            "distribution": [{"band": b, "count": dist.get(b, 0)} for b in ("low", "medium", "high", "critical")],
            "items": [{k: r[k] for k in ("external_id", "executed_at", "fund", "claim", "score", "band", "flags", "expected_cut")} for r in items[:400]],
            "total_at_risk": sum(r["expected_cut"] for r in rows),
        })

    async def expected_cuts(self, period: str) -> dict:
        rows = await self._risk_rows(period)
        names = await self._fund_names()
        by_flag: dict = defaultdict(lambda: {"count": 0, "cut": 0})
        by_fund: dict = defaultdict(lambda: {"count": 0, "cut": 0})
        for r in rows:
            if not r["expected_cut"]:
                continue
            for f in r["flags"]:
                by_flag[f]["count"] += 1
                by_flag[f]["cut"] += r["expected_cut"]
            by_fund[r["fund_id"]]["count"] += 1
            by_fund[r["fund_id"]]["cut"] += r["expected_cut"]
        return jsonsafe({
            "total": sum(r["expected_cut"] for r in rows),
            "by_reason": [{"reason": k, **v} for k, v in sorted(by_flag.items(), key=lambda x: -x[1]["cut"])],
            "by_fund": [{"fund": names.get(k, "—"), **v} for k, v in sorted(by_fund.items(), key=lambda x: -x[1]["cut"])],
        })

    # ── 7. SUBMISSION CONTROL + 8. AUDIT TRAIL + 9. RECONCILIATION ──────────
    # Workflow at the monthly per-fund batch level (how pharmacies actually submit).
    STATUSES = ("draft", "ready_for_review", "ready_for_submission", "submitted",
                "received", "approved", "paid", "cut", "rejected")

    def _batch_id(self, period: str, fund_id) -> str:
        return f"{self.tenant_id}:{period}:{fund_id}"

    async def _log(self, batch_id: str, period: str, fund_id, action: str,
                   frm: str | None, to: str | None, note: str | None = None) -> None:
        await self._db["claim_events"].insert_one({
            "tenant_id": self.tenant_id, "batch_id": batch_id, "period": period,
            "fund_id": fund_id, "action": action, "from_status": frm, "to_status": to,
            "note": note, "at": _now()})

    async def submission(self, period: str) -> dict:
        """Per-fund submission batches for a month — auto-synced from executions (financials/rx),
        status/payment preserved. Plus a risk summary per batch."""
        start, end = _month_bounds(period)
        meta = await self._fund_meta()
        agg = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}, "status": {"$ne": "cancelled"}}},
            {"$group": {"_id": "$fund_id", "rx": {"$sum": 1}, "claim": {"$sum": "$amount_claimed"}}},
        ]).to_list(None)
        # fold funds into their group (ΕΟΠΥΥ = one batch, standalone funds separate)
        gagg: dict = defaultdict(lambda: {"rx": 0, "claim": 0, "is_eopyy": False})
        for a in agg:
            m = meta.get(a["_id"], {"group": "—", "is_eopyy": False})
            g = gagg[m["group"]]
            g["rx"] += a["rx"]; g["claim"] += a["claim"]; g["is_eopyy"] = m["is_eopyy"]
        risk_rows = await self._risk_rows(period)
        risk_by_group: dict = defaultdict(lambda: {"flagged": 0, "cut": 0})
        for r in risk_rows:
            if r["score"] >= 25:
                m = meta.get(r["fund_id"], {"group": "—"})
                risk_by_group[m["group"]]["flagged"] += 1
                risk_by_group[m["group"]]["cut"] += r["expected_cut"]

        out = []
        for grp, a in gagg.items():
            bid = self._batch_id(period, grp)
            existing = await self._db["submission_batches"].find_one(
                {"_id": bid, "tenant_id": self.tenant_id})
            doc = {
                "_id": bid, "tenant_id": self.tenant_id, "period": period, "fund_id": grp,
                "fund_name": grp, "is_eopyy": a["is_eopyy"],
                "rx": a["rx"], "expected_claim": a["claim"], "updated_at": _now()}
            if not existing:
                doc["status"] = "ready_for_review"
                await self._db["submission_batches"].insert_one(doc)
                await self._log(bid, period, grp, "created", None, "ready_for_review")
                existing = doc
            else:
                await self._db["submission_batches"].update_one(
                    {"_id": bid, "tenant_id": self.tenant_id},
                    {"$set": {"rx": a["rx"], "expected_claim": a["claim"], "fund_name": grp,
                              "is_eopyy": a["is_eopyy"], "updated_at": _now()}})
            rb = risk_by_group.get(grp, {"flagged": 0, "cut": 0})
            out.append({
                "batch_id": bid, "fund": doc["fund_name"], "is_eopyy": doc["is_eopyy"],
                "rx": a["rx"], "expected_claim": a["claim"],
                "status": existing.get("status", "ready_for_review"),
                "paid_amount": existing.get("paid_amount"), "cut_amount": existing.get("cut_amount"),
                "flagged": rb["flagged"], "risk_cut": rb["cut"],
                "submitted_at": existing.get("submitted_at"), "paid_at": existing.get("paid_at"),
            })
        # χειροκίνητα τιμολόγια (π.χ. Αναλώσιμα e-dapy) — δεν προέρχονται από εκτελέσεις
        async for mb in self._db["submission_batches"].find(
                {"tenant_id": self.tenant_id, "period": period, "manual": True}):
            out.append({
                "batch_id": mb["_id"], "fund": mb.get("fund_name", "Χειροκίνητο τιμολόγιο"),
                "is_eopyy": False, "manual": True, "note": mb.get("note"),
                "rx": 0, "expected_claim": mb.get("expected_claim", 0),
                "status": mb.get("status", "ready_for_review"),
                "paid_amount": mb.get("paid_amount"), "cut_amount": mb.get("cut_amount"),
                "flagged": 0, "risk_cut": 0,
                "submitted_at": mb.get("submitted_at"), "paid_at": mb.get("paid_at")})
        out.sort(key=lambda x: x["expected_claim"], reverse=True)
        counts: dict = defaultdict(int)
        for b in out:
            counts[b["status"]] += 1
        return jsonsafe({"period": period, "batches": out,
                         "status_counts": {s: counts.get(s, 0) for s in self.STATUSES}})

    async def add_manual_invoice(self, period: str, label: str, amount: int, note: str | None = None) -> dict:
        import uuid
        bid = f"manual:{period}:{uuid.uuid4().hex[:8]}"
        await self._db["submission_batches"].insert_one({
            "_id": bid, "tenant_id": self.tenant_id, "period": period, "manual": True,
            "fund_name": (label or "Χειροκίνητο τιμολόγιο").strip(), "expected_claim": int(amount or 0),
            "rx": 0, "status": "ready_for_review", "note": (note or None),
            "created_at": _now(), "updated_at": _now()})
        return {"ok": True, "batch_id": bid}

    async def delete_manual_invoice(self, batch_id: str) -> dict:
        await self._db["submission_batches"].delete_one(
            {"_id": batch_id, "tenant_id": self.tenant_id, "manual": True})
        return {"ok": True}

    async def set_status(self, period: str, batch_id: str, status: str) -> dict:
        if status not in self.STATUSES:
            return {"ok": False, "error": "bad_status"}
        b = await self._db["submission_batches"].find_one({"_id": batch_id, "tenant_id": self.tenant_id})
        if not b:
            return {"ok": False, "error": "not_found"}
        extra = {"submitted_at": _now()} if status == "submitted" else {}
        await self._db["submission_batches"].update_one(
            {"_id": batch_id, "tenant_id": self.tenant_id},
            {"$set": {"status": status, "updated_at": _now(), **extra}})
        await self._log(batch_id, period, b.get("fund_id"), "status_change", b.get("status"), status)
        return {"ok": True}

    async def set_payment(self, period: str, batch_id: str, paid_amount: int) -> dict:
        b = await self._db["submission_batches"].find_one({"_id": batch_id, "tenant_id": self.tenant_id})
        if not b:
            return {"ok": False, "error": "not_found"}
        expected = b.get("expected_claim", 0)
        cut = max(0, expected - int(paid_amount))
        status = "cut" if cut > 0 else "paid"
        await self._db["submission_batches"].update_one(
            {"_id": batch_id, "tenant_id": self.tenant_id},
            {"$set": {"paid_amount": int(paid_amount), "cut_amount": cut, "status": status,
                      "paid_at": _now(), "updated_at": _now()}})
        await self._log(batch_id, period, b.get("fund_id"), "payment", b.get("status"), status,
                        note=f"paid {paid_amount} / expected {expected} / cut {cut}")
        return {"ok": True, "cut": cut, "status": status}

    # ── 10. OPEN BALANCES / RECEIVABLES (cross-month) ───────────────────────
    # ΗΔΥΚΑ never tells us which submission a fund has settled, so the pharmacist marks each
    # month/fund as «εισπράχθηκε» and edits the amount actually received; we then show what's
    # still OPEN (uncollected) per fund across months. Reuses the submission_batches store.
    async def _period_group_claims(self, period: str) -> dict:
        """{fund_group → {rx, claim, is_eopyy}} for one month (ΕΟΠΥΥ folded into one group)."""
        start, end = _month_bounds(period)
        meta = await self._fund_meta()
        agg = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}, "status": {"$ne": "cancelled"}}},
            {"$group": {"_id": "$fund_id", "rx": {"$sum": 1}, "claim": {"$sum": "$amount_claimed"}}},
        ]).to_list(None)
        g: dict = defaultdict(lambda: {"rx": 0, "claim": 0, "is_eopyy": False})
        for a in agg:
            m = meta.get(a["_id"], {"group": "—", "is_eopyy": False})
            gg = g[m["group"]]
            gg["rx"] += a["rx"]; gg["claim"] += a["claim"]; gg["is_eopyy"] = m["is_eopyy"]
        return dict(g)

    @staticmethod
    def _load_payments(b: dict) -> tuple[list, bool]:
        """Payments list + settled flag for a batch, migrating the legacy single paid_amount."""
        payments = b.get("payments")
        if payments is None:
            pa = b.get("paid_amount")
            payments = [{"amount": pa, "at": b.get("paid_at")}] if pa is not None else []
            settled = bool(b.get("status") in ("paid", "cut") and pa is not None)
        else:
            settled = bool(b.get("settled"))
        return list(payments), settled

    @staticmethod
    def _recent_periods(now: datetime, n: int) -> list[str]:
        out, y, m = [], now.year, now.month
        for _ in range(max(1, n)):
            out.append(f"{y:04d}-{m:02d}")
            m -= 1
            if m == 0:
                y, m = y - 1, 12
        return out

    async def receivables(self, months_back: int = 12) -> dict:
        """Per (month, fund) receivable across the last N months: expected vs collected, and the
        OPEN balance (= expected for anything not yet marked collected). months_back<=0 ⇒ ALL
        history (from the earliest execution, capped at 120 months)."""
        now = _now()
        if months_back <= 0:
            first = await self._db["prescription_executions"].find_one(
                {"tenant_id": self.tenant_id}, sort=[("executed_at", 1)], projection={"executed_at": 1})
            fe = (first or {}).get("executed_at")
            months_back = ((now.year - fe.year) * 12 + (now.month - fe.month) + 1) if fe else 12
            months_back = max(1, min(months_back, 120))
        periods = self._recent_periods(now, months_back)
        batch_map: dict = {}
        async for b in self._db["submission_batches"].find(
                {"tenant_id": self.tenant_id, "period": {"$in": periods}}):
            batch_map[b["_id"]] = b

        rows: list[dict] = []
        by_fund: dict = defaultdict(lambda: {"expected": 0, "paid": 0, "open": 0, "cut": 0, "is_eopyy": False})
        tot = {"expected": 0, "paid": 0, "open": 0, "cut": 0,
               "settled_count": 0, "partial_count": 0, "open_count": 0}
        for per in periods:
            for grp, a in (await self._period_group_claims(per)).items():
                expected = a["claim"]
                if expected <= 0:
                    continue
                b = batch_map.get(self._batch_id(per, grp)) or {}
                payments, settled = self._load_payments(b)
                paid_total = sum(p.get("amount", 0) for p in payments)
                # OPEN until fully settled; once settled the shortfall becomes the περικοπή (cut)
                open_bal = 0 if settled else max(0, expected - paid_total)
                cut = max(0, expected - paid_total) if settled else 0
                status = "settled" if settled else ("partial" if paid_total > 0 else "open")
                rows.append({
                    "period": per, "batch_id": self._batch_id(per, grp), "fund": grp,
                    "is_eopyy": a["is_eopyy"], "rx": a["rx"], "expected": expected,
                    "payments": payments, "paid": paid_total, "settled": settled,
                    "cut": cut, "open": open_bal, "status": status})
                f = by_fund[grp]
                f["expected"] += expected; f["paid"] += paid_total; f["open"] += open_bal
                f["cut"] += cut; f["is_eopyy"] = a["is_eopyy"]
                tot["expected"] += expected; tot["paid"] += paid_total
                tot["open"] += open_bal; tot["cut"] += cut
                tot["settled_count"] += 1 if settled else 0
                tot["partial_count"] += 1 if (not settled and paid_total > 0) else 0
                tot["open_count"] += 0 if settled else 1
        rows.sort(key=lambda r: (r["open"], r["period"]), reverse=True)  # biggest open first, then recent
        fund_summary = sorted(({"fund": k, **v} for k, v in by_fund.items()),
                              key=lambda x: x["open"], reverse=True)
        return jsonsafe({"periods": periods, "totals": tot, "by_fund": fund_summary, "rows": rows})

    async def _receivable_base(self, period: str, fund_group: str) -> dict:
        g = (await self._period_group_claims(period)).get(fund_group) or {}
        return {"tenant_id": self.tenant_id, "period": period, "fund_id": fund_group,
                "fund_name": fund_group, "is_eopyy": g.get("is_eopyy", False),
                "expected_claim": g.get("claim", 0), "updated_at": _now()}

    async def add_payment(self, period: str, fund_group: str, amount: int, note: str | None = None) -> dict:
        """Record an installment (δόση) toward a month/fund receivable. ΕΟΠΥΥ usually pays in two."""
        base = await self._receivable_base(period, fund_group)
        expected = base["expected_claim"]
        bid = self._batch_id(period, fund_group)
        prev = await self._db["submission_batches"].find_one({"_id": bid, "tenant_id": self.tenant_id})
        payments, _ = self._load_payments(prev or {})
        payments.append({"amount": int(amount), "at": _now(), "note": (note or None)})
        paid_total = sum(p.get("amount", 0) for p in payments)
        await self._db["submission_batches"].update_one(
            {"_id": bid, "tenant_id": self.tenant_id},
            {"$set": {**base, "payments": payments, "paid_amount": paid_total, "settled": False,
                      "cut_amount": None, "status": "partial", "paid_at": _now()}}, upsert=True)
        await self._log(bid, period, fund_group, "payment", (prev or {}).get("status"), "partial",
                        note=f"δόση {len(payments)}: +{amount} (σύνολο {paid_total}/{expected})")
        return {"ok": True, "paid": paid_total, "open": max(0, expected - paid_total),
                "installments": len(payments)}

    async def settle(self, period: str, fund_group: str, settled: bool = True) -> dict:
        """Close (εξόφληση) a receivable: shortfall vs expected becomes the περικοπή. Or reopen it."""
        base = await self._receivable_base(period, fund_group)
        expected = base["expected_claim"]
        bid = self._batch_id(period, fund_group)
        prev = await self._db["submission_batches"].find_one({"_id": bid, "tenant_id": self.tenant_id})
        payments, _ = self._load_payments(prev or {})
        paid_total = sum(p.get("amount", 0) for p in payments)
        if settled:
            cut = max(0, expected - paid_total)
            await self._db["submission_batches"].update_one(
                {"_id": bid, "tenant_id": self.tenant_id},
                {"$set": {**base, "payments": payments, "settled": True, "paid_amount": paid_total,
                          "cut_amount": cut, "status": "cut" if cut > 0 else "paid",
                          "settled_at": _now()}}, upsert=True)
            await self._log(bid, period, fund_group, "settle", (prev or {}).get("status"),
                            "cut" if cut > 0 else "paid",
                            note=f"εξόφληση: εισπράχθηκε {paid_total}/{expected}, περικοπή {cut}")
            return {"ok": True, "cut": cut}
        await self._db["submission_batches"].update_one(
            {"_id": bid, "tenant_id": self.tenant_id},
            {"$set": {**base, "settled": False, "cut_amount": None,
                      "status": "partial" if paid_total > 0 else "ready_for_review"}}, upsert=True)
        await self._log(bid, period, fund_group, "reopen", (prev or {}).get("status"), "partial")
        return {"ok": True, "open": max(0, expected - paid_total)}

    async def remove_payment(self, period: str, fund_group: str, index: int) -> dict:
        """Undo a mistaken installment."""
        bid = self._batch_id(period, fund_group)
        prev = await self._db["submission_batches"].find_one({"_id": bid, "tenant_id": self.tenant_id})
        if not prev:
            return {"ok": False, "error": "not_found"}
        payments, _ = self._load_payments(prev)
        if 0 <= index < len(payments):
            payments.pop(index)
        paid_total = sum(p.get("amount", 0) for p in payments)
        expected = (await self._receivable_base(period, fund_group))["expected_claim"]
        await self._db["submission_batches"].update_one(
            {"_id": bid, "tenant_id": self.tenant_id},
            {"$set": {"payments": payments, "paid_amount": (paid_total if payments else None),
                      "settled": False, "cut_amount": None,
                      "status": "partial" if payments else "ready_for_review", "updated_at": _now()}})
        await self._log(bid, period, fund_group, "payment_removed", prev.get("status"), None)
        return {"ok": True, "paid": paid_total, "open": max(0, expected - paid_total)}

    async def reconciliation(self, period: str) -> dict:
        batches = [b async for b in self._db["submission_batches"].find(
            {"tenant_id": self.tenant_id, "period": period})]
        rows, exp, paid, cut = [], 0, 0, 0
        for b in batches:
            e = b.get("expected_claim", 0)
            p = b.get("paid_amount")
            exp += e
            if p is not None:
                paid += p
                c = b.get("cut_amount", 0)
                cut += c
                rows.append({"fund": b.get("fund_name"), "expected": e, "paid": p, "cut": c,
                             "diff_pct": _pct(p, e), "status": b.get("status")})
        rows.sort(key=lambda x: x["cut"], reverse=True)
        return jsonsafe({"period": period, "expected": exp, "paid": paid, "cut": cut,
                         "outstanding": exp - paid - cut, "rows": rows})

    async def audit_trail(self, batch_id: str) -> dict:
        events = [e async for e in self._db["claim_events"].find(
            {"tenant_id": self.tenant_id, "batch_id": batch_id}).sort("at", 1)]
        return jsonsafe({"events": events})

    # ── PHYSICAL BARCODE CHECK (digital vs physical reconciliation) ─────────
    async def physical_check(self, period: str, day: str | None = None, group: str = "all") -> dict:
        """All distinct prescription barcodes we hold for the month + their scan status, plus the
        'extra' barcodes scanned that we DON'T have. Optional `day` narrows to one day; `group`
        filters per submission/fund («ΕΟΠΥΥ - Φάρμακα»/«ΕΟΠΥΥ - Εμβόλια»/«Αμιγώς 100%»/ταμείο)."""
        start, end = _month_bounds(period)
        meta = await self._fund_meta()
        rows = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}, "status": {"$ne": "cancelled"}}},
            # ΑΝΑ ΕΚΤΕΛΕΣΗ (full external_id = barcode:execNo), ΟΧΙ ανά barcode-root: μια συνταγή που
            # εκτελέστηκε σε φάσεις (μερικές εκτελέσεις) πρέπει να εμφανίζεται ως ΞΕΧΩΡΙΣΤΕΣ εγγραφές
            # για έλεγχο/υποβολή — μπορεί και σε διαφορετικές ημερομηνίες.
            {"$group": {"_id": "$external_id",
                        "claim": {"$sum": "$amount_claimed"}, "retail": {"$sum": "$amount_total"},
                        "fund_id": {"$first": "$fund_id"},
                        "vac": {"$first": {"$ifNull": ["$details.vaccines", False]}},
                        "intangible": {"$first": {"$ifNull": ["$details.intangible", False]}},
                        "exec_count": {"$first": "$details.exec_count"},
                        "n3816": {"$first": {"$ifNull": ["$details.n3816", False]}},
                        "supp": {"$first": {"$ifNull": ["$details.supplementary_cover", False]}},
                        "full_part": {"$first": {"$ifNull": ["$details.full_participation", False]}},
                        "dose": {"$max": {"$ifNull": ["$needs_dose_check", False]}},
                        "opinion": {"$first": {"$ifNull": ["$details.opinion", False]}},
                        "desens": {"$first": {"$ifNull": ["$details.desensitization", False]}},
                        "narcotic": {"$first": {"$ifNull": ["$details.narcotic", False]}},
                        "doc_id": {"$first": "$_id"},
                        "executed_at": {"$min": "$executed_at"}}},
        ]).to_list(None)
        session = await self._db["barcode_check"].find_one(
            {"tenant_id": self.tenant_id, "period": period}) or {}
        checked = set(session.get("checked", []))
        vchecked = set(session.get("visual", []))   # οπτικά ελεγμένες (ποιοτικό στάδιο)
        allrows = []
        doc_map: dict = {}     # execution _id → row (για 2ο πέρασμα: ταινίες + σημειώσεις ΗΔΥΚΑ)
        for r in rows:
            # ΚΑΝΟΝΙΚΗ ομαδοποίηση εδώ· το «Αμιγώς 100%» ΔΕΝ κρίνεται από claim==0 (αναξιόπιστο — π.χ.
            # 25% συμμετοχή μπορεί να έχει claim=0) αλλά από τη ΣΥΜΜΕΤΟΧΗ ΑΝΑ ΦΑΡΜΑΚΟ: «Αμιγώς 100%» =
            # ΟΛΑ τα φάρμακα με participation_pct==100· αν έστω ΕΝΑ <100 → κατατίθεται στον ΕΟΠΥΥ.
            # Υπολογίζεται στο 2ο πέρασμα (per-item participation_pct) & εφαρμόζεται μετά.
            is_100 = False
            glabel, is_eo = self._grp_label(meta, r["fund_id"], bool(r.get("vac")))
            is_vac = is_eo and bool(r.get("vac"))
            ec = r.get("exec_count")
            ext = str(r["_id"])
            root = ext.split(":")[0]                       # 13ψήφιο barcode συνταγής
            exno = ext.split(":")[1] if ":" in ext else None  # αριθμός εκτέλεσης/φάσης
            # Πρωτότυπη χάρτινη: η μη-άυλη συνταγή χρειάζεται την πρωτότυπη του ιατρού στη ΦΑΣΗ 1
            # (πρώτη εκτέλεση) — ΟΧΙ μόνο όταν είναι μονή. Σε επαναλαμβανόμενη έντυπη, η πρωτότυπη
            # κατατίθεται μία φορά (στη φάση 1)· οι επόμενες φάσες την αναφέρουν. (ec δεν κρίνει πλέον.)
            first_phase = (exno is None) or (str(exno) == "1")
            needs_orig = (not bool(r.get("intangible"))) and first_phase
            allrows.append({
                "barcode": root, "external_id": ext, "exec_no": exno,
                "claim": r["claim"], "retail": r.get("retail", 0), "executed_at": r["executed_at"],
                "day": r["executed_at"].strftime("%Y-%m-%d") if r.get("executed_at") else None,
                "fund": glabel, "group": glabel, "is_eopyy": is_eo, "is_vaccine": is_vac,
                "is_100": is_100, "is_fyk": bool(r.get("n3816")), "is_etyap": bool(r.get("supp")),
                "full_participation": bool(r.get("full_part")),
                "needs_original": needs_orig,
                "needs_dose_check": False,   # υπολογίζεται ΑΝΑ ΕΚΤΕΛΕΣΗ στο 2ο πέρασμα (τεμάχια φάσης > 1)
                "has_opinion": bool(r.get("opinion")), "has_desens": bool(r.get("desens")),
                # χρειάζεται έλεγχο = ταινία γνησιότητας (μη-QR) Ή κάποια ιδιαιτερότητα (δοσολογία/E,
                # ΦΥΚ, γνωμάτευση, απευαισθητοποίηση, ναρκωτικό, πρωτότυπη, ή φάρμακο με σημείωση ΗΔΥΚΑ).
                # base εδώ· δοσολογία/strips/catalog-attention προστίθενται στο 2ο πέρασμα παρακάτω.
                "needs_check": bool(r.get("n3816") or r.get("opinion") or r.get("desens")
                                    or r.get("narcotic") or needs_orig),
                # checked ανά εκτέλεση (νέο) ή ανά barcode-root (παλιό state) — συμβατό και τα δύο
                "checked": (ext in checked) or (root in checked),
                "visual_checked": (ext in vchecked) or (root in vchecked)})
            if r.get("doc_id"):
                doc_map[r["doc_id"]] = allrows[-1]
        # 2ο πέρασμα: κατηγοριοποίηση ανά εκτέλεση (ταινία μη-QR / ναρκωτικό / σημείωση ΗΔΥΚΑ) για
        # το needs_check + την αναλυτική ενημέρωση μήνα. Μία αναζήτηση items + δύο set καταλόγου.
        if doc_map:
            narc = {str(d["_id"]) async for d in self._db["medicine_catalog"].find(  # tenant-ok: shared
                {"narcotic": True}, {"_id": 1})}
            note = {str(d["_id"]) async for d in self._db["medicine_catalog"].find(
                {"$or": [{"info_popup": {"$ne": None}}, {"pharmacist_popup": {"$ne": None}},
                         {"withdrawn": True}, {"limited_execution": True}, {"hospital_medicine": True},
                         {"ifet": True}, {"is_heparin": True}]}, {"_id": 1})}
            dose = {str(d["_id"]) async for d in self._db["medicine_catalog"].find(  # σκευάσματα με οπτικό έλεγχο δοσολογίας
                {"$or": [
                    {"needs_dose_check": True},
                    # Αμπούλες/φιαλίδια — πόσιμες (VIOFER PS.OR.SOL) ή ΕΝΕΣΙΜΕΣ (BRIKLIN INJ.SOL): έλεγχος
                    # δόσης ΑΝΑ αμπούλα ακόμη κι αν omt=="E" — ίδια λογική με prescription_checks (root fix).
                    {"$and": [{"form_code": {"$regex": r"INJ|OR\.SO|OR\.SUSP|SUSP|POS", "$options": "i"}},
                              {"package_form": {"$regex": "VIAL|AMP|ΦΙΑΛ", "$options": "i"}},
                              {"form_code": {"$not": {"$regex": "NEB|INHAL", "$options": "i"}}}]}]},
                {"_id": 1})}
            # Πολυδοσικοί περιέκτες (σταγόνες/σιρόπι σε μπουκάλι — π.χ. SIMBRINZA EY.DRO.SUS): 1 τεμάχιο =
            # πολλές δόσεις → έλεγχος δοσολογίας ΑΚΟΜΗ κι αν το κουπόνι είναι ΕΝΑ (δεν ισχύει το >1).
            multidose = {str(d["_id"]) async for d in self._db["medicine_catalog"].find(
                {"form_code": {"$regex": r"DRO|DROP|ΣΤΑΓ|SYR|OR\.SO|OR\.SUSP", "$options": "i"},
                 "$nor": [{"form_code": {"$regex": "INJ", "$options": "i"}}]}, {"_id": 1})}
            async for it in self._db["prescription_items"].find(
                    {"tenant_id": self.tenant_id, "execution_id": {"$in": list(doc_map.keys())}},
                    {"execution_id": 1, "details.eof_code": 1, "details.coupons.qr": 1,
                     "details.coupons.execution_no": 1, "details.participation_pct": 1}):
                row = doc_map.get(it["execution_id"])
                if not row:
                    continue
                d = it.get("details") or {}
                eof = str(d.get("eof_code") or "")
                # συμμετοχή ανά φάρμακο: μετράμε items & πόσα είναι 100% → «Αμιγώς 100%» μόνο αν ΟΛΑ 100%
                row["_nit"] = row.get("_nit", 0) + 1
                if float(d.get("participation_pct") or 0) == 100.0:
                    row["_n100"] = row.get("_n100", 0) + 1
                coupons = d.get("coupons") or []
                # ΑΝΑ ΕΚΤΕΛΕΣΗ (μερική εκτέλεση): κράτα ΜΟΝΟ τα κουπόνια αυτής της φάσης — η CDA αποθηκεύει
                # ΟΛΑ τα κουπόνια σε ΚΑΘΕ φάση, οπότε χωρίς φιλτράρισμα μια ΑΥΛΗ (all-QR) φάση φαινόταν
                # λάθος ότι έχει ταινία (has_strip) από κουπόνι άλλης φάσης.
                exno = int(row["exec_no"]) if str(row.get("exec_no") or "").isdigit() else None
                pc = [c for c in coupons if exno is None
                      or int(float(c.get("execution_no") or 0)) == exno]
                if any(c.get("qr") is False for c in pc):
                    row["has_strip"] = True
                if eof in narc:
                    row["is_narcotic"] = True
                if eof in note:
                    row["hdika_note"] = True
                # δοσολογία ΑΝΑ ΕΚΤΕΛΕΣΗ: >1 τεμάχιο ΑΥΤΗΣ της φάσης· ΕΞΑΙΡΕΣΗ πολυδοσικού περιέκτη
                # (σταγόνες/σιρόπι) → έλεγχος & με 1 τεμάχιο (1 μπουκάλι = πολλές δόσεις).
                if eof in dose and (len(pc) > 1 or eof in multidose):
                    row["needs_dose_check"] = True
            for row in doc_map.values():
                if row.get("has_strip") or row.get("is_narcotic") or row.get("hdika_note") or row.get("needs_dose_check"):
                    row["needs_check"] = True
                # «Αμιγώς 100%» = retail>0 & ΟΛΑ τα φάρμακα με 100% συμμετοχή (κανένα <100%). Το
                # `details.full_participation` (από την ΗΔΥΚΑ, στο ingest) είναι ΑUTHORITATIVE — το ίδιο
                # σήμα με το summary — και υπερισχύει όταν λείπει το per-item participation_pct (π.χ.
                # εκτέλεση που ανακτήθηκε με degraded item από στιγμιαία αποτυχία CDA).
                if (row.get("retail", 0) or 0) > 0 and (
                        row.get("full_participation")
                        or (row.get("_nit") and row["_nit"] == row.get("_n100", 0))):
                    row["is_100"] = True
                    row["fund"] = row["group"] = "Αμιγώς 100%"
                    row["is_eopyy"] = False
                    row["is_vaccine"] = False
        # Αναλυτική ενημέρωση μήνα (πριν το φίλτρο ομάδας → όλος ο μήνας)
        def _cnt(f):
            return sum(1 for r in allrows if r.get(f))
        summary = {
            "total": len(allrows), "needs_check": _cnt("needs_check"),
            "clean": len(allrows) - _cnt("needs_check"),
            "dose": _cnt("needs_dose_check"), "fyk": _cnt("is_fyk"), "narcotic": _cnt("is_narcotic"),
            "needs_original": _cnt("needs_original"), "opinion": _cnt("has_opinion"),
            "desensitization": _cnt("has_desens"), "strips": _cnt("has_strip"),
            "hdika_note": _cnt("hdika_note"), "vaccine": _cnt("is_vaccine"),
        }
        order = {EOPYY_MED: 0, "ΕΟΠΥΥ - Εμβόλια": 1, "Αμιγώς 100%": 8}
        groups = ["all"] + sorted({a["group"] for a in allrows}, key=lambda g: (order.get(g, 5), g))
        if group != "all":
            allrows = [a for a in allrows if a["group"] == group]
        by_day: dict = {}
        for it in allrows:
            d = by_day.setdefault(it["day"], {"date": it["day"], "total": 0, "checked": 0})
            d["total"] += 1
            d["checked"] += 1 if it["checked"] else 0
        items = [i for i in allrows if i["day"] == day] if day else allrows
        items.sort(key=lambda x: (x["checked"], -x["claim"]))  # unchecked, by € first
        checked_n = sum(1 for i in items if i["checked"])
        # «extra» = σκαναρισμένα που ΔΕΝ έχουμε. Καθαρίζουμε (α) ΜΗ-έγκυρα barcodes (≠13 ψηφία —
        # κομμένα σκαναρίσματα πριν τον invalid_length guard) και (β) όσα ΠΛΕΟΝ υπάρχουν στα δεδομένα
        # (π.χ. ανακτήθηκαν από reconciliation/backfill) → self-heal, δεν μένουν «κολλημένα κάτω».
        extra13 = [b for b in session.get("extra", []) if len(re.sub(r"\D", "", str(b))) == 13]
        if extra13:
            present = set()
            rx = "^(" + "|".join(re.escape(str(b)) for b in extra13) + ")"
            # ΔΙΑΣΤΑΥΡΟΥΜΕΝΟΣ έλεγχος ύπαρξης (ΟΛΟΙ οι tenants — ΟΧΙ tenant-scoped, σκόπιμα): κρύβει
            # (α) όσα ανακτήθηκαν στο ΔΙΚΟ μας tenant ΚΑΙ (β) όσα ανήκουν σε ΑΛΛΟ φαρμακείο (μις-
            # σκανάρισμα σε λάθος tenant). Δεν εκτίθεται κανένα δεδομένο άλλου tenant — μόνο ύπαρξη
            # barcode που ο ίδιος ο χρήστης πληκτρολόγησε. Μένει μόνο ό,τι ΔΕΝ υπάρχει πουθενά.
            async for e in self._db["prescription_executions"].find(
                    {"external_id": {"$regex": rx}, "status": {"$ne": "cancelled"}}, {"external_id": 1}):
                present.add(str(e["external_id"]).split(":")[0])
            extra13 = [b for b in extra13 if str(b) not in present]
        return jsonsafe({
            "period": period, "day": day, "group": group, "groups": groups,
            "total": len(items), "checked": checked_n,
            "remaining": len(items) - checked_n,
            "extra": extra13,
            "summary": summary,
            "by_day": sorted(by_day.values(), key=lambda x: x["date"] or ""), "items": items})

    @staticmethod
    def _submission_flags(ex: dict) -> dict:
        """Per-prescription flags the pharmacist must act on when assembling the ΕΟΠΥΥ submission
        (Έλεγχος συνταγών). All are prescription-level (same across partial executions)."""
        d = ex.get("details") or {}
        intangible = bool(d.get("intangible"))            # 1.5.10
        exec_count = d.get("exec_count")                  # 1.1.19
        ext = str(ex.get("external_id") or "")
        exno = ext.split(":")[1] if ":" in ext else None  # φάση εκτέλεσης
        first_phase = (exno is None) or (str(exno) == "1")
        return {
            "is_intangible": intangible,
            # Αμιγώς 100% συμμετοχή ασθενή → ΔΕΝ υποβάλλεται στο ταμείο (authoritative από ΗΔΥΚΑ).
            "is_full_participation": bool(d.get("full_participation")),
            # α) μη άυλη + ΦΑΣΗ 1 (πρώτη εκτέλεση) → χρειάζεται η πρωτότυπη χάρτινη συνταγή ιατρού. Σε
            # επαναλαμβανόμενη έντυπη η πρωτότυπη κατατίθεται ΜΙΑ φορά (φάση 1)· ΟΧΙ μόνο όταν είναι μονή.
            "needs_original": (not intangible) and first_phase,
            "is_fyk": bool(d.get("n3816")),               # β) ΦΥΚ Ν.3816/10 (1.1.14)
            "has_desensitization": bool(d.get("desensitization")),  # γ) εμβόλιο απευαισθητοποίησης (1.1.8)
            "has_opinion": bool(d.get("opinion")),        # δ) γνωμάτευση (1.1.23)
            "has_vaccine": bool(d.get("vaccines")),       # ενημερωτικό: συνταγή εμβολίων (1.1.24)
            # ΕΤΥΑΠ/ΚΥΥΑΠ: συμπληρωματική κάλυψη (1.1.27) — δεν ελέγχεται ξεχωριστά, αρκεί ο έλεγχος ΕΟΠΥΥ
            "is_etyap": bool(d.get("supplementary_cover")),
            "exec_count": exec_count,
        }

    async def physical_scan(self, period: str, barcode: str, day: str | None = None) -> dict:
        # 16 ψηφία: 13 (barcode) + 3, όπου το 16ο ψηφίο = αριθμός ΜΕΡΙΚΗΣ ΕΚΤΕΛΕΣΗΣ (1-9). Έτσι
        # ξεχωρίζουμε δύο μερικές εκτελέσεις της ΙΔΙΑΣ μέρας. Αν δεν δίνεται (ή 0) → ταίριασμα με
        # ημερομηνία/μήνα (fallback για μονές εκτελέσεις/χειροκίνητη πληκτρολόγηση 13 ψηφίων).
        orig = (barcode or "").strip()
        digits = re.sub(r"\D", "", orig.split(":")[0])   # ΜΟΝΟ ψηφία (αφαιρεί κενά π.χ. «… 121»)
        bc = digits[:13]
        if not bc:
            return {"ok": False, "error": "empty"}
        # Άκυρο ΜΗΚΟΣ: τα barcode συνταγών ΗΔΥΚΑ είναι 13 ψηφία (προαιρετικά +3 για τη φάση εκτέλεσης).
        # Λιγότερα ψηφία = ΚΟΜΜΕΝΟ/λάθος σκανάρισμα (π.χ. έπεσε ένα ψηφίο: 2607061395384 → 267061395384).
        # ΔΕΝ το καταγράφουμε ως «extra» (θα φαινόταν λανθασμένα «εκτός δεδομένων») — ζητάμε ξανασκανάρισμα.
        if len(digits) < 13:
            return {"ok": False, "found": False, "invalid_length": True,
                    "barcode": digits, "digits": len(digits), "n_executions": 0}
        # αριθμός μερικής εκτέλεσης: από χειροκίνητο «:N» ή από το 16ο ψηφίο
        if ":" in orig and orig.split(":", 1)[1][:1].isdigit():
            seq = int(orig.split(":", 1)[1][0])
        elif len(digits) >= 16 and digits[15] != "0":
            seq = int(digits[15])
        else:
            seq = None
        all_exs = [e async for e in self._db["prescription_executions"].find(  # tenant-ok
            {"tenant_id": self.tenant_id, "status": {"$ne": "cancelled"},
             "external_id": {"$regex": f"^{re.escape(bc)}"}})]
        if not all_exs:               # δεν υπάρχει σε ΑΥΤΟ το φαρμακείο
            # μήπως ανήκει σε ΑΛΛΟ φαρμακείο (μις-σκανάρισμα σε λάθος tenant, π.χ. χρήστης δικτύου που
            # έχει επιλέξει λάθος φαρμακείο); → ΜΗ το βάλεις στο «δεν υπάρχουν», ενημέρωσε ξεκάθαρα.
            other = await self._db["prescription_executions"].count_documents(
                {"external_id": {"$regex": f"^{re.escape(bc)}"}, "status": {"$ne": "cancelled"}})
            if other > 0:
                return {"ok": True, "found": False, "other_tenant": True, "barcode": bc, "n_executions": 0}
            await self._db["barcode_check"].update_one(
                {"tenant_id": self.tenant_id, "period": period},
                {"$addToSet": {"extra": bc}, "$set": {"updated_at": _now()}}, upsert=True)
            return {"ok": True, "found": False, "barcode": bc, "n_executions": 0}
        start, end = _month_bounds(period)
        # στόχος: συγκεκριμένη μερική εκτέλεση από το 16ο ψηφίο (bc:seq), αλλιώς ταίριασμα μήνα/μέρας
        target = next((e for e in all_exs if e["external_id"] == f"{bc}:{seq}"), None) if seq else None
        if target is not None:
            td = target["executed_at"].strftime("%Y-%m-%d")
            if not (start <= target["executed_at"] < end) or (day and td != day):
                # ΣΥΓΚΕΚΡΙΜΕΝΗ μερική εκτέλεση → ΜΙΑ ημερομηνία (αυτής της φάσης), όχι όλες της συνταγής
                return {"ok": True, "found": True, "wrong_day": True, "barcode": bc,
                        "exec_no": seq, "actual_days": [td], "n_executions": 1}
            targets = [target]
        else:
            in_month = [e for e in all_exs if start <= e["executed_at"] < end]
            targets = [e for e in in_month if e["executed_at"].strftime("%Y-%m-%d") == day] if day else in_month
            if not targets:           # υπάρχει αλλά ΟΧΙ σε αυτή τη μέρα/μήνα → ειδοποίηση
                actual = sorted({e["executed_at"].strftime("%Y-%m-%d") for e in all_exs})
                return {"ok": True, "found": True, "wrong_day": True, "barcode": bc,
                        "actual_days": actual, "n_executions": len(all_exs)}
            # ΕΛΕΓΧΟΣ ΑΝΑ ΕΚΤΕΛΕΣΗ: μερική εκτέλεση με ΠΟΛΛΕΣ φάσεις (κάθε φάση = δικό της φάρμακο/κουπόνι)
            # που σκαναρίστηκε με το 13ψήφιο (χωρίς φάση) → μαρκάρουμε ΜΙΑ φάση τη φορά (την επόμενη
            # ανέλεγκτη), ώστε ο φαρμακοποιός να ελέγχει ανά εκτέλεση & να βλέπει ΤΟ 1 κουπόνι της φάσης —
            # όχι όλες μαζί/όλα τα κουπόνια. (Σε διαφορετικές μέρες/μήνες ήδη ταιριάζει 1 φάση.)
            if len(targets) > 1:
                chk = await self._db["barcode_check"].find_one(
                    {"tenant_id": self.tenant_id, "period": period}) or {}
                done = set(chk.get("checked", []))
                ordered = sorted(targets, key=lambda e: e["external_id"])
                pending = [e for e in ordered if e["external_id"] not in done and bc not in done]
                # ΠΑΝΤΑ scope σε ΜΙΑ εκτέλεση (σαν ξεχωριστή συνταγή): την επόμενη ανέλεγκτη· αν όλες
                # είναι ήδη ελεγμένες → την πρώτη. Έτσι το popup δείχνει ΠΑΝΤΑ 1 κουπόνι/εκτέλεση,
                # ποτέ και τα δύο μαζί — ακόμη και σε επανασκανάρισμα ελεγμένης συνταγής.
                targets = [pending[0]] if pending else [ordered[0]]
        await self._db["barcode_check"].update_one(
            {"tenant_id": self.tenant_id, "period": period},
            {"$addToSet": {"checked": {"$each": [e["external_id"] for e in targets]}},
             "$set": {"updated_at": _now()}}, upsert=True)
        total_exec = len([e for e in all_exs if start <= e["executed_at"] < end])
        res = {"ok": True, "found": True, "barcode": bc, "n_executions": total_exec}
        res["flags"] = self._submission_flags(targets[0])
        # Ασφαλιστικός φορέας — να ΤΟΝΙΖΕΤΑΙ ΟΤΑΝ ΔΕΝ είναι ΕΟΠΥΥ (π.χ. Ένοπλες Δυνάμεις/ΓΕΣ, ΤΥΠΕΤ):
        # αυτές οι συνταγές κατατίθενται ΞΕΧΩΡΙΣΤΑ στο δικό τους ταμείο, όχι στον ΕΟΠΥΥ.
        fmeta = (await self._fund_meta()).get(targets[0].get("fund_id")) or {}
        res["flags"]["is_eopyy"] = bool(fmeta.get("is_eopyy"))
        res["flags"]["fund"] = fmeta.get("group") or fmeta.get("name") or "—"
        res["flags"]["fund_name"] = fmeta.get("name") or "—"
        if len(targets) == 1:         # μία μερική εκτέλεση → popup με τα κουπόνια ΑΥΤΗΣ (scope ανά :N)
            res["external_id"] = targets[0]["external_id"]
            if ":" in targets[0]["external_id"]:
                res["exec_no"] = targets[0]["external_id"].split(":")[1]
        return res

    async def physical_reset(self, period: str, day: str | None = None) -> dict:
        if not day:                       # μηδενισμός ΟΛΟΥ του μήνα
            await self._db["barcode_check"].delete_one({"tenant_id": self.tenant_id, "period": period})
            return {"ok": True}
        # μηδενισμός ΜΟΝΟ μιας ημέρας: αφαιρούμε από το checked τις εκτελέσεις εκείνης της μέρας
        start, end = _month_bounds(period)
        ids = [e["external_id"] async for e in self._db["prescription_executions"].find(  # tenant-ok
            {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end},
             "status": {"$ne": "cancelled"}}, {"external_id": 1, "executed_at": 1})
            if e["executed_at"].strftime("%Y-%m-%d") == day]
        if ids:
            roots = list({i.split(":")[0] for i in ids})   # + παλιό state ανά barcode-root
            await self._db["barcode_check"].update_one(
                {"tenant_id": self.tenant_id, "period": period},
                {"$pull": {"checked": {"$in": ids + roots}, "visual": {"$in": ids + roots}},
                 "$set": {"updated_at": _now()}})
        return {"ok": True, "day": day, "cleared": len(ids)}

    async def physical_extra_remove(self, period: str, barcode: str) -> dict:
        """Ο φαρμακοποιός απορρίπτει ένα «σκαναρίστηκε αλλά ΔΕΝ υπάρχει» barcode (π.χ. λάθος σκανάρισμα ή
        συνταγή άλλου φαρμακείου) ώστε να μη μένει στη λίστα ελέγχου. Αφαιρεί ΜΟΝΟ το συγκεκριμένο."""
        bc = re.sub(r"\D", "", str(barcode or ""))[:13]
        if not bc:
            return {"ok": False, "error": "empty"}
        r = await self._db["barcode_check"].update_one(
            {"tenant_id": self.tenant_id, "period": period},
            {"$pull": {"extra": bc}, "$set": {"updated_at": _now()}})
        return {"ok": True, "barcode": bc, "removed": r.modified_count}

    async def physical_visual(self, period: str, external_id: str, undo: bool = False) -> dict:
        """Ποιοτικό στάδιο: σημείωση μιας εκτέλεσης ως οπτικά ελεγμένης (ή αναίρεση)."""
        op = "$pull" if undo else "$addToSet"
        await self._db["barcode_check"].update_one(
            {"tenant_id": self.tenant_id, "period": period},
            {op: {"visual": external_id}, "$set": {"updated_at": _now()}}, upsert=True)
        return {"ok": True, "external_id": external_id, "visual_checked": not undo}

    async def closing_prefs(self) -> dict:
        """Προτιμήσεις κλεισίματος (ανά φαρμακείο) — τρόπος ελέγχου barcode + αν η λίστα ξεκινά ανοιχτή."""
        s = await self._db["reimbursement_settings"].find_one({"tenant_id": self.tenant_id}) or {}
        return {"closing_mode": s.get("closing_mode", "classic"), "list_open": bool(s.get("list_open", False))}

    async def set_closing_prefs(self, closing_mode: str | None = None, list_open: bool | None = None) -> dict:
        upd: dict = {"tenant_id": self.tenant_id, "updated_at": _now()}
        if closing_mode is not None:
            upd["closing_mode"] = closing_mode if closing_mode in ("guided", "express") else "classic"
        if list_open is not None:
            upd["list_open"] = bool(list_open)
        await self._db["reimbursement_settings"].update_one(
            {"tenant_id": self.tenant_id}, {"$set": upd}, upsert=True)
        return await self.closing_prefs()

    # ── DAILY RECONCILIATION — amounts + execution counts per day (vs the pharmacist's program) ─
    async def daily_reconciliation(self, period: str, group: str = "all") -> dict:
        """Ανά ημέρα, με δυνατότητα φίλτρου ανά ομάδα/ταμείο («all», «ΕΟΠΥΥ - Φάρμακα»,
        «ΕΟΠΥΥ - Εμβόλια», «ΕΤΥΑΠ», ή οποιοδήποτε ταμείο). Σε ξεχωριστό πεδίο, οι αμιγώς-100%
        συμμετοχής ανά ημέρα (δεν υποβάλλονται). Εξαιρούνται οι ακυρωμένες."""
        start, end = _month_bounds(period)
        meta = await self._fund_meta()
        per: dict = defaultdict(lambda: {"barcodes": set(), "executions": 0, "claim": 0,
                                         "retail": 0, "patient": 0, "hundred": 0})
        groups: set = set()
        cur = self._db["prescription_executions"].find(
            {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end},
             "status": {"$ne": "cancelled"}},
            {"executed_at": 1, "external_id": 1, "fund_id": 1, "amount_total": 1,
             "amount_claimed": 1, "patient_share": 1, "details.vaccines": 1, "details.kyyap_covered": 1,
             "details.full_participation": 1})
        async for e in cur:
            day = e["executed_at"].strftime("%Y-%m-%d")
            det = e.get("details") or {}
            vac = bool(det.get("vaccines"))
            kyyap = det.get("kyyap_covered") or 0
            label, _is_eo = self._grp_label(meta, e.get("fund_id"), vac)
            groups.add(label)
            if kyyap > 0:
                groups.add("ΕΤΥΑΠ")
            total = e.get("amount_total", 0) or 0
            claim = e.get("amount_claimed", 0) or 0
            # «Αμιγώς 100%» = ΟΛΑ τα φάρμακα με συμμετοχή ασθενή 100% (details.full_participation).
            # ΟΧΙ claim==0 (αναξιόπιστο: 25% συμμετοχή μπορεί να έχει claim=0 & ναρκωτικά έχουν claim=0).
            is_100 = total > 0 and det.get("full_participation") is True
            d = per[day]
            if is_100:
                d["hundred"] += 1
            if group == "ΕΤΥΑΠ":
                inc, cval, rval, pval = kyyap > 0, kyyap, 0, 0
            elif group == "all":
                inc, cval, rval, pval = True, claim, total, (e.get("patient_share", 0) or 0)
            else:                                      # συγκεκριμένη ομάδα ταμείου — μόνο υποβαλλόμενες
                inc = (label == group) and not is_100
                cval, rval, pval = claim, total, (e.get("patient_share", 0) or 0)
            if inc:
                d["barcodes"].add(str(e.get("external_id", "")).split(":")[0])
                d["executions"] += 1
                d["claim"] += cval
                d["retail"] += rval
                d["patient"] += pval
        days = []
        for day in sorted(per):
            d = per[day]
            if d["executions"] == 0 and d["hundred"] == 0:
                continue
            days.append({"date": day, "rx": len(d["barcodes"]), "executions": d["executions"],
                         "claim": d["claim"], "retail": d["retail"], "patient": d["patient"],
                         "hundred": d["hundred"]})
        tot = {k: sum(d[k] for d in days) for k in ("rx", "executions", "claim", "retail", "patient", "hundred")}
        tot["days"] = len(days)
        # επιλογές για το dropdown: σύνολο + ομάδες, με ΕΟΠΥΥ/ΕΤΥΑΠ πρώτα
        order = {EOPYY_MED: 0, "ΕΟΠΥΥ - Εμβόλια": 1, "ΕΤΥΑΠ": 2}
        opts = ["all"] + sorted(groups, key=lambda g: (order.get(g, 9), g))
        return jsonsafe({"period": period, "group": group, "groups": opts, "days": days, "totals": tot})

    # ── ADVANCED PER-PRESCRIPTION DETAIL — coupons (medicine lines) + submission flags ──────────
    async def _rx_lines(self, ex_ids: list, exec_no: int | None = None) -> tuple:
        # exec_no: όταν δοθεί, κρατάμε ΜΟΝΟ τα κουπόνια αυτής της φάσης (κάθε κουπόνι φέρει
        # execution_no) — ώστε κάθε μερική εκτέλεση να δείχνει ΤΑ ΔΙΚΑ ΤΗΣ κουπόνια, όχι το σύνολο.
        items = [it async for it in self._db["prescription_items"].find(
            {"tenant_id": self.tenant_id, "execution_id": {"$in": ex_ids}})]
        pids = []
        for it in items:
            try:
                pids.append(ObjectId(it.get("product_id")))
            except Exception:  # noqa: BLE001
                pass
        prods = {}
        async for p in self._db["products"].find({"_id": {"$in": pids}, "tenant_id": self.tenant_id}):
            prods[str(p["_id"])] = p
        # resolve the catalogue (full name + category) by product.barcode (== eofCode)
        eofs = [p.get("barcode") for p in prods.values() if p.get("barcode")]
        cat_by_key: dict = {}
        async for c in self._db["medicine_catalog"].find(  # tenant-ok: shared catalogue
                {"$or": [{"_id": {"$in": eofs}}, {"barcode": {"$in": eofs}}]}):
            cat_by_key[c["_id"]] = c
            if c.get("barcode"):
                cat_by_key[c["barcode"]] = c
        # Μία κάρτα ΑΝΑ διακριτό εκτελεσμένο κουπόνι (ανά strip/batch) ώστε ΚΑΘΕ QR/ταινία να
        # φαίνεται ξεχωριστά για έλεγχο. Το dedup διασταυρώνει ΜΟΝΟ τις μερικές εκτελέσεις (που
        # αποθηκεύουν η καθεμία ΟΛΑ τα κουπόνια) → δεν διπλομετρώνται, αλλά τα 2 QR μένουν 2 κάρτες.
        lines, flags, seen = [], set(), set()
        for it in items:
            p = prods.get(str(it.get("product_id")), {})
            c = cat_by_key.get(p.get("barcode"), {})
            cat = it.get("category") or p.get("category") or "normal"
            flags.add(cat)
            name = c.get("full_name") or p.get("name") or "—"
            bc = p.get("barcode")
            eof = c.get("_id") or p.get("barcode")
            executed = bool(it.get("is_executed", True))
            coupons = (it.get("details") or {}).get("coupons") or []
            if exec_no is not None:
                coupons = [cp for cp in coupons
                           if int(float(cp.get("execution_no") or 0)) == exec_no]
                if not coupons:
                    continue   # αυτό το είδος δεν χορηγήθηκε σε αυτή τη φάση
            if coupons:
                for cp in coupons:
                    sk = cp.get("strip") or cp.get("qr_batch")
                    dk = (eof, sk)
                    if sk and dk in seen:
                        continue
                    seen.add(dk)
                    # ανεκτέλεστη γραμμή → ΔΕΝ έχει κουπόνι/QR (δεν χορηγήθηκε ποτέ)
                    lines.append({"name": name, "barcode": bc, "eof": eof, "quantity": 1,
                                  "category": cat, "executed": executed,
                                  "qr": cp.get("qr") if executed else None,
                                  "qr_batch": cp.get("qr_batch") if executed else None,
                                  "qr_expiry": cp.get("qr_expiry") if executed else None,
                                  "lot": cp.get("strip") if executed else None})
            else:
                dk = (eof, "_noc")
                if dk in seen:
                    continue
                seen.add(dk)
                lines.append({"name": name, "barcode": bc, "eof": eof,
                              "quantity": it.get("quantity", 1) or 1, "category": cat,
                              "executed": executed})
        return lines, flags

    async def _coupons_from_cda(self, cda_lines: list) -> tuple:
        """Authoritative coupons straight from the CDA lines (each = one coupon, executed + QR + lot
        from the SAME source). An unexecuted line was never dispensed → it has NO coupon (no QR/strip)."""
        from app.services.ingestion.hdika_catalog import categorize
        eofs = [ln["eof"] for ln in cda_lines if ln.get("eof")]
        cat_by_key: dict = {}
        async for c in self._db["medicine_catalog"].find(  # tenant-ok: shared catalogue
                {"$or": [{"_id": {"$in": eofs}}, {"barcode": {"$in": eofs}}]}):
            cat_by_key[c["_id"]] = c
            if c.get("barcode"):
                cat_by_key[c["barcode"]] = c
        coupons, flags = [], set()
        for ln in cda_lines:
            c = cat_by_key.get(ln.get("eof"), {})
            cat = categorize(c.get("atc"), c.get("narcotic"), c.get("high_cost"),
                             c.get("substance_name") or ln.get("name") or "")
            flags.add(cat)
            ex = bool(ln.get("executed", True))
            coupons.append({
                "name": c.get("full_name") or ln.get("name") or "—",
                "barcode": c.get("barcode") or ln.get("eof"), "quantity": 1,
                "category": cat, "executed": ex,
                "qr": ln.get("qr") if ex else None,            # unexecuted → no coupon at all
                "qr_batch": ln.get("batch") if ex else None,
                "qr_expiry": ln.get("expiry") if ex else None,
                "lot": ln.get("lot") if ex else None})
        return coupons, flags

    async def prescription_detail(self, barcode: str, live: bool = False) -> dict:
        raw = (barcode or "").strip()
        bc = raw.split(":")[0].strip()
        scope_exec: int | None = None     # αν δοθεί barcode:N → δείξε ΜΟΝΟ αυτή τη φάση/εκτέλεση
        if ":" in raw:
            try:
                scope_exec = int(raw.split(":")[1])
            except (ValueError, IndexError):
                scope_exec = None
        if not bc:
            return {"ok": False, "found": False}
        exs = [e async for e in self._db["prescription_executions"].find(
            {"tenant_id": self.tenant_id, "external_id": {"$regex": f"^{re.escape(bc)}"}})]  # tenant-ok
        if not exs:
            return {"ok": True, "found": False, "barcode": bc}
        # περιορισμός σε μία φάση (μερική εκτέλεση) αν ζητήθηκε ρητά
        scoped = [e for e in exs if e.get("external_id") == f"{bc}:{scope_exec}"] if scope_exec is not None else exs
        if not scoped:                    # άγνωστη φάση → δείξε όλη τη συνταγή
            scoped, scope_exec = exs, None
        meta = await self._fund_meta()
        # γνωμάτευση is a PRESCRIPTION-level flag (ΗΔΥΚΑ CDA id 1.1.23) — NOT per medicine. When the
        # user OPENS the Rx (live) we fetch the CDA once → authoritative coupons (executed + QR + lot
        # consistent, no eof-collision) + opinion (cached). The scan path uses our stored items.
        opinion = scoped[0].get("has_opinion")
        cda_lines: list = []
        # PERF: για ΣΥΓΚΕΚΡΙΜΕΝΗ εκτέλεση (scope_exec) τα κουπόνια έρχονται από τα ΑΠΟΘΗΚΕΥΜΕΝΑ items —
        # το live CDA χρειάζεται ΜΟΝΟ για τη γνωμάτευση, που είναι prescription-level & cache-άρεται στο
        # 1ο άνοιγμα. Άρα παρακάμπτουμε την αργή κλήση ΗΔΥΚΑ όταν η γνωμάτευση είναι ήδη γνωστή (π.χ. 2η
        # εκτέλεση της ίδιας συνταγής) → χωρίς καθυστέρηση. (Unscoped/άγνωστη γνωμάτευση → κανονικά.)
        if live and not (scope_exec is not None and opinion is not None):
            from app.services.ingestion.cda_lookup import fetch_cda_info
            try:
                info = await fetch_cda_info(self.tenant_id, self._db, bc)
            except Exception:  # noqa: BLE001
                info = {}
            cda_lines = info.get("lines") or []
            if info.get("opinion") is not None:
                opinion = info["opinion"]
                await self._db["prescription_executions"].update_many(
                    {"tenant_id": self.tenant_id, "external_id": {"$regex": f"^{re.escape(bc)}"}},
                    {"$set": {"has_opinion": opinion}})
        # Το live CDA ΜΠΟΡΕΙ να υστερεί από τα αποθηκευμένα κουπόνια (π.χ. μερική εκτέλεση που
        # μπήκε αργότερα) → διάλεξε την ΠΙΟ ΠΛΗΡΗ πηγή ώστε popup & έλεγχος κλεισίματος να
        # συμφωνούν πάντα στα τεμάχια/QR.
        if scope_exec is not None:
            # ΜΙΑ φάση: τα κουπόνια ΑΥΤΗΣ της εκτέλεσης (το CDA δεν ξεχωρίζει φάσεις → stored)
            lines, flags = await self._rx_lines([e["_id"] for e in scoped], exec_no=scope_exec)
        else:
            cda_l, cda_f = (await self._coupons_from_cda(cda_lines)) if cda_lines else ([], set())
            stored_l, stored_f = await self._rx_lines([e["_id"] for e in exs])
            n_cda = sum(ln.get("quantity", 1) for ln in cda_l if ln.get("executed", True))
            n_stored = sum(ln.get("quantity", 1) for ln in stored_l if ln.get("executed", True))
            if cda_l and n_cda >= n_stored:
                lines, flags = cda_l, cda_f
            else:
                lines, flags = stored_l, stored_f
        return jsonsafe({
            "ok": True, "found": True, "barcode": bc,
            "exec_no": scope_exec,
            "fund": meta.get(scoped[0].get("fund_id"), {}).get("group", "—"),
            "is_eopyy": bool(meta.get(scoped[0].get("fund_id"), {}).get("is_eopyy")),
            "claim": sum(e.get("amount_claimed", 0) for e in scoped),
            "n_coupons": sum(ln.get("quantity", 1) for ln in lines if ln.get("executed", True)),
            "has_opinion": opinion,                    # prescription-level γνωμάτευση (None=unknown)
            "has_vaccine": "vaccine" in flags,
            "has_narcotic": "narcotic" in flags,
            "partial": any(not ln["executed"] for ln in lines),
            **{k: v for k, v in self._submission_flags(scoped[0]).items()
               if k in ("is_intangible", "needs_original", "has_desensitization", "exec_count", "is_etyap")},
            "is_fyk": ("fyk" in flags) or bool((scoped[0].get("details") or {}).get("n3816")),
            "coupons": lines})

    # ── 19. EXECUTIVE DASHBOARD + 18. AI AUDITOR ────────────────────────────
    async def executive(self, period: str | None = None) -> dict:
        period = period or _now().strftime("%Y-%m")
        closing = await self.monthly_closing(period)
        cuts = await self.expected_cuts(period)
        start, end = _month_bounds(period)
        risk_rows = await self._risk_rows(period)
        to_fix = sum(1 for r in risk_rows if r["score"] >= 50)
        # informational only — partial execution is lawful, NOT a cut reason
        partial = await self._db["prescription_executions"].count_documents(
            {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end},
             "status": {"$ne": "cancelled"}, "has_unexecuted_substances": True})
        mismatch = sum(1 for r in risk_rows if "amount_mismatch" in r["flags"])
        # Συνταγές «Αμιγώς 100%» = ΟΛΑ τα φάρμακα με συμμετοχή ασθενή 100% (`details.full_participation`)
        # → ΔΕΝ υποβάλλονται. ΟΧΙ `amount_claimed==0` (25% μπορεί να έχει claim=0· έδινε 10 αντί 4).
        rx_100 = await self._db["prescription_executions"].count_documents(
            {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end},
             "status": {"$ne": "cancelled"}, "amount_total": {"$gt": 0},
             "details.full_participation": True})
        t = closing["totals"]

        insights = []
        if to_fix:
            insights.append({"severity": "critical", "icon": "shield-alert",
                             "text": f"Βρέθηκαν {to_fix} συνταγές υψηλού κινδύνου περικοπής. "
                                     f"Πιθανή απώλεια €{eur_gr(cuts['total'])} — διόρθωσέ τες πριν την υποβολή."})
        if mismatch:
            insights.append({"severity": "warning", "icon": "calculator",
                             "text": f"{mismatch} συνταγές με ασυμφωνία ποσών (ταμείο+συμμετοχή ≠ λιανική)."})
        insights.append({"severity": "info", "icon": "wallet",
                         "text": f"Αναμενόμενη απαίτηση μήνα: €{eur_gr(t['claim'])} "
                                 f"(ΕΟΠΥΥ €{eur_gr(t['eopyy_claim'])} · λοιπά €{eur_gr(t['other_claim'])})."})

        return jsonsafe({
            "period": period,
            "kpis": {
                "rx": t["rx"], "retail": t["retail"], "claim": t["claim"],
                "eopyy_claim": t["eopyy_claim"], "other_claim": t["other_claim"],
                "patient": t["patient"], "gross_profit": t["gross_profit"],
                "expected_cuts": cuts["total"], "to_fix": to_fix,
                "partial": partial, "mismatch": mismatch, "rx_100": rx_100,
            },
            "delta_prev": closing["delta_prev"], "delta_yoy": closing["delta_yoy"],
            "insights": insights,
        })
