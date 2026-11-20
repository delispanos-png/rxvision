"""RxVision Κύπρος: «Ο Σύμβουλός σου» με τα ΙΔΙΑ σχήματα και την ΙΔΙΑ οθόνη με την Ελλάδα.

Όπως η Εικόνα Πελάτη (`cy_intelligence.py`), οι κλάσεις ΚΛΗΡΟΝΟΜΟΥΝ τις ελληνικές και αλλάζουν ΜΟΝΟ τις
πηγές δεδομένων και τη «φωνή» όπου η ελληνική λέει κάτι που δεν ισχύει στην Κύπρο. Ό,τι είναι κοινό
(σερί, «Έγινε»/«Δεν με αφορά», απολογισμός, εβδομάδα, στόχος, ομάδα, ρυθμίσεις, email) μένει αυτούσιο.

Σήματα Κύπρου (κλειδιά ίδια με την Ελλάδα όπου η έννοια ταιριάζει, ώστε ρυθμίσεις/στατιστικά να δουλεύουν):
  unexecuted       → γραμμές συνταγής ΓεΣΥ που ΔΕΝ δόθηκαν (QtyDisp 0) τις τελευταίες 14 ημέρες. ΧΩΡΙΣ το
                     ελληνικό «το υπόλοιπο κλειδώνει στο φαρμακείο σου» — είναι ελληνική νομοθεσία.
  repeat_expiring  → φάση πολυμηνιαίας συνταγής που ΚΑΘΥΣΤΕΡΕΙ (αλυσίδες `services/cy/chains.py`).
  lapsed_chronic   → «χαμένοι» πελάτες: δεν ξαναήρθαν μετά τη φάση που περιμέναμε (ίδιος ορισμός).
  no_contact       → πέρασαν τις τελευταίες 3 ημέρες χωρίς κινητό/email στην Καρτέλα πελάτη.
  advance_due      → δανεικό (προχορήγηση) ανοιχτό πάνω από 7 ημέρες.
  idle_request     → αίτημα πύλης χωρίς απάντηση (ΚΟΙΝΟ κύκλωμα — ο ελληνικός κώδικας αυτούσιος).
  revenue_drop     → πτώση τζίρου από τις εκτελέσεις ΓεΣΥ.
  αποθήκη          → ΚΟΙΝΗ Αποθήκη (`pharmacy_products`) — ο ελληνικός κώδικας αυτούσιος.
ΔΕΝ υπάρχουν στην Κύπρο: εμβόλιο γρίπης, ζημιά/περιθώριο ανά εκτέλεση (το XML ΓεΣΥ δεν έχει χονδρική).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from bson import ObjectId

from app.repositories.cy import CyDispensingRepository, CyLoanRepository, CyPatientRepository
from app.repositories.cy_intelligence import _sex
from app.repositories.daily_coach import (ATHENS, MAX_ITEMS, SIGNAL_LABEL, CoachSchool,
                                          DailyCoachRepository, _days_between, _now)
from app.services import coach_voice as V
from app.utils.masking import mask_amka, mask_name, pseudo_email, pseudo_phone

# Οι ετικέτες που βλέπει ο φαρμακοποιός στις Ρυθμίσεις — ΜΟΝΟ ό,τι υπάρχει στην Κύπρο
SIGNAL_LABEL_CY = {
    "unexecuted": "Είδη που δεν δόθηκαν",
    "repeat_expiring": "Φάσεις συνταγών που καθυστερούν",
    "idle_request": "Αιτήματα χωρίς απάντηση",
    "no_contact": "Πελάτες χωρίς στοιχεία",
    "lapsed_chronic": "Πελάτες που σταμάτησαν να έρχονται",
    "advance_due": "Δανεικά που δεν τακτοποιήθηκαν",
    "revenue_drop": "Πτώση τζίρου",
    "expired_stock": "Ληγμένα με απόθεμα",
    "expiring_soon": "Λήγουν σύντομα",
    "dead_stock": "Ακίνητο απόθεμα",
    "below_reorder": "Κάτω από το σημείο αναπαραγγελίας",
}


def _aware(d):
    return d.replace(tzinfo=timezone.utc) if isinstance(d, datetime) and d.tzinfo is None else d


class CyDailyCoachRepository(DailyCoachRepository):

    def _disp(self) -> CyDispensingRepository:
        return CyDispensingRepository(tenant_id=self.tenant_id)

    # ── ποιος είναι ο πελάτης ───────────────────────────────────────────────────────────
    async def _patient_info(self, ids: list) -> dict:
        """id → {name, sex, amka(=κωδικός ΟΑΥ), mobile, email, cy_ref}. Δέχεται ψευδώνυμα ΓεΣΥ ΚΑΙ τις
        καρτέλες πύλης (ObjectId) που χρησιμοποιούν τα κοινά κυκλώματα (αιτήματα πύλης)."""
        ids = [i for i in ids if i]
        if not ids:
            return {}
        shell_of: dict = {}
        oids = [i for i in ids if isinstance(i, ObjectId)]
        if oids:
            async for s in self._db["patients_anonymized"].find(      # tenant-ok: tenant_id στο φίλτρο
                    {"tenant_id": self.tenant_id, "_id": {"$in": oids}, "source": "cy_portal"},
                    {"cy_pseudo_id": 1}):
                if s.get("cy_pseudo_id"):
                    shell_of[s["_id"]] = s["cy_pseudo_id"]
        refs = {shell_of.get(i, i) for i in ids if isinstance(i, str) or i in shell_of}
        pats = {p["pseudo_id"]: p for p in await CyPatientRepository(tenant_id=self.tenant_id).find(
            {"pseudo_id": {"$in": list(refs)}}, limit=len(refs) + 1)}
        out: dict = {}
        for i in ids:
            ref = shell_of.get(i, i) if not isinstance(i, str) else i
            p = pats.get(ref)
            if not p:
                continue
            c = p.get("contact") or {}
            out[i] = {"name": mask_name(p.get("full_name"), self.demo), "sex": _sex(p.get("gender")),
                      "amka": mask_amka(p.get("hio_code"), self.demo),
                      "mobile": pseudo_phone(c.get("mobile"), self.demo), "phone": None,
                      "email": pseudo_email(c.get("email"), self.demo), "cy_ref": ref}
        return out

    def _links(self, f: dict) -> list[dict]:          # type: ignore[override]
        who = f.get("who") or {}
        ref, out = who.get("cy_ref"), []
        if ref:
            out.append({"kind": "profile", "label": "Εικόνα Πελάτη",
                        "href": f"/intelligence/profile?patient_id={quote(ref)}"})
            out.append({"kind": "card", "label": "Καρτέλα & επαφή", "href": f"/cy/patients/{quote(ref)}"})
        if f.get("disp"):
            out.append({"kind": "rx", "label": "Η εκτέλεση", "href": f"/cy/dispensings/{quote(str(f['disp']))}"})
        if f.get("inbox"):
            out.append({"kind": "inbox", "label": {"no_contact": "Πελάτες", "repeat_expiring": "Ανοιχτές συνταγές",
                                                   "lapsed_chronic": "Χαμένοι πελάτες",
                                                   "advance_due": "Προχορηγήσεις"}.get(
                f["signal"], "Άνοιγμα λίστας"), "href": f["inbox"]})
        return out

    # ── σήματα ──────────────────────────────────────────────────────────────────────────
    async def _sig_unexecuted(self, now: datetime) -> list[dict]:
        since = now - timedelta(days=14)
        rows = await self._disp().find({"dispensed_at": {"$gte": since}, "lines.qty_disp": 0},
                                       sort=[("dispensed_at", -1)], limit=300)
        latest: dict = {}
        for d in rows:
            miss = [ln.get("description") for ln in d.get("lines") or []
                    if not ln.get("qty_disp") and (ln.get("qty_presc") or 0) > 0 and ln.get("description")]
            if miss and d.get("patient_ref") and d["patient_ref"] not in latest:
                latest[d["patient_ref"]] = (d, miss)
        from app.services.cy.chains import deceased_refs
        for r in await deceased_refs(self.tenant_id):
            latest.pop(r, None)
        if not latest:
            return []
        # ήρθε ξανά μετά → δεν είναι πια εκκρεμότητα
        later = {r["_id"]: r["last"] for r in await self._disp().aggregate([
            {"$match": {"patient_ref": {"$in": list(latest)}}},
            {"$group": {"_id": "$patient_ref", "last": {"$max": "$dispensed_at"}}}])}
        info = await self._patient_info(list(latest))
        out = []
        for ref, (d, miss) in latest.items():
            if _aware(later.get(ref)) and _aware(later[ref]) > _aware(d["dispensed_at"]):
                continue
            who = self._who(info.get(ref), ref, extra=info.get(ref))
            out.append({"signal": "unexecuted", "subject": f"{ref}:{d['dispensing_id']}",
                        "name": who.get("name"), "sex": who.get("sex"), "who": who,
                        "since": _aware(d["dispensed_at"]), "items": miss[:6], "money_cents": None,
                        "severity": 2, "disp": d["dispensing_id"]})
        return out

    async def _sig_repeat_expiring(self, now: datetime) -> list[dict]:
        from app.services.cy import chains as ch
        cs = [c for c in await ch.chains(self.tenant_id) if c["status"] == "late" and c.get("patient_ref")]
        if not cs:
            return []
        cs.sort(key=lambda c: -(c.get("avg_value_cents") or 0))
        info = await self._patient_info([c["patient_ref"] for c in cs[:40]])
        out = []
        for c in cs[:40]:
            who = self._who(info.get(c["patient_ref"]), c["patient_ref"], extra=info.get(c["patient_ref"]))
            late = max(0, -int(c.get("days_to_due") or 0))
            out.append({"signal": "repeat_expiring", "subject": c["prescription_id"],
                        "name": who.get("name"), "sex": who.get("sex"), "who": who, "since": None,
                        "money_cents": int(c.get("avg_value_cents") or 0) or None,
                        "extra": {"position": int(c.get("instance") or 1) + 1, "total": int(c.get("instances") or 0),
                                  "late": late, "lost_after": c.get("lost_after_days"),
                                  "items": c.get("items") or []},
                        "severity": 3 if late >= 7 else 2, "inbox": "/cy/open"})
        return out

    async def _sig_lapsed_chronic(self, now: datetime) -> list[dict]:
        from app.services.cy import chains as ch
        res = await ch.lost_customers(self.tenant_id)
        lost = [i for i in res["items"] if i["kind"] == "lost"][:6]
        if not lost:
            return []
        visits = {r["_id"]: r["n"] for r in await self._disp().aggregate([
            {"$match": {"patient_ref": {"$in": [i["patient_ref"] for i in lost]}}},
            {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}}}])}
        info = await self._patient_info([i["patient_ref"] for i in lost])
        out = []
        for i in lost:
            ref = i["patient_ref"]
            who = self._who(info.get(ref), ref, extra=info.get(ref))
            out.append({"signal": "lapsed_chronic", "subject": ref, "name": who.get("name"),
                        "sex": who.get("sex"), "who": who,
                        "since": now - timedelta(days=int(i.get("days_since_visit") or 0)),
                        "money_cents": int(i.get("monthly_value_cents") or 0) or None,
                        "extra": {"rx_count": visits.get(ref, 0)}, "severity": 2, "inbox": "/cy/lost"})
        return out

    async def _sig_no_contact(self, now: datetime) -> list[dict]:
        rows = await self._disp().aggregate([
            {"$match": {"dispensed_at": {"$gte": now - timedelta(days=3)}, "patient_ref": {"$nin": [None, ""]}}},
            {"$group": {"_id": "$patient_ref", "value": {"$sum": "$totals.total"}, "last": {"$max": "$dispensed_at"}}}])
        if not rows:
            return []
        pats = {p["pseudo_id"]: p for p in await CyPatientRepository(tenant_id=self.tenant_id).find(
            {"pseudo_id": {"$in": [r["_id"] for r in rows]}}, limit=len(rows) + 1)}
        missing = [r for r in rows if not ((pats.get(r["_id"]) or {}).get("deceased") or {}).get("at")
                   and not ((pats.get(r["_id"]) or {}).get("contact") or {}).get("mobile")
                   and not ((pats.get(r["_id"]) or {}).get("contact") or {}).get("email")]
        if not missing:
            return []
        missing.sort(key=lambda r: r["value"], reverse=True)
        info = await self._patient_info([r["_id"] for r in missing[:6]])
        return [{"signal": "no_contact", "subject": "batch", "name": None,
                 "since": min(_aware(r["last"]) for r in missing),
                 "money_cents": sum(int(r["value"] or 0) for r in missing),
                 "extra": {"count": len(missing),
                           "names": [{"name": info[r["_id"]]["name"], "sex": info[r["_id"]].get("sex")}
                                     for r in missing[:4] if info.get(r["_id"], {}).get("name")]},
                 "severity": 2, "inbox": "/cy/patients"}]

    async def _sig_advance_due(self, now: datetime) -> list[dict]:
        loans = await CyLoanRepository(tenant_id=self.tenant_id).find(
            {"status": "open", "created_at": {"$lt": now - timedelta(days=7)}}, sort=[("created_at", 1)], limit=50)
        if not loans:
            return []
        info = await self._patient_info([ln.get("patient_ref") for ln in loans])
        out = []
        for ln in loans:
            items = [i.get("name") or i.get("gtin") for i in ln.get("items") or [] if i.get("status") == "open"]
            if not items or not ln.get("patient_ref"):
                continue
            ref = ln["patient_ref"]
            who = self._who(info.get(ref), ref, extra=info.get(ref))
            out.append({"signal": "advance_due", "subject": str(ln["_id"]), "name": who.get("name"),
                        "sex": who.get("sex"), "who": who, "since": _aware(ln.get("created_at")),
                        "money_cents": None, "extra": {"items": items}, "severity": 2, "inbox": "/cy/loans"})
        return out

    async def _sig_vaccine_missed(self, now: datetime) -> list[dict]:
        return []                               # το XML ΓεΣΥ δεν φέρνει εμβολιασμούς

    async def _sig_loss_execution(self, now: datetime) -> list[dict]:
        return []                               # το XML ΓεΣΥ δεν έχει χονδρική ανά εκτέλεση

    async def _sig_margin_drop(self, now: datetime) -> list[dict]:
        return []

    async def _totals(self, start: datetime, end: datetime) -> dict:
        rows = await self._disp().aggregate([
            {"$match": {"dispensed_at": {"$gte": start, "$lt": end}, "totals.total": {"$gt": 0}}},
            {"$group": {"_id": None, "rev": {"$sum": "$totals.total"}, "n": {"$sum": 1}}}])
        r = rows[0] if rows else {}
        return {"rev": int(r.get("rev") or 0), "cost": 0, "n": int(r.get("n") or 0)}

    async def _data_is_fresh(self, now: datetime) -> bool:
        last = await self._disp().find({}, sort=[("dispensed_at", -1)], limit=1)
        at = _aware(last[0]["dispensed_at"]) if last else None
        return bool(at and (now - at).days <= 3)

    # ── φωνή: ό,τι η ελληνική λέει και δεν ισχύει στην Κύπρο ──────────────────────────────
    def _speak(self, f: dict, st: dict) -> dict:
        sig = f["signal"]
        if sig not in ("unexecuted", "repeat_expiring", "advance_due"):
            return super()._speak(f, st)
        streak, relapses = int(st.get("days_seen") or 1), int(st.get("relapses") or 0)
        tone, opener = V.tone_for(streak + relapses), V.repeat_opener(streak + relapses)
        sex = f.get("sex")
        subj = f"{V.the(sex)} {V.person(f.get('name'))}"
        him, gen = V.g(sex, "τον", "την"), V.g(sex, "του", "της")
        ex = f.get("extra") or {}
        if sig == "unexecuted":
            names = [V.product(n) for n in (f.get("items") or [])]
            what = (f"το {names[0]}" if len(names) == 1
                    else ", ".join(names[:2]) + (f" και άλλα {len(names) - 2}" if len(names) > 2 else ""))
            title = f"{subj} έφυγε χωρίς μέρος της συνταγής {gen}"
            body = (f"Πέρασε {V.ago_phrase(_days_between(f.get('since'), _now()))} και δεν πήρε {what}. "
                    "Αν ήταν έλλειψη, μόλις το έχεις ένα τηλέφωνο αρκεί — οι περισσότεροι επιστρέφουν "
                    "μόλις μάθουν ότι τους το κρατάς.")
            action = f"Πάρ' {him} τηλέφωνο"
        elif sig == "repeat_expiring":
            late = int(ex.get("late") or 0)
            title = f"{subj}: η {ex.get('position', 2)}η φάση της συνταγής {gen} καθυστερεί"
            body = (f"Την περιμέναμε πριν από {V.count_word(late, feminine=True)} "
                    f"{'μέρα' if late == 1 else 'μέρες'} και δεν έχει έρθει"
                    + (f" ({', '.join(V.product(i) for i in ex['items'][:2])})" if ex.get("items") else "") + ". ")
            if ex.get("lost_after"):
                body += (f"Αν περάσουν {ex['lost_after']} μέρες χωρίς αυτήν, η συνταγή θεωρείται χαμένη. ")
            body += "Μια υπενθύμιση σήμερα συνήθως αρκεί."
            action = f"Ειδοποίησέ {him} σήμερα"
        else:   # advance_due
            names = [V.product(n) for n in (ex.get("items") or [])]
            what = f"το {names[0]}" if len(names) == 1 else ", ".join(names[:2]) + (
                f" και άλλα {len(names) - 2}" if len(names) > 2 else "")
            title = f"{subj} δεν έχει φέρει ακόμη τη συνταγή για {what}"
            body = (f"Το πήρε χωρίς συνταγή {V.ago_phrase(_days_between(f.get('since'), _now()))} και το "
                    "δανεικό είναι ακόμη ανοιχτό. Μέχρι να έρθει η εκτέλεση ΓεΣΥ, το κουτί λείπει από το "
                    "ράφι σου. Ένα τηλέφωνο σήμερα το λύνει.")
            action = f"Πάρ' {him} τηλέφωνο"
        if opener:
            body = f"{opener} {body}"
        return {"title": title, "body": body, "action": action, "tone": tone,
                "emoji": None if tone == V.TONE_HARD else V.SIGNAL_EMOJI.get(sig),
                "streak": streak, "relapses": relapses}

    # ── μικρές νίκες ────────────────────────────────────────────────────────────────────
    async def _wins(self, now: datetime) -> list[dict]:
        wins: list[dict] = []
        week = now - timedelta(days=7)
        fast = 0
        for coll, ts in (("rx_requests", "replied_at"), ("availability_requests", "answered_at")):
            async for d in self._db[coll].find(                      # tenant-ok: tenant_id στο φίλτρο
                    {"tenant_id": self.tenant_id, ts: {"$gte": week}}, {"created_at": 1, ts: 1}):
                if d.get(ts) and d.get("created_at") and (d[ts] - d["created_at"]) <= timedelta(hours=2):
                    fast += 1
        if fast:
            wins.append({"key": "w_fast_reply", "count": fast, "emoji": V.WIN_EMOJI.get("w_fast_reply"),
                         "text": (f"{V.count_word(fast, feminine=True).capitalize()} φορές απάντησες σε "
                                  "πελάτη μέσα σε δύο ώρες. Αυτό τους κάνει να ξαναγράφουν σ' εσένα.")})
        added = await CyPatientRepository(tenant_id=self.tenant_id).count(
            {"contact.updated_at": {"$gte": week}, "contact.source": {"$in": ["pharmacist", "patient"]}})
        if added:
            wins.append({"key": "w_contacts", "count": added, "emoji": V.WIN_EMOJI.get("w_contacts"),
                         "text": (f"Καταχωρήθηκαν στοιχεία επικοινωνίας για "
                                  f"{'έναν άνθρωπο' if added == 1 else f'{added} ανθρώπους'} αυτή την εβδομάδα — "
                                  "κάποιους που μπορείς πλέον να ειδοποιήσεις.")})
        return wins

    # ── ανάκτηση: λύθηκε ή χάθηκε; ΠΑΝΤΑ από τα πρωτογενή δεδομένα ΓεΣΥ ─────────────────────
    async def _verify(self, st: dict) -> str:
        sig, subj = st.get("signal"), str(st.get("subject") or "")
        since = _aware(st.get("first_seen_at")) or (_now() - timedelta(days=30))
        if sig in ("unexecuted", "lapsed_chronic"):
            ref = subj.split(":")[0]
            got = await self._disp().find_one({"patient_ref": ref, "dispensed_at": {"$gt": since}})
            return "recovered" if got else "lost"
        if sig == "repeat_expiring":
            got = await self._disp().find_one({"prescription_id": subj, "dispensed_at": {"$gt": since}})
            return "recovered" if got else "lost"
        if sig == "advance_due":
            try:
                ln = await CyLoanRepository(tenant_id=self.tenant_id).find_one({"_id": ObjectId(subj)})
            except Exception:  # noqa: BLE001
                return "unknown"
            return "recovered" if (ln or {}).get("status") == "closed" else "lost"
        if sig in ("idle_request", "no_contact"):
            return await super()._verify(st)
        return "unknown"

    # ── στο ταμείο: σύντομο για ΑΥΤΟΝ τον πελάτη (Εικόνα Πελάτη) ────────────────────────────
    async def patient_brief(self, patient_id: str) -> dict:
        p = await CyPatientRepository(tenant_id=self.tenant_id).find_one({"pseudo_id": patient_id})
        if not p:
            return {"found": False}
        now = _now()
        sex = _sex(p.get("gender"))
        him = V.g(sex, "τον", "την")
        notes: list[dict] = []
        last = await self._disp().find({"patient_ref": patient_id}, sort=[("dispensed_at", -1)], limit=1)
        if last:
            d = last[0]
            miss = [ln.get("description") for ln in d.get("lines") or []
                    if not ln.get("qty_disp") and (ln.get("qty_presc") or 0) > 0 and ln.get("description")]
            if miss and _days_between(_aware(d["dispensed_at"]), now) <= 30:
                notes.append({"kind": "unexecuted", "tone": "warn",
                              "text": (f"Την τελευταία φορά δεν πήρε: {', '.join(V.product(m) for m in miss[:2])}. "
                                       f"Ρώτησέ {him} αν το θέλει τώρα."),
                              "href": f"/cy/dispensings/{quote(str(d['dispensing_id']))}"})
        from app.services.cy import chains as ch
        for c in await ch.chains(self.tenant_id, match={"patient_ref": patient_id}):
            if c["status"] in ("late", "soon"):
                notes.append({"kind": "repeat_expiring", "tone": "warn" if c["status"] == "late" else "info",
                              "text": (f"Η {int(c.get('instance') or 1) + 1}η φάση της συνταγής "
                                       + ("καθυστερεί — αν τη θέλει, εκτέλεσέ τη τώρα."
                                          if c["status"] == "late" else "έρχεται τις επόμενες μέρες.")),
                              "href": "/cy/open"})
                break
        c = p.get("contact") or {}
        if not (c.get("mobile") or c.get("email")):
            notes.append({"kind": "no_contact", "tone": "info",
                          "text": (f"Δεν έχεις κανένα στοιχείο επικοινωνίας γι' {V.g(sex, 'αυτόν', 'αυτήν')}. "
                                   "Τώρα που είναι μπροστά σου, ζήτα ένα κινητό."),
                          "href": f"/cy/patients/{quote(patient_id)}"})
        return {"found": True, "patient_id": patient_id, "name": mask_name(p.get("full_name"), self.demo),
                "amka": mask_amka(p.get("hio_code"), self.demo), "notes": notes}

    # ── κρυφό κόστος: χαμένες φάσεις + είδη που δεν δόθηκαν, σε τζίρο ──────────────────────
    async def leakage(self, months: int = 6) -> dict:
        """Ίδιο σχήμα με την Ελλάδα. Το «κέρδος» ΔΕΝ υπολογίζεται (το XML ΓεΣΥ δεν έχει χονδρική) —
        `profit_known=False` και η οθόνη δείχνει μόνο τζίρο. Ποτέ εκτίμηση."""
        from app.services.cy import chains as ch
        now = _now()
        start = (now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                 - timedelta(days=31 * (months - 1))).replace(day=1)
        acc: dict = {}

        def _b(m: str) -> dict:
            return acc.setdefault(m, {"month": m, "repeats_n": 0, "repeats_value": 0, "repeats_profit": 0,
                                      "items_n": 0, "items_value": 0, "items_profit": 0})
        for c in await ch.chains(self.tenant_id):
            if c["status"] != "lost":
                continue
            lost_day = datetime.fromisoformat(c["next_due"]).replace(tzinfo=timezone.utc) + timedelta(
                days=int(c.get("lost_after_days") or 0))
            if not (start <= lost_day < now):
                continue
            b = _b(lost_day.astimezone(ATHENS).strftime("%Y-%m"))
            b["repeats_n"] += 1
            b["repeats_value"] += int(c.get("value_at_stake_cents") or 0)
        rows = await self._disp().aggregate([
            {"$match": {"dispensed_at": {"$gte": start}}}, {"$unwind": "$lines"},
            {"$match": {"lines.qty_disp": 0, "lines.qty_presc": {"$gt": 0}}},
            {"$project": {"dispensed_at": 1}}])
        for r in rows:                     # μήνας σε ώρα Αθήνας/Λευκωσίας (ίδια ζώνη)
            _b(_aware(r["dispensed_at"]).astimezone(ATHENS).strftime("%Y-%m"))["items_n"] += 1
        out = sorted(acc.values(), key=lambda b: b["month"])
        this_month = now.astimezone(ATHENS).strftime("%Y-%m")
        for b in out:
            b["total_value"] = b["repeats_value"] + b["items_value"]
            b["total_profit"] = 0
            b["partial"] = b["month"] == this_month
        tot = {k: sum(b[k] for b in out) for k in ("repeats_n", "repeats_value", "repeats_profit", "items_n",
                                                    "items_value", "items_profit", "total_value", "total_profit")}
        full = [b for b in out if not b["partial"]]
        trend = None
        if len(full) >= 4:
            half = len(full) // 2
            a = sum(b["total_value"] for b in full[:half]) / max(1, half)
            z = sum(b["total_value"] for b in full[half:]) / max(1, len(full) - half)
            trend = {"before": a, "after": z, "better": z < a * 0.9, "worse": z > a * 1.1}
        return {"months": out, "total": tot, "trend": trend, "full_months": len(full),
                "this_month": this_month, "country": "CY", "profit_known": False}

    async def settings(self) -> dict:
        s = await super().settings()
        d = await self._db["coach_settings"].find_one({"tenant_id": self.tenant_id}) or {}
        stored = d.get("signals") or {}
        # ΟΛΑ τα κλειδιά (ελληνικά + κυπριακά, π.χ. advance_due) ώστε κάθε διακόπτης της οθόνης να
        # αποθηκεύεται· η οθόνη δείχνει μόνο όσα υπάρχουν στην Κύπρο (`labels`).
        keys = set(SIGNAL_LABEL) | set(SIGNAL_LABEL_CY)
        return {**s, "signals": {k: bool(stored.get(k, True)) for k in keys}, "labels": SIGNAL_LABEL_CY}

    async def save_settings(self, patch: dict) -> dict:
        if isinstance(patch.get("signals"), dict):
            cur = (await self.settings())["signals"]
            sig = {k: bool(patch["signals"].get(k, cur[k])) for k in cur}
            await self._db["coach_settings"].update_one(
                {"tenant_id": self.tenant_id}, {"$set": {"tenant_id": self.tenant_id, "signals": sig}}, upsert=True)
            patch = {k: v for k, v in patch.items() if k != "signals"}
        if patch:
            await super().save_settings(patch)
        return await self.settings()


class CyCoachSchool(CoachSchool):
    """«Τι άλλο μπορείς»: ίδιες κάρτες, μετρημένες στα δεδομένα ΓεΣΥ. Χωρίς προτάσεις που δεν έχουν
    δεδομένα στην Κύπρο (θεραπείες με επανάληψη ΗΔΥΚΑ, εμβόλια)."""

    collection_name = "cy_dispensings"

    async def _base(self) -> tuple[int, int]:
        since = _now() - timedelta(days=365)
        total = await CyPatientRepository(tenant_id=self.tenant_id).count({"last_seen": {"$gte": since}})
        agg = await self.aggregate([{"$match": {"dispensed_at": {"$gte": since}}},
                                    {"$group": {"_id": None, "v": {"$avg": "$totals.total"}}}])
        return total, int((agg[0].get("v") or 0) if agg else 0)

    async def _prop_therapies(self, now, total, avg):
        return None

    async def _prop_vaccines(self, now, total, avg):
        return None

    async def _prop_reach(self, now: datetime, total: int, avg: int) -> dict | None:
        if total < 50:
            return None
        since = now - timedelta(days=365)
        missing = await CyPatientRepository(tenant_id=self.tenant_id).count({
            "last_seen": {"$gte": since}, "contact.mobile": {"$in": [None, ""]},
            "contact.email": {"$in": [None, ""]}})
        if missing < max(20, total // 10):
            return None
        return {
            "id": "reach", "feature": "Στοιχεία επικοινωνίας", "module": None,
            "headline": (f"Ξέρεις ότι **{missing} πελάτες σου** ({self._pct(missing, total)}%) δεν έχουν "
                         "ούτε κινητό ούτε email;"),
            "situation": ("Το XML ΓεΣΥ δεν φέρνει τηλέφωνο. Ό,τι κι αν στήσουμε — υπενθυμίσεις φάσεων, "
                          "πύλη, καμπάνιες — αυτοί δεν θα το μάθουν ποτέ."),
            "promise": ("Δέκα δευτερόλεπτα στο ταμείο: ανοίγεις την **Καρτέλα πελάτη**, γράφεις κινητό και "
                        "τσεκάρεις τη συγκατάθεση. Δύο τη μέρα και σε έναν μήνα έχεις αλλάξει εικόνα."),
            "serve_n": missing, "serve_pct": self._pct(missing, total), "money_cents": 0,
            "setup": ["Ανοίγουμε τη λίστα Πελάτες.", "Ξεκινάμε από όσους έρχονται συχνότερα.",
                      "Σε κάθε επίσκεψη ζητάμε κινητό και συγκατάθεση.", "Σε έναν μήνα ξαναμετράμε."],
            "cta": {"label": "Άνοιξε τους Πελάτες", "href": "/cy/patients"}, "weight": 98}

    async def _prop_winback(self, now: datetime, total: int, avg: int) -> dict | None:
        from app.repositories.cy_intelligence import CyPatientIntelligenceRepository
        pi = CyPatientIntelligenceRepository(tenant_id=self.tenant_id)
        grp = [b for b in pi._winback_buckets(await pi._patients(), now) if b["bucket"] in (180, 365)]
        n = sum(b["count"] for b in grp)
        if n < 15:
            return None
        lost = sum(b["lost_revenue"] for b in grp)
        return {
            "id": "winback", "feature": "Επανάκτηση (Win-Back)", "module": "patient_analytics",
            "headline": (f"Ξέρεις ότι **{n} πελάτες σου** ({self._pct(n, total)}%) έχουν να φανούν "
                         "από 3 έως 12 μήνες;"),
            "situation": f"Μέχρι να σταματήσουν είχαν αφήσει σε εσένα **{lost/100:,.0f} €**.".replace(",", "."),
            "promise": ("Με το **Win-Back** τους βλέπεις ομαδοποιημένους κατά πόσο καιρό λείπουν και "
                        "ξεκινάς από τους πιο πρόσφατους — εκεί η επιστροφή είναι πιο εύκολη."),
            "serve_n": n, "serve_pct": self._pct(n, total), "money_cents": lost,
            "setup": ["Ανοίγουμε το Win-Back.", "Ξεκινάμε από τη μικρότερη ομάδα.",
                      "Παίρνεις 10 τηλέφωνα, όχι 300.", "Σε δύο εβδομάδες βλέπουμε πόσοι γύρισαν."],
            "cta": {"label": "Άνοιξε το Win-Back", "href": "/intelligence/winback"}, "weight": 94}

    async def _prop_loyalty(self, now: datetime, total: int, avg: int) -> dict | None:
        res = await self.aggregate([
            {"$match": {"dispensed_at": {"$gte": now - timedelta(days=365)}, "patient_ref": {"$nin": [None, ""]}}},
            {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}, "val": {"$sum": "$totals.total"}}},
            {"$match": {"n": {"$gte": 6}}}])
        loyal = len(res)
        if loyal < 40:
            return None
        members = await self._db["loyalty_members"].count_documents({"tenant_id": self.tenant_id})
        if members >= loyal // 4:
            return None
        val = sum(int(r.get("val") or 0) for r in res)
        return {
            "id": "loyalty", "feature": "Κάρτες Πιστότητας", "module": "loyalty",
            "headline": (f"Ξέρεις ότι **{loyal} άνθρωποι** ({self._pct(loyal, total)}%) ήρθαν σε εσένα "
                         "6 ή περισσότερες φορές μέσα στον χρόνο;"),
            "situation": (f"Αφήνουν **{val/100:,.0f} €** τον χρόνο και ".replace(",", ".")
                          + ("κανένας τους δεν είναι μέλος σε πρόγραμμα επιβράβευσης."
                             if not members else f"μόνο {members} είναι μέλη στην κάρτα σου.")),
            "promise": ("Οι **Κάρτες Πιστότητας** ανταμείβουν τη συνέπεια — και ο πελάτης έχει λόγο να μη "
                        "δοκιμάσει το διπλανό φαρμακείο."),
            "serve_n": loyal, "serve_pct": self._pct(loyal, total), "money_cents": val,
            "setup": ["Ορίζουμε 3-4 δώρα.", "Βάζουμε δώρο εγγραφής.",
                      "Γράφουμε μέλη από την Καρτέλα πελάτη.", "Ξεκινάμε από όσους έρχονται κάθε μήνα."],
            "cta": {"label": "Άνοιξε τις Κάρτες Πιστότητας", "href": "/loyalty"}, "weight": 88}

    async def _prop_portal(self, now: datetime, total: int, avg: int) -> dict | None:
        if total < 100:
            return None
        reg = len(await self._db["patient_links"].distinct(          # tenant-ok: tenant_id στο φίλτρο
            "account_id", {"tenant_id": self.tenant_id}))
        if reg >= total // 10:
            return None
        return {
            "id": "portal", "feature": "Πύλη Πελατών", "module": "patient_portal",
            "headline": (f"Ξέρεις ότι μόνο **{reg} από τους {total} πελάτες σου** "
                         f"({self._pct(reg, total)}%) έχουν λογαριασμό στην πύλη σου;"),
            "situation": "Οι υπόλοιποι σε παίρνουν τηλέφωνο για ό,τι θα μπορούσαν να δουν μόνοι τους.",
            "promise": ("Με την **Πύλη Πελατών** βλέπουν τα φάρμακα και το πρόγραμμα λήψης τους, ζητούν "
                        "διαθεσιμότητα και ραντεβού — και οι ειδοποιήσεις στο κινητό **δεν κοστίζουν τίποτα**."),
            "serve_n": total - reg, "serve_pct": self._pct(total - reg, total), "money_cents": 0,
            "setup": ["Ορίζουμε ωράριο και υπηρεσίες.", "Στέλνουμε πρόσκληση από την Καρτέλα πελάτη.",
                      "Ξεκινάμε από όσους ρωτούν «πότε ξαναπαίρνω;».", "Σε έναν μήνα ξαναμετράμε."],
            "cta": {"label": "Άνοιξε τους Πελάτες", "href": "/cy/patients"}, "weight": 84}

    async def _prop_marketing(self, now: datetime, total: int, avg: int) -> dict | None:
        from app.services.cy.marketing import category_sizes
        cats = await category_sizes(self.tenant_id)
        if not cats or cats[0]["patients"] < 40:
            return None
        camps = await self._db["comms_campaigns"].count_documents({"tenant_id": self.tenant_id})
        if camps >= 3:
            return None
        n, name = cats[0]["patients"], cats[0]["label"]
        return {
            "id": "marketing", "feature": "Στοχευμένη Προώθηση", "module": "marketing",
            "headline": (f"Ξέρεις ότι έχεις **{n} πελάτες** ({self._pct(n, total)}%) στην ίδια θεραπευτική "
                         f"κατηγορία — **{name}**;"),
            "situation": "Ξέρεις τι παίρνουν και κάθε πότε. "
                         + ("Και δεν τους έχεις στείλει ποτέ τίποτα." if not camps
                            else f"Και έχεις στείλει μόλις {camps} καμπάνιες συνολικά."),
            "promise": ("Με τη **Στοχευμένη Προώθηση** τους βλέπεις ανά θεραπεία, ξέρεις πόσοι είναι "
                        "προσεγγίσιμοι και τους στέλνεις μήνυμα φροντίδας με ένα κλικ."),
            "serve_n": n, "serve_pct": self._pct(n, total), "money_cents": 0,
            "setup": ["Διαλέγουμε ΜΙΑ θεραπεία.", "Γράφουμε ένα σύντομο μήνυμα φροντίδας.",
                      "Στέλνουμε σε όσους έχουν συγκατάθεση.", "Σε μια εβδομάδα βλέπουμε τι απέδωσε."],
            "cta": {"label": "Θεραπευτικές κατηγορίες", "href": "/marketing/categories"}, "weight": 80}


async def coach_for(tenant_id: str, demo: bool = False):
    """ΕΝΑ σημείο επιλογής χώρας για τον Σύμβουλο (router + worker email)."""
    from app.services.cy.gate import tenant_country
    from app.utils.masking import set_given_name_first
    cy = await tenant_country(tenant_id) == "CY"
    set_given_name_first(cy)      # worker: ένας βρόχος περνά Ελλάδα ΚΑΙ Κύπρο → ορίζεται σε ΚΑΘΕ φαρμακείο
    if cy:
        return CyDailyCoachRepository(tenant_id=tenant_id, demo=demo)
    return DailyCoachRepository(tenant_id=tenant_id, demo=demo)


async def school_for(tenant_id: str):
    from app.services.cy.gate import tenant_country
    if await tenant_country(tenant_id) == "CY":
        return CyCoachSchool(tenant_id=tenant_id)
    return CoachSchool(tenant_id=tenant_id)


__all__ = ["CyDailyCoachRepository", "CyCoachSchool", "coach_for", "school_for", "SIGNAL_LABEL_CY",
           "MAX_ITEMS", "SIGNAL_LABEL"]
