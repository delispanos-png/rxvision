"""RxVision Κύπρος: Patient Intelligence ΑΥΤΟΥΣΙΟ με την Ελλάδα.

ΙΔΙΕΣ οθόνες, ΙΔΙΟΙ υπολογισμοί (VIP βαθμίδες, Win-Back ομάδες, Ρίσκο, ζώνες Συμμόρφωσης, AI insights),
ΙΔΙΟ σχήμα απαντήσεων — γιατί αυτή η κλάση ΚΛΗΡΟΝΟΜΕΙ τον ελληνικό repository και αλλάζει ΜΟΝΟ τις
πηγές δεδομένων:

    _patients        → cy_patients + σύνολα από cy_dispensings (ίδια πεδία με patients_anonymized)
    _timeline        → cy_dispensings (dispensed_at, totals.total)
    _chain_analysis  → οι αλυσίδες ΓεΣΥ από `services/cy/chains.py` (ΕΝΑΣ ορισμός με Ανοιχτές
                       συνταγές / Χαμένους / Καρτέλα)
    _exec_totals / _active_count / _trend / _regular_patients → cy_dispensings

Ό,τι ΔΕΝ υπάρχει στο XML ΓεΣΥ δεν επινοείται: χωρίς ICD-10 → καμία «Διάγνωση»· χωρίς ATC → από τα
θεραπευτικά segments μόνο ο Διαβήτης (από τα αναλώσιμα). `patient_id` = το ψευδώνυμο ΓεΣΥ (string).
Το πεδίο `amka` των απαντήσεων κουβαλά τον ΚΩΔΙΚΟ ΟΑΥ (η οθόνη τον ονομάζει ανάλογα με τη χώρα).
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from app.repositories.base import jsonsafe
from app.repositories.cy import CyDispensingRepository, CyPatientRepository, find_all
from app.repositories.patient_intelligence import (SEGMENTS, PatientIntelligenceRepository, _band, _now,
                                                   _pct, _yago)
from app.services.cy import chains as ch
from app.services.cy import insights as cy_insights
from app.utils.masking import mask_amka, mask_name, mask_rows

TZ = ZoneInfo("Asia/Nicosia")


def _dt(v: Any) -> datetime | None:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _day_dt(d: date) -> datetime:
    return datetime.combine(d, datetime.min.time(), tzinfo=TZ)


def _sex(g: Any) -> str | None:
    s = str(g or "").strip().upper()[:1]
    return {"M": "M", "F": "F", "Α": "M", "Θ": "F"}.get(s)


def _age_group(dob: Any) -> tuple[int | None, str | None]:
    m = re.match(r"(\d{4})", str(dob or ""))
    if not m:
        return None, None
    from app.utils.anonymization import age_group
    y = int(m.group(1))
    return y, age_group(y, today=date.today())


def chain_positions(c: dict, today: date) -> dict:
    """Μία αλυσίδα ΓεΣΥ (από `chains.chains`) → θέσεις 1…N στο ΙΔΙΟ σχήμα με το ελληνικό
    `chain_positions`. Αναμενόμενες θέσεις: ίδιος κανόνας με `chains.adherence` (μετά το περιθώριο
    «χάθηκε»)· διαθέσιμη = η επόμενη φάση έρχεται σύντομα ή καθυστερεί."""
    interval, lost_after = c["interval_days"], c.get("lost_after_days", ch.LOST_AFTER_DAYS)
    first = _dt(c.get("first_at")) or _dt(c.get("last_at"))
    possible = max(0, c["instances"] - c["first_instance"] + 1)
    elapsed = (today - ch.local_day(first)).days - lost_after - 1 if first else -1
    expected = min(possible, 1 + (elapsed // interval if elapsed >= 0 else 0))
    executed = min(c["visits"], possible)
    out = {"windows": [], "executed": min(executed, expected) if expected else executed,
           "missed": max(0, expected - min(executed, expected)), "available": 0,
           "value_each": c["avg_value_cents"], "missed_closed": []}
    nxt = date.fromisoformat(c["next_due"])
    for k in range(c["first_instance"], c["instances"] + 1):
        if k <= c["instance"]:
            st, due = "executed", None
        else:
            due = nxt + timedelta(days=interval * (k - c["instance"] - 1))
            lost = (today - due).days > lost_after
            st = ("missed" if lost else "available" if k == c["instance"] + 1 and c["status"] in ("soon", "late")
                  else "future")
        wd = _day_dt(due) if due else None
        dl = _day_dt(due + timedelta(days=lost_after)) if due else None
        if st == "available":
            out["available"] += 1
        if st == "missed":
            out["missed_closed"].append(dl)
        out["windows"].append({"k": k, "due": wd, "deadline": dl, "status": st})
    out["missed"] = max(out["missed"], len(out["missed_closed"]))
    return out


class CyPatientIntelligenceRepository(PatientIntelligenceRepository):
    collection_name = "cy_dispensings"
    CACHED_VIEWS = {"overview": 900, "segments": 900, "today": 300}

    def _disp(self) -> CyDispensingRepository:
        return CyDispensingRepository(tenant_id=self.tenant_id)

    # ── πηγές δεδομένων ─────────────────────────────────────────────────────────────────────
    async def _patients(self) -> list[dict]:
        agg = {r["_id"]: r for r in await self._disp().aggregate([
            {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}, "v": {"$sum": "$totals.total"},
                        "first": {"$min": "$dispensed_at"}, "last": {"$max": "$dispensed_at"}}}]) if r["_id"]}
        names = await ch.names_of(self.tenant_id, set(agg))
        out = []
        for ref, r in agg.items():
            p = names.get(ref) or {}
            if (p.get("deceased") or {}).get("at"):
                continue                    # ίδιος κανόνας με την Ελλάδα: θανόντες εκτός κάθε ανάλυσης
            by, ag = _age_group(p.get("dob"))
            out.append({"_id": ref, "full_name": p.get("full_name"), "amka": p.get("hio_code"),
                        "sex": _sex(p.get("gender")), "birth_year": by, "age_group": ag,
                        "rx_count": r["n"], "rx_value_total": r["v"] or 0,
                        "first_seen_at": _dt(r["first"]), "last_seen_at": _dt(r["last"])})
        return out

    async def _timeline(self) -> dict:
        by: dict = defaultdict(list)
        for r in await self._disp().aggregate([
                {"$project": {"_id": 0, "p": "$patient_ref", "t": "$dispensed_at", "v": "$totals.total"}}]):
            t = _dt(r.get("t"))
            if r.get("p") and t:
                by[r["p"]].append((t, r.get("v") or 0))
        for evs in by.values():
            evs.sort()
        return by

    async def _chains(self) -> list[dict]:
        return await ch.chains(self.tenant_id)

    async def _chain_analysis(self) -> dict:
        today = datetime.now(tz=TZ).date()
        per: dict = defaultdict(lambda: {"executed": 0, "expected": 0, "missed": 0, "available": 0,
                                         "recoverable": 0, "chains": 0, "missed_closed": []})
        for c in await self._chains():
            if not c["patient_ref"] or c["instances"] <= 1:
                continue
            cp = chain_positions(c, today)
            p = per[c["patient_ref"]]
            p["chains"] += 1
            p["executed"] += cp["executed"]
            p["expected"] += cp["executed"] + cp["missed"]
            p["missed"] += cp["missed"]
            p["available"] += cp["available"]
            p["recoverable"] += cp["value_each"] * (cp["missed"] + cp["available"])
            p["missed_closed"] += cp["missed_closed"]
        for p in per.values():
            p["compliance"] = round(p["executed"] / p["expected"] * 100) if p["expected"] else None
        return per

    async def recall_refs(self, chain: dict | None = None) -> dict:
        chain = chain if chain is not None else await self._chain_analysis()
        return {p: c for p, c in chain.items() if c["missed"] or c["available"]}

    async def _exec_totals(self, lo: datetime, hi: datetime | None = None) -> tuple[int, int]:
        rng: dict = {"$gte": lo, **({"$lt": hi} if hi else {})}
        r = await self._disp().aggregate([{"$match": {"dispensed_at": rng}},
                                          {"$group": {"_id": None, "n": {"$sum": 1}, "v": {"$sum": "$totals.total"}}}])
        return (r[0]["n"], r[0]["v"] or 0) if r else (0, 0)

    async def _active_count(self, lo: datetime, hi: datetime) -> int:
        r = await self._disp().aggregate([{"$match": {"dispensed_at": {"$gte": lo, "$lt": hi}}},
                                          {"$group": {"_id": "$patient_ref"}}])
        return len(r)

    async def _points(self, since: datetime) -> list[tuple[datetime, int]]:
        rows = await self._disp().aggregate([{"$match": {"dispensed_at": {"$gte": since}}},
                                             {"$project": {"_id": 0, "t": "$dispensed_at", "v": "$totals.total"}}])
        return [(_dt(r["t"]).astimezone(TZ), r.get("v") or 0) for r in rows if _dt(r.get("t"))]

    async def _trend(self) -> dict:
        now = _now()
        pts = await self._points(now - timedelta(days=370))

        def buckets(fmt, since):
            b: dict = defaultdict(lambda: {"rx": 0, "value": 0})
            for t, v in pts:
                if t >= since:
                    k = t.strftime(fmt) if fmt != "W" else f"{t.isocalendar()[0]}-W{t.isocalendar()[1]:02d}"
                    b[k]["rx"] += 1
                    b[k]["value"] += v
            return [{"label": k, **b[k]} for k in sorted(b)]
        return {"daily": buckets("%Y-%m-%d", now - timedelta(days=30)),
                "weekly": buckets("W", now - timedelta(weeks=12)),
                "monthly": buckets("%Y-%m", now - timedelta(days=370))}

    async def _regular_patients(self, months: int = 6) -> set:
        seen: dict = defaultdict(set)
        rows = await self._disp().aggregate([
            {"$match": {"dispensed_at": {"$gte": _now() - timedelta(days=365)}}},
            {"$project": {"_id": 0, "p": "$patient_ref", "t": "$dispensed_at"}}])
        for r in rows:
            t = _dt(r.get("t"))
            if r.get("p") and t:
                seen[r["p"]].add(t.astimezone(TZ).strftime("%Y-%m"))
        return {p for p, m in seen.items() if len(m) >= months}

    # ── οθόνες με δικά τους ερωτήματα ───────────────────────────────────────────────────────
    async def segments(self) -> dict:
        """Θεραπευτικά segments ΙΔΙΑ με την Ελλάδα (ATC → SEGMENTS). Ο ATC κάθε γραμμής έρχεται από τον
        κατάλογο Κύπρου (services/cy/atc_link.py)· ο Διαβήτης μετρά ΚΑΙ όσους παίρνουν μόνο αναλώσιμα."""
        from app.services.cy.atc_link import lookup
        lk = await lookup()
        pats: dict[str, dict] = defaultdict(lambda: {"atcs": set(), "value": 0, "diab": False})
        for d in await self._disp().aggregate([
                {"$project": {"_id": 0, "p": "$patient_ref", "kind": 1, "lines": 1, "v": "$totals.total"}}]):
            if not d.get("p"):
                continue
            x = pats[d["p"]]
            x["value"] += d.get("v") or 0
            x["atcs"] |= lk.atcs_of([d])
            if d.get("kind") == "consumable" and cy_insights.is_diabetic([d]):
                x["diab"] = True
        out = []
        for seg in SEGMENTS:
            members = [x for x in pats.values()
                       if any(a.startswith(tuple(seg["atc"])) for a in x["atcs"]) or (seg["key"] == "diabetes" and x["diab"])]
            out.append({"key": seg["key"], "label": seg["label"], "en": seg["en"],
                        "patients": len(members), "value": round(sum(m["value"] for m in members))})
        out.sort(key=lambda s: s["patients"], reverse=True)
        return jsonsafe({"segments": out})

    async def returns(self) -> dict:
        now = _now()
        rets = self._returns_from(await self._timeline(), now)
        names = await ch.names_of(self.tenant_id, {r["patient_ref"] for r in rets})
        items = [{"patient_id": r["patient_ref"], "name": (names.get(r["patient_ref"]) or {}).get("full_name"),
                  "amka": (names.get(r["patient_ref"]) or {}).get("hio_code"),
                  "returned_at": r["returned_at"], "gap_days": r["gap_days"], "value": r["value"],
                  "reactivation_reason": None, "mobile": ((names.get(r["patient_ref"]) or {}).get("contact") or {}).get("mobile"),
                  "phone": None} for r in rets]
        return jsonsafe({"items": mask_rows(items, self.demo), "count": len(items),
                         "recovered_value": round(sum(r["value"] for r in rets))})

    async def today(self) -> dict:
        now = datetime.now(tz=TZ)
        tstart = now.replace(hour=0, minute=0, second=0, microsecond=0)
        tend = tstart + timedelta(days=1)
        disp = await find_all(self._disp(), {"dispensed_at": {"$gte": tstart, "$lt": tend}})
        pts_y = await self._exec_totals(_yago(tstart), _yago(now))
        latest = await self._disp().find({}, sort=[("dispensed_at", -1)], limit=1)
        by_h: dict = defaultdict(lambda: {"rx": 0, "value": 0})
        cats: Counter = Counter()
        meds: Counter = Counter()
        pats = set()
        value = 0
        for d in disp:
            t = _dt(d.get("dispensed_at")).astimezone(TZ)
            v = (d.get("totals") or {}).get("total", 0)
            by_h[t.hour]["rx"] += 1
            by_h[t.hour]["value"] += v
            value += v
            pats.add(d.get("patient_ref"))
            cats["Αναλώσιμα" if d.get("kind") == "consumable" else "Φάρμακα"] += len(d.get("lines") or [])
            for ln in d.get("lines") or []:
                if ln.get("qty_disp") and ln.get("description"):
                    meds[ln["description"]] += 1
        firsts = await self._disp().aggregate([{"$group": {"_id": "$patient_ref", "f": {"$min": "$dispensed_at"}}}])
        new_today = sum(1 for r in firsts if (f := _dt(r.get("f"))) and tstart <= f < tend)
        d30: Counter = Counter(t.date() for t, _ in await self._points(tstart - timedelta(days=30)) if t < tstart)
        avg_day = round(sum(d30.values()) / len(d30)) if d30 else 0
        rec = await self.recall_refs()
        rx = len(disp)
        return jsonsafe({
            "day": tstart.date().isoformat(), "is_live": True, "current_hour": now.hour,
            "last_activity": (latest[0].get("dispensed_at") if latest else None), "last_sync": None,
            "rx": rx, "value": value, "patients": len(pats), "new_patients": new_today,
            "avg_day_rx": avg_day, "vs_avg": _pct(rx, avg_day),
            "rx_yoy": pts_y[0], "value_yoy": pts_y[1],
            "vs_yoy_rx": _pct(rx, pts_y[0]), "vs_yoy_value": _pct(value, pts_y[1]),
            "by_hour": [{"hour": h, **by_h[h]} for h in sorted(by_h)],
            "categories": [{"category": k, "count": n} for k, n in cats.most_common()],
            "top_meds": [{"name": k, "count": n} for k, n in meds.most_common(8)],
            "expected_absent": len(rec),
            "expected_week": sum(1 for c in rec.values() if c["available"] and not c["missed"]),
            "expected_missed": sum(1 for c in rec.values() if c["missed"]),
        })

    # ── Recall (ίδιο σχήμα με AdvisorRepository.recall / recall_detail) ──────────────────────
    async def recall(self) -> dict:
        rec = await self.recall_refs()
        names = await ch.names_of(self.tenant_id, set(rec))
        pats = {p["_id"]: p for p in await self._patients() if p["_id"] in rec}
        items = []
        for pref, c in rec.items():
            n = names.get(pref) or {}
            ct = n.get("contact") or {}
            items.append({"patient_id": pref, "name": n.get("full_name"), "amka": n.get("hio_code"),
                          "age_group": (pats.get(pref) or {}).get("age_group"),
                          "last_seen": (pats.get(pref) or {}).get("last_seen_at"),
                          "missed": c["missed"], "available": c["available"], "value": round(c["recoverable"]),
                          "mobile": ct.get("mobile"), "phone": None, "email": ct.get("email"),
                          "consent": bool(ct.get("marketing_consent")),
                          "has_contact": bool(ct.get("mobile") or ct.get("email"))})
        items.sort(key=lambda x: x["value"], reverse=True)
        return jsonsafe({"items": mask_rows(items[:5000], self.demo), "patients": len(items),
                         "total_value": sum(i["value"] for i in items),
                         "total_missed": sum(i["missed"] for i in items),
                         "total_available": sum(i["available"] for i in items),
                         "with_contact": sum(1 for i in items if i["has_contact"]),
                         "excluded_inactive": 0})

    async def recall_detail(self, patient_id: str) -> dict:
        p = await CyPatientRepository(tenant_id=self.tenant_id).find_one({"pseudo_id": patient_id})
        if not p:
            return {"found": False}
        today = datetime.now(tz=TZ).date()
        out = []
        for c in await ch.chains(self.tenant_id, match={"patient_ref": patient_id}):
            if c["instances"] <= 1:
                continue
            cp = chain_positions(c, today)
            if not (cp["missed"] or cp["available"]):
                continue
            first = _dt(c.get("first_at"))
            out.append({"key": c["prescription_id"], "medicine": " · ".join(c["items"][:2]) or None,
                        "doctor": {"name": c["doctor"], "specialty": None, "phone": None} if c["doctor"] else None,
                        "valid_from": first, "valid_until": None,
                        "missed": cp["missed"], "available": cp["available"],
                        "value": round(cp["value_each"] * (cp["missed"] + cp["available"])),
                        "windows": [{"due": w["due"], "deadline": w["deadline"], "status": w["status"]}
                                    for w in cp["windows"] if w["due"]],
                        "intent": None})
        out.sort(key=lambda c: (c["available"] == 0, -c["value"]))
        return jsonsafe({"found": True, "patient_id": patient_id,
                         "name": mask_name(p.get("full_name"), self.demo),
                         "amka": mask_amka(p.get("hio_code"), self.demo),
                         "coverage_start": None, "chains": out})

    # ── Εικόνα Πελάτη ───────────────────────────────────────────────────────────────────────
    async def advice_signature(self, amka: str | None = None, patient_id: str | None = None,
                               barcode: str | None = None, date_from: datetime | None = None,
                               date_to: datetime | None = None) -> tuple:
        """Φθηνή υπογραφή για την AI συμβουλή (ίδιο συμβόλαιο με την Ελλάδα): (ψευδώνυμο, None, sig_src).
        Το 2ο στοιχείο (ΑΜΚΑ) είναι ΠΑΝΤΑ None → η συμβουλή αποθηκεύεται ΑΝΑ ΦΑΡΜΑΚΕΙΟ, ποτέ στην
        καθολική βάση γνώσεων (στην Κύπρο δεν υπάρχει καθολικό κλειδί πελάτη — και δεν το θέλουμε).
        Κλινικές συνθήκες = οι θεραπευτικές ομάδες ATC (4 χαρακτήρες) των φαρμάκων που πήρε."""
        from app.services.cy import atc_link
        from app.services.cy.meds import key_of
        ref = await self.find_patient(amka=amka, patient_id=patient_id, barcode=barcode)
        if not ref:
            return None, None, None
        p = await CyPatientRepository(tenant_id=self.tenant_id).find_one({"pseudo_id": ref}) or {}
        q: dict = {"patient_ref": ref}
        if date_from or date_to:
            q["dispensed_at"] = {**({"$gte": date_from} if date_from else {}),
                                 **({"$lte": date_to} if date_to else {})}
        lk = await atc_link.lookup()
        groups: set = set()
        meds: set = set()
        for d in await self._disp().find(q, limit=500):
            for ln in d.get("lines") or []:
                if not ln.get("qty_disp"):
                    continue
                if info := lk.for_line(ln):
                    groups.add(info["atc"][:4])
                    meds.add(key_of(ln))
        _by, ag = _age_group(p.get("dob"))
        return ref, None, {"age": ag, "sex": _sex(p.get("gender")), "conditions": sorted(groups),
                           "medicines": sorted(meds), "g6pd": False}

    async def find_patient(self, *, amka: str | None = None, patient_id: str | None = None,
                           barcode: str | None = None) -> str | None:
        """Ταυτότητα / ARC / κωδικός ΟΑΥ (πεδίο `amka`) · αριθμός συνταγής ή εκτέλεσης (`barcode`) ·
        ψευδώνυμο (`patient_id`). Ο αριθμός ταυτότητας ΔΕΝ αποθηκεύεται: ψευδωνυμοποιείται με το ίδιο
        κλειδί του φαρμακείου και συγκρίνεται με το `id_ref` (ίδιος τρόπος με την πρόσκληση πύλης)."""
        pats = CyPatientRepository(tenant_id=self.tenant_id)
        if patient_id and await pats.find_one({"pseudo_id": patient_id}):
            return patient_id
        if barcode:
            bc = barcode.strip()
            d = await self._disp().find_one({"$or": [{"prescription_id": bc}, {"dispensing_id": bc}]})
            if d and d.get("patient_ref"):
                return d["patient_ref"]
        typed = re.sub(r"\s", "", amka or "")
        if not typed:
            return None
        p = await pats.find_one({"hio_code": {"$in": [typed, typed.lstrip("0")]}})
        if p:
            return p["pseudo_id"]
        from app.services.cy.parser import patient_key
        from app.services.vault_service import vault
        from app.utils.anonymization import pseudonymize
        pepper = vault.tenant_pepper(self.tenant_id)
        refs = [pseudonymize(patient_key("", t, typed), tenant_pepper=pepper) for t in ("NID", "ARC")]
        p = await pats.find_one({"id_ref": {"$in": refs}})
        if p:
            return p["pseudo_id"]
        d = await self._disp().find_one({"$or": [{"prescription_id": typed}, {"dispensing_id": typed}]})
        return (d or {}).get("patient_ref")

    async def patient_profile(self, amka: str | None = None, patient_id: str | None = None,
                              barcode: str | None = None, date_from: datetime | None = None,
                              date_to: datetime | None = None) -> dict:
        ref = await self.find_patient(amka=amka, patient_id=patient_id, barcode=barcode)
        if not ref:
            return {"found": False}
        p = await CyPatientRepository(tenant_id=self.tenant_id).find_one({"pseudo_id": ref})
        disp = await self._disp().find({"patient_ref": ref}, sort=[("dispensed_at", -1)], limit=500)
        today = datetime.now(tz=TZ).date()
        now = _now()
        tot = {k: sum((d.get("totals") or {}).get(k, 0) for d in disp) for k in ("total", "hio", "beneficiary")}
        cs = await ch.chains(self.tenant_id, today=today, match={"patient_ref": ref})

        missed = available = expected = executed = 0
        recoverable = 0.0
        missed_items, available_items = [], []
        for c in cs:
            if c["instances"] <= 1:
                continue
            cp = chain_positions(c, today)
            expected += cp["executed"] + cp["missed"]
            executed += cp["executed"]
            missed += cp["missed"]
            available += cp["available"]
            recoverable += cp["value_each"] * (cp["missed"] + cp["available"])
            if cp["missed"]:
                missed_items.append({"root": c["prescription_id"], "medicines": c["items"][:5], "count": cp["missed"],
                                     "value": round(cp["missed"] * cp["value_each"]), "last_executed": c["last_at"],
                                     "due": max(w["due"] for w in cp["windows"] if w["status"] == "missed")})
            if cp["available"]:
                w = next(w for w in cp["windows"] if w["status"] == "available")
                available_items.append({"root": c["prescription_id"], "medicines": c["items"][:5],
                                        "count": cp["available"], "value": round(cp["available"] * cp["value_each"]),
                                        "until": w["deadline"], "opens": w["due"], "last_executed": c["last_at"]})
        missed_items.sort(key=lambda x: x["value"], reverse=True)
        available_items.sort(key=lambda x: x["value"], reverse=True)
        compliance = round(executed / expected * 100) if expected else None
        open_due = [date.fromisoformat(c["next_due"]) for c in cs if c["status"] in ("soon", "upcoming", "late")]
        next_open = _day_dt(min(open_due)) if open_due else None

        def in_scope(d):
            t = _dt(d.get("dispensed_at"))
            return not ((date_from and t < date_from) or (date_to and t >= date_to))
        from app.services.cy.atc_link import lookup
        lk = await lookup()
        meds: dict = {}
        groups: dict[str, dict] = {}   # θεραπευτικές ομάδες (στη θέση των διαγνώσεων, που το ΓεΣΥ δεν δίνει)
        for d in disp:
            if not in_scope(d):
                continue
            for ln in d.get("lines") or []:
                if not ln.get("qty_disp") or not ln.get("description"):
                    continue
                info = lk.for_line(ln)
                m = meds.setdefault(ln["description"], {"name": ln["description"], "atc": (info or {}).get("atc"),
                                                         "substance": None, "times": 0, "value": 0, "last": None})
                if info:
                    path = info.get("cat_path") or []
                    if len(path) > 1:
                        title = path[1]
                    else:   # χωρίς κατηγορίες PharmacyOne → η ελληνική ονομασία της ομάδας ATC (ποτέ κενό)
                        from app.services.catalog_taxonomy import medicine_category
                        title = medicine_category(info["atc"])
                    g = groups.setdefault(info["atc"][:4], {"code": info["atc"][:4], "title": title, "times": 0})
                    g["times"] += 1
                m["times"] += 1
                m["value"] += (ln.get("amounts") or {}).get("total", 0)
                t = _dt(d.get("dispensed_at"))
                m["last"] = max(filter(None, [m["last"], t]))
        medicines = sorted(meds.values(), key=lambda m: -m["times"])
        for m in medicines:
            m["days_since"] = (now - m["last"]).days if m["last"] else None

        docs: Counter = Counter((d.get("doctor") or {}).get("name") for d in disp if (d.get("doctor") or {}).get("name"))
        executions = [{"kind": "rx", "barcode": d.get("dispensing_id") or d.get("prescription_id") or "",
                       "cy_id": d.get("_id"), "executed_at": d.get("dispensed_at"),
                       "amount_total": (d.get("totals") or {}).get("total", 0),
                       "patient_share": (d.get("totals") or {}).get("beneficiary", 0),
                       "doctor": (d.get("doctor") or {}).get("name"), "cancelled": False,
                       "medicines": [{"name": ln.get("description"), "quantity": ln.get("qty_disp")}
                                     for ln in d.get("lines") or [] if ln.get("qty_disp") and ln.get("description")]}
                      for d in disp]

        pats = await self._patients()
        ranked = sorted((x.get("rx_value_total", 0) for x in pats if x.get("rx_value_total", 0) > 0), reverse=True)
        mine = next((x for x in pats if x["_id"] == ref), {})
        total_pat = len(ranked)
        rank = sum(1 for v in ranked if v > mine.get("rx_value_total", 0)) + 1
        r = rank / total_pat if total_pat else 1
        tier = "platinum" if r <= 0.05 else "gold" if r <= 0.15 else "silver" if r <= 0.35 else "bronze"
        ls = mine.get("last_seen_at")
        ct = p.get("contact") or {}
        fy = now.year if now.month >= 9 else now.year - 1
        return jsonsafe({
            "found": True, "country": "CY",
            "patient": {"id": ref, "name": mask_name(p.get("full_name"), self.demo),
                        "amka": mask_amka(p.get("hio_code"), self.demo),
                        "age_group": mine.get("age_group"), "sex": mine.get("sex"), "area": None,
                        "birth_year": mine.get("birth_year"), "lifecycle": None,
                        "deceased": bool((p.get("deceased") or {}).get("at")),
                        "first_seen": mine.get("first_seen_at"), "last_seen": ls,
                        "gap_days": (now - ls).days if ls else None},
            "contact": {"mobile": None if self.demo else ct.get("mobile"), "phone": None,
                        "email": None if self.demo else ct.get("email"),
                        "consent": bool(ct.get("marketing_consent")), "active": True,
                        "has_contact": (not self.demo) and bool(ct.get("mobile") or ct.get("email"))},
            "financials": {"rx_count": len(disp), "value": tot["total"], "claimed": tot["hio"],
                           "paid": tot["beneficiary"], "profit": None,
                           "avg_per_visit": round(tot["total"] / len(disp)) if disp else 0},
            "vip": {"tier": tier, "rank": rank, "of": total_pat, "percentile": round((1 - r) * 100),
                    "value": mine.get("rx_value_total", 0)},
            "adherence": {"compliance": compliance,
                          "band": _band(compliance)[1] if compliance is not None else None,
                          "executed": executed, "expected": expected, "missed": missed,
                          "available": available, "lost_value": round(recoverable), "next_open": next_open},
            "missed_items": missed_items, "available_items": available_items,
            "flu": {"season": f"{fy}-{fy + 1}", "vaccinated": False, "date": None, "vaccine": None},
            "programs": [], "clinical": {"g6pd_deficiency": False},
            "segments": [{"key": s["key"], "label": s["label"]} for s in SEGMENTS
                         if any((m.get("atc") or "").startswith(tuple(s["atc"])) for m in medicines)
                         or (s["key"] == "diabetes" and cy_insights.is_diabetic(disp))],
            # ΘΕΡΑΠΕΥΤΙΚΕΣ ΟΜΑΔΕΣ (ATC 4 χαρ.) στη θέση των διαγνώσεων ICD-10 — το ΓεΣΥ δεν δίνει διαγνώσεις
            "conditions": sorted(groups.values(), key=lambda g: -g["times"])[:12],
            "conditions_kind": "therapy_groups",
            "medicines": medicines[:15],
            "doctors": [{"name": n, "specialty": None, "times": k} for n, k in docs.most_common(5)],
            "executions": executions,
        })
