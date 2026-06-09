"""Intelligent advisors — Business & Order. Synthesise every signal ΗΔΙΚΑ gives us
into a small set of prioritised, actionable insights so the pharmacist decides from
one screen. Pure read-side aggregation over the existing collections."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository


def _as_oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(v)
    except (InvalidId, TypeError):
        return None


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _pct(a: float, b: float):
    return ((a - b) / b * 100) if b else None


_SEV_ORDER = {"critical": 0, "warning": 1, "opportunity": 2, "info": 3, "positive": 4}


def _sort_insights(ins: list[dict]) -> None:
    ins.sort(key=lambda x: _SEV_ORDER.get(x["severity"], 9))


class AdvisorRepository(BaseRepository):
    collection_name = "prescription_executions"

    # ── shared period metrics ────────────────────────────────────────────
    async def _period(self, df: datetime, dt: datetime) -> dict:
        rows = await self.aggregate([
            {"$match": {"executed_at": {"$gte": df, "$lt": dt}}},
            {"$group": {"_id": None, "rx": {"$sum": 1},
                        "revenue": {"$sum": "$amount_total"},
                        "claimed": {"$sum": "$amount_claimed"},
                        "cost": {"$sum": "$wholesale_cost"},
                        "patient_share": {"$sum": "$patient_share"},
                        "patients": {"$addToSet": "$patient_ref"},
                        "unexec": {"$sum": {"$cond": ["$has_unexecuted_substances", 1, 0]}}}},
        ])
        r = rows[0] if rows else {}
        rev, cost = r.get("revenue", 0) or 0, r.get("cost", 0) or 0
        gp = rev - cost
        return {"rx": r.get("rx", 0) or 0, "revenue": rev, "claimed": r.get("claimed", 0) or 0,
                "cost": cost, "gross_profit": gp, "patient_share": r.get("patient_share", 0) or 0,
                "margin_pct": (gp / rev * 100) if rev else 0,
                "patients": len(r.get("patients", []) or []), "unexec": r.get("unexec", 0) or 0}

    async def _top_dimension(self, df, dt, field) -> tuple:
        rows = await self.aggregate([
            {"$match": {"executed_at": {"$gte": df, "$lt": dt}}},
            {"$group": {"_id": f"${field}", "rev": {"$sum": "$amount_total"}}},
            {"$sort": {"rev": -1}},
        ])
        total = sum(r["rev"] for r in rows) or 1
        return (rows[0] if rows else None), total

    async def _name(self, coll, _id, field):
        if not _id:
            return None
        d = await self._db[coll].find_one({"_id": _id})
        return (d or {}).get(field)

    async def _aging_overdue(self) -> int:
        """Claimed amount executed >90 days ago (still owed by funds)."""
        cutoff = _now() - timedelta(days=90)
        rows = await self.aggregate([
            {"$match": {"executed_at": {"$lt": cutoff}}},
            {"$group": {"_id": None, "claimed": {"$sum": "$amount_claimed"}}},
        ])
        return (rows[0]["claimed"] if rows else 0) or 0

    async def _future_revenue(self, days: int = 30) -> tuple:
        """Expected recurring revenue from pending future prescriptions (count + retail)."""
        fut = BaseRepository(tenant_id=self.tenant_id)
        fut.collection_name = "future_prescriptions"
        today = _now()
        rows = await fut.aggregate([
            {"$match": {"status": "pending",
                        "expected_open_date": {"$gte": today, "$lt": today + timedelta(days=days)}}},
            {"$group": {"_id": None, "n": {"$sum": 1}, "patients": {"$addToSet": "$patient_ref"}}},
        ])
        r = rows[0] if rows else {}
        return r.get("n", 0) or 0, len(r.get("patients", []) or [])

    async def _recent_price_changes(self, days: int = 30) -> dict:
        cutoff = _now() - timedelta(days=days)
        pc = self._db["price_changes"]
        up = await pc.count_documents({"direction": "up", "changed_at": {"$gte": cutoff}})
        down = await pc.count_documents({"direction": "down", "changed_at": {"$gte": cutoff}})
        return {"up": up, "down": down}

    async def _unexec_lost(self, df, dt) -> int:
        items = BaseRepository(tenant_id=self.tenant_id)
        items.collection_name = "prescription_items"
        rows = await items.aggregate([
            {"$match": {"executed_at": {"$gte": df, "$lt": dt}, "is_executed": False}},
            {"$group": {"_id": None, "lost": {"$sum": "$retail_price"}}},
        ])
        return (rows[0]["lost"] if rows else 0) or 0

    # ── business advisor ─────────────────────────────────────────────────
    async def business(self, df: datetime, dt: datetime) -> dict:
        span = dt - df
        cur = await self._period(df, dt)
        prev = await self._period(df - span, df)
        ins: list[dict] = []

        def add(sev, icon, title, detail, metric=None, cta=None):
            ins.append({"severity": sev, "icon": icon, "title": title,
                        "detail": detail, "metric": metric, "cta": cta})

        # 1) revenue trend
        d_rev = _pct(cur["revenue"], prev["revenue"])
        if d_rev is not None:
            if d_rev <= -10:
                add("critical", "trending-down", "Πτώση εσόδων",
                    f"Τα έσοδα έπεσαν {abs(d_rev):.0f}% σε σχέση με την προηγούμενη ίση περίοδο.",
                    f"{d_rev:+.0f}%", {"label": "Δες συνταγές", "href": "/prescriptions"})
            elif d_rev >= 10:
                add("positive", "trending-up", "Άνοδος εσόδων",
                    f"Τα έσοδα αυξήθηκαν {d_rev:.0f}% έναντι της προηγούμενης περιόδου.", f"{d_rev:+.0f}%")

        # 2) margin
        if cur["margin_pct"] < 18 and cur["revenue"] > 0:
            add("warning", "percent", "Χαμηλό περιθώριο",
                f"Το μεικτό περιθώριο είναι {cur['margin_pct']:.1f}% — κάτω από το υγιές ~20%. Δες ποια σκευάσματα το πιέζουν.",
                f"{cur['margin_pct']:.1f}%", {"label": "Κερδοφορία", "href": "/profitability"})
        else:
            d_m = (cur["margin_pct"] - prev["margin_pct"])
            if d_m <= -2:
                add("warning", "percent", "Συρρίκνωση περιθωρίου",
                    f"Το περιθώριο μειώθηκε κατά {abs(d_m):.1f} μονάδες ({prev['margin_pct']:.1f}% → {cur['margin_pct']:.1f}%).",
                    f"{cur['margin_pct']:.1f}%", {"label": "Κερδοφορία", "href": "/profitability"})

        # 3) receivables overdue
        overdue = await self._aging_overdue()
        if overdue > 50000:
            add("critical", "wallet", "Καθυστερημένες απαιτήσεις",
                f"€{overdue/100:,.0f} αιτούμενα από ταμεία με εκτέλεση πάνω από 90 ημέρες — διεκδίκησε/έλεγξε εκκαθαρίσεις.",
                f"€{overdue/100:,.0f}", {"label": "Ταμειακή ροή", "href": "/profitability"})

        # 4) lost value (unexecuted)
        lost = await self._unexec_lost(df, dt)
        if lost > 0:
            add("opportunity", "alert-triangle", "Χαμένη αξία από ανεκτέλεστες",
                f"€{lost/100:,.0f} σε δραστικές που δεν εκτελέστηκαν. Επικοινώνησε με τους ασθενείς να τις ολοκληρώσουν.",
                f"€{lost/100:,.0f}", {"label": "Ανεκτέλεστες", "href": "/prescriptions"})

        # 5) doctor concentration
        top_doc, doc_total = await self._top_dimension(df, dt, "doctor_id")
        if top_doc and doc_total:
            share = top_doc["rev"] / doc_total * 100
            if share >= 15:
                nm = await self._name("doctors", top_doc["_id"], "full_name")
                add("info", "stethoscope", "Εξάρτηση από ιατρό",
                    f"Ο/Η {nm or 'κορυφαίος ιατρός'} φέρνει το {share:.0f}% των εσόδων. Καλλιέργησε τη σχέση — αλλά πρόσεξε τη συγκέντρωση.",
                    f"{share:.0f}%", {"label": "Ιατροί", "href": "/doctors"})

        # 6) future recurring revenue
        fut_n, fut_pat = await self._future_revenue(30)
        if fut_n > 0:
            add("opportunity", "calendar-clock", "Επερχόμενη επαναλαμβανόμενη ζήτηση",
                f"{fut_n} συνταγές ({fut_pat} ασθενείς) αναμένονται τις επόμενες 30 ημέρες. Προετοίμασε απόθεμα & υπενθυμίσεις.",
                f"{fut_n}", {"label": "Μελλοντικές", "href": "/future"})

        # 7) price changes
        pcg = await self._recent_price_changes(30)
        if pcg["up"] + pcg["down"] > 0:
            add("info", "tag", "Αλλαγές τιμών στον τιμοκατάλογο",
                f"{pcg['up']} φάρμακα ακρίβυναν και {pcg['down']} έπεσαν τον τελευταίο μήνα — επηρεάζουν κόστος & παραγγελίες.",
                f"↑{pcg['up']} / ↓{pcg['down']}", {"label": "Σύμβουλος παραγγελίας", "href": "/order-advisor"})

        # 8) new vs returning patients
        d_pat = _pct(cur["patients"], prev["patients"])
        if d_pat is not None and d_pat <= -10:
            add("warning", "users", "Πτώση πελατείας",
                f"Οι μοναδικοί ασθενείς μειώθηκαν {abs(d_pat):.0f}%. Δες retention & ποιες κατηγορίες χάνεις.",
                f"{d_pat:+.0f}%", {"label": "Ασφαλισμένοι", "href": "/patients"})

        _sort_insights(ins)

        return {
            "period": {"from": df.date().isoformat(), "to": dt.date().isoformat()},
            "kpis": {
                "revenue": {"value": cur["revenue"], "delta": _pct(cur["revenue"], prev["revenue"])},
                "gross_profit": {"value": cur["gross_profit"], "delta": _pct(cur["gross_profit"], prev["gross_profit"])},
                "margin_pct": {"value": cur["margin_pct"], "delta": cur["margin_pct"] - prev["margin_pct"]},
                "rx": {"value": cur["rx"], "delta": _pct(cur["rx"], prev["rx"])},
                "claimed": {"value": cur["claimed"], "delta": _pct(cur["claimed"], prev["claimed"])},
                "patients": {"value": cur["patients"], "delta": _pct(cur["patients"], prev["patients"])},
            },
            "insights": ins,
        }

    # ── order advisor ────────────────────────────────────────────────────
    async def orders(self, *, lead_days: int = 7, safety_pct: float = 15.0) -> dict:
        from app.repositories.future import FuturePrescriptionRepository
        fr = FuturePrescriptionRepository(tenant_id=self.tenant_id)
        today = _now()
        suggestions = await fr.order_suggestions(
            today=today, lead_horizon=today + timedelta(days=lead_days), safety_stock_pct=safety_pct)
        upcoming = await fr.upcoming_list(today=today, horizon=today + timedelta(days=lead_days), limit=500)

        # price-increase alerts on suggested items → buy before the rise
        cutoff = today - timedelta(days=45)
        rising = {c["_id"] async for c in self._db["price_changes"].find(
            {"direction": "up", "changed_at": {"$gte": cutoff}}, {"_id": 1})}
        # tag suggestions whose eofCode recently rose (product.barcode == eofCode)
        for s in suggestions:
            pid = s.get("product_id")
            prod = await self._db["products"].find_one({"_id": _as_oid(pid)}, {"barcode": 1}) if pid else None
            s["price_rising"] = bool(prod and prod.get("barcode") in rising)

        total_qty = sum(s.get("suggested_qty", 0) for s in suggestions)
        total_cost = sum(s.get("est_cost", 0) for s in suggestions)
        rising_items = [s for s in suggestions if s.get("price_rising")]

        ins: list[dict] = []

        def add(sev, icon, title, detail, metric=None, cta=None):
            ins.append({"severity": sev, "icon": icon, "title": title,
                        "detail": detail, "metric": metric, "cta": cta})

        if total_qty > 0:
            add("opportunity", "package-search", "Προτεινόμενη παραγγελία",
                f"{len(suggestions)} σκευάσματα · {total_qty} τεμάχια · εκτ. κόστος €{total_cost/100:,.0f} για κάλυψη {lead_days} ημερών (+{safety_pct:.0f}% ασφάλεια).",
                f"€{total_cost/100:,.0f}", {"label": "Δες προτάσεις", "href": "/orders"})
        if rising_items:
            names = ", ".join(s.get("product_name", "?") for s in rising_items[:3])
            add("warning", "tag", "Ακριβαίνουν — παράγγειλε τώρα",
                f"{len(rising_items)} προτεινόμενα ακρίβυναν πρόσφατα ({names}{'…' if len(rising_items) > 3 else ''}). Παράγγειλε πριν εξαντληθεί το παλιό κόστος.",
                f"{len(rising_items)}")
        if upcoming:
            soon = [u for u in upcoming if u.get("patient_name")]
            add("opportunity", "calendar-clock", "Ασθενείς για υπενθύμιση",
                f"{len(upcoming)} επερχόμενες συνταγές τις επόμενες {lead_days} ημέρες — ειδοποίησε τους ασθενείς να εξασφαλίσεις την πώληση.",
                f"{len(soon)}", {"label": "Μελλοντικές", "href": "/future"})

        _sort_insights(ins)
        return {
            "kpis": {"items": len(suggestions), "qty": total_qty,
                     "cost": total_cost, "rising": len(rising_items)},
            "insights": ins,
            "suggestions": suggestions[:50],
            "upcoming": upcoming[:50],
        }
