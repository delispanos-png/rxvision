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


# ATC level-1 therapeutic classes → Greek names
ATC_L1 = {
    "A": "Πεπτικό & μεταβολισμός", "B": "Αίμα & αιμοποιητικά", "C": "Καρδιαγγειακό",
    "D": "Δερματολογικά", "G": "Ουροποιογεννητικό & ορμόνες φύλου", "H": "Ορμόνες (συστηματικές)",
    "J": "Αντιλοιμώδη", "L": "Αντινεοπλασματικά & ανοσορυθμιστικά", "M": "Μυοσκελετικό",
    "N": "Νευρικό σύστημα", "P": "Αντιπαρασιτικά", "R": "Αναπνευστικό", "S": "Αισθητήρια όργανα",
    "V": "Διάφορα",
}

# Cross-sell knowledge base: chronic-therapy ATC prefix → accompanying-sale opportunity.
# Curated for the Greek pharmacy (παραφαρμακευτικά/ΜΗΣΥΦΑ). reach = distinct patients on that class.
CROSS_SELL = [
    {"atc": "C10AA", "name": "Στατίνες", "sell": "Συνένζυμο Q10 · Ω-3 λιπαρά · Βιταμίνη D",
     "why": "Μειώνουν το CoQ10 και προκαλούν μυαλγίες — ισχυρή, λογική συνοδευτική πώληση."},
    {"atc": "A10", "name": "Αντιδιαβητικά", "sell": "Ταινίες μέτρησης · Βιταμίνη B12 · Περιποίηση διαβητικού ποδιού",
     "why": "Η μετφορμίνη μειώνει τη B12· ανάγκη συνεχούς μέτρησης σακχάρου & φροντίδας ποδιού."},
    {"atc": "A02BC", "name": "Αναστολείς αντλίας πρωτονίων (PPI)", "sell": "Μαγνήσιο · Βιταμίνη B12 · Προβιοτικά",
     "why": "Μακροχρόνια χρήση μειώνει Mg/B12 και επηρεάζει την απορρόφηση."},
    {"atc": "C03", "name": "Διουρητικά", "sell": "Μαγνήσιο · Κάλιο · Ενυδάτωση",
     "why": "Αυξημένη αποβολή ηλεκτρολυτών."},
    {"atc": "J01", "name": "Αντιβιοτικά", "sell": "Προβιοτικά · Ηλεκτρολύτες",
     "why": "Προστασία εντερικής χλωρίδας κατά/μετά την αγωγή."},
    {"atc": "H03AA", "name": "Λεβοθυροξίνη (υποθυρεοειδισμός)", "sell": "Σελήνιο · Βιταμίνη D",
     "why": "Υποστήριξη λειτουργίας θυρεοειδούς."},
    {"atc": "M05B", "name": "Οστεοπόρωση (διφωσφονικά)", "sell": "Ασβέστιο + Βιταμίνη D3 · Κολλαγόνο",
     "why": "Απαραίτητα συμπληρώματα για την αποτελεσματικότητα της αγωγής."},
    {"atc": "R03", "name": "Εισπνεόμενα (άσθμα/ΧΑΠ)", "sell": "Spacer/αποστείρωση · Βιταμίνη D · Φυσιολογικός ορός",
     "why": "Υποστήριξη αναπνευστικού & σωστή χρήση συσκευής."},
    {"atc": "B01", "name": "Αντιπηκτικά / Αντιαιμοπεταλιακά", "sell": "Συμβουλή διατροφής (βιτ. K) · Ασπίδα στομάχου",
     "why": "Αλληλεπιδράσεις & κίνδυνος γαστρικής δυσφορίας."},
    {"atc": "N06A", "name": "Αντικαταθλιπτικά", "sell": "Ω-3 · Μαγνήσιο · Σύμπλεγμα B · Μελατονίνη",
     "why": "Υποστήριξη διάθεσης, ύπνου και νευρικού συστήματος."},
    {"atc": "G03", "name": "Ορμονική/αντισύλληψη", "sell": "Φυλλικό οξύ · Μαγνήσιο · B6",
     "why": "Συχνές ελλείψεις θρεπτικών στις θεραπείες αυτές."},
    {"atc": "M01A", "name": "ΜΣΑΦ (αντιφλεγμονώδη)", "sell": "Γαστροπροστασία · Τοπικά gel · Κολλαγόνο/γλυκοζαμίνη",
     "why": "Προστασία στομάχου & υποστήριξη αρθρώσεων."},
    {"atc": "C09", "name": "Αντιυπερτασικά (ΜΕΑ/ARB)", "sell": "Πιεσόμετρο · Ω-3 · CoQ10 · Μαγνήσιο",
     "why": "Παρακολούθηση πίεσης στο σπίτι & καρδιαγγειακή υποστήριξη."},
    {"atc": "N02", "name": "Αναλγητικά", "sell": "Θερμοφόρες/τοπικά · Μαγνήσιο · Συμπληρώματα ύπνου",
     "why": "Διαχείριση χρόνιου πόνου & ποιότητα ύπνου."},
]

# Nutrition knowledge base: ATC prefix → personalised dietary advice for the patient,
# to improve treatment outcomes. Curated, conservative, GR-friendly.
NUTRITION = [
    {"atc": "C10AA", "title": "Στατίνες (χοληστερόλη)",
     "favor": "Λιπαρά ψάρια 2×/εβδ. (Ω-3), βρώμη, όσπρια, ανάλατοι ξηροί καρποί, ελαιόλαδο, λαχανικά",
     "avoid": "Γκρέιπφρουτ & χυμός του (αλληλεπίδραση), κορεσμένα/τηγανητά, υπερβολικό αλκοόλ",
     "why": "Ενισχύεις τη μείωση χοληστερόλης και στηρίζεις τους μυς."},
    {"atc": "B01AA", "title": "Αντιπηκτικά (βαρφαρίνη)",
     "favor": "Σταθερή ημερήσια ποσότητα πράσινων φυλλωδών — χωρίς αυξομειώσεις",
     "avoid": "Απότομες αλλαγές σε σπανάκι/μπρόκολο, cranberry σε υπερβολή, αλκοόλ",
     "why": "Η σταθερή βιταμίνη K κρατά σταθερό το INR."},
    {"atc": "A10", "title": "Αντιδιαβητικά / Σακχαρώδης διαβήτης",
     "favor": "Σύνθετοι υδατάνθρακες, φυτικές ίνες, λαχανικά, καλή πρωτεΐνη, τακτικά γεύματα",
     "avoid": "Ζάχαρη/γλυκά, αναψυκτικά, λευκό ψωμί, υπερβολικό αλκοόλ",
     "why": "Σταθεροποιείς το σάκχαρο και μειώνεις υπογλυκαιμίες."},
    {"atc": "C09", "title": "Αντιυπερτασικά (ΜΕΑ/ARB)",
     "favor": "Δίαιτα DASH: λαχανικά, φρούτα, κάλιο (μπανάνα, ντομάτα), χαμηλά λιπαρά",
     "avoid": "Αλάτι/αλμυρά, υποκατάστατα αλατιού με κάλιο, γλυκόριζα",
     "why": "Ρίχνεις την πίεση φυσικά & ενισχύεις τη θεραπεία."},
    {"atc": "C03", "title": "Διουρητικά",
     "favor": "Τρόφιμα με κάλιο & μαγνήσιο (λαχανικά, ξηροί καρποί), καλή ενυδάτωση",
     "avoid": "Υπερβολικό αλάτι, αφυδάτωση", "why": "Αναπληρώνεις ηλεκτρολύτες που χάνονται."},
    {"atc": "A02BC", "title": "Αναστολείς αντλίας πρωτονίων (PPI)",
     "favor": "Τρόφιμα με μαγνήσιο/B12/ασβέστιο, μικρά & συχνά γεύματα",
     "avoid": "Καφεΐνη, πικάντικα, λιπαρά, αλκοόλ, όψιμο βραδινό",
     "why": "Καλύπτεις ελλείψεις & μειώνεις την παλινδρόμηση."},
    {"atc": "H03AA", "title": "Λεβοθυροξίνη (θυρεοειδής)",
     "favor": "Λήψη με άδειο στομάχι· σελήνιο (καρύδια Βραζιλίας)",
     "avoid": "Σόγια, ασβέστιο/σίδηρο & καφές κοντά στη δόση",
     "why": "Μεγιστοποιείς την απορρόφηση της ορμόνης."},
    {"atc": "M05B", "title": "Οστεοπόρωση",
     "favor": "Ασβέστιο (γαλακτοκομικά, σαρδέλες) + βιταμίνη D, καλή πρωτεΐνη",
     "avoid": "Υπερβολική καφεΐνη/αναψυκτικά cola, αλκοόλ, κάπνισμα",
     "why": "Στηρίζεις την οστική πυκνότητα."},
    {"atc": "J01", "title": "Αντιβιοτικά (τρέχουσα αγωγή)",
     "favor": "Προβιοτικά/γιαούρτι σε διαφορετική ώρα, καλή ενυδάτωση",
     "avoid": "Γαλακτοκομικά κοντά στη δόση (τετρακυκλίνες/κινολόνες), αλκοόλ",
     "why": "Προστατεύεις τη χλωρίδα & την απορρόφηση."},
    {"atc": "N06A", "title": "Αντικαταθλιπτικά",
     "favor": "Ω-3, σύμπλεγμα B, τρυπτοφάνη (γαλοπούλα), ενυδάτωση",
     "avoid": "Αλκοόλ· (MAOI: τυραμίνη — παλαιωμένα τυριά/αλλαντικά)",
     "why": "Υποστηρίζεις διάθεση & νευρικό σύστημα."},
    {"atc": "M01A", "title": "Αντιφλεγμονώδη (ΜΣΑΦ)",
     "favor": "Λήψη με φαγητό, αντιφλεγμονώδη τρόφιμα (ψάρι, κουρκουμάς, ελαιόλαδο)",
     "avoid": "Άδειο στομάχι, αλκοόλ, υπερβολικό αλάτι",
     "why": "Προστατεύεις το στομάχι & μειώνεις τη φλεγμονή."},
]


def nutrition_html(plan: dict, from_name: str | None = None) -> str:
    secs = "".join(
        f"""<div style="margin:0 0 12px;padding:14px 16px;border:1px solid #e2e8f0;border-radius:12px;">
            <div style="font-weight:700;color:#4f46e5;font-size:15px;">{s['title']}</div>
            <div style="font-size:12px;color:#94a3b8;margin:2px 0 8px;">Σχετικά φάρμακα: {', '.join(s['drugs']) or '—'}</div>
            <div style="font-size:14px;color:#0f172a;"><b style="color:#16a34a;">✓ Προτίμησε:</b> {s['favor']}</div>
            <div style="font-size:14px;color:#0f172a;margin-top:4px;"><b style="color:#dc2626;">✕ Πρόσεξε:</b> {s['avoid']}</div>
            <div style="font-size:13px;color:#64748b;margin-top:4px;">{s['why']}</div></div>"""
        for s in plan.get("sections", []))
    return f"""<div style="background:#f1f5f9;padding:24px;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="background:#4f46e5;padding:18px 24px;color:#fff;">
          <div style="font-size:18px;font-weight:800;">{from_name or 'Το φαρμακείο σας'}</div>
          <div style="font-size:13px;opacity:.9;">Εξατομικευμένες διατροφικές συμβουλές</div></div>
        <div style="padding:20px 24px;">
          <p style="font-size:15px;color:#0f172a;line-height:1.6;">Αγαπητέ/ή {plan.get('name') or ''}, με βάση τη φαρμακευτική σας αγωγή ετοιμάσαμε προτάσεις διατροφής για καλύτερα αποτελέσματα:</p>
          {secs or '<p style="color:#64748b;">Δεν εντοπίστηκαν ειδικές διατροφικές οδηγίες για την τρέχουσα αγωγή.</p>'}
          <p style="font-size:12px;color:#94a3b8;margin-top:14px;line-height:1.5;">Οι συμβουλές είναι γενικές & ενημερωτικές και δεν υποκαθιστούν ιατρική ή διαιτολογική γνωμάτευση. Συμβουλευτείτε τον φαρμακοποιό σας.</p>
        </div></div></div>"""


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
            "categories": await self.category_analysis(df, dt),
            "cross_sell": await self.cross_sell(df, dt),
        }

    # ── deep category & cross-sell analytics ─────────────────────────────
    async def _cat_rows(self, df, dt) -> list[dict]:
        items = BaseRepository(tenant_id=self.tenant_id)
        items.collection_name = "prescription_items"
        rows = await items.aggregate([
            {"$match": {"executed_at": {"$gte": df, "$lt": dt}, "is_executed": True}},
            {"$lookup": {"from": "products", "localField": "product_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"code": {"$toUpper": {"$substrCP": [{"$ifNull": [{"$first": "$p.atc"}, "?"]}, 0, 1]}}}},
            {"$group": {"_id": "$code",
                        "revenue": {"$sum": {"$multiply": ["$retail_price", "$quantity"]}},
                        "cost": {"$sum": {"$multiply": ["$wholesale_price", "$quantity"]}},
                        "units": {"$sum": "$quantity"}, "rx": {"$sum": 1}}},
            {"$project": {"_id": 0, "code": "$_id", "revenue": 1, "cost": 1, "units": 1, "rx": 1}},
        ])
        return [r for r in rows if r["code"] in ATC_L1]

    async def category_analysis(self, df, dt) -> list[dict]:
        span = dt - df
        cur = await self._cat_rows(df, dt)
        prev = {r["code"]: r["revenue"] for r in await self._cat_rows(df - span, df)}
        total = sum(r["revenue"] for r in cur) or 1
        out = []
        for r in cur:
            gp = r["revenue"] - r["cost"]
            margin = (gp / r["revenue"] * 100) if r["revenue"] else 0
            share = r["revenue"] / total * 100
            trend = _pct(r["revenue"], prev.get(r["code"], 0))
            if share >= 8 and margin >= 18:
                verdict = "focus"
            elif margin < 12 or (share < 3 and (trend or 0) < 0):
                verdict = "divest"
            else:
                verdict = "maintain"
            out.append({"code": r["code"], "name": ATC_L1.get(r["code"], r["code"]),
                        "revenue": r["revenue"], "gross_profit": gp, "margin_pct": margin,
                        "units": r["units"], "rx": r["rx"], "share_pct": share,
                        "trend_pct": trend, "verdict": verdict})
        out.sort(key=lambda x: -x["revenue"])
        return out

    async def cross_sell(self, df, dt) -> list[dict]:
        pairs = await self.aggregate([
            {"$match": {"executed_at": {"$gte": df, "$lt": dt}}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$lookup": {"from": "products", "localField": "it.product_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"atc": {"$toUpper": {"$ifNull": [{"$first": "$p.atc"}, ""]}}}},
            {"$match": {"atc": {"$ne": ""}}},
            {"$group": {"_id": {"pt": "$patient_ref", "atc": "$atc"}}},
            {"$project": {"_id": 0, "pt": "$_id.pt", "atc": "$_id.atc"}},
        ])
        pmap: dict = {}
        for r in pairs:
            pmap.setdefault(str(r.get("pt")), set()).add(r.get("atc") or "")
        out = []
        for rule in CROSS_SELL:
            pref = rule["atc"]
            reach = sum(1 for atcs in pmap.values() if any(a.startswith(pref) for a in atcs))
            if reach > 0:
                out.append({"atc": rule["atc"], "class": rule["name"], "sell": rule["sell"],
                            "why": rule["why"], "reach": reach})
        out.sort(key=lambda x: -x["reach"])
        return out

    async def nutrition_plan(self, patient_id: str) -> dict | None:
        """Personalised nutrition plan from a patient's medication mix (ATC classes)."""
        oid = _as_oid(patient_id)
        if not oid:
            return None
        pa = await self._db["patients_anonymized"].find_one({"_id": oid, "tenant_id": self.tenant_id})
        if not pa:
            return None
        rows = await self.aggregate([
            {"$match": {"patient_ref": oid}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$lookup": {"from": "products", "localField": "it.product_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"atc": {"$toUpper": {"$ifNull": [{"$first": "$p.atc"}, ""]}},
                      "nm": {"$first": "$p.name"}}},
            {"$match": {"atc": {"$ne": ""}}},
            {"$group": {"_id": "$atc", "drugs": {"$addToSet": "$nm"}}},
        ])
        atc_drugs = {r["_id"]: [d for d in r["drugs"] if d] for r in rows}
        sections = []
        for rule in NUTRITION:
            matched = [a for a in atc_drugs if a.startswith(rule["atc"])]
            if matched:
                drugs = sorted({d for a in matched for d in atc_drugs[a]})[:6]
                sections.append({"title": rule["title"], "drugs": drugs,
                                 "favor": rule["favor"], "avoid": rule["avoid"], "why": rule["why"]})
        ct = await self._db["patient_contacts"].find_one({"_id": oid, "tenant_id": self.tenant_id})
        return {"patient_id": patient_id, "name": pa.get("full_name"),
                "email": (ct or {}).get("email"), "mobile": (ct or {}).get("mobile"),
                "sections": sections}

    async def cross_sell_patients(self, atc_prefix: str) -> list[dict]:
        """Patients on a therapeutic class (ATC prefix) — with demographics + contact +
        quick-reach info, for the cross-sell drill-down. Last 12 months."""
        cutoff = _now() - timedelta(days=365)
        pref = (atc_prefix or "").upper()
        rows = await self.aggregate([
            {"$match": {"executed_at": {"$gte": cutoff}}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$lookup": {"from": "products", "localField": "it.product_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"atc": {"$toUpper": {"$ifNull": [{"$first": "$p.atc"}, ""]}},
                      "pname": {"$first": "$p.name"}}},
            {"$match": {"atc": {"$regex": "^" + pref}}},
            {"$group": {"_id": "$patient_ref", "times": {"$sum": 1},
                        "last": {"$max": "$executed_at"},
                        "drugs": {"$addToSet": "$pname"}}},
            {"$lookup": {"from": "patients_anonymized", "localField": "_id",
                         "foreignField": "_id", "as": "pa"}},
            {"$lookup": {"from": "patient_contacts", "localField": "_id",
                         "foreignField": "_id", "as": "ct"}},
            {"$set": {"pa": {"$first": "$pa"}, "ct": {"$first": "$ct"}}},
            {"$project": {
                "_id": 0, "patient_id": {"$toString": "$_id"},
                "name": "$pa.full_name", "amka": "$pa.amka",
                "age_group": "$pa.age_group", "sex": "$pa.sex", "birth_year": "$pa.birth_year",
                "times": 1, "last": 1, "drugs": {"$slice": ["$drugs", 4]},
                "mobile": "$ct.mobile", "phone": "$ct.phone", "email": "$ct.email",
                "consent": {"$ifNull": ["$ct.marketing_consent", False]},
            }},
            {"$sort": {"last": -1}},
            {"$limit": 500},
        ])
        return rows

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
            # accompanying products worth stocking, from the patient base's therapy mix (90d)
            "cross_sell": await self.cross_sell(today - timedelta(days=90), today),
        }
