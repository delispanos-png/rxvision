"""RxVision Reimbursement Intelligence — a digital ΕΟΠΥΥ auditor inside the pharmacy.

Turns the monthly claim/submission/reimbursement cycle into a controlled, data-driven workflow:
monthly closing financials, claim forecast, a per-prescription risk engine, expected-cuts
estimation, a pre-submission audit and an executive dashboard. Computed from the ΗΔΙΚΑ amount
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
            grp, is_eo = grouping.get(code, (name, False))
            out[f["_id"]] = {"name": name, "group": grp, "is_eopyy": is_eo}
        return out

    # ── 1. MONTHLY CLOSING ──────────────────────────────────────────────────
    async def _period_money(self, period: str) -> dict:
        start, end = _month_bounds(period)
        rows = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}}},
            {"$group": {"_id": None, "rx": {"$sum": 1},
                        "retail": {"$sum": "$amount_total"}, "claim": {"$sum": "$amount_claimed"},
                        "patient": {"$sum": "$patient_share"}, "cost": {"$sum": "$wholesale_cost"}}},
        ]).to_list(1)
        r = rows[0] if rows else {}
        return {"rx": r.get("rx", 0), "retail": r.get("retail", 0), "claim": r.get("claim", 0),
                "patient": r.get("patient", 0), "cost": r.get("cost", 0)}

    async def monthly_closing(self, period: str) -> dict:
        start, end = _month_bounds(period)
        meta = await self._fund_meta()
        match = {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}}

        by_day = [{"day": r["_id"], "rx": r["rx"], "claim": r["claim"]}
                  for r in await self._db["prescription_executions"].aggregate([
                      {"$match": match},
                      {"$group": {"_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$executed_at"}},
                                  "rx": {"$sum": 1}, "claim": {"$sum": "$amount_claimed"}}},
                      {"$sort": {"_id": 1}}]).to_list(None)]

        by_fund_raw = await self._db["prescription_executions"].aggregate([
            {"$match": match},
            {"$group": {"_id": "$fund_id", "rx": {"$sum": 1}, "retail": {"$sum": "$amount_total"},
                        "claim": {"$sum": "$amount_claimed"}, "patient": {"$sum": "$patient_share"}}},
            {"$sort": {"claim": -1}}]).to_list(None)
        grouped: dict = defaultdict(lambda: {"rx": 0, "retail": 0, "claim": 0, "patient": 0, "is_eopyy": False})
        for f in by_fund_raw:
            m = meta.get(f["_id"], {"group": "—", "is_eopyy": False})
            g = grouped[m["group"]]
            g["rx"] += f["rx"]; g["retail"] += f["retail"]; g["claim"] += f["claim"]; g["patient"] += f["patient"]
            g["is_eopyy"] = m["is_eopyy"]
        by_fund = [{"fund": k, "is_eopyy": v["is_eopyy"], "rx": v["rx"], "retail": v["retail"],
                    "claim": v["claim"], "patient": v["patient"]} for k, v in grouped.items()]
        by_fund.sort(key=lambda x: x["claim"], reverse=True)
        eopyy_claim = sum(b["claim"] for b in by_fund if b["is_eopyy"])
        other_claim = sum(b["claim"] for b in by_fund if not b["is_eopyy"])

        by_cat = [{"category": (r["_id"] or "—"), "rx": r["rx"], "claim": r["claim"]}
                  for r in await self._db["prescription_executions"].aggregate([
                      {"$match": match},
                      {"$lookup": {"from": "prescription_items", "localField": "_id",
                                   "foreignField": "execution_id", "as": "it"}},
                      {"$unwind": "$it"},
                      {"$group": {"_id": "$it.category", "rx": {"$sum": 1}, "claim": {"$sum": "$it.amount_claimed"}}},
                      {"$sort": {"claim": -1}}]).to_list(None)]

        cur = await self._period_money(period)
        prev = await self._period_money(_prev_period(period))
        yoy = await self._period_money(_yoy_period(period))
        return jsonsafe({
            "period": period,
            "totals": {**cur, "net_claim": cur["claim"], "eopyy_claim": eopyy_claim, "other_claim": other_claim,
                       "gross_profit": cur["retail"] - cur["cost"]},
            "delta_prev": {k: _pct(cur[k], prev[k]) for k in ("rx", "retail", "claim", "patient")},
            "delta_yoy": {k: _pct(cur[k], yoy[k]) for k in ("rx", "retail", "claim", "patient")},
            "by_day": by_day, "by_fund": by_fund, "by_category": by_cat,
        })

    # ── 2. CLAIM FORECAST ───────────────────────────────────────────────────
    async def forecast(self) -> dict:
        """Expected receipts per fund, projected from the last 3 closed months' average."""
        now = _now()
        months = []
        y, m = now.year, now.month
        for _ in range(3):
            m -= 1
            if m == 0:
                y, m = y - 1, 12
            months.append(f"{y:04d}-{m:02d}")
        meta = await self._fund_meta()
        acc: dict = defaultdict(lambda: {"claim": 0, "is_eopyy": False})
        n_months = 0
        for per in months:
            start, end = _month_bounds(per)
            rows = await self._db["prescription_executions"].aggregate([
                {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}}},
                {"$group": {"_id": "$fund_id", "claim": {"$sum": "$amount_claimed"}}}]).to_list(None)
            if rows:
                n_months += 1
            for r in rows:
                m = meta.get(r["_id"], {"group": "—", "is_eopyy": False})
                acc[m["group"]]["claim"] += r["claim"]
                acc[m["group"]]["is_eopyy"] = m["is_eopyy"]
        out = [{"fund": grp, "is_eopyy": a["is_eopyy"],
                "expected_monthly": round(a["claim"] / max(n_months, 1))} for grp, a in acc.items()]
        out.sort(key=lambda x: x["expected_monthly"], reverse=True)
        return jsonsafe({"months_used": months, "by_fund": out,
                         "expected_total": sum(o["expected_monthly"] for o in out)})

    # ── 5. RISK ENGINE + 6. EXPECTED CUTS + 3. AUDIT ────────────────────────
    async def _risk_rows(self, period: str) -> list[dict]:
        start, end = _month_bounds(period)
        rows = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}}},
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
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}}},
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
        out.sort(key=lambda x: x["expected_claim"], reverse=True)
        counts: dict = defaultdict(int)
        for b in out:
            counts[b["status"]] += 1
        return jsonsafe({"period": period, "batches": out,
                         "status_counts": {s: counts.get(s, 0) for s in self.STATUSES}})

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
    async def physical_check(self, period: str, day: str | None = None) -> dict:
        """All distinct prescription barcodes we hold for the month + their scan status, plus the
        'extra' barcodes scanned that we DON'T have. Optional `day` (YYYY-MM-DD) narrows to one day
        (daily reconciliation); `by_day` always lists per-day counts for the day picker."""
        start, end = _month_bounds(period)
        meta = await self._fund_meta()
        rows = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}}},
            {"$group": {"_id": {"$arrayElemAt": [{"$split": ["$external_id", ":"]}, 0]},
                        "claim": {"$sum": "$amount_claimed"}, "fund_id": {"$first": "$fund_id"},
                        "executed_at": {"$min": "$executed_at"}}},
        ]).to_list(None)
        session = await self._db["barcode_check"].find_one(
            {"tenant_id": self.tenant_id, "period": period}) or {}
        checked = set(session.get("checked", []))
        allrows = [{"barcode": r["_id"], "claim": r["claim"], "executed_at": r["executed_at"],
                    "day": r["executed_at"].strftime("%Y-%m-%d") if r.get("executed_at") else None,
                    "fund": meta.get(r["fund_id"], {}).get("group", "—"),
                    "checked": r["_id"] in checked} for r in rows]
        by_day: dict = {}
        for it in allrows:
            d = by_day.setdefault(it["day"], {"date": it["day"], "total": 0, "checked": 0})
            d["total"] += 1
            d["checked"] += 1 if it["checked"] else 0
        items = [i for i in allrows if i["day"] == day] if day else allrows
        items.sort(key=lambda x: (x["checked"], -x["claim"]))  # unchecked, by € first
        checked_n = sum(1 for i in items if i["checked"])
        return jsonsafe({
            "period": period, "day": day, "total": len(items), "checked": checked_n,
            "remaining": len(items) - checked_n, "extra": session.get("extra", []),
            "by_day": sorted(by_day.values(), key=lambda x: x["date"] or ""), "items": items})

    async def physical_scan(self, period: str, barcode: str) -> dict:
        bc = (barcode or "").strip().split(":")[0].strip()
        if not bc:
            return {"ok": False, "error": "empty"}
        start, end = _month_bounds(period)
        ex = await self._db["prescription_executions"].find_one(
            {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end},
             "external_id": {"$regex": f"^{re.escape(bc)}"}})  # tenant-ok: scoped by tenant_id
        found = bool(ex)
        field = "checked" if found else "extra"
        await self._db["barcode_check"].update_one(
            {"tenant_id": self.tenant_id, "period": period},
            {"$addToSet": {field: bc}, "$set": {"updated_at": _now()}}, upsert=True)
        return {"ok": True, "found": found, "barcode": bc}

    async def physical_reset(self, period: str) -> dict:
        await self._db["barcode_check"].delete_one({"tenant_id": self.tenant_id, "period": period})
        return {"ok": True}

    # ── DAILY RECONCILIATION — amounts + execution counts per day (vs the pharmacist's program) ─
    async def daily_reconciliation(self, period: str) -> dict:
        start, end = _month_bounds(period)
        rows = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": start, "$lt": end}}},
            {"$group": {
                "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$executed_at"}},
                "barcodes": {"$addToSet": {"$arrayElemAt": [{"$split": ["$external_id", ":"]}, 0]}},
                "executions": {"$sum": 1}, "claim": {"$sum": "$amount_claimed"},
                "retail": {"$sum": "$amount_total"}, "patient": {"$sum": "$patient_share"}}},
            {"$sort": {"_id": 1}},
        ]).to_list(None)
        days = [{"date": r["_id"], "rx": len(r["barcodes"]), "executions": r["executions"],
                 "claim": r["claim"], "retail": r["retail"], "patient": r["patient"]} for r in rows]
        tot = {k: sum(d[k] for d in days) for k in ("rx", "executions", "claim", "retail", "patient")}
        tot["days"] = len(days)
        return jsonsafe({"period": period, "days": days, "totals": tot})

    # ── ADVANCED PER-PRESCRIPTION DETAIL — coupons (medicine lines) + submission flags ──────────
    async def _rx_lines(self, ex_ids: list) -> tuple:
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
        lines, flags = [], set()
        for it in items:
            p = prods.get(str(it.get("product_id")), {})
            c = cat_by_key.get(p.get("barcode"), {})
            cat = it.get("category") or p.get("category") or "normal"
            flags.add(cat)
            lines.append({"name": c.get("full_name") or p.get("name") or "—",
                          "barcode": p.get("barcode"), "eof": c.get("_id") or p.get("barcode"),
                          "quantity": it.get("quantity"), "category": cat,
                          "executed": bool(it.get("is_executed", True))})
        return lines, flags

    async def prescription_detail(self, barcode: str, live: bool = False) -> dict:
        bc = (barcode or "").split(":")[0].strip()
        if not bc:
            return {"ok": False, "found": False}
        exs = [e async for e in self._db["prescription_executions"].find(
            {"tenant_id": self.tenant_id, "external_id": {"$regex": f"^{re.escape(bc)}"}})]  # tenant-ok
        if not exs:
            return {"ok": True, "found": False, "barcode": bc}
        meta = await self._fund_meta()
        lines, flags = await self._rx_lines([e["_id"] for e in exs])
        # γνωμάτευση is a PRESCRIPTION-level flag (ΗΔΙΚΑ CDA id 1.1.23) — NOT per medicine. Read the
        # cached `has_opinion`; if absent and live (user opened the prescription), fetch the CDA once
        # and cache it on every execution of this barcode (gentle, one ΗΔΙΚΑ call per Rx ever).
        opinion = exs[0].get("has_opinion")
        qr_by_eof: dict = {}
        if live:  # explicit open → one CDA call: prescription γνωμάτευση + per-coupon QR flags
            from app.services.ingestion.cda_lookup import fetch_cda_info
            try:
                info = await fetch_cda_info(self.tenant_id, self._db, bc)
            except Exception:  # noqa: BLE001
                info = {}
            qr_by_eof = info.get("qr_by_eof", {})
            if info.get("opinion") is not None:
                opinion = info["opinion"]
                await self._db["prescription_executions"].update_many(
                    {"tenant_id": self.tenant_id, "external_id": {"$regex": f"^{re.escape(bc)}"}},
                    {"$set": {"has_opinion": opinion}})
        for ln in lines:  # QR coupon (HMVS) → auto-verified; ΕΟΦ ταινία → physical check needed
            ln["qr"] = qr_by_eof.get(str(ln.get("eof"))) if qr_by_eof else None
        return jsonsafe({
            "ok": True, "found": True, "barcode": bc,
            "fund": meta.get(exs[0].get("fund_id"), {}).get("group", "—"),
            "claim": sum(e.get("amount_claimed", 0) for e in exs), "n_coupons": len(lines),
            "has_opinion": opinion,                    # prescription-level γνωμάτευση (None=unknown)
            "is_fyk": "fyk" in flags, "has_vaccine": "vaccine" in flags,
            "has_narcotic": "narcotic" in flags,
            "partial": any(not ln["executed"] for ln in lines),
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
             "has_unexecuted_substances": True})
        mismatch = sum(1 for r in risk_rows if "amount_mismatch" in r["flags"])
        t = closing["totals"]

        insights = []
        if to_fix:
            insights.append({"severity": "critical", "icon": "shield-alert",
                             "text": f"Βρέθηκαν {to_fix} συνταγές υψηλού κινδύνου περικοπής. "
                                     f"Πιθανή απώλεια €{cuts['total']/100:,.0f} — διόρθωσέ τες πριν την υποβολή."})
        if mismatch:
            insights.append({"severity": "warning", "icon": "calculator",
                             "text": f"{mismatch} συνταγές με ασυμφωνία ποσών (ταμείο+συμμετοχή ≠ λιανική)."})
        insights.append({"severity": "info", "icon": "wallet",
                         "text": f"Αναμενόμενη απαίτηση μήνα: €{t['claim']/100:,.0f} "
                                 f"(ΕΟΠΥΥ €{t['eopyy_claim']/100:,.0f} · λοιπά €{t['other_claim']/100:,.0f})."})

        return jsonsafe({
            "period": period,
            "kpis": {
                "rx": t["rx"], "retail": t["retail"], "claim": t["claim"],
                "eopyy_claim": t["eopyy_claim"], "other_claim": t["other_claim"],
                "patient": t["patient"], "gross_profit": t["gross_profit"],
                "expected_cuts": cuts["total"], "to_fix": to_fix,
                "partial": partial, "mismatch": mismatch,
            },
            "delta_prev": closing["delta_prev"], "delta_yoy": closing["delta_yoy"],
            "insights": insights,
        })
