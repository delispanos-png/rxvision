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

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository
from app.services import coach_voice as V
from app.utils.masking import mask_name

ATHENS = timezone(timedelta(hours=3))          # πρακτικά αρκεί για το «ποια μέρα είναι»

# Πόσα ευρήματα βλέπει ο φαρμακοποιός τη φορά. Πάνω από αυτό δεν διαβάζεται — αγνοείται.
MAX_ITEMS = 10
# Και όριο ΑΝΑ ΣΗΜΑ: 28 συνταγές που λήγουν δεν είναι 28 μηνύματα, είναι ένα μήνυμα με ουρά.
# Χωρίς αυτό ο σύμβουλος γίνεται λίστα — και οι λίστες αγνοούνται.
PER_SIGNAL_CAP = {"idle_request": 4, "unexecuted": 3, "repeat_expiring": 3,
                  "vaccine_missed": 2, "no_contact": 1, "lapsed_chronic": 2}
DISMISS_DAYS = 30                               # «δεν με αφορά» → σιωπή για έναν μήνα


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
            out.append({
                "signal": "unexecuted", "subject": str(e["patient_ref"]),
                "name": (info.get(e["patient_ref"]) or {}).get("name"),
                "sex": (info.get(e["patient_ref"]) or {}).get("sex"), "since": e["executed_at"],
                "money_cents": miss["retail"], "profit_cents": miss["margin"],
                "items": miss["names"], "severity": 3 if miss["retail"] >= 3000 else 2,
                "href": f"/intelligence/profile?patient={e['patient_ref']}",
            })
        return out

    async def _sig_repeat_expiring(self, now: datetime) -> list[dict]:
        """Επαναλαμβανόμενη συνταγή με δόσεις που δεν πάρθηκαν και λήγει. Χάνει ο ασθενής — και εσύ."""
        rows = [e async for e in self._db["prescription_executions"].find(
            {"tenant_id": self.tenant_id,
             "$expr": {"$lt": ["$repeat_current", "$repeat_total"]},
             "valid_until": {"$gte": now, "$lt": now + timedelta(days=6)}},
            {"patient_ref": 1, "valid_until": 1, "repeat_current": 1, "repeat_total": 1,
             "repeat_root": 1, "amount_total": 1}).sort("valid_until", 1).limit(200)]
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
        out = []
        for r in by_root.values():
            left = int(r.get("repeat_total") or 0) - int(r.get("repeat_current") or 0)
            if left <= 0:
                continue
            days_left = max(0, (r["valid_until"] - now).days)
            out.append({
                "signal": "repeat_expiring", "subject": r.get("repeat_root") or str(r["_id"]),
                "name": (info.get(r.get("patient_ref")) or {}).get("name"),
                "sex": (info.get(r.get("patient_ref")) or {}).get("sex"), "since": None,
                "money_cents": int(r.get("amount_total") or 0) * left,
                "extra": {"left": left, "days_left": days_left},
                "severity": 3 if days_left <= 2 else 2,
                "href": f"/intelligence/profile?patient={r.get('patient_ref')}",
            })
        return out

    async def _sig_idle_requests(self, now: datetime) -> list[dict]:
        """Κάποιος σου μίλησε και δεν του απάντησες. Αυτό δεν συγχωρείται εύκολα."""
        cutoff = now - timedelta(hours=24)
        out: list[dict] = []
        specs = [
            ("rx_requests", {"status": "new"}, "created_at",
             "ζήτησε να του ετοιμάσεις συνταγή", "/portal-admin#rx"),
            ("availability_requests", {"status": "open"}, "created_at",
             "ρώτησε αν έχεις ένα φάρμακο", "/portal-admin#availability"),
            ("appointments", {"status": "requested"}, "created_at",
             "ζήτησε ραντεβού", "/portal-admin#appointments"),
            ("orders_delivery", {"status": {"$in": ["pending", "new"]}}, "created_at",
             "έκανε παραγγελία", "/orders-delivery#orders"),
        ]
        for coll, flt, field, what, href in specs:
            async for d in self._db[coll].find(
                    {"tenant_id": self.tenant_id, **flt, field: {"$lt": cutoff}}).sort(field, 1).limit(30):
                out.append({
                    "signal": "idle_request", "subject": f"{coll}:{d['_id']}",
                    "name": d.get("patient_name"), "hdika_name": False, "since": d.get(field),
                    "money_cents": int(d.get("total_cents") or 0) or None,
                    "extra": {"what": what, "detail": (d.get("query") or d.get("medicine_name")
                                                       or d.get("service_name") or d.get("note") or "")},
                    "severity": 3, "href": href,
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
                      "names": [info[r["_id"]]["name"] for r in missing[:4]
                                if info.get(r["_id"], {}).get("name")]},
            "severity": 2, "href": "/patients?filter=no-contact",
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
                {"full_name": 1, "pseudo_id": 1, "age_group": 1, "sex": 1}):
            elig[p["_id"]] = p
        if not elig:
            return []
        done = {r["_id"] for r in await self._db["vaccinations"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "cancelled": {"$ne": True},
                        "executed_at": {"$gte": start, "$lt": end},
                        "patient_ref": {"$in": [p["pseudo_id"] for p in elig.values() if p.get("pseudo_id")]}}},
            {"$group": {"_id": "$patient_ref"}},
        ]).to_list(length=None)}
        inactive = {c["_id"] async for c in self._db["patient_contacts"].find(
            {"tenant_id": self.tenant_id, "_id": {"$in": list(elig)}, "active": False}, {"_id": 1})}
        last = {r["_id"]: r["last"] for r in rows}
        out = []
        for pid, p in elig.items():
            if p.get("pseudo_id") in done or pid in inactive:
                continue
            out.append({
                "signal": "vaccine_missed", "subject": str(pid),
                "name": mask_name(p.get("full_name"), self.demo), "sex": p.get("sex"),
                "since": last.get(pid), "money_cents": None,
                "extra": {"age_group": p.get("age_group")},
                "severity": 2, "href": "/vaccinations",
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
        out = []
        for pid, p in cand[:6]:
            per_visit = int((p.get("rx_value_total") or 0) / max(1, p.get("rx_count") or 1))
            out.append({
                "signal": "lapsed_chronic", "subject": str(pid),
                "name": mask_name(p.get("full_name"), self.demo), "sex": p.get("sex"),
                "since": by_pat[pid]["expected_open_date"], "money_cents": per_visit,
                "extra": {"rx_count": p.get("rx_count")}, "severity": 2,
                "href": f"/intelligence/profile?patient={pid}",
            })
        return out

    # ─────────────────────────────────────────────────────────────────────────
    # ΕΠΙΒΡΑΒΕΥΣΗ — από τα ίδια δεδομένα, όχι ευγένειες
    # ─────────────────────────────────────────────────────────────────────────

    async def _wins(self, now: datetime) -> list[dict]:
        wins: list[dict] = []
        week = now - timedelta(days=7)

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
                                  f"Αυτό δεν γίνεται μόνο του — κάποιος τους κυνήγησε.")})

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
            {"tenant_id": self.tenant_id, "cancelled": {"$ne": True}, "executed_at": {"$gte": week}})
        if vacc:
            wins.append({"key": "w_vaccines", "count": vacc,
                         "text": (f"{vacc} εμβολιασμοί μέσα στην εβδομάδα. Πέρα από τα λεφτά: "
                                  f"{vacc} άνθρωποι που πιθανότατα δεν θα αρρωστήσουν φέτος "
                                  f"επειδή μπήκαν στο δικό σου φαρμακείο.")})
        return wins

    # ─────────────────────────────────────────────────────────────────────────
    # βοηθητικά
    # ─────────────────────────────────────────────────────────────────────────

    async def _patient_info(self, ids: list) -> dict:
        """_id → {name, sex}. Το φύλο δεν είναι στολίδι: χωρίς αυτό ο σύμβουλος λέει
        «ο ΚΩΝΣΤΑΝΤΙΝΟΣ… της μένουν» και χάνει αμέσως κάθε αξιοπιστία."""
        ids = [i for i in ids if i]
        if not ids:
            return {}
        out = {}
        async for p in self._db["patients_anonymized"].find(
                {"tenant_id": self.tenant_id, "_id": {"$in": ids}}, {"full_name": 1, "sex": 1}):
            out[p["_id"]] = {"name": mask_name(p.get("full_name"), self.demo), "sex": p.get("sex")}
        return out

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

    def _speak(self, f: dict, st: dict) -> dict:
        streak = int(st.get("days_seen") or 1)
        relapses = int(st.get("relapses") or 0)
        tone = V.tone_for(streak + relapses)
        opener = V.repeat_opener(streak + relapses)
        sig = f["signal"]
        sex = f.get("sex")
        # Η ΗΔΥΚΑ δίνει «ΕΠΩΝΥΜΟ ΟΝΟΜΑ» (το μικρό είναι τελευταίο)· η πύλη δίνει ό,τι έγραψε ο
        # ίδιος ο πελάτης. Εκεί ΔΕΝ μαντεύουμε — λέμε το όνομα όπως το έδωσε.
        who = V.first_name(f.get("name")) if f.get("hdika_name", True) else V.person(f.get("name"))
        ago = V.ago_phrase(_days_between(f.get("since"), _now()))
        ex = f.get("extra") or {}
        money = V.money(f.get("money_cents")) if f.get("money_cents") else None
        him = V.g(sex, "τον", "την")
        his = V.g(sex, "Του", "Της")

        if sig == "unexecuted":
            names = [V.product(n) for n in (f.get("items") or [])]
            items = ", ".join(names[:2])
            if len(names) > 2:
                items += f" και άλλα {len(names) - 2}"
            title = f"{who}: έφυγε με μισή συνταγή"
            body = (f"Ήρθε {ago} και δεν πήρε {items}. "
                    f"{money} που θα ξοδέψει σε άλλο φαρμακείο")
            if f.get("profit_cents"):
                body += f" — {V.money(f['profit_cents'])} δικό σου κέρδος"
            body += "."
            if tone == V.TONE_HARD:
                body += (f" Και δεν είναι μόνο τα λεφτά: αν άρχισε να ψωνίζει αλλού, "
                         f"την επόμενη φορά μπορεί να μην έρθει καθόλου.")
            action = f"Πάρ' {him} τηλέφωνο — «σου κράτησα το υπόλοιπο»"

        elif sig == "repeat_expiring":
            left, dl = ex.get("left", 1), ex.get("days_left", 0)
            when = ("σήμερα" if dl == 0 else "αύριο" if dl == 1
                    else f"σε {V.count_word(dl, feminine=True)} μέρες")
            title = f"{who}: η συνταγή λήγει {when}"
            body = (f"{his} {'μένει' if left == 1 else 'μένουν'} {V.doses(left)} "
                    f"και η συνταγή λήγει {when}. "
                    f"Αν δεν περάσει, {'τη' if left == 1 else 'τις'} χάνει — "
                    f"και ξαναρχίζει από τον γιατρό. "
                    f"Για σένα είναι {money} που δεν θα γίνουν ποτέ.")
            action = f"Στείλε {V.g(sex, 'του', 'της')} υπενθύμιση σήμερα"

        elif sig == "idle_request":
            what = ex.get("what", "σου έστειλε αίτημα")
            title = f"{who}: περιμένει απάντηση {V.days_phrase(_days_between(f.get('since'), _now()))}"
            body = f"{who} {what} και δεν έχει πάρει απάντηση ακόμα."
            if ex.get("detail"):
                body += f" Έγραψε: «{str(ex['detail'])[:120]}»."
            if tone == V.TONE_SOFT:
                body += " Δύο λεπτά θέλει."
            elif tone == V.TONE_FIRM:
                body += " Ένας πελάτης που ρωτάει και δεν παίρνει απάντηση, δεν ξαναρωτάει."
            else:
                body += (" Αυτός ο άνθρωπος σού εμπιστεύτηκε ένα αίτημα και τον αφήνεις να περιμένει. "
                         "Είναι το χειρότερο πράγμα που μπορείς να κάνεις σε πελάτη της πύλης.")
            action = "Απάντησέ του τώρα"

        elif sig == "no_contact":
            n = ex.get("count", 0)
            nms = [x for x in (ex.get("names") or []) if x]
            who_list = ", ".join(V.first_name(x) for x in nms[:3])
            title = f"{n} πελάτες που δεν μπορείς να βρεις"
            body = (f"{V.people(n).capitalize()} πέρασαν τις τελευταίες τρεις μέρες"
                    + (f" — {who_list} και άλλοι" if who_list else "")
                    + f" — και δεν έχεις ούτε τηλέφωνο ούτε email. Ψώνισαν {money}. "
                      f"Αν αύριο έρθει το φάρμακό τους ή λήξει η συνταγή τους, "
                      f"δεν έχεις τρόπο να τους το πεις.")
            if tone == V.TONE_HARD:
                body += (" Το λέμε μέρες. Ένα τηλέφωνο στο ταμείο είναι δέκα δευτερόλεπτα — "
                         "και είναι η διαφορά ανάμεσα σε πελάτη και περαστικό.")
            action = "Ζήτα τηλέφωνο στο ταμείο"

        elif sig == "vaccine_missed":
            title = f"{who}: δικαιούται εμβόλιο και δεν {V.g(sex, 'του', 'της')} το είπες"
            body = (f"{V.person(f.get('name'))}, {ex.get('age_group', '65+')}, ήταν μπροστά σου {ago} "
                    f"και δεν έχει κάνει αντιγριπικό φέτος. Δεν είναι πώληση — είναι ο λόγος "
                    f"που υπάρχει φαρμακείο στη γειτονιά.")
            action = f"Πρόσφερέ {V.g(sex, 'του', 'της')} εμβολιασμό"

        elif sig == "lapsed_chronic":
            title = f"{who}: χρόνιος ασθενής που δεν ήρθε"
            body = (f"Έπαιρνε την αγωγή {V.g(sex, 'του', 'της')} εδώ {ex.get('rx_count', 'πολλές')} φορές. "
                    f"{him.capitalize()} περίμενες {ago} και δεν φάνηκε. "
                    f"Κάθε επίσκεψη άξιζε περίπου {money} — αλλά το θέμα δεν είναι αυτό: "
                    f"όποιος παίρνει χρόνια αγωγή και σταματά, ή άλλαξε φαρμακείο ή κάτι συμβαίνει.")
            action = f"Πάρ' {him} να δεις τι έγινε"

        else:
            title, body, action = f["signal"], "", ""

        if ex.get("rest"):
            body += f" Άλλοι {ex['rest']} είναι στην ίδια ακριβώς κατάσταση σήμερα."
        if opener:
            body = f"{opener} {body}"
        return {"title": title, "body": body, "action": action, "tone": tone,
                "streak": streak, "relapses": relapses}

    # ─────────────────────────────────────────────────────────────────────────
    # Η ΣΥΝΑΡΜΟΛΟΓΗΣΗ
    # ─────────────────────────────────────────────────────────────────────────

    async def build(self, *, user_name: str | None = None, persist: bool = True) -> dict:
        now = _now()
        day = _day_key(now)
        raw: list[dict] = []
        for fn in (self._sig_idle_requests, self._sig_unexecuted, self._sig_repeat_expiring,
                   self._sig_vaccine_missed, self._sig_no_contact, self._sig_lapsed_chronic):
            try:
                raw += await fn(now)
            except Exception:                              # noqa: BLE001
                # Ένα σήμα που σκάει ΔΕΝ ρίχνει τον σύμβουλο — ο φαρμακοποιός βλέπει τα υπόλοιπα.
                import logging
                logging.getLogger(__name__).exception("coach signal failed: %s", fn.__name__)
        for f in raw:
            f["key"] = f"{f['signal']}:{f['subject']}"

        raw = self._cap_per_signal(raw)
        states = await self._touch([(f["key"], f["signal"]) for f in raw], day, persist=persist)

        items = []
        for f in raw:
            st = states.get(f["key"]) or {}
            if st.get("hidden_until") and st["hidden_until"] >= day:
                continue                                   # «έγινε» σήμερα ή «δεν με αφορά»
            spoken = self._speak(f, st)
            items.append({
                "key": f["key"], "signal": f["signal"], "name": f.get("name"),
                "money_cents": f.get("money_cents"), "href": f.get("href"),
                "severity": f.get("severity", 2), **spoken,
            })

        rank = {V.TONE_HARD: 0, V.TONE_FIRM: 1, V.TONE_SOFT: 2}
        items.sort(key=lambda i: (rank[i["tone"]], -i["severity"], -(i["money_cents"] or 0)))
        shown, hidden = items[:MAX_ITEMS], max(0, len(items) - MAX_ITEMS)

        wins = await self._wins(now)
        clean = await self._clean_streak(day) if persist else 0
        hard = sum(1 for i in shown if i["tone"] == V.TONE_HARD)
        if persist:
            await self._stamp_day(day, misses=len(items), wins=len(wins))

        return {
            "day": day,
            "greeting": V.greeting(user_name, hour=now.astimezone(ATHENS).hour,
                                   open_misses=len(items), wins=len(wins), clean_streak=clean),
            "items": shown, "hidden": hidden, "wins": wins,
            "closing": V.closing(open_misses=len(items), wins=len(wins), hard=hard),
            "clean_streak": clean,
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

    async def _touch(self, keys: list[tuple[str, str]], day: str, *, persist: bool) -> dict:
        """Ενημέρωσε/διάβασε την κατάσταση κάθε ευρήματος & υπολόγισε το σερί."""
        if not keys:
            return {}
        existing = {d["key"]: d async for d in self._coll.find(
            {"tenant_id": self.tenant_id, "_id": {"$in": [self._doc_id(k) for k, _ in keys]}})}
        out, ops = {}, []
        yesterday = (datetime.strptime(day, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        for key, sig in keys:
            st = existing.get(key)
            if not st:
                st = {"_id": self._doc_id(key), "key": key, "tenant_id": self.tenant_id,
                      "signal": sig, "days_seen": 1, "relapses": 0,
                      "first_day": day, "last_day": day, "hidden_until": None}
                ops.append(("insert", st))
            elif st.get("last_day") != day:
                if st.get("last_day") == yesterday:
                    st["days_seen"] = int(st.get("days_seen") or 0) + 1
                else:                                       # επανεμφανίστηκε μετά από κενό = υποτροπή
                    st["relapses"] = int(st.get("relapses") or 0) + 1
                    st["days_seen"] = 1
                st["last_day"] = day
                ops.append(("update", st))
            out[key] = st
        if persist and ops:
            from pymongo import UpdateOne
            await self._coll.bulk_write([UpdateOne(
                {"_id": s["_id"]},
                {"$set": {k: v for k, v in s.items() if k != "_id"}}, upsert=True) for _, s in ops])
        return out

    async def _stamp_day(self, day: str, *, misses: int, wins: int) -> None:
        await self._db["coach_days"].update_one(
            {"tenant_id": self.tenant_id, "day": day},
            {"$set": {"misses": misses, "wins": wins, "at": _now()},
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

    async def history(self, days: int = 30) -> list[dict]:
        """Η γραμμή αυτοβελτίωσης: πόσα ξέφευγαν τότε, πόσα ξεφεύγουν τώρα."""
        since = (datetime.now(tz=ATHENS) - timedelta(days=days)).strftime("%Y-%m-%d")
        return [{"day": d["day"], "misses": d.get("misses", 0), "wins": d.get("wins", 0)}
                async for d in self._db["coach_days"].find(
                    {"tenant_id": self.tenant_id, "day": {"$gte": since}},
                    {"_id": 0, "day": 1, "misses": 1, "wins": 1}).sort("day", 1)]
