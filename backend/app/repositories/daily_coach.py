"""Ο Σύμβουλος της ημέρας — «τι έπρεπε να είχες προσέξει».

ΞΕΧΩΡΙΣΤΟ κύκλωμα (module `daily_coach`), αγοράζεται ως extra — δεν περιλαμβάνεται σε κανένα
πακέτο. Δεν είναι άλλο ένα dashboard με νούμερα: κάθε γραμμή είναι ΕΝΑΣ άνθρωπος, ΜΙΑ ενέργεια
και ΤΙ ΚΟΣΤΙΖΕΙ αν δεν γίνει. Μιλάει ελληνικά, όχι σε KPI.

Η λογική:
  · κάθε «σήμα» (signal) σαρώνει τα πραγματικά δεδομένα και βγάζει ευρήματα (findings)·
  · κάθε εύρημα έχει ΣΤΑΘΕΡΟ κλειδί (signal:subject) → το ίδιο θέμα αναγνωρίζεται αύριο·
  · όσο μένει ανοιχτό, μεγαλώνει το `streak` → ο τόνος σκληραίνει (coach_voice)·
  · «Έγινε» το κρύβει ΜΟΝΟ για σήμερα: αν αύριο το σήμα το ξαναβρεί, μετράει ως υποτροπή·
  · η ΕΠΙΒΡΑΒΕΥΣΗ δεν είναι διακοσμητική — βγαίνει από τα ίδια δεδομένα.

Persistence: `coach_findings` (κατάσταση ανά κλειδί) + `coach_days` (ημερήσιο αποτύπωμα για
σερί & ιστορικό). Και τα δύο tenant-scoped μέσω BaseRepository.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from urllib.parse import quote

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository
from app.services import coach_voice as V
from app.utils.masking import mask_amka, mask_name, pseudo_email, pseudo_phone

ATHENS = timezone(timedelta(hours=3))          # πρακτικά αρκεί για το «ποια μέρα είναι»

# Πόσα ευρήματα βλέπει ο φαρμακοποιός τη φορά. Πάνω από αυτό δεν διαβάζεται — αγνοείται.
MAX_ITEMS = 10
# Και όριο ΑΝΑ ΣΗΜΑ: 28 συνταγές που λήγουν δεν είναι 28 μηνύματα, είναι ένα μήνυμα με ουρά.
# Χωρίς αυτό ο σύμβουλος γίνεται λίστα — και οι λίστες αγνοούνται.
PER_SIGNAL_CAP = {"idle_request": 4, "unexecuted": 3, "repeat_expiring": 3,
                  "vaccine_missed": 2, "no_contact": 1, "lapsed_chronic": 2}
DISMISS_DAYS = 30                               # «δεν με αφορά» → σιωπή για έναν μήνα

# Η οθόνη-λίστα του κάθε σήματος (εκεί δουλεύεις μαζικά, όχι ανά άτομο).
_INBOX_LABEL = {"idle_request": "Άνοιγμα αιτημάτων", "no_contact": "Λίστα επιβεβαίωσης στοιχείων",
                "vaccine_missed": "Κύκλωμα εμβολιασμών",
                "margin_drop": "Ανάλυση κερδοφορίας", "revenue_drop": "Ανάλυση τζίρου",
                "expired_stock": "Αποθήκη — ληγμένα", "expiring_soon": "Αποθήκη — λήγουν",
                "dead_stock": "Αποθήκη — ακίνητα", "below_reorder": "Αποθήκη — χαμηλό απόθεμα"}

# Ανθρώπινο όνομα κάθε σήματος — για στόχους, απολογισμούς και ρυθμίσεις.
SIGNAL_LABEL = {
    "unexecuted": "Ανεκτέλεστα είδη",
    "repeat_expiring": "Επαναλήψεις που λήγουν",
    "idle_request": "Αιτήματα χωρίς απάντηση",
    "no_contact": "Πελάτες χωρίς στοιχεία",
    "vaccine_missed": "Χαμένοι εμβολιασμοί",
    "lapsed_chronic": "Χρόνιοι που σταμάτησαν",
    # ── Λειτουργία & Κέρδος ──
    "loss_execution": "Εκτελέσεις με ζημιά",
    "margin_drop": "Πτώση περιθωρίου",
    "revenue_drop": "Πτώση τζίρου",
    "expired_stock": "Ληγμένα με απόθεμα",
    "expiring_soon": "Λήγουν σύντομα",
    "dead_stock": "Ακίνητο απόθεμα",
    "below_reorder": "Κάτω από το σημείο αναπαραγγελίας",
}

# Τα σήματα που ΔΕΝ μιλούν για ασθενή αλλά για την ΕΠΙΧΕΙΡΗΣΗ. Χωριστή φωνή (δεν έχουν όνομα
# ούτε γένος) και χωριστό δικαίωμα: τζίρος και περιθώρια δεν είναι για κάθε χειριστή.
BUSINESS_SIGNALS = frozenset({
    "loss_execution", "margin_drop", "revenue_drop",
    "expired_stock", "expiring_soon", "dead_stock", "below_reorder",
})

# Κάτω από τόσες εκτελέσεις στην περίοδο, η σύγκριση είναι θόρυβος και όχι τάση.
_MIN_EXECS = 200
# Κάτω από τόσα είδη με απόθεμα, η αποθήκη δεν χρησιμοποιείται — δεν βγάζουμε συμπεράσματα.
_STOCK_MIN = 20
# Μετά από τόσες συνεχόμενες μέρες ανοιχτό, το θέμα ανεβαίνει στον ιδιοκτήτη.
ESCALATE_DAYS = 7


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _day_key(dt: datetime) -> str:
    return dt.astimezone(ATHENS).strftime("%Y-%m-%d")


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


# Ορόσημα σερί: γιορτάζουμε ΣΠΑΝΙΑ, αλλιώς παύει να σημαίνει κάτι.
_MILESTONES = {
    3: "Τρεις καθαρές μέρες στη σειρά.",
    5: "Πέντε καθαρές μέρες. Αυτό είναι πια συνήθεια, όχι τύχη.",
    10: "Δέκα καθαρές μέρες στη σειρά. Λίγα φαρμακεία το πετυχαίνουν αυτό.",
    20: "Είκοσι καθαρές μέρες. Δεν έχω κάτι να προσθέσω.",
    30: "Έναν ολόκληρο μήνα χωρίς να μου ξεφύγει τίποτα. Καμάρωσε.",
}


def _milestone(clean_streak: int) -> str | None:
    return _MILESTONES.get(int(clean_streak or 0))


def _days_between(a: datetime | None, b: datetime) -> int:
    if not a:
        return 0
    if a.tzinfo is None:
        a = a.replace(tzinfo=timezone.utc)
    return max(0, (b - a).days)


class DailyCoachRepository(BaseRepository):
    collection_name = "coach_findings"

    # ─────────────────────────────────────────────────────────────────────────
    # ΣΗΜΑΤΑ — κάθε ένα γυρίζει «ωμά» ευρήματα· τη γλώσσα τη βάζει το build()
    # ─────────────────────────────────────────────────────────────────────────

    async def _sig_unexecuted(self, now: datetime) -> list[dict]:
        """Ο άνθρωπος έφυγε χωρίς μέρος της συνταγής του. Τα υπόλοιπα τα αγόρασε αλλού."""
        since = now - timedelta(days=10)
        execs = [e async for e in self._db["prescription_executions"].find(
            {"tenant_id": self.tenant_id, "has_unexecuted_substances": True,
             "executed_at": {"$gte": since}},
            {"patient_ref": 1, "executed_at": 1, "external_id": 1}).sort("executed_at", -1)]
        if not execs:
            return []
        # Ο ασθενής ξαναπέρασε μετά; Τότε το έκλεισε — δεν το χρεώνουμε.
        pids = list({e["patient_ref"] for e in execs if e.get("patient_ref")})
        latest = {r["_id"]: r["last"] for r in await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "patient_ref": {"$in": pids},
                        "executed_at": {"$gte": since}, "has_unexecuted_substances": {"$ne": True}}},
            {"$group": {"_id": "$patient_ref", "last": {"$max": "$executed_at"}}},
        ]).to_list(length=None)}

        open_execs, seen = [], set()
        for e in execs:
            pid = e.get("patient_ref")
            if not pid or pid in seen:
                continue
            if (latest.get(pid) or datetime.min.replace(tzinfo=timezone.utc)) > e["executed_at"]:
                continue                                   # γύρισε και το πήρε
            seen.add(pid)
            open_execs.append(e)
        if not open_execs:
            return []

        info = await self._patient_info([e["patient_ref"] for e in open_execs])
        items_by_exec = await self._missing_items([e["_id"] for e in open_execs])
        out = []
        for e in open_execs:
            miss = items_by_exec.get(e["_id"]) or {}
            if not miss.get("names"):
                continue
            who = self._who(info.get(e["patient_ref"]), e["patient_ref"])
            out.append({
                "signal": "unexecuted", "subject": str(e["patient_ref"]),
                "name": who.get("name"), "sex": who.get("sex"), "who": who,
                "since": e["executed_at"],
                "money_cents": miss["retail"], "profit_cents": miss["margin"],
                "items": miss["names"], "severity": 3 if miss["retail"] >= 3000 else 2,
                "rx": e.get("external_id"),
            })
        return out


    async def _chain_progress(self, roots: list) -> dict:
        """repeat_root → η ΜΕΓΑΛΥΤΕΡΗ θέση αλυσίδας που έχει ΕΚΤΕΛΕΣΤΕΙ.

        ΠΡΟΣΟΧΗ στη σημασιολογία: το `repeat_current` ΔΕΝ είναι «πόσες εκτελέσεις έγιναν» —
        είναι η ΘΕΣΗ αυτής της συνταγής μέσα στην αλυσίδα (CDA 1.1.4.1 «Σειρά»). Κάθε θέση
        είναι ΞΕΧΩΡΙΣΤΟ barcode με δικό του παράθυρο εκτέλεσης.

        Χωρίς αυτό, το `repeat_total - repeat_current` έβγαζε ψευδείς συναγερμούς: μια συνταγή
        στη θέση 3/6 που «λήγει» εμφανιζόταν ως «3 χαμένες εκτελέσεις», ενώ η θέση 4 είχε ήδη
        εκτελεστεί κανονικά (αναφορά πελάτη 21/09/2026)."""
        roots = [r for r in roots if r]
        if not roots:
            return {}
        rows = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "repeat_root": {"$in": roots}}},
            {"$group": {"_id": "$repeat_root", "max_pos": {"$max": "$repeat_current"}}},
        ]).to_list(length=None)
        return {r["_id"]: int(r.get("max_pos") or 0) for r in rows}

    async def _sig_repeat_expiring(self, now: datetime) -> list[dict]:
        """Επαναλαμβανόμενη συνταγή με δόσεις που δεν πάρθηκαν και λήγει. Χάνει ο ασθενής — και εσύ."""
        rows = [e async for e in self._db["prescription_executions"].find(
            {"tenant_id": self.tenant_id,
             "$expr": {"$lt": ["$repeat_current", "$repeat_total"]},
             "valid_until": {"$gte": now, "$lt": now + timedelta(days=6)}},
            {"patient_ref": 1, "valid_until": 1, "repeat_current": 1, "repeat_total": 1,
             "repeat_root": 1, "amount_total": 1, "external_id": 1}).sort("valid_until", 1).limit(200)]
        if not rows:
            return []
        # κράτα την ΤΕΛΕΥΤΑΙΑ σειρά ανά συνταγή (repeat_root) — μία γραμμή ανά συνταγή
        by_root: dict = {}
        for r in rows:
            k = r.get("repeat_root") or str(r["_id"])
            cur = by_root.get(k)
            if not cur or (r.get("repeat_current") or 0) > (cur.get("repeat_current") or 0):
                by_root[k] = r
        info = await self._patient_info([r["patient_ref"] for r in by_root.values()])
        # Πόσο έχει προχωρήσει ΠΡΑΓΜΑΤΙΚΑ κάθε αλυσίδα (όχι μόνο όσες λήγουν τώρα).
        progress = await self._chain_progress([r.get("repeat_root") for r in by_root.values()])
        out = []
        for r in by_root.values():
            pos = int(r.get("repeat_current") or 0)
            done = max(pos, progress.get(r.get("repeat_root"), 0))
            # Υπάρχει ΝΕΟΤΕΡΗ συνταγή της αλυσίδας ⇒ ο ασθενής πήρε τη συνέχειά του και αυτή
            # εδώ απλώς έληξε φυσιολογικά. Δεν είναι απώλεια — δεν βγάζουμε συναγερμό.
            if done > pos:
                continue
            left = int(r.get("repeat_total") or 0) - done
            if left <= 0:
                continue
            days_left = max(0, (r["valid_until"] - now).days)
            who = self._who(info.get(r.get("patient_ref")), r.get("patient_ref"))
            out.append({
                "signal": "repeat_expiring", "subject": r.get("repeat_root") or str(r["_id"]),
                "name": who.get("name"), "sex": who.get("sex"), "who": who, "since": None,
                "money_cents": int(r.get("amount_total") or 0) * left,
                "extra": {"left": left, "days_left": days_left},
                "severity": 3 if days_left <= 2 else 2,
                # ΟΧΙ το repeat_root — η καρτέλα συνταγής θέλει external_id (barcode:σειρά)
                "rx": r.get("external_id"),
            })
        return out

    async def _sig_idle_requests(self, now: datetime) -> list[dict]:
        """Κάποιος απευθύνθηκε στο φαρμακείο μέσω της πύλης και δεν πήρε απάντηση."""
        cutoff = now - timedelta(hours=24)
        out: list[dict] = []
        specs = [
            ("rx_requests", {"status": "new"}, "created_at",
             "ζήτησε να ετοιμάσεις μια συνταγή", "/portal-admin#rx"),
            ("availability_requests", {"status": "open"}, "created_at",
             "ρώτησε αν έχεις κάποιο φάρμακο", "/portal-admin#availability"),
            ("appointments", {"status": "requested"}, "created_at",
             "ζήτησε ραντεβού", "/portal-admin#appointments"),
            ("orders_delivery", {"status": {"$in": ["pending", "new"]}}, "created_at",
             "έκανε παραγγελία", "/orders-delivery#orders"),
        ]
        rows: list[tuple] = []
        for coll, flt, field, what, href in specs:
            async for d in self._db[coll].find(
                    {"tenant_id": self.tenant_id, **flt, field: {"$lt": cutoff}}).sort(field, 1).limit(30):
                rows.append((coll, field, what, href, d))
        # Το φύλο το ξέρουμε ΜΟΝΟ μέσω της καρτέλας ασθενή — χωρίς αυτό ο σύμβουλος
        # γράφει «Ο ΜΑΡΙΑ» και χάνει αμέσως κάθε σοβαρότητα.
        info = await self._patient_info([_oid(d.get("patient_ref")) for *_, d in rows])
        for coll, field, what, href, d in rows:
            pid = _oid(d.get("patient_ref"))
            who = self._who(info.get(pid), pid, extra={
                "name": d.get("patient_name"),
                "mobile": pseudo_phone(d.get("patient_phone"), self.demo)
                or (info.get(pid) or {}).get("mobile")})
            out.append({
                "signal": "idle_request", "subject": f"{coll}:{d['_id']}",
                "name": d.get("patient_name"), "hdika_name": False, "since": d.get(field),
                "sex": who.get("sex"), "who": who,
                "money_cents": int(d.get("total_cents") or 0) or None,
                "extra": {"what": what, "detail": (d.get("query") or d.get("medicine_name")
                                                   or d.get("service_name") or d.get("note") or "")},
                "severity": 3, "href": href, "inbox": href,
            })
        return out

    async def _sig_advance_due(self, now: datetime) -> list[dict]:
        """Δανεικό σκεύασμα που ο πελάτης είπε ότι θα ξεχρεώσει σήμερα (ή το είχε πει για πριν).

        ΜΟΝΟ με δηλωμένη ημερομηνία: ένα δανεικό χωρίς συμφωνημένη μέρα δεν είναι «σημερινή
        δουλειά» — θα γέμιζε τον σύμβουλο με υπενθυμίσεις που δεν αφορούν τη σημερινή ημέρα.
        """
        today = now.date().isoformat()
        rows = [d async for d in self._db["advance_dispensings"].find(
            {"tenant_id": self.tenant_id, "status": "open",
             "expected_at": {"$ne": None, "$lte": today}}).sort("expected_at", 1).limit(40)]
        if not rows:
            return []
        info = await self._patient_info([_oid(d.get("patient_ref")) for d in rows])
        out: list[dict] = []
        for d in rows:
            pid = _oid(d.get("patient_ref"))
            who = self._who(info.get(pid), pid, extra={"name": d.get("patient_name")})
            names = [n for n in ((i.get("name") or i.get("strip") or i.get("lot"))
                                 for i in (d.get("items") or [])) if n]
            overdue = (d.get("expected_at") or today) < today
            out.append({
                "signal": "advance_due", "subject": f"advance:{d['_id']}",
                "name": d.get("patient_name"), "hdika_name": True,
                "since": d.get("created_at"), "sex": who.get("sex"), "who": who,
                "extra": {"items": names[:3], "expected_at": d.get("expected_at"),
                          "overdue": overdue},
                "severity": 4 if overdue else 3,
                "href": "/patients/advance", "inbox": "/patients/advance",
            })
        return out

    async def _sig_no_contact(self, now: datetime) -> list[dict]:
        """Πέρασαν από το ταμείο και δεν ξέρεις πώς να τους βρεις. Δεν θα τους ξαναδείς με δική σου πρωτοβουλία."""
        since = now - timedelta(days=3)
        rows = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": since}}},
            {"$group": {"_id": "$patient_ref", "value": {"$sum": "$amount_total"},
                        "last": {"$max": "$executed_at"}}},
        ]).to_list(length=None)
        if not rows:
            return []
        pids = [r["_id"] for r in rows if r["_id"]]
        have: set = set()
        async for c in self._db["patient_contacts"].find(
                {"tenant_id": self.tenant_id, "_id": {"$in": pids}},
                {"mobile": 1, "phone": 1, "email": 1, "active": 1}):
            if c.get("active") is False or c.get("mobile") or c.get("phone") or c.get("email"):
                have.add(c["_id"])                        # έχει στοιχεία ή είναι ανενεργός
        missing = [r for r in rows if r["_id"] and r["_id"] not in have]
        if not missing:
            return []
        missing.sort(key=lambda r: r["value"], reverse=True)
        info = await self._patient_info([r["_id"] for r in missing[:6]])
        return [{
            "signal": "no_contact", "subject": "batch",
            "name": None, "since": min(r["last"] for r in missing),
            "money_cents": sum(r["value"] for r in missing),
            "extra": {"count": len(missing),
                      "names": [{"name": info[r["_id"]]["name"], "sex": info[r["_id"]].get("sex")}
                                for r in missing[:4] if info.get(r["_id"], {}).get("name")]},
            "severity": 2, "inbox": "/patients/verify-contacts",
        }]

    async def _sig_vaccine_missed(self, now: datetime) -> list[dict]:
        """Ήταν μπροστά σου, δικαιούται εμβόλιο, και δεν του το είπες."""
        season = now.year if now.month >= 10 else now.year - 1
        start = datetime(season, 10, 1, tzinfo=timezone.utc)
        end = datetime(season + 1, 5, 1, tzinfo=timezone.utc)
        if not (start <= now < end):
            return []                                      # εκτός εμβολιαστικής περιόδου
        since = now - timedelta(days=3)
        rows = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": since}}},
            {"$group": {"_id": "$patient_ref", "last": {"$max": "$executed_at"}}},
        ]).to_list(length=None)
        pids = [r["_id"] for r in rows if r["_id"]]
        if not pids:
            return []
        elig: dict = {}
        async for p in self._db["patients_anonymized"].find(
                {"tenant_id": self.tenant_id, "_id": {"$in": pids},
                 "age_group": {"$in": ["65-74", "75+"]}},
                {"full_name": 1, "pseudo_id": 1, "age_group": 1, "sex": 1, "amka": 1}):
            elig[p["_id"]] = p
        if not elig:
            return []
        done = {r["_id"] for r in await self._db["vaccinations"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "cancelled": {"$ne": True}, "excluded_from_stats": {"$ne": True},
                        "executed_at": {"$gte": start, "$lt": end},
                        "patient_ref": {"$in": [p["pseudo_id"] for p in elig.values() if p.get("pseudo_id")]}}},
            {"$group": {"_id": "$patient_ref"}},
        ]).to_list(length=None)}
        inactive = {c["_id"] async for c in self._db["patient_contacts"].find(
            {"tenant_id": self.tenant_id, "_id": {"$in": list(elig)}, "active": False}, {"_id": 1})}
        last = {r["_id"]: r["last"] for r in rows}
        contacts_info = await self._patient_info(list(elig))
        out = []
        for pid, p in elig.items():
            if p.get("pseudo_id") in done or pid in inactive:
                continue
            who = self._who(contacts_info.get(pid), pid, extra={
                "name": mask_name(p.get("full_name"), self.demo), "sex": p.get("sex"),
                "amka": mask_amka(p.get("amka"), self.demo)})
            out.append({
                "signal": "vaccine_missed", "subject": str(pid),
                "name": who.get("name"), "sex": p.get("sex"), "who": who,
                "since": last.get(pid), "money_cents": None,
                "extra": {"age_group": p.get("age_group")},
                "severity": 2, "inbox": "/vaccinations",
            })
        return out[:8]

    async def _sig_lapsed_chronic(self, now: datetime) -> list[dict]:
        """Χρόνιος ασθενής που περίμενες και δεν ήρθε. Κάθε μέρα που περνά, λιγότερες πιθανότητες."""
        rows = [f async for f in self._db["future_prescriptions"].find(
            {"tenant_id": self.tenant_id, "status": "pending",
             "expected_open_date": {"$lt": now - timedelta(days=10),
                                    "$gte": now - timedelta(days=45)}},
            {"patient_ref": 1, "expected_open_date": 1}).sort("expected_open_date", 1).limit(500)]
        if not rows:
            return []
        by_pat: dict = {}
        for f in rows:
            pid = f.get("patient_ref")
            if pid and pid not in by_pat:
                by_pat[pid] = f
        # μόνο οι πραγματικά αξιόλογοι — αλλιώς πνίγεται η λίστα
        pats = {p["_id"]: p async for p in self._db["patients_anonymized"].find(
            {"tenant_id": self.tenant_id, "_id": {"$in": list(by_pat)}, "rx_count": {"$gte": 12}},
            {"full_name": 1, "rx_value_total": 1, "rx_count": 1, "last_seen_at": 1, "sex": 1})}
        if not pats:
            return []
        inactive = {c["_id"] async for c in self._db["patient_contacts"].find(
            {"tenant_id": self.tenant_id, "_id": {"$in": list(pats)}, "active": False}, {"_id": 1})}
        cand = [(pid, p) for pid, p in pats.items() if pid not in inactive]
        cand.sort(key=lambda t: t[1].get("rx_value_total") or 0, reverse=True)
        info = await self._patient_info([pid for pid, _ in cand[:6]])
        out = []
        for pid, p in cand[:6]:
            per_visit = int((p.get("rx_value_total") or 0) / max(1, p.get("rx_count") or 1))
            who = self._who(info.get(pid), pid, extra={
                "name": mask_name(p.get("full_name"), self.demo), "sex": p.get("sex")})
            out.append({
                "signal": "lapsed_chronic", "subject": str(pid),
                "name": who.get("name"), "sex": p.get("sex"), "who": who,
                "since": by_pat[pid]["expected_open_date"], "money_cents": per_visit,
                "extra": {"rx_count": p.get("rx_count")}, "severity": 2,
            })
        return out

    # ─────────────────────────────────────────────────────────────────────────
    # ΛΕΙΤΟΥΡΓΙΑ & ΚΕΡΔΟΣ — ο σύμβουλος δεν παρακολουθεί μόνο ασθενείς
    #
    # ΓΙΑΤΙ ΑΝΑ ΕΚΤΕΛΕΣΗ ΚΑΙ ΟΧΙ ΑΝΑ ΕΙΔΟΣ: η λιανική ΑΝΑ ΕΙΔΟΣ είναι αναξιόπιστη — όταν πέντε
    # είδη μοιράζονται μία εκτέλεση, το ποσό δεν επιμερίζεται. Μετρημένο 19/09/2026: ΚΑΘΕ μία από
    # τις 163 γραμμές «αρνητικού περιθωρίου» είχε λιανική 0 — δηλαδή ΚΑΜΙΑ πραγματική ζημιά. Ένα
    # σήμα πάνω σε αυτό το πεδίο θα έλεγε στον φαρμακοποιό ότι έχασε 1.738€ που δεν έχασε ποτέ.
    # Η ΕΚΤΕΛΕΣΗ όμως έχει σωστά και τα δύο ποσά (amount_total 100% συμπληρωμένο, wholesale_cost).
    # ─────────────────────────────────────────────────────────────────────────

    async def _totals(self, start: datetime, end: datetime) -> dict:
        """Τζίρος, κόστος και πλήθος εκτελέσεων μιας περιόδου."""
        agg = [{"$match": {"tenant_id": self.tenant_id, "amount_total": {"$gt": 0},
                           "executed_at": {"$gte": start, "$lt": end}}},
               {"$group": {"_id": None, "rev": {"$sum": "$amount_total"},
                           "cost": {"$sum": "$wholesale_cost"}, "n": {"$sum": 1}}}]
        async for r in self._db["prescription_executions"].aggregate(agg):
            return {"rev": int(r.get("rev") or 0), "cost": int(r.get("cost") or 0),
                    "n": int(r.get("n") or 0)}
        return {"rev": 0, "cost": 0, "n": 0}

    async def _data_is_fresh(self, now: datetime) -> bool:
        """Έχουμε ΠΡΟΣΦΑΤΑ δεδομένα για να μιλήσουμε για τζίρο και περιθώριο;

        ⚠️ ΧΩΡΙΣ ΑΥΤΟ Ο ΣΥΜΒΟΥΛΟΣ ΚΑΤΗΓΟΡΕΙ ΤΟΝ ΠΕΛΑΤΗ ΓΙΑ ΔΙΚΟ ΜΑΣ ΠΡΟΒΛΗΜΑ. Μετρημένο
        22/09/2026: φαρμακείο με σταματημένο συγχρονισμό 26 ημερών εμφάνιζε «πτώση τζίρου 82%».
        Δεν είχε πέσει τίποτα — απλώς σταματήσαμε να κατεβάζουμε. Ένα τέτοιο μήνυμα τρομάζει
        τον φαρμακοποιό και, όταν ανακαλύψει την αλήθεια, δεν ξαναπιστεύει ΚΑΝΕΝΑ σήμα.

        Τρεις ημέρες ανοχή: η ΗΔΥΚΑ καταχωρεί με καθυστέρηση και τα Σαββατοκύριακα είναι αραιά.
        """
        last = await self._db["prescription_executions"].find_one(
            {"tenant_id": self.tenant_id}, sort=[("executed_at", -1)],
            projection={"executed_at": 1})
        at = (last or {}).get("executed_at")
        return bool(at and (now - at).days <= 3)

    async def _sig_loss_execution(self, now: datetime) -> list[dict]:
        """Εκτέλεση που κόστισε περισσότερα απ' όσα έφερε. Σπάνιο — άρα αληθινό όταν συμβαίνει."""
        out = []
        async for e in self._db["prescription_executions"].find(
                {"tenant_id": self.tenant_id, "amount_total": {"$gt": 0},
                 "wholesale_cost": {"$gt": 0},
                 "executed_at": {"$gte": now - timedelta(days=30)},
                 "$expr": {"$gt": ["$wholesale_cost", "$amount_total"]}},
                {"external_id": 1, "executed_at": 1, "amount_total": 1, "wholesale_cost": 1}
        ).sort("executed_at", -1).limit(20):
            loss = int(e["wholesale_cost"]) - int(e["amount_total"])
            if loss < 100:
                continue                       # κάτω από 1€: στρογγυλοποίηση, όχι πρόβλημα
            out.append({"signal": "loss_execution",
                        "subject": str(e.get("external_id") or e["_id"]),
                        "since": e.get("executed_at"), "money_cents": loss,
                        "rx": e.get("external_id"), "severity": 3,
                        "extra": {"rev": e.get("amount_total"), "cost": e.get("wholesale_cost")}})
        return out

    async def _sig_margin_drop(self, now: datetime) -> list[dict]:
        """Το περιθώριο έπεσε σε σχέση με το ΔΙΚΟ ΤΟΥ ιστορικό.

        Η διατίμηση κρατά το μικτό περιθώριο πολύ σταθερό (μετρημένο: 25–26% σε ΟΛΑ τα φαρμακεία).
        Γι' αυτό ακόμη και 2 μονάδες πτώσης ΔΕΝ είναι διακύμανση — είναι κάτι που άλλαξε.
        """
        if not await self._data_is_fresh(now):
            return []          # κενό στα δεδομένα ΜΑΣ — δεν το χρεώνουμε στον πελάτη
        cur = await self._totals(now - timedelta(days=30), now)
        base = await self._totals(now - timedelta(days=120), now - timedelta(days=30))
        if cur["n"] < _MIN_EXECS or base["n"] < _MIN_EXECS or not cur["rev"] or not base["rev"]:
            return []                          # λίγα δεδομένα: καμία γνώμη
        cur_pct = (cur["rev"] - cur["cost"]) * 100 / cur["rev"]
        base_pct = (base["rev"] - base["cost"]) * 100 / base["rev"]
        gap = base_pct - cur_pct
        if gap < 2:
            return []
        return [{"signal": "margin_drop", "subject": "period", "since": now - timedelta(days=30),
                 "money_cents": int(cur["rev"] * gap / 100), "inbox": "/analytics", "severity": 3,
                 "extra": {"cur": round(cur_pct, 1), "base": round(base_pct, 1),
                           "gap": round(gap, 1)}}]

    async def _sig_revenue_drop(self, now: datetime) -> list[dict]:
        """Πτώση τζίρου σε σχέση με τον προηγούμενο μήνα — πριν τη νιώσει στο ταμείο."""
        if not await self._data_is_fresh(now):
            return []          # δες `_data_is_fresh` — σταματημένος συγχρονισμός ΔΕΝ είναι πτώση τζίρου
        cur = await self._totals(now - timedelta(days=30), now)
        prev = await self._totals(now - timedelta(days=60), now - timedelta(days=30))
        if cur["n"] < _MIN_EXECS or prev["n"] < _MIN_EXECS or prev["rev"] <= 0:
            return []
        drop = prev["rev"] - cur["rev"]
        pct = drop * 100 // prev["rev"]
        if drop <= 0 or pct < 12:
            return []                          # κάτω από 12%: εποχικότητα, όχι σήμα
        return [{"signal": "revenue_drop", "subject": "period", "since": now - timedelta(days=30),
                 "money_cents": drop, "inbox": "/analytics", "severity": 3,
                 "extra": {"pct": pct, "prev": prev["rev"], "cur": cur["rev"]}}]

    # ── Αποθήκη: ΚΟΙΜΟΥΝΤΑΙ μέχρι να υπάρξει πραγματικό απόθεμα ──────────────
    async def _stock_ready(self) -> bool:
        """Μια αποθήκη με πέντε είδη δεν είναι αποθήκη — είναι δοκιμή.

        Χωρίς αυτόν τον φραγμό, ένα φαρμακείο που μόλις καταχώρησε δύο προϊόντα θα δεχόταν
        «συμβουλές αποθήκης» βγαλμένες από το τίποτα, και θα έπαυε να εμπιστεύεται τον σύμβουλο
        ΚΑΙ στα υπόλοιπα. Μετρημένο 22/09/2026: σε ΟΛΑ τα φαρμακεία μαζί υπήρχαν 13 είδη με
        απόθεμα και ΚΑΜΙΑ ημερομηνία λήξης — γι' αυτό τα σήματα αυτά γεννιούνται κοιμισμένα.
        """
        n = await self._db["pharmacy_products"].count_documents(
            {"tenant_id": self.tenant_id, "stock_qty": {"$gt": 0}}, limit=_STOCK_MIN)
        return n >= _STOCK_MIN

    async def _stock_bucket(self, query: dict, *, signal: str, severity: int,
                            inbox: str, now: datetime) -> list[dict]:
        """Ένα θέμα ΣΥΝΟΛΙΚΑ ανά κατηγορία αποθήκης, όχι ένα ανά προϊόν.

        Πενήντα ξεχωριστά «έληξε το Χ» δεν είναι συμβουλή· είναι λίστα. Ο σύμβουλος λέει πόσα
        και πόσων αξίας, και στέλνει στη λίστα για τη λεπτομέρεια.
        """
        n, value, names = 0, 0, []
        async for pr in self._db["pharmacy_products"].find(
                {"tenant_id": self.tenant_id, **query},
                {"name": 1, "stock_qty": 1, "wholesale_price": 1}).limit(500):
            n += 1
            value += int(pr.get("stock_qty") or 0) * int(pr.get("wholesale_price") or 0)
            if len(names) < 3 and pr.get("name"):
                names.append(pr["name"])
        if not n:
            return []
        return [{"signal": signal, "subject": "stock", "since": now, "money_cents": value or None,
                 "inbox": inbox, "severity": severity, "extra": {"count": n, "names": names}}]

    async def _sig_expired_stock(self, now: datetime) -> list[dict]:
        """Ληγμένα στο ράφι — χρήματα ήδη χαμένα, που μπορεί να πουληθούν κιόλας."""
        if not await self._stock_ready():
            return []
        today = now.date().isoformat()
        return await self._stock_bucket(
            {"stock_qty": {"$gt": 0}, "expiry": {"$ne": None, "$gt": "", "$lt": today}},
            signal="expired_stock", severity=3, inbox="/warehouse?expiring=expired", now=now)

    async def _sig_expiring_soon(self, now: datetime) -> list[dict]:
        """Λήγουν σε τρεις μήνες: ακόμη προλαβαίνεις να τα κινήσεις."""
        if not await self._stock_ready():
            return []
        today = now.date().isoformat()
        soon = (now + timedelta(days=90)).date().isoformat()
        return await self._stock_bucket(
            {"stock_qty": {"$gt": 0}, "expiry": {"$gte": today, "$lt": soon}},
            signal="expiring_soon", severity=2, inbox="/warehouse?expiring=90", now=now)

    async def _sig_below_reorder(self, now: datetime) -> list[dict]:
        """Κάτω από το σημείο αναπαραγγελίας που όρισε ο ΙΔΙΟΣ — χαμένη πώληση, όχι γνώμη μας."""
        if not await self._stock_ready():
            return []
        return await self._stock_bucket(
            {"min_stock": {"$gt": 0}, "$expr": {"$lte": ["$stock_qty", "$min_stock"]}},
            signal="below_reorder", severity=2, inbox="/warehouse?stock=low", now=now)

    async def _sig_dead_stock(self, now: datetime) -> list[dict]:
        """Απόθεμα που δεν κινήθηκε έξι μήνες — κεφάλαιο δεμένο στο ράφι."""
        if not await self._stock_ready():
            return []
        moved = await self._db["pharmacy_stock_movements"].distinct(
            "product_id", {"tenant_id": self.tenant_id,
                           "created_at": {"$gte": now - timedelta(days=180)}})
        if not moved:
            return []      # καμία κίνηση καταγεγραμμένη: δεν ξέρουμε τι κινήθηκε, άρα σιωπή
        return await self._stock_bucket(
            {"stock_qty": {"$gt": 0}, "_id": {"$nin": moved}},
            signal="dead_stock", severity=1, inbox="/warehouse?stock=in", now=now)

    # ─────────────────────────────────────────────────────────────────────────
    # ΕΠΙΒΡΑΒΕΥΣΗ — από τα ίδια δεδομένα, όχι ευγένειες
    # ─────────────────────────────────────────────────────────────────────────

    async def _wins(self, now: datetime) -> list[dict]:
        wins: list[dict] = []
        week = now - timedelta(days=7)

        def _emoji(w: dict) -> dict:
            w["emoji"] = V.WIN_EMOJI.get(w["key"], "✅")
            return w

        # 1. Ανεκτέλεστα που ΕΚΛΕΙΣΑΝ: ασθενής με ανεκτέλεστο ΓΥΡΙΣΕ και το ολοκλήρωσε.
        # Δύο απλά group-by αντί για per-patient $lookup — το ίδιο αποτέλεσμα, κλάσμα του κόστους.
        had = {r["_id"]: r["first"] for r in await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "has_unexecuted_substances": True,
                        "executed_at": {"$gte": now - timedelta(days=30)}}},
            {"$group": {"_id": "$patient_ref", "first": {"$min": "$executed_at"}}},
        ]).to_list(length=None)}
        n = 0
        if had:
            for r in await self._db["prescription_executions"].aggregate([
                {"$match": {"tenant_id": self.tenant_id, "executed_at": {"$gte": week},
                            "has_unexecuted_substances": {"$ne": True},
                            "patient_ref": {"$in": list(had)}}},
                {"$group": {"_id": "$patient_ref", "last": {"$max": "$executed_at"}}},
            ]).to_list(length=None):
                if r["last"] > had[r["_id"]]:
                    n += 1
        if n:
            wins.append({"key": "w_unexec_closed", "count": n,
                         "text": (f"{V.people(n).capitalize()} που είχαν φύγει με μισή συνταγή "
                                  f"γύρισαν μέσα στην εβδομάδα και την ολοκλήρωσαν. "
                                  f"Δεν έγινε μόνο του· κάποιος ασχολήθηκε μαζί τους.")})

        # 2. Γρήγορες απαντήσεις σε αιτήματα πελατών (<2 ώρες)
        fast = 0
        for coll, ts in (("rx_requests", "replied_at"), ("availability_requests", "answered_at")):
            async for d in self._db[coll].find(
                    {"tenant_id": self.tenant_id, ts: {"$gte": week}}, {"created_at": 1, ts: 1}):
                if d.get(ts) and d.get("created_at") and (d[ts] - d["created_at"]) <= timedelta(hours=2):
                    fast += 1
        if fast:
            wins.append({"key": "w_fast_reply", "count": fast,
                         "text": (f"{V.count_word(fast, feminine=True).capitalize()} φορές απάντησες σε "
                                  f"πελάτη μέσα σε δύο ώρες. Αυτό είναι που τους κάνει να ξαναγράφουν "
                                  f"σ' εσένα και όχι στο διπλανό φαρμακείο.")})

        # 3. Στοιχεία επικοινωνίας που συμπληρώθηκαν
        added = await self._db["patient_contacts"].count_documents(
            {"tenant_id": self.tenant_id, "contact_updated_at": {"$gte": week},
             "contact_source": {"$in": ["pharmacist", "patient"]}})
        if added:
            wins.append({"key": "w_contacts", "count": added,
                         "text": (f"Καταχωρήθηκαν στοιχεία επικοινωνίας για "
                                  f"{'έναν άνθρωπο' if added == 1 else f'{added} ανθρώπους'} "
                                  f"αυτή την εβδομάδα. "
                                  f"{'Είναι κάποιος' if added == 1 else 'Καθένας τους είναι κάποιος'} "
                                  f"που μπορείς πλέον να ειδοποιήσεις — αντί να περιμένεις "
                                  f"να θυμηθεί μόνος του.")})

        # 4. Εμβολιασμοί
        vacc = await self._db["vaccinations"].count_documents(
            {"tenant_id": self.tenant_id, "cancelled": {"$ne": True}, "excluded_from_stats": {"$ne": True}, "executed_at": {"$gte": week}})
        if vacc:
            wins.append({"key": "w_vaccines", "count": vacc,
                         "text": (f"{vacc} εμβολιασμοί μέσα στην εβδομάδα. Πέρα από τα λεφτά: "
                                  f"{vacc} άνθρωποι που πιθανότατα δεν θα αρρωστήσουν φέτος "
                                  f"επειδή μπήκαν στο δικό σου φαρμακείο.")})
        return [_emoji(w) for w in wins]

    # ─────────────────────────────────────────────────────────────────────────
    # βοηθητικά
    # ─────────────────────────────────────────────────────────────────────────

    async def _patient_info(self, ids: list) -> dict:
        """_id → {name, sex, amka, mobile, phone, email}.

        Το φύλο δεν είναι στολίδι: χωρίς αυτό ο σύμβουλος λέει «ο ΚΩΝΣΤΑΝΤΙΝΟΣ… της μένουν».
        Το ΑΜΚΑ και το τηλέφωνο δεν είναι στολίδι ούτε αυτά: «ο ΧΑΡΑΛΑΜΠΟΣ» δεν ταυτοποιεί
        κανέναν σε φαρμακείο με 14.000 πελάτες, και μια προτροπή «πάρ' τον τηλέφωνο» χωρίς
        τον αριθμό είναι απλώς μια ευχή.
        """
        ids = [i for i in ids if i]
        if not ids:
            return {}
        out = {}
        async for p in self._db["patients_anonymized"].find(
                {"tenant_id": self.tenant_id, "_id": {"$in": ids}},
                {"full_name": 1, "sex": 1, "amka": 1}):
            out[p["_id"]] = {"name": mask_name(p.get("full_name"), self.demo), "sex": p.get("sex"),
                             "amka": mask_amka(p.get("amka"), self.demo)}
        async for c in self._db["patient_contacts"].find(
                {"tenant_id": self.tenant_id, "_id": {"$in": ids}},
                {"mobile": 1, "phone": 1, "email": 1}):
            if c["_id"] in out:
                out[c["_id"]].update(
                    mobile=pseudo_phone(c.get("mobile"), self.demo),
                    phone=pseudo_phone(c.get("phone"), self.demo),
                    email=pseudo_email(c.get("email"), self.demo))
        return out

    @staticmethod
    def _who(info: dict | None, pid, *, extra: dict | None = None) -> dict:
        """Η «ταυτότητα» του ευρήματος — ό,τι χρειάζεται η κάρτα για να δείξει ΠΟΙΟΝ αφορά
        και να δώσει τρόπο να τον βρεις. Ένα εύρημα χωρίς αυτό είναι παρατήρηση, όχι ενέργεια."""
        d = dict(info or {})
        d.update(extra or {})
        d["id"] = str(pid) if pid else None
        return d

    async def _missing_items(self, exec_ids: list) -> dict:
        """execution_id → {names, retail(cents), margin(cents)} για ΜΟΝΟ τα ανεκτέλεστα είδη."""
        rows = [i async for i in self._db["prescription_items"].find(
            {"tenant_id": self.tenant_id, "execution_id": {"$in": exec_ids}, "is_executed": False},
            {"execution_id": 1, "product_id": 1, "quantity": 1, "retail_price": 1, "margin": 1})]
        if not rows:
            return {}
        prods = {}
        async for p in self._db["products"].find(
                {"_id": {"$in": list({r["product_id"] for r in rows if r.get("product_id")})}},
                {"name": 1, "commercial_name": 1}):
            prods[p["_id"]] = p.get("commercial_name") or p.get("name")
        out: dict = {}
        for r in rows:
            b = out.setdefault(r["execution_id"], {"names": [], "retail": 0, "margin": 0})
            q = int(r.get("quantity") or 1)
            nm = prods.get(r.get("product_id"))
            if nm and nm not in b["names"]:
                b["names"].append(nm)
            b["retail"] += int(r.get("retail_price") or 0) * q
            b["margin"] += int(r.get("margin") or 0) * q
        return out

    # ─────────────────────────────────────────────────────────────────────────
    # Η ΓΛΩΣΣΑ — ωμό εύρημα + ιστορικό ⇒ κουβέντα
    # ─────────────────────────────────────────────────────────────────────────

    def _speak_business(self, f: dict, tone: str) -> dict:
        """Φωνή για τα σήματα «Λειτουργία & Κέρδος».

        ΚΑΝΟΝΑΣ: λέμε ΤΙ, ΠΟΣΟ και ΠΑΝΩ ΣΕ ΤΙ το στηρίζουμε. Ο φαρμακοποιός ξέρει τη δουλειά του
        καλύτερα από εμάς — αν του πούμε «κάτι πάει στραβά» χωρίς νούμερο και βάση, είναι θόρυβος.
        """
        ex = f.get("extra") or {}
        money = V.money(f.get("money_cents")) if f.get("money_cents") else None
        n = ex.get("count", 0)
        some = ", ".join(V.product(x) for x in (ex.get("names") or [])[:2])

        if f["signal"] == "loss_execution":
            title = "Μια εκτέλεση σού κόστισε περισσότερα απ' όσα έφερε"
            body = (f"Πλήρωσες {V.money(ex.get('cost'))} για φάρμακα και εισέπραξες "
                    f"{V.money(ex.get('rev'))} — διαφορά {money} σε βάρος σου. Συνήθως φταίει "
                    f"τιμή αγοράς που δεν ενημερώθηκε ή είδος εκτός διατίμησης.")
            action = "Δες την εκτέλεση"
        elif f["signal"] == "margin_drop":
            title = f"Το περιθώριό σου έπεσε στο {ex.get('cur')}%"
            body = (f"Τους προηγούμενους τρεις μήνες κρατούσες {ex.get('base')}% και τον τελευταίο "
                    f"μήνα {ex.get('cur')}% — {ex.get('gap')} μονάδες κάτω, περίπου {money} "
                    f"λιγότερο κέρδος. Η διατίμηση κρατά το περιθώριο σταθερό, οπότε μια τέτοια "
                    f"διαφορά δεν είναι διακύμανση: κάτι άλλαξε στις τιμές αγοράς ή στο μείγμα.")
            action = "Δες την κερδοφορία"
        elif f["signal"] == "revenue_drop":
            title = f"Ο τζίρος σου έπεσε {ex.get('pct')}% τον τελευταίο μήνα"
            body = (f"Από {V.money(ex.get('prev'))} σε {V.money(ex.get('cur'))} — {money} "
                    f"λιγότερα. Αξίζει να δεις αν έφυγαν συγκεκριμένοι πελάτες ή αν έπεσε "
                    f"συγκεκριμένη κατηγορία.")
            action = "Δες τον τζίρο"
        elif f["signal"] == "expired_stock":
            title = f"{n} ληγμένα είδη είναι ακόμη στο ράφι"
            body = (f"Αξίας {money} σε τιμή αγοράς" + (f" — {some} ανάμεσά τους" if some else "") +
                    ". Τα χρήματα χάθηκαν ήδη· μένει να μην πουληθούν κατά λάθος.")
            action = "Δες τα ληγμένα"
        elif f["signal"] == "expiring_soon":
            title = f"{n} είδη λήγουν μέσα στο τρίμηνο"
            body = (f"Απόθεμα {money}" + (f" — {some} ανάμεσά τους" if some else "") +
                    ". Προλαβαίνεις ακόμη να τα κινήσεις ή να τα επιστρέψεις.")
            action = "Δες τι λήγει"
        elif f["signal"] == "dead_stock":
            title = f"{n} είδη δεν κινήθηκαν έξι μήνες"
            body = (f"Κεφάλαιο {money} δεμένο στο ράφι" +
                    (f" — {some} ανάμεσά τους" if some else "") + ".")
            action = "Δες τα ακίνητα"
        else:                                    # below_reorder
            title = f"{n} είδη κάτω από το σημείο αναπαραγγελίας"
            body = ("Είναι το όριο που όρισες εσύ" +
                    (f" — {some} ανάμεσά τους" if some else "") +
                    ". Όσο λείπουν, η πώληση πάει αλλού.")
            action = "Δες τι λείπει"

        return {"title": title, "body": body, "action": action, "tone": tone}

    def _speak(self, f: dict, st: dict) -> dict:
        """Ωμό εύρημα ⇒ κουβέντα.

        ΥΦΟΣ (ρητή απαίτηση): φιλικός αλλά επαγγελματίας σύμβουλος. Ολοκληρωμένες προτάσεις,
        το όνομα ΠΑΝΤΑ σε ονομαστική με άρθρο («Ο ΓΙΩΡΓΟΣ…», «Η ΜΑΡΙΑ…») ώστε να μη χρειάζεται
        κλίση ονόματος (η ΗΔΥΚΑ τα δίνει άκλιτα και κάθε προσπάθεια κλίσης βγάζει λάθος).
        Ποτέ προσβολή· η σοβαρότητα βγαίνει από το ίδιο το γεγονός, όχι από τον χαρακτηρισμό.
        """
        streak = int(st.get("days_seen") or 1)
        relapses = int(st.get("relapses") or 0)
        tone = V.tone_for(streak + relapses)
        opener = V.repeat_opener(streak + relapses)
        sig = f["signal"]
        # Τα σήματα της επιχείρησης δεν έχουν όνομα ούτε γένος: αν περνούσαν από τον παρακάτω
        # κώδικα θα προσπαθούσε να κλίνει ανύπαρκτο πρόσωπο («Ο None…»). Χωριστή φωνή.
        if sig in BUSINESS_SIGNALS:
            return self._speak_business(f, tone)
        sex = f.get("sex")
        # Η ΗΔΥΚΑ δίνει «ΕΠΩΝΥΜΟ ΟΝΟΜΑ» (το μικρό είναι τελευταίο)· η πύλη δίνει ό,τι έγραψε ο
        # ίδιος ο πελάτης. Εκεί ΔΕΝ μαντεύουμε — λέμε το όνομα όπως το έδωσε.
        who = V.first_name(f.get("name")) if f.get("hdika_name", True) else V.person(f.get("name"))
        art = V.the(sex)                        # «Ο» / «Η»
        subj = f"{art} {who}"                   # ονομαστική — δουλεύει σε κάθε πρόταση
        # Στον ΤΙΤΛΟ μπαίνει ΟΛΟΚΛΗΡΟ το ονοματεπώνυμο: «ο ΧΑΡΑΛΑΜΠΟΣ» δεν ταυτοποιεί κανέναν
        # σε φαρμακείο με χιλιάδες πελάτες. Στο κείμενο μένει το μικρό, για να διαβάζεται.
        subj_full = f"{art} {V.person(f.get('name'))}"
        ago = V.ago_phrase(_days_between(f.get("since"), _now()))
        ex = f.get("extra") or {}
        money = V.money(f.get("money_cents")) if f.get("money_cents") else None
        him = V.g(sex, "τον", "την")
        gen = V.g(sex, "του", "της")

        if sig == "advance_due":
            names = [V.product(n) for n in (ex.get("items") or [])]
            rest = f" και άλλα {len(names) - 2}" if len(names) > 2 else ""
            what = f"το {names[0]}" if len(names) == 1 else ", ".join(names[:2]) + rest
            if ex.get("overdue"):
                title = f"{subj_full} δεν έφερε ακόμη τη συνταγή για {what}"
                body = ("Είχε πει ότι θα την έφερνε και η μέρα πέρασε. "
                        f"Πήρε {what} χωρίς συνταγή και το κουτί λείπει από το ράφι σου "
                        "μέχρι να ξεχρεωθεί. Ένα τηλέφωνο σήμερα το λύνει.")
            else:
                title = f"{subj_full} θα φέρει σήμερα τη συνταγή για {what}"
                body = ("Το είχε πάρει χωρίς συνταγή και σήμερα είναι η μέρα που συμφωνήσατε. "
                        "Αν δεν εμφανιστεί μέχρι το κλείσιμο, αξίζει μια υπενθύμιση.")
            return {"title": title, "body": opener + body if opener else body}

        if sig == "unexecuted":
            names = [V.product(n) for n in (f.get("items") or [])]
            what = (f"το {names[0]}" if len(names) == 1
                    else ", ".join(names[:2]) + (f" και άλλα {len(names) - 2}" if len(names) > 2 else ""))
            title = f"{subj_full} έφυγε χωρίς μέρος της συνταγής {gen}"
            body = (f"Πέρασε {ago} και δεν πήρε {what}. "
                    f"Μιλάμε για {money} που πιθανότατα θα καταλήξουν σε άλλο φαρμακείο")
            if f.get("profit_cents"):
                body += f", και μαζί τους {V.money(f['profit_cents'])} δικό σου κέρδος"
            body += ". "
            if tone == V.TONE_HARD:
                body += ("Όταν κάποιος συνηθίσει να συμπληρώνει τη συνταγή του αλλού, συνήθως "
                         "δεν το ξανασκέφτεται. Αξίζει να μπει σήμερα στη λίστα σου.")
            else:
                body += ("Ένα τηλέφωνο συνήθως αρκεί — οι περισσότεροι επιστρέφουν μόλις "
                         "μάθουν ότι τους το κρατάς.")
            action = f"Πάρ' {him} τηλέφωνο"

        elif sig == "repeat_expiring":
            left, dl = ex.get("left", 1), ex.get("days_left", 0)
            when = ("σήμερα" if dl == 0 else "αύριο" if dl == 1
                    else f"σε {V.count_word(dl, feminine=True)} μέρες")
            title = f"{subj_full} χάνει {V.doses(left)} {when}"
            body = (f"Η επαναλαμβανόμενη συνταγή {gen} λήγει {when} και "
                    f"{'μένει' if left == 1 else 'μένουν'} {V.doses(left)} αχρησιμοποίητ"
                    f"{'η' if left == 1 else 'ες'}. Αν δεν προλάβει, θα χρειαστεί να ξαναπάει "
                    f"στον γιατρό για να {'την' if left == 1 else 'τις'} ξαναγράψει — και για "
                    f"το φαρμακείο είναι {money} που δεν θα εκτελεστούν ποτέ. "
                    f"Μια υπενθύμιση σήμερα το λύνει.")
            action = f"Ειδοποίησέ {him} σήμερα"

        elif sig == "idle_request":
            what = ex.get("what", "έστειλε ένα αίτημα")
            title = f"{subj_full} περιμένει απάντηση {V.days_phrase(_days_between(f.get('since'), _now()))}"
            body = f"{what.capitalize()} μέσα από την πύλη και το αίτημα παραμένει αναπάντητο. "
            if ex.get("detail"):
                body += f"Έγραψε: «{str(ex['detail'])[:120]}». "
            if tone == V.TONE_SOFT:
                body += ("Μια σύντομη απάντηση, έστω «το κοιτάζω», είναι αρκετή για να "
                         "μην αισθανθεί ότι τον ξέχασαν.")
            elif tone == V.TONE_FIRM:
                body += ("Όποιος ρωτήσει και δεν πάρει απάντηση, συνήθως δεν ξαναρωτά — "
                         "και δεν το λέει κιόλας.")
            else:
                body += ("Η πύλη έχει αξία μόνο όσο κάποιος απαντά σε αυτήν· διαφορετικά "
                         "δουλεύει εναντίον του φαρμακείου. Αξίζει να κλείσει σήμερα.")
            action = "Απάντησε στο αίτημα"

        elif sig == "no_contact":
            n = ex.get("count", 0)
            nms = [f"{V.the(x.get('sex'), cap=False)} {V.first_name(x.get('name'))}"
                   for x in (ex.get("names") or []) if x and x.get("name")][:2]
            who_list = (" και ".join(nms) + (" ανάμεσά τους" if n > len(nms) else "")) if nms else ""
            title = f"{n} πελάτες χωρίς στοιχεία επικοινωνίας"
            body = (f"{V.people(n).capitalize()} πέρασαν από το φαρμακείο τις τελευταίες τρεις "
                    f"μέρες" + (f" — {who_list} — " if who_list else " ") +
                    f"και άφησαν {money}, αλλά στην καρτέλα τους δεν υπάρχει ούτε τηλέφωνο "
                    f"ούτε email. Αν αύριο έρθει το φάρμακό τους ή λήξει η συνταγή τους, "
                    f"δεν υπάρχει τρόπος να τους το πεις.")
            if tone == V.TONE_HARD:
                body += (" Δέκα δευτερόλεπτα στο ταμείο είναι όλη κι όλη η διαφορά ανάμεσα "
                         "σε πελάτη και σε περαστικό.")
            else:
                body += " Δέκα δευτερόλεπτα στο ταμείο αρκούν."
            action = "Ζήτα στοιχεία στο ταμείο"

        elif sig == "vaccine_missed":
            title = f"{subj_full} δικαιούται αντιγριπικό"
            body = (f"Ανήκει στην ομάδα {ex.get('age_group', '65+')}, πέρασε από το φαρμακείο "
                    f"{ago} και δεν έχει εμβολιαστεί φέτος. Δεν είναι θέμα πώλησης· είναι "
                    f"ακριβώς ο ρόλος που έχει ένα φαρμακείο στη γειτονιά του. ")
            body += ("Σε αυτή την ηλικία η γρίπη δεν είναι απλώς ενόχληση, και η σύσταση "
                     "βαραίνει περισσότερο όταν έρχεται από το φαρμακείο που εμπιστεύεται."
                     if tone == V.TONE_HARD
                     else "Μια κουβέντα στο ταμείο, την επόμενη φορά που θα περάσει, αρκεί.")
            action = "Πρότεινε εμβολιασμό"

        elif sig == "lapsed_chronic":
            title = f"{subj_full} σταμάτησε να έρχεται"
            body = (f"Έχει εκτελέσει {ex.get('rx_count', 'πολλές')} συνταγές εδώ, αλλά η "
                    f"επόμενη αναμενόταν {ago} και δεν εμφανίστηκε. Κάθε επίσκεψη άξιζε "
                    f"περίπου {money}· το ουσιαστικό ερώτημα όμως είναι άλλο: όταν ένας "
                    f"χρόνιος ασθενής σταματά απότομα, ή άλλαξε φαρμακείο ή έχει συμβεί κάτι. "
                    f"Ένα τηλέφωνο θα το ξεκαθαρίσει.")
            action = f"Πάρ' {him} τηλέφωνο"

        else:
            title, body, action = f["signal"], "", ""

        if ex.get("rest"):
            body += (f" Στην ίδια ακριβώς κατάσταση βρίσκονται σήμερα άλλοι "
                     f"{ex['rest']} πελάτες.")
        if opener:
            body = f"{opener} {body}"
        return {"title": title, "body": body, "action": action, "tone": tone,
                # Στον σκληρό τόνο ΔΕΝ μπαίνει εικονίδιο: όταν το λέμε πέντε μέρες, η
                # χαριτωμενιά ακυρώνει το μήνυμα.
                "emoji": None if tone == V.TONE_HARD else V.SIGNAL_EMOJI.get(sig),
                "streak": streak, "relapses": relapses}

    @staticmethod
    def _links(f: dict) -> list[dict]:
        """Πού πάει ο φαρμακοποιός από εδώ. ΟΛΑ τα href δείχνουν σε υπαρκτές διαδρομές που
        φορτώνουν ΤΟΝ ΣΥΓΚΕΚΡΙΜΕΝΟ πελάτη — μια προτροπή που δεν σε πάει πουθενά είναι θόρυβος.

          · Εικόνα Πελάτη 360°  → /intelligence/profile?patient_id=…  (deep-link)
          · Καρτέλα & επαφή     → /patients/<id>  (εκεί ζει η ContactCard)
          · Η συνταγή           → /prescriptions/<external_id>
          · Λίστα εργασίας      → η οθόνη του κυκλώματος (αιτήματα/εμβόλια/επαφές)
        """
        who = f.get("who") or {}
        pid, out = who.get("id"), []
        if pid:
            out.append({"kind": "profile", "label": "Εικόνα Πελάτη",
                        "href": f"/intelligence/profile?patient_id={quote(pid)}"})
            out.append({"kind": "card", "label": "Καρτέλα & επαφή",
                        "href": f"/patients/{quote(pid)}"})
        if f.get("rx"):
            out.append({"kind": "rx", "label": "Η συνταγή",
                        "href": f"/prescriptions/{quote(str(f['rx']))}"})
        if f.get("inbox"):
            out.append({"kind": "inbox", "label": _INBOX_LABEL.get(f["signal"], "Άνοιγμα λίστας"),
                        "href": f["inbox"]})
        return out

    # ─────────────────────────────────────────────────────────────────────────
    # Η ΣΥΝΑΡΜΟΛΟΓΗΣΗ
    # ─────────────────────────────────────────────────────────────────────────

    async def build(self, *, user_name: str | None = None, persist: bool = True,
                    business: bool = True) -> dict:
        """`business=False` → τα σήματα κέρδους ΟΥΤΕ ΚΑΝ υπολογίζονται.

        Το δικαίωμα δεν είναι φίλτρο εμφάνισης: αν ο χειριστής δεν το έχει, δεν πρέπει να
        διαβαστούν καν τα οικονομικά του φαρμακείου — και γλιτώνουμε και τα ερωτήματα.
        """
        now = _now()
        day = _day_key(now)
        cfg = await self.settings()
        on = cfg["signals"]
        raw: list[dict] = []
        _SIGNALS = (("idle_request", self._sig_idle_requests),
                    ("unexecuted", self._sig_unexecuted),
                    ("repeat_expiring", self._sig_repeat_expiring),
                    ("vaccine_missed", self._sig_vaccine_missed),
                    ("no_contact", self._sig_no_contact),
                    ("advance_due", self._sig_advance_due),
                    ("lapsed_chronic", self._sig_lapsed_chronic))
        if business:
            _SIGNALS += (("loss_execution", self._sig_loss_execution),
                         ("margin_drop", self._sig_margin_drop),
                         ("revenue_drop", self._sig_revenue_drop),
                         ("expired_stock", self._sig_expired_stock),
                         ("expiring_soon", self._sig_expiring_soon),
                         ("below_reorder", self._sig_below_reorder),
                         ("dead_stock", self._sig_dead_stock))
        for sig, fn in _SIGNALS:
            if not on.get(sig, True):
                continue                                    # το έκλεισε ο φαρμακοποιός
            try:
                raw += await fn(now)
            except Exception:                              # noqa: BLE001
                # Ένα σήμα που σκάει ΔΕΝ ρίχνει τον σύμβουλο — ο φαρμακοποιός βλέπει τα υπόλοιπα.
                import logging
                logging.getLogger(__name__).exception("coach signal failed: %s", fn.__name__)
        for f in raw:
            f["key"] = f"{f['signal']}:{f['subject']}"

        raw = self._cap_per_signal(raw)
        states = await self._touch(raw, day, persist=persist)

        items = []
        for f in raw:
            st = states.get(f["key"]) or {}
            if st.get("hidden_until") and st["hidden_until"] >= day:
                continue                                   # «έγινε» σήμερα ή «δεν με αφορά»
            spoken = self._speak(f, st)
            who = f.get("who") or {}
            items.append({
                "key": f["key"], "signal": f["signal"], "name": f.get("name"),
                "money_cents": f.get("money_cents"),
                "severity": f.get("severity", 2),
                # ΠΟΙΟΝ αφορά — ονοματεπώνυμο, ΑΜΚΑ, τηλέφωνο για κλήση με ένα άγγιγμα
                "who": {"id": who.get("id"), "name": who.get("name"), "amka": who.get("amka"),
                        "mobile": who.get("mobile"), "phone": who.get("phone"),
                        "email": who.get("email")},
                "call": who.get("mobile") or who.get("phone"),
                "links": self._links(f),
                **spoken,
            })

        rank = {V.TONE_HARD: 0, V.TONE_FIRM: 1, V.TONE_SOFT: 2}
        items.sort(key=lambda i: (rank[i["tone"]], -i["severity"], -(i["money_cents"] or 0)))
        cap = int(cfg.get("max_items") or MAX_ITEMS)
        shown, hidden = items[:cap], max(0, len(items) - cap)

        if persist:
            # ΠΡΩΤΑ κλείσε ό,τι λύθηκε — αλλιώς η ανάκτηση δεν μετριέται ποτέ
            await self._close_resolved({f["key"] for f in raw}, day)
        wins = await self._wins(now)
        clean = await self._clean_streak(day) if persist else 0
        hard = sum(1 for i in shown if i["tone"] == V.TONE_HARD)
        if persist:
            by_sig: dict = {}
            for i in items:
                by_sig[i["signal"]] = by_sig.get(i["signal"], 0) + 1
            await self._stamp_day(day, misses=len(items), wins=len(wins), by_signal=by_sig)

        return {
            "day": day,
            "greeting": V.greeting(user_name, hour=now.astimezone(ATHENS).hour,
                                   open_misses=len(items), wins=len(wins), clean_streak=clean),
            "items": shown, "hidden": hidden, "wins": wins,
            "closing": V.closing(open_misses=len(items), wins=len(wins), hard=hard),
            "clean_streak": clean,
            # Η «διάθεση» της ημέρας — το UI διαλέγει χρώμα/εικονίδιο/μικρή γιορτή.
            "mood": V.mood(open_misses=len(items), clean_streak=clean, hard=hard),
            "milestone": _milestone(clean),
            "at_risk_cents": sum(i["money_cents"] or 0 for i in items),
        }

    def _doc_id(self, key: str) -> str:
        """Το _id είναι ΠΑΝΤΑ namespaced ανά tenant — αλλιώς κλειδιά όπως «no_contact:batch»
        θα έπεφταν το ένα πάνω στο άλλο μεταξύ φαρμακείων."""
        return f"{self.tenant_id}|{key}"

    @staticmethod
    def _cap_per_signal(raw: list[dict]) -> list[dict]:
        """Κράτα τα ΣΗΜΑΝΤΙΚΟΤΕΡΑ ανά σήμα· τα υπόλοιπα γίνονται μία φράση («και άλλα N»)."""
        groups: dict[str, list[dict]] = {}
        for f in raw:
            groups.setdefault(f["signal"], []).append(f)
        out: list[dict] = []
        for sig, g in groups.items():
            g.sort(key=lambda x: (-(x.get("severity") or 0), -(x.get("money_cents") or 0)))
            cap = PER_SIGNAL_CAP.get(sig, 3)
            keep, rest = g[:cap], len(g) - cap
            if rest > 0 and keep:
                keep[0].setdefault("extra", {})["rest"] = rest
            out += keep
        return out

    async def _touch(self, raw: list[dict], day: str, *, persist: bool) -> dict:
        """Ενημέρωσε/διάβασε την κατάσταση κάθε ευρήματος & υπολόγισε το σερί.

        Κρατάμε ΚΑΙ την αξία και τη στιγμή που πρωτοεμφανίστηκε: χωρίς αυτά, όταν αργότερα το
        θέμα λυθεί, δεν έχουμε πώς να πιστώσουμε το ποσό που ανακτήθηκε."""
        keys = [(f["key"], f["signal"]) for f in raw]
        if not keys:
            return {}
        by_key = {f["key"]: f for f in raw}
        existing = {d["key"]: d async for d in self._coll.find(
            {"tenant_id": self.tenant_id, "_id": {"$in": [self._doc_id(k) for k, _ in keys]}})}
        out, ops = {}, []
        yesterday = (datetime.strptime(day, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        for key, sig in keys:
            f = by_key[key]
            st = existing.get(key)
            if not st:
                st = {"_id": self._doc_id(key), "key": key, "tenant_id": self.tenant_id,
                      "signal": sig, "days_seen": 1, "relapses": 0,
                      "first_day": day, "last_day": day, "hidden_until": None,
                      "first_seen_at": _now(), "subject": f.get("subject"),
                      "patient_ref": (f.get("who") or {}).get("id"),
                      "name": f.get("name"),
                      "value_cents": int(f.get("money_cents") or 0),
                      "profit_cents": int(f.get("profit_cents") or 0)}
                ops.append(("insert", st))
            elif st.get("last_day") != day:
                if st.get("last_day") == yesterday:
                    st["days_seen"] = int(st.get("days_seen") or 0) + 1
                else:                                       # επανεμφανίστηκε μετά από κενό = υποτροπή
                    st["relapses"] = int(st.get("relapses") or 0) + 1
                    st["days_seen"] = 1
                st["last_day"] = day
                # η αξία μπορεί να μεγαλώσει (π.χ. κι άλλο ανεκτέλεστο) — κράτα τη ΜΕΓΑΛΥΤΕΡΗ
                st["value_cents"] = max(int(st.get("value_cents") or 0),
                                        int(f.get("money_cents") or 0))
                st["profit_cents"] = max(int(st.get("profit_cents") or 0),
                                         int(f.get("profit_cents") or 0))
                ops.append(("update", st))
            out[key] = st
        if persist and ops:
            from pymongo import UpdateOne
            await self._coll.bulk_write([UpdateOne(
                {"_id": s["_id"]},
                {"$set": {k: v for k, v in s.items() if k != "_id"}}, upsert=True) for _, s in ops])
        return out

    async def _stamp_day(self, day: str, *, misses: int, wins: int,
                         by_signal: dict | None = None) -> None:
        await self._db["coach_days"].update_one(
            {"tenant_id": self.tenant_id, "day": day},
            {"$set": {"misses": misses, "wins": wins, "by_signal": by_signal or {}, "at": _now()},
             "$setOnInsert": {"tenant_id": self.tenant_id, "day": day}}, upsert=True)

    async def _clean_streak(self, day: str) -> int:
        """Πόσες συνεχόμενες μέρες ΠΡΙΝ από σήμερα έκλεισαν χωρίς ανοιχτό εύρημα."""
        rows = [d async for d in self._db["coach_days"].find(
            {"tenant_id": self.tenant_id, "day": {"$lt": day}},
            {"day": 1, "misses": 1}).sort("day", -1).limit(60)]
        streak, expect = 0, datetime.strptime(day, "%Y-%m-%d") - timedelta(days=1)
        for r in rows:
            if r["day"] != expect.strftime("%Y-%m-%d") or (r.get("misses") or 0) > 0:
                break
            streak += 1
            expect -= timedelta(days=1)
        return streak

    # ── ενέργειες του φαρμακοποιού ───────────────────────────────────────────
    async def mark(self, key: str, action: str, *, by: str | None = None) -> dict:
        """action: done → κρύβεται ΜΟΝΟ για σήμερα (αν αύριο υπάρχει ακόμα, μετράει υποτροπή)·
        dismiss → σιωπή για έναν μήνα."""
        day = _day_key(_now())
        if action == "done":
            hide = day
        elif action == "dismiss":
            hide = (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=DISMISS_DAYS)).strftime("%Y-%m-%d")
        else:
            return {"ok": False, "error": "bad_action"}
        res = await self._coll.update_one(
            {"_id": self._doc_id(key), "tenant_id": self.tenant_id},
            {"$set": {"hidden_until": hide, "status": action, "acted_by": by, "acted_at": _now()}})
        return {"ok": bool(res.matched_count), "hidden_until": hide}

    # ─────────────────────────────────────────────────────────────────────────
    # ΑΝΑΚΤΗΣΗ — «τι σου γλίτωσε ο Σύμβουλος», μετρημένο στα δεδομένα
    # ─────────────────────────────────────────────────────────────────────────
    async def _close_resolved(self, open_keys: set[str], day: str) -> int:
        """Ό,τι ήταν ανοιχτό χθες και ΔΕΝ εμφανίστηκε σήμερα, έκλεισε. Για κάθε τέτοιο πάμε ΠΙΣΩ
        στα δεδομένα και ρωτάμε: λύθηκε ή χάθηκε; Μόνο αν λύθηκε πιστώνεται ποσό.

        Δεν πιστώνουμε ποτέ «επειδή το πάτησε Έγινε» — το πάτημα δεν είναι απόδειξη. Απόδειξη
        είναι η εκτέλεση που εμφανίστηκε, το αίτημα που απαντήθηκε, το τηλέφωνο που μπήκε.
        """
        prev = [d async for d in self._coll.find(
            {"tenant_id": self.tenant_id, "last_day": {"$lt": day},
             "closed_at": {"$exists": False}})]
        n = 0
        for st in prev:
            if st["key"] in open_keys:
                continue
            verdict = await self._verify(st)
            await self._coll.update_one({"_id": st["_id"]}, {"$set": {
                "closed_at": _now(), "closed_day": day, "outcome": verdict}})
            if verdict == "recovered":
                await self._db["coach_recoveries"].update_one(
                    {"_id": st["_id"]},
                    {"$set": {"tenant_id": self.tenant_id, "key": st["key"],
                              "signal": st["signal"], "day": day,
                              "name": st.get("name"), "patient_ref": st.get("patient_ref"),
                              "value_cents": int(st.get("value_cents") or 0),
                              "profit_cents": int(st.get("profit_cents") or 0),
                              "days_open": int(st.get("days_seen") or 1),
                              # «ενήργησε κάποιος» = το είχε σημειώσει ως Έγινε πριν λυθεί.
                              # Το ξεχωρίζουμε γιατί το υπόλοιπο μπορεί να έλυσε μόνο του.
                              "acted": bool(st.get("acted_at")), "acted_by": st.get("acted_by"),
                              "at": _now()}}, upsert=True)
                n += 1
        return n

    async def _verify(self, st: dict) -> str:
        """recovered | lost | unknown — ΠΑΝΤΑ από τα πρωτογενή δεδομένα."""
        sig, subj = st.get("signal"), st.get("subject")
        since = st.get("first_seen_at") or (_now() - timedelta(days=30))
        if since.tzinfo is None:
            since = since.replace(tzinfo=timezone.utc)
        try:
            if sig in ("unexecuted", "lapsed_chronic"):
                pid = _oid(subj)
                got = await self._db["prescription_executions"].find_one(
                    {"tenant_id": self.tenant_id, "patient_ref": pid,
                     "executed_at": {"$gt": since}}, {"_id": 1})
                return "recovered" if got else "lost"
            if sig == "repeat_expiring":
                got = await self._db["prescription_executions"].find_one(
                    {"tenant_id": self.tenant_id, "repeat_root": subj,
                     "executed_at": {"$gt": since}}, {"_id": 1})
                return "recovered" if got else "lost"
            if sig == "idle_request":
                coll, _id = str(subj).split(":", 1)
                d = await self._db[coll].find_one(
                    {"tenant_id": self.tenant_id, "_id": _oid(_id)}, {"status": 1})
                if not d:
                    return "unknown"
                return "lost" if d.get("status") in ("new", "open", "pending", "requested") \
                    else "recovered"
            if sig == "no_contact":
                return "recovered"              # έπαψε να ισχύει = μπήκαν στοιχεία
            if sig == "vaccine_missed":
                p = await self._db["patients_anonymized"].find_one(
                    {"tenant_id": self.tenant_id, "_id": _oid(subj)}, {"pseudo_id": 1})
                if not p:
                    return "unknown"
                got = await self._db["vaccinations"].find_one(
                    {"tenant_id": self.tenant_id, "patient_ref": p.get("pseudo_id"),
                     "cancelled": {"$ne": True}, "excluded_from_stats": {"$ne": True}, "executed_at": {"$gt": since}}, {"_id": 1})
                return "recovered" if got else "lost"
        except Exception:                       # noqa: BLE001
            import logging
            logging.getLogger(__name__).exception("coach verify failed: %s", st.get("key"))
        return "unknown"

    async def value(self, days: int = 90) -> dict:
        """Ο απολογισμός: τι ανακτήθηκε και τι χάθηκε, με ονόματα. Η μόνη σελίδα που απαντά
        στην ερώτηση «γιατί πληρώνω γι' αυτό»."""
        since = (datetime.now(tz=ATHENS) - timedelta(days=days)).strftime("%Y-%m-%d")
        rows = [r async for r in self._db["coach_recoveries"].find(
            {"tenant_id": self.tenant_id, "day": {"$gte": since}}).sort("at", -1).limit(500)]
        acted = [r for r in rows if r.get("acted")]
        passive = [r for r in rows if not r.get("acted")]
        lost = [d async for d in self._coll.find(
            {"tenant_id": self.tenant_id, "outcome": "lost", "closed_day": {"$gte": since}},
            {"signal": 1, "value_cents": 1, "profit_cents": 1, "name": 1}).limit(1000)]

        def _sum(xs, k):
            return sum(int(x.get(k) or 0) for x in xs)

        by_sig: dict = {}
        for r in rows:
            b = by_sig.setdefault(r["signal"], {"signal": r["signal"], "n": 0, "value": 0, "profit": 0})
            b["n"] += 1
            b["value"] += int(r.get("value_cents") or 0)
            b["profit"] += int(r.get("profit_cents") or 0)
        return {
            "days": days,
            "acted": {"n": len(acted), "value_cents": _sum(acted, "value_cents"),
                      "profit_cents": _sum(acted, "profit_cents")},
            "passive": {"n": len(passive), "value_cents": _sum(passive, "value_cents"),
                        "profit_cents": _sum(passive, "profit_cents")},
            "lost": {"n": len(lost), "value_cents": _sum(lost, "value_cents"),
                     "profit_cents": _sum(lost, "profit_cents")},
            "by_signal": sorted(by_sig.values(), key=lambda b: -b["value"]),
            "recent": [{"name": r.get("name"), "signal": r["signal"], "day": r["day"],
                        "value_cents": r.get("value_cents"), "acted": bool(r.get("acted")),
                        "days_open": r.get("days_open")} for r in rows[:25]],
        }

    # ─────────────────────────────────────────────────────────────────────────
    # ΚΡΥΦΟ ΚΟΣΤΟΣ — τι χάνει το φαρμακείο χωρίς να το βλέπει
    # ─────────────────────────────────────────────────────────────────────────
    async def leakage(self, months: int = 6) -> dict:
        """Ανά μήνα: ληγμένες επαναλήψεις & ανεκτέλεστα είδη, σε τζίρο ΚΑΙ σε μεικτό κέρδος.

        ΤΙΜΙΟΤΗΤΑ: αυτά ΔΕΝ ανακτώνται όλα — κάποιοι άλλαξαν αγωγή, μετακόμισαν ή πέθαναν.
        Είναι το μέγεθος της διαρροής, όχι υπόσχεση εσόδων. Το λέμε καθαρά και στην οθόνη.
        """
        now = _now()
        start = (now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                 - timedelta(days=31 * (months - 1))).replace(day=1)
        mfmt = {"$dateToString": {"format": "%Y-%m", "date": "$valid_until",
                                  "timezone": "Europe/Athens"}}
        # Το `repeat_current` είναι ΘΕΣΗ στην αλυσίδα, όχι πλήθος εκτελέσεων (βλ. _chain_progress).
        # Μετράμε μία φορά ανά ΑΛΥΣΙΔΑ, με βάση την πιο προχωρημένη θέση που εκτελέστηκε —
        # αλλιώς κάθε ενδιάμεση συνταγή που «λήγει» μετριόταν ως χαμένη, ενώ η αλυσίδα συνεχιζόταν.
        repeats = await self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id,
                        "repeat_total": {"$gt": 1},
                        "valid_until": {"$gte": start, "$lt": now}}},
            {"$group": {"_id": {"root": {"$ifNull": ["$repeat_root", "$external_id"]}},
                        "month": {"$last": mfmt},
                        "total": {"$max": "$repeat_total"},
                        "done": {"$max": "$repeat_current"},
                        "amount": {"$last": "$amount_total"},
                        "wholesale": {"$last": "$wholesale_cost"}}},
            {"$set": {"left": {"$subtract": ["$total", "$done"]}}},
            {"$match": {"left": {"$gt": 0}}},
            {"$group": {"_id": "$month", "n": {"$sum": 1},
                        "value": {"$sum": {"$multiply": ["$amount", "$left"]}},
                        "cost": {"$sum": {"$multiply": ["$wholesale", "$left"]}}}},
        ]).to_list(length=None)
        items = await self._db["prescription_items"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "is_executed": False,
                        "executed_at": {"$gte": start}}},
            {"$group": {"_id": {"$dateToString": {"format": "%Y-%m", "date": "$executed_at",
                                                  "timezone": "Europe/Athens"}},
                        "n": {"$sum": 1},
                        "value": {"$sum": {"$multiply": ["$retail_price", "$quantity"]}},
                        "profit": {"$sum": {"$multiply": ["$margin", "$quantity"]}}}},
        ]).to_list(length=None)

        by_month: dict = {}
        for r in repeats:
            b = by_month.setdefault(r["_id"], {"month": r["_id"]})
            b["repeats_n"] = r["n"]
            b["repeats_value"] = r["value"]
            b["repeats_profit"] = r["value"] - r["cost"]
        for r in items:
            b = by_month.setdefault(r["_id"], {"month": r["_id"]})
            b["items_n"] = r["n"]
            b["items_value"] = r["value"]
            b["items_profit"] = r["profit"]
        rows = sorted(by_month.values(), key=lambda b: b["month"])
        for b in rows:
            for k in ("repeats_n", "repeats_value", "repeats_profit",
                      "items_n", "items_value", "items_profit"):
                b.setdefault(k, 0)
            b["total_value"] = b["repeats_value"] + b["items_value"]
            b["total_profit"] = b["repeats_profit"] + b["items_profit"]
        tot = {k: sum(b[k] for b in rows) for k in
               ("repeats_n", "repeats_value", "repeats_profit",
                "items_n", "items_value", "items_profit", "total_value", "total_profit")}
        # Ο ΤΡΕΧΩΝ μήνας είναι μισός. Αν μπει στην τάση, κάθε μήνα θα ανακοινώνουμε ψευδώς
        # «η διαρροή μικραίνει» — και θα το πιστέψουν. Τον σημαδεύουμε και τον βγάζουμε.
        this_month = now.astimezone(ATHENS).strftime("%Y-%m")
        for b in rows:
            b["partial"] = b["month"] == this_month
        full = [b for b in rows if not b["partial"]]
        trend = None
        if len(full) >= 4:
            half = len(full) // 2
            a = sum(b["total_profit"] for b in full[:half]) / max(1, half)
            z = sum(b["total_profit"] for b in full[half:]) / max(1, len(full) - half)
            trend = {"before": a, "after": z, "better": z < a * 0.9, "worse": z > a * 1.1}
        return {"months": rows, "total": tot, "trend": trend,
                "full_months": len(full), "this_month": this_month}

    # ─────────────────────────────────────────────────────────────────────────
    # Η ΕΒΔΟΜΑΔΑ & Ο ΣΤΟΧΟΣ
    # ─────────────────────────────────────────────────────────────────────────
    async def week(self) -> dict:
        """Απολογισμός 7 ημερών + πρόοδος του ενεργού στόχου."""
        today = datetime.now(tz=ATHENS)
        days = [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)][::-1]
        prev = [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7, 14)][::-1]
        rows = {d["day"]: d async for d in self._db["coach_days"].find(
            {"tenant_id": self.tenant_id, "day": {"$in": days + prev}})}
        # ΠΡΟΣΟΧΗ: μέρα χωρίς εγγραφή ΔΕΝ είναι «καθαρή» μέρα — είναι μέρα που δεν λειτουργούσε
        # ακόμη ο Σύμβουλος. Αν τις μετρήσουμε ως μηδέν, το γράφημα λέει ψέματα και η σύγκριση
        # με την προηγούμενη εβδομάδα βγάζει πάντα «βελτιώθηκες».
        have = [d for d in days if d in rows]
        have_prev = [d for d in prev if d in rows]
        cur_m = sum(rows[d].get("misses", 0) for d in have)
        prev_m = sum(rows[d].get("misses", 0) for d in have_prev)
        rec = [r async for r in self._db["coach_recoveries"].find(
            {"tenant_id": self.tenant_id, "day": {"$in": days}})]
        closed = await self._coll.count_documents(
            {"tenant_id": self.tenant_id, "closed_day": {"$in": days}})
        goal = await self.goal()
        return {
            "from": days[0], "to": days[-1],
            "misses": cur_m, "misses_prev": prev_m,
            "days_with_data": len(have), "prev_days_with_data": len(have_prev),
            "closed": closed,
            "recovered": {"n": len(rec),
                          "value_cents": sum(int(r.get("value_cents") or 0) for r in rec),
                          "profit_cents": sum(int(r.get("profit_cents") or 0) for r in rec)},
            "daily": [{"day": d, "misses": (rows.get(d) or {}).get("misses", 0),
                       "has_data": d in rows} for d in days],
            "goal": goal,
            "narrative": self._week_words(cur_m, prev_m, len(rec), closed,
                                          days_with_data=len(have),
                                          prev_days=len(have_prev)),
        }

    @staticmethod
    def _week_words(cur: int, prev: int, rec: int, closed: int, *,
                    days_with_data: int, prev_days: int) -> str:
        """Ο στόχος ΔΕΝ μπαίνει εδώ — έχει δική του κάρτα και θα διαβαζόταν δύο φορές."""
        if days_with_data == 0:
            return ("Ο Σύμβουλος μόλις ξεκίνησε σε αυτό το φαρμακείο. Από την επόμενη εβδομάδα "
                    "θα μπορώ να σου λέω αν βελτιώνεσαι.")
        bits = []
        if closed:
            bits.append(f"Έκλεισαν {closed} θέματα μέσα στην εβδομάδα")
            if rec:
                bits[-1] += f", και σε {rec} από αυτά τα δεδομένα δείχνουν ότι ο άνθρωπος " \
                            f"όντως γύρισε ή το αίτημα όντως απαντήθηκε"
            bits[-1] += "."
        if prev_days >= 4 and prev and cur < prev * 0.8:
            bits.append(f"Σου ξέφυγαν λιγότερα απ' ό,τι την προηγούμενη εβδομάδα "
                        f"({cur} έναντι {prev}). Κάτι αλλάζει στον τρόπο που δουλεύεις.")
        elif prev_days >= 4 and prev and cur > prev * 1.2:
            bits.append(f"Σου ξέφυγαν περισσότερα απ' ό,τι την προηγούμενη εβδομάδα "
                        f"({cur} έναντι {prev}). Δεν σε κατηγορώ — ίσως ήταν πιο φορτωμένη· "
                        f"απλώς να το ξέρεις.")
        elif prev_days >= 4 and prev:
            bits.append(f"Σταθερή εβδομάδα ({cur} θέματα, έναντι {prev} την προηγούμενη).")
        elif days_with_data < 7:
            bits.append(f"Έχω δεδομένα για {days_with_data} από τις 7 μέρες — "
                        f"από την επόμενη εβδομάδα η σύγκριση θα είναι πλήρης.")
        if not bits:
            bits.append(f"Αυτή την εβδομάδα σου επισήμανα {cur} θέματα.")
        return " ".join(b for b in bits if b)

    async def goal(self) -> dict | None:
        """Ο ΕΝΑΣ στόχος του μήνα. Παραπάνω από έναν δεν τον κυνηγά κανείς."""
        g = await self._db["coach_goals"].find_one(
            {"tenant_id": self.tenant_id, "active": True})
        if not g:
            return None
        today = datetime.now(tz=ATHENS)
        days = [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
        hits = 0
        async for d in self._db["coach_days"].find(
                {"tenant_id": self.tenant_id, "day": {"$in": days}}, {"by_signal": 1}):
            if int((d.get("by_signal") or {}).get(g["signal"], 0)) <= int(g.get("target") or 0):
                hits += 1
        label = SIGNAL_LABEL.get(g["signal"], g["signal"])
        ok = hits >= 6
        return {"signal": g["signal"], "label": label, "target": int(g.get("target") or 0),
                "active": True, "hit_days": hits, "of_days": 7, "achieved": ok,
                "emoji": V.SIGNAL_EMOJI.get(g["signal"]),
                "progress_text": (
                    f"Ο στόχος σου «{label}: το πολύ {g.get('target', 0)} την ημέρα» τηρήθηκε "
                    f"{hits} από τις 7 μέρες." + (" Πέτυχε — και το πέτυχες εσύ." if ok else
                    " Δεν είναι ακόμη συνήθεια, αλλά πλησιάζεις."))}

    async def set_goal(self, signal: str | None, target: int = 0) -> dict:
        await self._db["coach_goals"].update_many(
            {"tenant_id": self.tenant_id}, {"$set": {"active": False}})
        if not signal:
            return {"ok": True, "cleared": True}
        await self._db["coach_goals"].update_one(
            {"tenant_id": self.tenant_id, "signal": signal},
            {"$set": {"tenant_id": self.tenant_id, "signal": signal,
                      "target": max(0, int(target)), "active": True, "since": _now()}},
            upsert=True)
        return {"ok": True, "goal": await self.goal()}

    # ─────────────────────────────────────────────────────────────────────────
    # ΟΜΑΔΑ — ποιος κάνει τη δουλειά
    # ─────────────────────────────────────────────────────────────────────────
    async def team(self, days: int = 30) -> dict:
        since = _now() - timedelta(days=days)
        rows = await self._coll.aggregate([
            {"$match": {"tenant_id": self.tenant_id, "acted_at": {"$gte": since},
                        "acted_by": {"$ne": None}}},
            {"$group": {"_id": "$acted_by", "closed": {"$sum": 1},
                        "recovered": {"$sum": {"$cond": [{"$eq": ["$outcome", "recovered"]}, 1, 0]}},
                        "last": {"$max": "$acted_at"}}},
            {"$sort": {"closed": -1}},
        ]).to_list(length=None)
        names = {}
        ids = [_oid(r["_id"]) for r in rows if _oid(r["_id"])]
        if ids:
            async for u in self._db["users"].find(
                    {"tenant_id": self.tenant_id, "_id": {"$in": ids}}, {"full_name": 1, "email": 1}):
                names[str(u["_id"])] = u.get("full_name") or u.get("email")
        total = sum(r["closed"] for r in rows)
        # Πόσα έμειναν ανοιχτά πολλές μέρες — η «ουρά» που κανείς δεν πιάνει
        stale = await self._coll.count_documents(
            {"tenant_id": self.tenant_id, "closed_at": {"$exists": False},
             "days_seen": {"$gte": ESCALATE_DAYS}})
        return {"days": days, "total_closed": total, "stale": stale,
                "members": [{"user_id": str(r["_id"]), "name": names.get(str(r["_id"])) or "—",
                             "closed": r["closed"], "recovered": r["recovered"],
                             "last": r["last"]} for r in rows]}

    # ─────────────────────────────────────────────────────────────────────────
    # Ο ΣΥΜΒΟΥΛΟΣ ΣΤΟ ΤΑΜΕΙΟ — ό,τι ξέρουμε γι' ΑΥΤΟΝ τον άνθρωπο, τη στιγμή που είναι μπροστά
    # ─────────────────────────────────────────────────────────────────────────
    async def patient_brief(self, patient_id: str) -> dict:
        """Σύντομο ενημερωτικό για έναν ασθενή, φτιαγμένο για να διαβαστεί σε 3 δευτερόλεπτα
        με τον άνθρωπο απέναντι. Δεν ξανατρέχει όλα τα σήματα — ρωτάει στοχευμένα γι' αυτόν."""
        pid = _oid(patient_id)
        if not pid:
            return {"found": False}
        p = await self._db["patients_anonymized"].find_one(
            {"tenant_id": self.tenant_id, "_id": pid},
            {"full_name": 1, "sex": 1, "amka": 1, "age_group": 1, "pseudo_id": 1})
        if not p:
            return {"found": False}
        now = _now()
        sex = p.get("sex")
        him, gen = V.g(sex, "τον", "την"), V.g(sex, "του", "της")
        notes: list[dict] = []

        # 1) ανεκτέλεστα που δεν κλείσανε
        ex = await self._db["prescription_executions"].find_one(
            {"tenant_id": self.tenant_id, "patient_ref": pid, "has_unexecuted_substances": True,
             "executed_at": {"$gte": now - timedelta(days=60)}},
            {"executed_at": 1, "external_id": 1}, sort=[("executed_at", -1)])
        if ex:
            newer = await self._db["prescription_executions"].find_one(
                {"tenant_id": self.tenant_id, "patient_ref": pid,
                 "has_unexecuted_substances": {"$ne": True},
                 "executed_at": {"$gt": ex["executed_at"]}}, {"_id": 1})
            if not newer:
                miss = (await self._missing_items([ex["_id"]])).get(ex["_id"]) or {}
                if miss.get("names"):
                    names = [V.product(n) for n in miss["names"]]
                    notes.append({
                        "kind": "unexecuted", "tone": "warn",
                        "text": (f"Έχει ανεκτέλεστο από {V.ago_phrase(_days_between(ex['executed_at'], now))}: "
                                 f"{', '.join(names[:2])}. Ρώτησέ {him} αν το θέλει τώρα."),
                        "money_cents": miss.get("retail"),
                        "href": f"/prescriptions/{quote(str(ex.get('external_id') or ''))}"})

        # 2) επανάληψη που λήγει
        rep = await self._db["prescription_executions"].find_one(
            {"tenant_id": self.tenant_id, "patient_ref": pid,
             "$expr": {"$lt": ["$repeat_current", "$repeat_total"]},
             "valid_until": {"$gte": now, "$lt": now + timedelta(days=15)}},
            {"valid_until": 1, "repeat_current": 1, "repeat_total": 1, "external_id": 1,
             "repeat_root": 1},
            sort=[("valid_until", 1)])
        if rep:
            _prog = await self._chain_progress([rep.get("repeat_root")])
            _pos = int(rep.get("repeat_current") or 0)
            _done = max(_pos, _prog.get(rep.get("repeat_root"), 0))
            # νεότερη συνταγή στην αλυσίδα ⇒ δεν χάνεται τίποτα (βλ. _chain_progress)
            left = 0 if _done > _pos else int(rep.get("repeat_total") or 0) - _done
            dl = max(0, (rep["valid_until"] - now).days)
            # left <= 0 ⇒ η αλυσίδα έχει ήδη προχωρήσει πέρα από αυτή τη θέση· δεν χάνεται τίποτα.
            if left > 0:
                notes.append({
                    "kind": "repeat_expiring", "tone": "warn" if dl <= 3 else "info",
                    "text": (f"Η επαναλαμβανόμενη συνταγή {gen} λήγει "
                             f"{'σήμερα' if dl == 0 else 'αύριο' if dl == 1 else f'σε {dl} μέρες'} "
                             f"με {V.doses(left)} αχρησιμοποίητ{'η' if left == 1 else 'ες'}. "
                             f"Αν δεν την εκτελέσει τώρα, θα ξαναπάει στον γιατρό."),
                    "href": f"/prescriptions/{quote(str(rep.get('external_id') or ''))}"})

        # 3) εμβόλιο
        season = now.year if now.month >= 10 else now.year - 1
        s_start = datetime(season, 10, 1, tzinfo=timezone.utc)
        s_end = datetime(season + 1, 5, 1, tzinfo=timezone.utc)
        if s_start <= now < s_end and p.get("age_group") in ("65-74", "75+"):
            done = await self._db["vaccinations"].find_one(
                {"tenant_id": self.tenant_id, "patient_ref": p.get("pseudo_id"),
                 "cancelled": {"$ne": True}, "excluded_from_stats": {"$ne": True},
                 "executed_at": {"$gte": s_start, "$lt": s_end}}, {"_id": 1})
            if not done:
                notes.append({"kind": "vaccine_missed", "tone": "info",
                              "text": (f"Ανήκει στην ομάδα {p.get('age_group')} και δεν έχει κάνει "
                                       f"αντιγριπικό φέτος. Καλή στιγμή να {gen} το προτείνεις."),
                              "href": "/vaccinations"})

        # 4) στοιχεία επικοινωνίας
        c = await self._db["patient_contacts"].find_one(
            {"tenant_id": self.tenant_id, "_id": pid},
            {"mobile": 1, "phone": 1, "email": 1, "active": 1}) or {}
        if c.get("active") is not False and not (c.get("mobile") or c.get("phone") or c.get("email")):
            notes.append({"kind": "no_contact", "tone": "info",
                          "text": (f"Δεν έχεις κανένα στοιχείο επικοινωνίας "
                                   f"γι' {V.g(sex, 'αυτόν', 'αυτήν')}. "
                                   f"Τώρα που είναι μπροστά σου, ζήτα ένα κινητό."),
                          "href": f"/patients/{quote(str(pid))}"})

        # 5) ανοιχτό αίτημα πύλης
        for coll, flt, what in (("rx_requests", {"status": "new"}, "αίτημα συνταγής"),
                                ("availability_requests", {"status": "open"}, "ερώτηση διαθεσιμότητας"),
                                ("appointments", {"status": "requested"}, "αίτημα ραντεβού")):
            d = await self._db[coll].find_one(
                {"tenant_id": self.tenant_id, "patient_ref": pid, **flt}, {"created_at": 1})
            if d:
                notes.append({"kind": "idle_request", "tone": "warn",
                              "text": f"Έχει ανοιχτό {what} στην πύλη, που δεν έχει απαντηθεί ακόμη.",
                              "href": "/portal-admin"})
                break

        return {"found": True, "patient_id": str(pid),
                "name": mask_name(p.get("full_name"), self.demo),
                "amka": mask_amka(p.get("amka"), self.demo),
                "notes": notes}

    # ─────────────────────────────────────────────────────────────────────────
    # ΡΥΘΜΙΣΕΙΣ — χωρίς αυτές, το πρώτο φαρμακείο που θα ενοχληθεί απλώς το κλείνει
    # ─────────────────────────────────────────────────────────────────────────
    async def settings(self) -> dict:
        d = await self._db["coach_settings"].find_one({"tenant_id": self.tenant_id}) or {}
        return {
            "email_hour": int(d.get("email_hour", 7)),          # ώρα Αθήνας
            "email_enabled": bool(d.get("email_enabled", True)),
            "email_to": d.get("email_to") or None,              # κενό = το email της καρτέλας
            "max_items": int(d.get("max_items", MAX_ITEMS)),
            "signals": {k: bool((d.get("signals") or {}).get(k, True)) for k in SIGNAL_LABEL},
            "escalate_owner": bool(d.get("escalate_owner", True)),
            "labels": SIGNAL_LABEL,
        }

    async def save_settings(self, patch: dict) -> dict:
        cur = await self.settings()
        upd = {"tenant_id": self.tenant_id}
        if "email_hour" in patch:
            upd["email_hour"] = max(0, min(23, int(patch["email_hour"])))
        if "email_enabled" in patch:
            upd["email_enabled"] = bool(patch["email_enabled"])
        if "email_to" in patch:
            upd["email_to"] = (str(patch["email_to"]).strip() or None)
        if "max_items" in patch:
            upd["max_items"] = max(3, min(25, int(patch["max_items"])))
        if "escalate_owner" in patch:
            upd["escalate_owner"] = bool(patch["escalate_owner"])
        if "signals" in patch and isinstance(patch["signals"], dict):
            upd["signals"] = {k: bool(patch["signals"].get(k, cur["signals"][k]))
                              for k in SIGNAL_LABEL}
        await self._db["coach_settings"].update_one(
            {"tenant_id": self.tenant_id}, {"$set": upd}, upsert=True)
        return await self.settings()

    async def history(self, days: int = 30) -> list[dict]:
        """Η γραμμή αυτοβελτίωσης: πόσα ξέφευγαν τότε, πόσα ξεφεύγουν τώρα."""
        since = (datetime.now(tz=ATHENS) - timedelta(days=days)).strftime("%Y-%m-%d")
        return [{"day": d["day"], "misses": d.get("misses", 0), "wins": d.get("wins", 0)}
                async for d in self._db["coach_days"].find(
                    {"tenant_id": self.tenant_id, "day": {"$gte": since}},
                    {"_id": 0, "day": 1, "misses": 1, "wins": 1}).sort("day", 1)]
