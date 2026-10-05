"""Κερδοφορία — ΕΝΑΣ ορισμός κέρδους για κάθε πάνελ της σελίδας.

ΜΕΙΚΤΟ ΚΕΡΔΟΣ = λιανική αξία ΧΩΡΙΣ ΦΠΑ − κόστος χονδρικής (δες [[product-profitability-spec]]).
Η χονδρική είναι χωρίς ΦΠΑ, η λιανική της ΗΔΥΚΑ με ΦΠΑ → ΟΛΑ τα έσοδα της σελίδας είναι ΚΑΘΑΡΑ
(services/vat.py, 05/10/2026). Πριν: λιανική με ΦΠΑ − χονδρική → κέρδος +~5,7% των πωλήσεων.

Η ΑΡΧΗ ΠΟΥ ΚΡΑΤΑ ΤΑ ΝΟΥΜΕΡΑ ΣΥΜΦΩΝΑ: το σύνολο ΚΑΘΕ ΕΚΤΕΛΕΣΗΣ (`amount_total`, από την ΗΔΥΚΑ) και
το κόστος της (`wholesale_cost`) είναι η αλήθεια. Τα είδη της συνταγής ΔΕΝ έχουν δικά τους
«ανεξάρτητα» ποσά — απλώς ΜΟΙΡΑΖΟΥΝ το σύνολο της εκτέλεσης, αναλογικά με την αξία που δόθηκε.
Έτσι ανά ταμείο / ιατρό / σκεύασμα / κατηγορία αθροίζουν ΑΚΡΙΒΩΣ στην κεφαλίδα.

Πριν (μετρημένο 27/09/2026, ίδιος μήνας, ίδια σελίδα): κεφαλίδα 4.145€, «ανά σκεύασμα» 5.578€,
«ανά κατηγορία» 7.496€ (+81%). Τρεις πηγές (σύνολο εκτέλεσης · λιανική γραμμής × τεμάχια
ΣΥΝΤΑΓΗΣ · ΜΕΓΙΣΤΗ ιστορική λιανική προϊόντος) έδιναν τρία κέρδη για τον ίδιο μήνα.

ΤΙ ΜΕΤΡΑΕΙ: μόνο εκτελέσεις που μετρούν στα στατιστικά — όχι ακυρωμένες, όχι όσες εξαίρεσε ο
φαρμακοποιός (`stats_exclusion`). Πριν, μία λάθος εγγραφή 16.162.808€ έκανε το περιθώριο ενός
φαρμακείου 2,0% αντί για 27,5%.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from app.repositories.base import BaseRepository
from app.services import dispensed, vat
from app.services.stats_exclusion import COUNTABLE_EXEC

#: Ετικέτα για αξία που δεν μπορεί να αποδοθεί σε σκεύασμα (εκτέλεση χωρίς δοσμένα είδη με
#: γνωστή τιμή). Δεν πετιέται — αλλιώς τα μέρη δεν θα έβγαζαν το σύνολο.
UNALLOCATED = "Χωρίς ανάλυση ανά σκεύασμα"
NO_DIAGNOSIS = "Χωρίς διάγνωση"
OTHERS = "Όλα τα υπόλοιπα"


def countable(date_from: datetime, date_to: datetime) -> dict:
    """ΤΟ φίλτρο κάθε ερωτήματος κερδοφορίας. Ίδιο με το κύκλωμα αποζημίωσης."""
    return {"executed_at": {"$gte": date_from, "$lt": date_to}, **COUNTABLE_EXEC}


def _pct(profit: float, value: float) -> float:
    return (profit / value * 100) if value else 0.0


def _row(label: str, value: float, cost: float, **extra) -> dict:
    gp = round(value - cost)
    return {"label": label, "value": round(value), "cost": round(cost),
            "gross_profit": gp, "margin_pct": _pct(gp, value), **extra}


def _top(rows: list[dict], limit: int) -> list[dict]:
    """Κορυφαίες `limit` γραμμές + ΜΙΑ «Όλα τα υπόλοιπα», ώστε το γράφημα να αθροίζει στο σύνολο."""
    rows.sort(key=lambda r: r["gross_profit"], reverse=True)
    if len(rows) <= limit:
        return rows
    head, rest = rows[:limit], rows[limit:]
    v = sum(r["value"] for r in rest)
    c = sum(r["cost"] for r in rest)
    return head + [_row(f"{OTHERS} ({len(rest)})", v, c, units=sum(r.get("units", 0) for r in rest))]


# ── χάρτης προσοχής: σταθερές & καθαρές συναρτήσεις (ελέγχονται χωρίς βάση) ───────────────
_ATTENTION_DIMS = ("category", "kind", "price_band", "fund")
#: Κάτω από αυτό το βάρος (% εσόδων ΚΑΙ % κέρδους) μια ενότητα δεν αλλάζει την εικόνα.
MIN_SHARE_PCT = 2.0
#: Απόκλιση περιθωρίου από τον μέσο όρο του φαρμακείου για να «πιέζει» / να «βοηθά» (±10%).
BAND = 0.10
_KIND_HIGH_COST = "ΦΥΚ (υψηλού κόστους)"
_PRICE_BANDS = ((1000, "έως 10€"), (3000, "10–30€"), (10000, "30–100€"),
                (30000, "100–300€"), (None, "πάνω από 300€"))


def _kind(product: dict, flags: dict | None) -> str:
    """Είδος σκευάσματος. Σειρά = ό,τι επηρεάζει περισσότερο το κέρδος/κεφάλαιο κερδίζει."""
    f = flags or {}
    if f.get("high_cost"):
        return _KIND_HIGH_COST
    if f.get("hospital_medicine"):
        return "Νοσοκομειακά"
    if f.get("narcotic") or product.get("category") == "narcotic":
        return "Ναρκωτικά"
    if product.get("category") == "galenic":
        return "Γαληνικά"
    if f.get("is_antibiotic"):
        return "Αντιβιοτικά"
    return "Κοινά σκευάσματα" if flags is not None else "Εκτός καταλόγου ΗΔΥΚΑ"


def _price_band(unit_cents: float | None) -> str:
    """Κλιμάκιο λιανικής ανά συσκευασία (όπως δόθηκε στην περίοδο)."""
    if not unit_cents:
        return UNALLOCATED
    return next(lab for hi, lab in _PRICE_BANDS if hi is None or unit_cents < hi)


def _classify(groups: dict, prev: dict) -> list[dict]:
    """Κάθε ενότητα: βάρος, περιθώριο, επίδραση € έναντι του μέσου όρου, σύγκριση με την
    προηγούμενη περίοδο, και ετυμηγορία pressure / helps / neutral (με αιτία).

    Ο μέσος όρος βγαίνει ΑΠΟ ΤΗΝ ΙΔΙΑ τη διάσταση: στο ταμείο είναι μετά τις περικοπές, στις
    άλλες πριν. Με κοινό μέσο όρο, όταν υπάρχουν περικοπές, όλες οι κατηγορίες θα έβγαιναν «βοηθούν»."""
    total_value = sum(g[0] for g in groups.values())
    total_net = sum(g[0] - g[1] - (g[2] if len(g) > 2 else 0) for g in groups.values())
    avg = total_net / total_value if total_value else 0.0
    out = []
    for label, (v, c, *rest) in groups.items():
        cut = rest[0] if rest else 0
        net = v - c - cut
        p = prev.get(label)
        prev_net = (p[0] - p[1] - (p[2] if len(p) > 2 else 0)) if p else None
        rev_share = _pct(v, total_value)
        profit_share = _pct(net, total_net) if total_net else 0.0
        margin = _pct(net, v)
        idx = (margin / 100 / avg) if avg and v else 1.0
        if label == UNALLOCATED:
            verdict, reason = "neutral", "unallocated"
        elif rev_share < MIN_SHARE_PCT and abs(profit_share) < MIN_SHARE_PCT:
            verdict, reason = "neutral", "small"   # ακόμη και με ζημιά: 10€ δεν αλλάζουν την εικόνα
        elif net < 0:
            verdict, reason = "pressure", "loss"
        elif idx <= 1 - BAND:
            verdict, reason = "pressure", "cuts" if cut and _pct(cut, v - c) >= 5 else "below_avg"
        elif idx >= 1 + BAND:
            verdict, reason = "helps", "above_avg"
        else:
            verdict, reason = "neutral", "near_avg"
        out.append({"label": label, "value": round(v), "cost": round(c), "cuts": round(cut),
                    "profit": round(net), "margin_pct": margin,
                    "return_on_capital_pct": _pct(net, c),
                    "revenue_share_pct": rev_share, "profit_share_pct": profit_share,
                    "impact": round(net - v * avg),
                    "prev_profit": round(prev_net) if prev_net is not None else None,
                    "delta_profit": round(net - prev_net) if prev_net is not None else None,
                    "verdict": verdict, "reason": reason})
    out.sort(key=lambda r: r["impact"])
    return out


def _focus(dims: list[dict], total_net: float, limit: int = 6) -> list[dict]:
    """«Πού να στρέψεις την προσοχή»: η χειρότερη πίεση ΚΑΘΕ διάστασης, οι δύο μεγαλύτερες
    βοήθειες, και οι μεγαλύτερες ΠΤΩΣΕΙΣ θεραπευτικών κατηγοριών έναντι της ίδιας περιόδου πέρσι.
    Όχι όλες οι πιέσεις μιας διάστασης: η ίδια αιτία (π.χ. ακριβά) φαίνεται ήδη σε δύο διαστάσεις."""
    floor = abs(total_net) * 0.01
    items: list[dict] = []
    for d in dims:
        worst = [s for s in d["segments"] if s["verdict"] == "pressure" and -s["impact"] >= floor]
        if worst:
            items.append({"type": "pressure", "dim": d["key"], **worst[0]})
    helps = sorted((dict(s, dim=d["key"]) for d in dims for s in d["segments"]
                    if s["verdict"] == "helps" and s["impact"] >= floor),
                   key=lambda s: -s["impact"])
    items += [{"type": "helps", **s} for s in helps[:2]]
    cat: dict = next((d for d in dims if d["key"] == "category"), {"segments": []})
    drops = sorted((s for s in cat["segments"]
                    if s["delta_profit"] is not None and s["prev_profit"]
                    and s["prev_profit"] > 0 and s["label"] != UNALLOCATED
                    and -s["delta_profit"] >= max(floor, s["prev_profit"] * 0.10)),
                   key=lambda s: s["delta_profit"])
    items += [{"type": "decline", "dim": "category", **s} for s in drops[:2]]
    order = {"pressure": 0, "decline": 1, "helps": 2}
    items.sort(key=lambda i: (order[i["type"]], -abs(i["impact"] if i["type"] != "decline"
                                                    else i["delta_profit"])))
    return items[:limit]


class ProfitabilityRepository(BaseRepository):
    collection_name = "prescription_executions"

    async def _div(self) -> float:
        """Λιανική με ΦΠΑ ÷ αυτό = καθαρή. Ο συντελεστής του φαρμακείου (services/vat.py)."""
        if getattr(self, "_vat_div", None) is None:
            self._vat_div = vat.divisor(await vat.pct_for(self.tenant_id, self._db))
        return self._vat_div

    # ── κεφαλίδα ────────────────────────────────────────────────────────────────
    async def range_summary(self, *, date_from: datetime, date_to: datetime) -> dict:
        rows = await self.aggregate([
            {"$match": countable(date_from, date_to)},
            {"$group": {"_id": None, "rx_count": {"$sum": 1},
                        "amount_total": {"$sum": "$amount_total"},
                        "amount_claimed": {"$sum": "$amount_claimed"},
                        "patient_share": {"$sum": "$patient_share"},
                        "wholesale_cost": {"$sum": "$wholesale_cost"}}},
        ])
        r = rows[0] if rows else {}
        total = r.get("amount_total", 0) or 0
        revenue = total / await self._div()          # ΚΑΘΑΡΕΣ πωλήσεις (χωρίς ΦΠΑ)
        cost = r.get("wholesale_cost", 0) or 0
        gp = revenue - cost
        out = {"rx_count": r.get("rx_count", 0), "revenue": round(revenue), "cost": cost,
               "vat": round(total - revenue), "vat_pct": round((await self._div() - 1) * 100, 2),
               "amount_total": total, "amount_claimed": r.get("amount_claimed", 0) or 0,
               "patient_share": r.get("patient_share", 0) or 0, "wholesale_cost": cost,
               "gross_profit": round(gp), "margin_pct": _pct(gp, revenue)}
        out["estimated_cost_pct"] = await self._estimated_cost_pct(date_from, date_to)
        out.update(await self._fund_cuts(date_from, date_to, gp))
        return out

    async def _estimated_cost_pct(self, date_from: datetime, date_to: datetime) -> float:
        """Τι ποσοστό του κόστους είναι ΕΚΤΙΜΗΣΗ (από την κλίμακα διατίμησης), όχι πραγματική
        χονδρική. Ο φαρμακοποιός πρέπει να ξέρει πόσο «σκληρό» είναι το νούμερο που βλέπει."""
        rows = await self.aggregate([
            {"$match": countable(date_from, date_to)},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "l",
                         "pipeline": [{"$set": {"_q": dispensed.qty_expr()}},
                                      {"$match": {"_q": {"$gt": 0}}},
                                      {"$project": {"wholesale_source": 1, "w": {"$multiply": [
                                          {"$ifNull": ["$wholesale_price", 0]}, "$_q"]}}}]}},
            {"$unwind": "$l"},
            {"$group": {"_id": None, "all": {"$sum": "$l.w"}, "est": {"$sum": {"$cond": [
                {"$eq": ["$l.wholesale_source", "estimated"]}, "$l.w", 0]}}}},
        ])
        r = rows[0] if rows else {}
        return _pct(r.get("est", 0), r.get("all", 0))

    async def _fund_cuts(self, date_from: datetime, date_to: datetime, gross: int) -> dict:
        """Περικοπές ταμείων στους μήνες της περιόδου — από το κύκλωμα αποζημίωσης.

        ΓΙΑΤΙ ΑΝΗΚΕΙ ΣΤΗΝ ΚΕΡΔΟΦΟΡΙΑ: ό,τι αιτήθηκες και δεν πληρώθηκε ποτέ είναι κέρδος που δεν
        υπήρξε. Μετράμε ΜΟΝΟ μήνες που ο φαρμακοποιός σημείωσε «εξοφλήθηκε» — πριν από αυτό η
        διαφορά είναι ανοιχτό υπόλοιπο, όχι περικοπή."""
        from app.repositories.reimbursement import ReimbursementRepository
        now = datetime.now(tz=timezone.utc)
        months = (now.year - date_from.year) * 12 + (now.month - date_from.month) + 1
        if months < 1:
            return {"fund_cuts": 0, "net_profit": gross, "cut_months_settled": 0}
        rec = await ReimbursementRepository(tenant_id=self.tenant_id).receivables(
            months_back=min(months, 36))
        lo, hi = date_from.strftime("%Y-%m"), (date_to - timedelta(seconds=1)).strftime("%Y-%m")
        rows = [r for r in rec.get("rows", []) if lo <= r["period"] <= hi]
        cuts = round(sum(r.get("cut", 0) for r in rows) / await self._div())   # περικοπή χωρίς ΦΠΑ
        return {"fund_cuts": cuts, "net_profit": gross - cuts,
                "cut_months_settled": sum(1 for r in rows if r.get("settled"))}

    # ── ανά διάσταση επιπέδου ΕΚΤΕΛΕΣΗΣ ───────────────────────────────────────────
    async def by_dimension(self, *, date_from: datetime, date_to: datetime,
                           dim: str, limit: int = 20) -> list[dict]:
        if dim in ("product", "type"):
            return _top(await self._by_line(date_from, date_to, key=dim), limit)
        match = {"$match": countable(date_from, date_to)}
        if dim == "fund":
            groups = await self._fund_groups(date_from, date_to)
            return _top([_row(k, v, c) for k, (v, c) in groups.items()], limit)
        if dim == "doctor":
            rows = await self.aggregate([
                match,
                {"$group": {"_id": "$doctor_id", "value": {"$sum": "$amount_total"},
                            "cost": {"$sum": "$wholesale_cost"}}},
                {"$lookup": {"from": "doctors", "localField": "_id",
                             "foreignField": "_id", "as": "_d"}},
                {"$project": {"_id": 0, "value": 1, "cost": 1,
                              "label": {"$ifNull": [{"$first": "$_d.full_name"}, "—"]}}},
            ])
            d = await self._div()
            return _top([_row(r["label"], r["value"] / d, r["cost"]) for r in rows], limit)
        if dim == "icd10":
            # Μία συνταγή με ΔΥΟ διαγνώσεις μετρούσε ΔΥΟ φορές → τα μέρη ξεπερνούσαν το σύνολο.
            # Μοιράζουμε ισόποσα. Συνταγή χωρίς διάγνωση δεν χάνεται — πάει στο «Χωρίς διάγνωση».
            rows = await self.aggregate([
                match,
                {"$set": {"_n": {"$size": {"$ifNull": ["$icd10", []]}}}},
                {"$set": {"_codes": {"$cond": [{"$gt": ["$_n", 0]}, "$icd10", [None]]},
                          "_div": {"$max": ["$_n", 1]}}},
                {"$unwind": "$_codes"},
                {"$group": {"_id": "$_codes",
                            "value": {"$sum": {"$divide": ["$amount_total", "$_div"]}},
                            "cost": {"$sum": {"$divide": ["$wholesale_cost", "$_div"]}}}},
                {"$lookup": {"from": "icd10_codes", "localField": "_id",
                             "foreignField": "_id", "as": "_d"}},
                {"$project": {"value": 1, "cost": 1, "title": {"$first": "$_d.title_el"}}},
            ])
            d = await self._div()
            return _top([_row((f"{r['_id']} {r.get('title') or ''}".strip()
                               if r["_id"] else NO_DIAGNOSIS), r["value"] / d, r["cost"])
                         for r in rows], limit)
        raise ValueError(f"unknown dimension: {dim}")

    async def _fund_groups(self, date_from: datetime, date_to: datetime) -> dict[str, list[float]]:
        """{ομάδα ταμείου → [αξία, κόστος]} — με τις ίδιες ομάδες που χρησιμοποιεί η Αποζημίωση."""
        rows = await self.aggregate([
            {"$match": countable(date_from, date_to)},
            {"$group": {"_id": "$fund_id", "value": {"$sum": "$amount_total"},
                        "cost": {"$sum": "$wholesale_cost"}}},
            {"$lookup": {"from": "insurance_funds", "localField": "_id",
                         "foreignField": "_id", "as": "_d"}},
            {"$project": {"_id": 0, "value": 1, "cost": 1,
                          "name": {"$ifNull": [{"$first": "$_d.name"}, "—"]},
                          "code": {"$first": "$_d.code"}}},
        ])
        from app.core.db import shared_db
        cfg = await shared_db()["fund_groups"].find().to_list(length=None)
        code2group = {c: g["name"] for g in cfg for c in g.get("codes", [])}
        groups: dict[str, list[float]] = defaultdict(lambda: [0, 0])
        d = await self._div()
        for r in rows:
            g = groups[code2group.get(r.get("code")) or r["name"]]
            g[0] += (r.get("value") or 0) / d                   # καθαρή αξία
            g[1] += r.get("cost") or 0
        return dict(groups)

    # ── ανά ΓΡΑΜΜΗ (σκεύασμα / τύπος / θεραπευτική κατηγορία) ─────────────────────
    async def _line_totals(self, date_from: datetime, date_to: datetime,
                           key: str) -> list[dict]:
        """Το σύνολο κάθε εκτέλεσης, ΜΟΙΡΑΣΜΕΝΟ στα είδη που δόθηκαν.

        Έσοδο γραμμής = σύνολο εκτέλεσης × (λιανική×δοσμένα της γραμμής / Σ ίδιου για την εκτέλεση).
        Κόστος γραμμής = κόστος εκτέλεσης × (χονδρική×δοσμένα / Σ ίδιου) — ώστε κάθε σκεύασμα να
        κρατά το ΔΙΚΟ του περιθώριο και όχι το μέσο της συνταγής.

        Μόνο ΔΟΣΜΕΝΑ τεμάχια (`executed_qty`). Τα τεμάχια της ΣΥΝΤΑΓΗΣ φούσκωναν τις «πωλήσεις»
        κατά 1,1εκ.€ σε όλο το σύστημα ([[partial-dispensing-executed-qty]])."""
        field = {"product": "$l.product_id", "type": "$l.category"}[key]
        rows = await self.aggregate([
            {"$match": countable(date_from, date_to)},
            {"$project": {"amount_total": 1, "wholesale_cost": 1}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "l",
                         "pipeline": [
                             # τεμάχια ΑΥΤΗΣ της εγγραφής: σε τμηματική `:N` το σύνολο της εγγραφής
                             # μοιράζεται ΜΟΝΟ στα είδη που δόθηκαν σε αυτήν (πριν: σε όλη τη συνταγή,
                             # και τα τεμάχια ×N) — 01/10/2026
                             {"$set": {"_q": dispensed.qty_expr()}},
                             {"$match": {"_q": {"$gt": 0}}},
                             {"$project": {"product_id": 1, "category": 1, "u": "$_q",
                                           "v": {"$multiply": [{"$ifNull": ["$retail_price", 0]},
                                                               "$_q"]},
                                           "w": {"$multiply": [{"$ifNull": ["$wholesale_price", 0]},
                                                               "$_q"]}}}]}},
            {"$set": {"_sv": {"$sum": "$l.v"}, "_sw": {"$sum": "$l.w"}}},
            # Χωρίς αξία γραμμών δεν υπάρχει βάση επιμερισμού: ΟΛΗ η εκτέλεση πάει σε μία γραμμή
            # «χωρίς ανάλυση» — αλλιώς θα μετριόταν ΜΙΑ φορά ανά είδος.
            {"$set": {"l": {"$cond": [{"$gt": ["$_sv", 0]}, "$l", []]}}},
            {"$unwind": {"path": "$l", "preserveNullAndEmptyArrays": True}},
            {"$set": {
                "_rev": {"$cond": [{"$gt": ["$_sv", 0]},
                                   {"$divide": [{"$multiply": ["$amount_total", "$l.v"]}, "$_sv"]},
                                   "$amount_total"]},
                "_cost": {"$cond": [
                    {"$gt": ["$_sw", 0]},
                    {"$divide": [{"$multiply": ["$wholesale_cost", "$l.w"]}, "$_sw"]},
                    {"$cond": [{"$gt": ["$_sv", 0]},
                               {"$divide": [{"$multiply": ["$wholesale_cost", "$l.v"]}, "$_sv"]},
                               "$wholesale_cost"]}]}}},
            # ΤΕΜΑΧΙΑ: μοιράζονται ΜΕ ΤΟΝ ΙΔΙΟ λόγο με τα ευρώ (ποσό εγγραφής / αξία ειδών).
            # Η ΗΔΥΚΑ δίνει ΜΙΑ συνταγή ως πολλές εγγραφές (`barcode:1`, `:2`…), και ΚΑΘΕ εγγραφή
            # κουβαλά ΟΛΗ τη λίστα ειδών με την τελική κατάσταση. Τα ποσά ανά εγγραφή είναι σωστά
            # (αθροίζουν στην αξία των ειδών)· τα τεμάχια όμως μετρούσαν ×N. Μετρημένο: 9% των
            # συνταγών, έως 14 εγγραφές — μία συνταγή FEBUXOSTAT 2 τεμ. έβγαινε 10.
            {"$set": {"_u": {"$cond": [{"$gt": ["$_sv", 0]},
                                       {"$divide": [{"$multiply": [{"$ifNull": ["$l.u", 0]},
                                                                   "$amount_total"]}, "$_sv"]},
                                       0]}}},
            {"$group": {"_id": field, "value": {"$sum": "$_rev"}, "cost": {"$sum": "$_cost"},
                        "units": {"$sum": "$_u"}}},
        ])
        d = await self._div()
        for r in rows:          # ΚΑΘΑΡΗ αξία γραμμής (χωρίς ΦΠΑ)· η μικτή κρατιέται για το κλιμάκιο τιμής
            r["value_gross"] = r["value"]
            r["value"] = r["value"] / d
        return rows

    async def _products(self, ids: list) -> dict:
        """{id-ως-κείμενο → προϊόν}. ΠΡΟΣΟΧΗ: το `aggregate()` του BaseRepository επιστρέφει τα
        ObjectId ως ΚΕΙΜΕΝΟ (jsonsafe) — ερώτημα με τα κείμενα δεν βρίσκει ΤΙΠΟΤΑ και κάθε όνομα
        έβγαινε «—». Μετατρέπουμε πίσω, και ο χάρτης κλειδώνει με κείμενο για να ταιριάζει."""
        from bson import ObjectId
        oids = []
        for i in ids:
            try:
                oids.append(ObjectId(str(i)))
            except Exception:  # noqa: BLE001
                continue
        if not oids:
            return {}
        return {str(p["_id"]): p async for p in self._db["products"].find(
            {"tenant_id": self.tenant_id, "_id": {"$in": oids}},
            {"name": 1, "atc": 1, "barcode": 1, "category": 1, "retail_price": 1,
             "wholesale_price": 1, "wholesale_source": 1})}

    async def _by_line(self, date_from: datetime, date_to: datetime, *, key: str) -> list[dict]:
        rows = await self._line_totals(date_from, date_to, key)
        if key == "type":
            names = {"normal": "Κανονικά", "narcotic": "Ναρκωτικά", "galenic": "Γαληνικά"}
            return [_row(names.get(r["_id"], r["_id"]) if r["_id"] else UNALLOCATED,
                         r["value"], r["cost"], units=round(r["units"])) for r in rows]
        prods = await self._products([r["_id"] for r in rows])
        return [_row((prods.get(str(r["_id"])) or {}).get("name") or (UNALLOCATED if r["_id"] is None
                                                                 else "—"),
                     r["value"], r["cost"], units=round(r["units"])) for r in rows]

    async def by_medicine_category(self, *, date_from: datetime, date_to: datetime,
                                   limit: int = 20) -> list[dict]:
        """Κέρδος ανά ΘΕΡΑΠΕΥΤΙΚΗ κατηγορία (ATC). ΙΔΙΑ βάση με όλα τα άλλα πάνελ.

        Πριν χρησιμοποιούσε την ΜΕΓΙΣΤΗ λιανική που είχε δει ποτέ το προϊόν × τεμάχια — τιμή που
        μόνο ανεβαίνει, ποτέ δεν κατεβαίνει όταν μειωθεί η διατίμηση. Γι' αυτό έβγαινε +81%."""
        from app.services.catalog_taxonomy import medicine_category
        rows = await self._line_totals(date_from, date_to, "product")
        prods = await self._products([r["_id"] for r in rows])
        cats: dict[str, list[float]] = defaultdict(lambda: [0, 0, 0])
        for r in rows:
            cat = (medicine_category((prods.get(str(r["_id"])) or {}).get("atc"))
                   if r["_id"] is not None else UNALLOCATED)
            c = cats[cat]
            c[0] += r["value"]
            c[1] += r["cost"]
            c[2] += r["units"]
        return _top([_row(k, v, c, units=round(u)) for k, (v, c, u) in cats.items()], limit)

    async def low_margin(self, *, threshold_pct: float, limit: int = 50,
                         date_from: datetime | None = None,
                         date_to: datetime | None = None) -> list[dict]:
        """Σκευάσματα με περιθώριο κάτω από το όριο, ταξινομημένα κατά ΤΕΜΑΧΙΑ ΠΟΥ ΔΟΘΗΚΑΝ.

        Πριν διάβαζε το `products.rx_frequency` — μετρητή που αυξανόταν σε ΚΑΘΕ επανα-άντληση και
        ήταν φουσκωμένος στο 71% των προϊόντων (έως ×932). Και χωρίς περίοδο: ό,τι έγινε ποτέ.
        Τώρα: πραγματικά τεμάχια και πραγματικό κέρδος, στην περίοδο που βλέπεις."""
        if date_to is None:
            date_to = datetime.now(tz=timezone.utc)
        if date_from is None:
            date_from = date_to - timedelta(days=90)
        rows = await self._line_totals(date_from, date_to, "product")
        rows = [r for r in rows if r["_id"] is not None and r["value"] > 0 and r["units"] > 0
                and _pct(r["value"] - r["cost"], r["value"]) < threshold_pct]
        rows.sort(key=lambda r: r["units"], reverse=True)
        rows = rows[:limit]
        prods = await self._products([r["_id"] for r in rows])
        out = []
        for r in rows:
            p = prods.get(str(r["_id"])) or {}
            gp = round(r["value"] - r["cost"])
            out.append({"product_id": str(r["_id"]), "product_name": p.get("name") or "—",
                        "units": round(r["units"]), "revenue": round(r["value"]),
                        "gross_profit": gp, "margin_pct": _pct(gp, r["value"]),
                        "retail_price": p.get("retail_price"),
                        "wholesale_price": p.get("wholesale_price"),
                        "wholesale_source": p.get("wholesale_source")})
        return out

    # ── χάρτης προσοχής ──────────────────────────────────────────────────────────
    async def attention(self, *, date_from: datetime, date_to: datetime) -> dict:
        """ΠΟΥ να κοιτάξει ο φαρμακοποιός: ποιες ενότητες πιέζουν, ποιες βοηθούν, ποιες δεν παίζουν ρόλο.

        ΕΠΙΔΡΑΣΗ (€) μιας ενότητας = το κέρδος της − όσο θα έφερνε με το ΜΕΣΟ περιθώριο του
        φαρμακείου. Αθροίζει στο μηδέν ανά διάσταση, άρα οι ενότητες συγκρίνονται μεταξύ τους.

        Στα συνταγογραφούμενα το περιθώριο το ορίζει η διατίμηση, και οι θεραπευτικές κατηγορίες
        διαφέρουν λίγο (μετρημένο 28/09/2026: 22–27%). Οι μεγάλες αποκλίσεις είναι στα ΑΚΡΙΒΑ (το
        κέρδος της διατίμησης είναι κλιμακωτό — ΦΥΚ 18,8% έναντι 23,5%) και στις περικοπές ταμείων.
        Γι' αυτό το κλιμάκιο τιμής και το ταμείο είναι διαστάσεις του χάρτη. Ιατρός/ICD ΟΧΙ: το «ποιος
        γιατρός σε βοηθά» δεν είναι κάτι που ο φαρμακοποιός πρέπει να «διορθώσει»."""
        # ΣΥΓΚΡΙΣΗ = ίδια περίοδος ΠΕΡΣΙ, 52 εβδομάδες πίσω (ίδια ημέρα εβδομάδας) — όπως οι κάρτες
        # της σελίδας (`prevYearRange`) και το `_yago`. Όχι «προηγούμενο τρίμηνο»: η εποχικότητα
        # (γρίπη, αλλεργίες) θα έβγαζε ψεύτικες πτώσεις και ανόδους.
        yago = timedelta(days=364)
        cur = await self._segments(date_from, date_to)
        prev = await self._segments(date_from - yago, date_to - yago)
        dims = []
        for key in _ATTENTION_DIMS:
            dims.append({"key": key, "segments": _classify(cur["dims"][key],
                                                           prev["dims"].get(key, {}))})
        return {"kpis": {**cur["kpis"], "prev": prev["kpis"]},
                "dimensions": dims, "focus": _focus(dims, cur["gp_net"]),
                "prev_period": {"from": (date_from - yago).isoformat(),
                                "to": (date_to - yago).isoformat()}}

    async def _segments(self, date_from: datetime, date_to: datetime) -> dict:
        from app.services.catalog_taxonomy import medicine_category
        rows = await self._line_totals(date_from, date_to, "product")
        prods = await self._products([r["_id"] for r in rows if r["_id"] is not None])
        flags = {c["barcode"]: c async for c in self._db["medicine_catalog"].find(
            {"barcode": {"$in": [p["barcode"] for p in prods.values() if p.get("barcode")]}},
            {"barcode": 1, "high_cost": 1, "hospital_medicine": 1, "narcotic": 1,
             "is_antibiotic": 1})}
        dims: dict[str, dict[str, list[float]]] = {k: defaultdict(lambda: [0, 0, 0])
                                                   for k in _ATTENTION_DIMS}
        value = cost = 0.0
        per_product = []
        for r in rows:
            v, c, u = r["value"], r["cost"], r["units"]
            value += v
            cost += c
            if r["_id"] is None:
                keys = dict.fromkeys(("category", "kind", "price_band"), UNALLOCATED)
            else:
                p = prods.get(str(r["_id"])) or {}
                per_product.append(v - c)
                keys = {"category": medicine_category(p.get("atc")),
                        "kind": _kind(p, flags.get(p.get("barcode"))),
                        # κλιμάκιο = λιανική ΜΕ ΦΠΑ ανά συσκευασία (όπως τη βλέπει ο φαρμακοποιός)
                        "price_band": _price_band(r.get("value_gross", v) / u if u else None)}
            for k, lab in keys.items():
                g = dims[k][lab]
                g[0] += v
                g[1] += c
        # ΤΑΜΕΙΟ: σε επίπεδο εκτέλεσης + περικοπές των εξοφλημένων μηνών της περιόδου
        cuts = await self._fund_cut_map(date_from, date_to)
        for name, (v, c) in (await self._fund_groups(date_from, date_to)).items():
            dims["fund"][name] = [v, c, cuts.get(name, 0)]
        for name, cut in cuts.items():   # ταμείο με περικοπή αλλά χωρίς εκτέλεση στην περίοδο
            dims["fund"].setdefault(name, [0, 0, cut])
        total_cut = sum(cuts.values())
        gp = value - cost
        head = await self.aggregate([
            {"$match": countable(date_from, date_to)},
            {"$group": {"_id": None, "p": {"$addToSet": "$patient_ref"},
                        "rx": {"$addToSet": {"$arrayElemAt": [
                            {"$split": [{"$ifNull": ["$external_id", ""]}, ":"]}, 0]}}}},
            {"$project": {"p": {"$size": "$p"}, "rx": {"$size": "$rx"}}},
        ])
        h = head[0] if head else {}
        patients, rx = h.get("p", 0), h.get("rx", 0)
        per_product.sort(reverse=True)
        kind = dims["kind"].get(_KIND_HIGH_COST, [0, 0, 0])
        return {
            "value": value, "gp_net": gp - total_cut,
            "dims": {k: dict(v) for k, v in dims.items()},
            "kpis": {
                "revenue": round(value), "capital": round(cost), "gross_profit": round(gp),
                "fund_cuts": round(total_cut), "net_profit": round(gp - total_cut),
                "margin_pct": _pct(gp, value),
                # κάθε 1€ που πληρώνεις στη χονδρική φέρνει τόσα λεπτά κέρδος
                "return_on_capital_pct": _pct(gp, cost),
                "prescriptions": rx, "patients": patients,
                "profit_per_prescription": round(gp / rx) if rx else 0,
                "profit_per_patient": round(gp / patients) if patients else 0,
                "top10_profit_share_pct": _pct(sum(per_product[:10]), gp) if gp > 0 else 0.0,
                "products": len(per_product),
                "high_cost_revenue_pct": _pct(kind[0], value),
                "high_cost_capital_pct": _pct(kind[1], cost),
            }}

    async def _fund_cut_map(self, date_from: datetime, date_to: datetime) -> dict[str, float]:
        """{ομάδα ταμείου → περικοπή} στους ΕΞΟΦΛΗΜΕΝΟΥΣ μήνες της περιόδου (ίδιος κανόνας με την
        κεφαλίδα: πριν την εξόφληση η διαφορά είναι ανοιχτό υπόλοιπο, όχι περικοπή)."""
        from app.repositories.reimbursement import ReimbursementRepository
        now = datetime.now(tz=timezone.utc)
        months = (now.year - date_from.year) * 12 + (now.month - date_from.month) + 1
        if months < 1:
            return {}
        rec = await ReimbursementRepository(tenant_id=self.tenant_id).receivables(
            months_back=min(months, 36))
        lo, hi = date_from.strftime("%Y-%m"), (date_to - timedelta(seconds=1)).strftime("%Y-%m")
        out: dict[str, float] = defaultdict(float)
        d = await self._div()
        for r in rec.get("rows", []):
            if lo <= r["period"] <= hi and r.get("cut"):
                out[r["fund"]] += r["cut"] / d          # περικοπή χωρίς ΦΠΑ
        return dict(out)

    # ── ταμειακή ροή ──────────────────────────────────────────────────────────────
    async def open_receivables(self, *, now: datetime) -> dict:
        """ΑΝΟΙΧΤΑ υπόλοιπα ταμείων ανά ηλικία — από το κύκλωμα αποζημίωσης, που ξέρει τι πληρώθηκε.

        Πριν: άθροιζε το `amount_claimed` ΚΑΘΕ εκτέλεσης από το 2024, χωρίς κανένα στοιχείο
        πληρωμής — και έδειχνε 22.334.756€ ως «ληξιπρόθεσμα 90+ ημερών». Ήταν ό,τι είχε αιτηθεί
        ποτέ το φαρμακείο, όχι ό,τι του χρωστούν.

        Ηλικία = ημέρες από το ΤΕΛΟΣ του μήνα της υποβολής (τότε γεννιέται η απαίτηση)."""
        from app.repositories.reimbursement import ReimbursementRepository
        rec = await ReimbursementRepository(tenant_id=self.tenant_id).receivables(months_back=24)
        edges = [(0, 30, "0-30"), (31, 60, "31-60"), (61, 90, "61-90"), (91, None, "90+")]
        buckets: dict[str, dict] = {lab: {"bucket": lab, "open": 0, "months": 0}
                                    for *_, lab in edges}
        rows = rec.get("rows", [])
        # ΑΠΟ ΠΟΤΕ ΚΑΤΑΓΡΑΦΕΙ ΕΙΣΠΡΑΞΕΙΣ. Μήνες ΠΡΙΝ από την πρώτη καταγραφή είναι ΑΓΝΩΣΤΟΙ, όχι
        # οφειλόμενοι: ο φαρμακοποιός άρχισε να σημειώνει από κάποιον μήνα και μετά, δεν γύρισε
        # πίσω. Πραγματικό (28/09/2026): φαρμακείο με εισπράξεις από 10/2025 έβγαζε 508.000€
        # «ανοιχτά» — όλο το προηγούμενο 12μηνο που απλώς δεν κατέγραψε ποτέ.
        tracked = [r["period"] for r in rows if r.get("payments") or r.get("settled")]
        tracking_from = min(tracked) if tracked else None
        untracked = 0
        for r in rows:
            if r.get("open", 0) <= 0:
                continue
            if tracking_from is None or r["period"] < tracking_from:
                untracked += r["open"]
                continue
            y, m = (int(x) for x in r["period"].split("-"))
            month_end = datetime(y + m // 12, m % 12 + 1, 1, tzinfo=timezone.utc)
            age = max(0, (now - month_end).days)
            lab = next(lab for lo, hi, lab in edges if hi is None or age <= hi)
            buckets[lab]["open"] += r["open"]
            buckets[lab]["months"] += 1
        tot = rec.get("totals", {})
        out = list(buckets.values())
        return {"buckets": out,
                "total_open": sum(b["open"] for b in out),
                "overdue_open": sum(b["open"] for b in out if b["bucket"] in ("61-90", "90+")),
                "total_cut": tot.get("cut", 0),
                "payments_recorded": tracking_from is not None,
                "tracking_from": tracking_from,
                "untracked_claimed": untracked}
