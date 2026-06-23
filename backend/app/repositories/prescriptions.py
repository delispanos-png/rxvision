"""Prescription repository — tenant-scoped reads + analytics pipelines.

Pipelines here intentionally omit the leading {$match: tenant_id}; BaseRepository.aggregate
prepends it so isolation can never be forgotten.
"""

from __future__ import annotations

import calendar
import re
from collections import defaultdict
from datetime import datetime, timezone

from bson import ObjectId

from app.repositories.base import BaseRepository, jsonsafe
from app.utils.masking import mask_amka, mask_name

_GRAIN_FMT = {"day": "%Y-%m-%d", "month": "%Y-%m"}
_METRIC_FIELD = {"executions": None, "value": "$amount_total", "claimed": "$amount_claimed"}


def _oid(v):
    try:
        return v if isinstance(v, ObjectId) else ObjectId(str(v))
    except Exception:  # noqa: BLE001
        return None


class PrescriptionRepository(BaseRepository):
    collection_name = "prescription_executions"

    async def execution_detail(self, external_id: str) -> dict | None:
        """Full drill-down for one executed prescription: doctor + (anonymised) patient +
        fund + repeat info + ICD-10 + every medicine line (name/qty/retail/wholesale/margin)."""
        ex = await self._coll.find_one(self._scope({"external_id": external_id}))
        if not ex:
            return None
        db = self._db
        async def _get(coll, oid):
            o = _oid(oid)
            return await db[coll].find_one({"_id": o}) if o else None
        doctor = await _get("doctors", ex.get("doctor_id"))
        fund = await _get("insurance_funds", ex.get("fund_id"))
        patient = await _get("patients_anonymized", ex.get("patient_ref"))
        item_docs = await db["prescription_items"].find(
            {"tenant_id": self.tenant_id, "execution_id": ex["_id"]}).to_list(200)
        items = []
        for it in item_docs:
            prod = await db["products"].find_one({"_id": it.get("product_id")}) if it.get("product_id") else None
            prod = prod or {}
            # catalog is keyed by eofCode (== product.barcode); fall back to full-EAN barcode
            cat = None
            if prod.get("barcode"):
                cat = (await db["medicine_catalog"].find_one({"_id": prod["barcode"]})
                       or await db["medicine_catalog"].find_one({"barcode": prod["barcode"]}))
            cat = cat or {}
            retail = it.get("retail_price", 0)
            qty = it.get("quantity", 1)
            line_total = retail * qty
            participation = cat.get("participation")  # co-pay % (0/10/25…)
            # per-line split: what the patient pays vs what the fund reimburses
            pat_share = round(line_total * (participation or 0) / 100) if participation else 0
            items.append({
                "name": prod.get("name"), "barcode": prod.get("barcode"),
                "substance": cat.get("substance_name") or prod.get("substance"),
                "category": prod.get("category") or it.get("category") or "normal",
                "atc": cat.get("atc") or prod.get("atc"),
                "narcotic": bool(cat.get("narcotic")),
                "high_cost": bool(cat.get("high_cost")),
                "quantity": qty,
                "retail_price": retail,
                "wholesale_price": it.get("wholesale_price", 0),
                "margin": it.get("margin", (retail - it.get("wholesale_price", 0))),
                "participation": participation,
                "patient_share": pat_share,
                "fund_share": line_total - pat_share,
                "is_executed": it.get("is_executed", True),
                "details": it.get("details") or {},   # rich ΗΔΥΚΑ/CDA per-line detail (stored)
            })
        # ── Συνοπτικά: άθροισμα ΟΛΩΝ των εκτελέσεων αυτής της συνταγής (ίδιο barcode, κάθε :N
        # ξεχωριστή εκτέλεση) — σύνολο ποσότητας/αξίας ανά προϊόν, για το tab «Συνοπτικά».
        barcode = str(external_id).split(":")[0]
        sib_ids = [e["_id"] async for e in self._coll.find(
            self._scope({"external_id": {"$regex": "^" + barcode + "(:|$)"}}), {"_id": 1})]
        sib_items = await db["prescription_items"].find(
            {"tenant_id": self.tenant_id, "execution_id": {"$in": sib_ids}}).to_list(2000)
        pids = list({it.get("product_id") for it in sib_items if it.get("product_id")})
        pmap = {p["_id"]: p async for p in db["products"].find(
            {"_id": {"$in": pids}}, {"name": 1, "category": 1, "substance": 1})}
        agg: dict = {}
        for it in sib_items:
            pid = it.get("product_id")
            prod = pmap.get(pid) or {}
            g = agg.get(pid) or {"name": prod.get("name"),
                                 "category": prod.get("category") or it.get("category") or "normal",
                                 "substance": prod.get("substance"),
                                 "quantity": 0, "amount": 0, "executions": 0, "is_executed": False}
            q = it.get("quantity", 1) or 1
            g["quantity"] += q
            g["amount"] += (it.get("retail_price", 0) or 0) * q
            g["executions"] += 1
            g["is_executed"] = g["is_executed"] or bool(it.get("is_executed", True))
            agg[pid] = g
        summary = sorted(agg.values(), key=lambda x: -x["amount"])

        # ΠΛΗΡΩΤΕΟ ΑΠΟ ΤΑΜΕΙΟ = amount_claimed (fund reimburses); ΑΠΟ ΑΣΦ/ΝΟ = patient_share
        fund_payable = ex.get("amount_claimed", 0)
        patient_payable = ex.get("patient_share", 0)
        out = {
            "external_id": ex.get("external_id"), "executed_at": ex.get("executed_at"),
            "status": ex.get("status"), "source": ex.get("source"),
            "repeat_current": ex.get("repeat_current", 1), "repeat_total": ex.get("repeat_total", 1),
            "repeat_root": ex.get("repeat_root"), "next_open_date": ex.get("next_open_date"),
            "amount_total": ex.get("amount_total", 0), "amount_claimed": ex.get("amount_claimed", 0),
            "patient_share": ex.get("patient_share", 0), "wholesale_cost": ex.get("wholesale_cost", 0),
            "fund_payable": fund_payable, "patient_payable": patient_payable,
            "icd10": ex.get("icd10", []),
            "has_unexecuted_substances": ex.get("has_unexecuted_substances", False),
            "doctor": {"name": (doctor or {}).get("full_name"),
                       "specialty": (doctor or {}).get("specialty")} if doctor else None,
            "fund": {"name": (fund or {}).get("name"), "code": (fund or {}).get("code")} if fund else None,
            "patient": {"sex": (patient or {}).get("sex"), "birth_year": (patient or {}).get("birth_year"),
                        "area": (patient or {}).get("area"),
                        "full_name": mask_name((patient or {}).get("full_name"), self.demo),
                        "amka": mask_amka((patient or {}).get("amka"), self.demo)} if patient else None,
            "details": ex.get("details") or {},   # rich ΗΔΥΚΑ/CDA prescription-level detail (stored)
            "items": items,
            "summary": summary,                    # σύνολο όλων των εκτελέσεων της συνταγής
            "execution_count": len(sib_ids),
        }
        # ICD-10 με ελληνικό τίτλο (κωδικός — τίτλος) για την προβολή (γενικά + ανά γραμμή)
        codes = ex.get("icd10", []) or []
        if codes:
            titles = {d["_id"]: d.get("title_el") async for d in
                      self._db["icd10_codes"].find({"_id": {"$in": codes}}, {"title_el": 1})}
            out["icd10_named"] = [f"{c} — {titles[c]}" if titles.get(c) else c for c in codes]
        else:
            out["icd10_named"] = []
        return jsonsafe(out)

    async def repeats(self, external_id: str) -> dict:
        """Repeat-chain tree. Groups every execution sharing `repeat_root` (the first
        prescription's barcode); each distinct barcode = one repeat period, with its partial
        executions (:1,:2,…) nested.

        We project a recurring schedule (executed/available/lost/future) ONLY for a genuine
        multi-barcode chain whose cadence we can infer from the gaps between repeats. For a
        single barcode — even a repeat whose sibling barcodes were not synced yet, or one
        dispensed in several partial executions — we show ONLY what actually happened and
        flag `plan_incomplete`. (The old logic fabricated monthly slots from the validity
        window, which turned one-off prescriptions into phantom "2 of 2" chains.)"""
        this_bc = str(external_id).split(":")[0]
        ex = await self._coll.find_one(self._scope({"external_id": external_id}))
        root = (ex.get("repeat_root") if ex else None) or this_bc
        rows = [r async for r in self._coll.find(self._scope({"repeat_root": root}))]
        if not rows:  # fall back to same-barcode grouping (e.g. legacy rows without repeat_root)
            rows = [r async for r in self._coll.find(self._scope(
                {"external_id": {"$regex": "^" + this_bc}}))]

        by_bc: dict[str, list] = defaultdict(list)
        for r in rows:
            by_bc[str(r.get("external_id", "")).split(":")[0]].append(r)

        def repeat_of(parts: list) -> dict:
            parts = sorted(parts, key=lambda p: p.get("external_id", ""))
            dates = [p["executed_at"] for p in parts if p.get("executed_at")]
            # Σειρά (CDA 1.1.4.1) — authoritative position of this barcode in the chain.
            seqs = [int(p["repeat_current"]) for p in parts if p.get("repeat_current")]
            return {
                "barcode": str(parts[0].get("external_id", "")).split(":")[0],
                "seq": seqs[0] if seqs else 1,
                "executed_at": min(dates) if dates else None,
                "status": "executed" if all(p.get("status") == "executed" for p in parts) else "partial",
                "amount_total": sum(p.get("amount_total", 0) for p in parts),
                "icd10": parts[0].get("icd10", []),
                "parts": [{"external_id": p.get("external_id"), "executed_at": p.get("executed_at"),
                           "status": p.get("status"), "amount_total": p.get("amount_total", 0)} for p in parts],
            }

        periods = [r for r in (repeat_of(p) for p in by_bc.values()) if r["executed_at"]]
        periods.sort(key=lambda r: r["seq"])

        n_barcodes = len(by_bc)
        has_partials = any(len(p["parts"]) > 1 for p in periods)

        # Authoritative plan: πλήθος επαναλήψεων = CDA 1.1.4 (repeat_total)· κάθε barcode
        # τοποθετείται στη ΣΕΙΡΑ του (1.1.4.1). ΔΕΝ μαντεύουμε πλήθος/θέση από ημερομηνίες.
        plan_total = max((int(r.get("repeat_total") or 1) for r in rows), default=1)
        max_seq = max((p["seq"] for p in periods), default=1)
        total = max(plan_total, max_seq, 1)
        is_repeat = total > 1 or n_barcodes > 1 or root != this_bc

        now = datetime.now(tz=timezone.utc)

        def add_months(d: datetime, n: int) -> datetime:
            y, m = d.year + (d.month - 1 + n) // 12, (d.month - 1 + n) % 12 + 1
            return d.replace(year=y, month=m, day=min(d.day, calendar.monthrange(y, m)[1]))

        # interval (μήνες) ΜΟΝΟ για να προβάλουμε ημερομηνίες έναρξης κενών/μελλοντικών σειρών:
        # ρητές ΗΔΥΚΑ ενδείξεις (μηνιαία/δίμηνη) > inferred από σειρά-ζυγισμένα gaps > default 1.
        interval = None
        for r in rows:
            det = r.get("details") or {}
            if det.get("interval_months"):
                interval = int(det["interval_months"]); break
            if det.get("bimonthly"):
                interval = 2; break
            if det.get("monthly"):
                interval = 1; break
        if interval is None and len(periods) >= 2:
            rates = []
            for i in range(len(periods) - 1):
                dseq = periods[i + 1]["seq"] - periods[i]["seq"]
                dd = (periods[i + 1]["executed_at"] - periods[i]["executed_at"]).days
                if dseq > 0 and dd > 0:
                    rates.append(dd / dseq)
            if rates:
                rates.sort(); interval = max(1, round(rates[len(rates) // 2] / 30))
        if interval is None and is_repeat:
            interval = 1

        starts = [r["valid_from"] for r in rows if r.get("valid_from")]
        ends = [r["valid_until"] for r in rows if r.get("valid_until")]
        start = min(starts) if starts else (periods[0]["executed_at"] if periods else None)
        end = max(ends) if ends else (periods[-1]["executed_at"] if periods else None)

        # Ορίζοντας δεδομένων: η παλαιότερη εκτέλεση που έχουμε συγχρονίσει. Σειρές που η
        # προβλεπόμενη έναρξή τους προηγείται του ορίζοντα ΔΕΝ είναι «χαμένες» — απλώς δεν τις
        # κατεβάσαμε ποτέ (η αλυσίδα ξεκίνησε πριν την περίοδο συγχρονισμού) → τις παραλείπουμε.
        horizon_doc = await self._coll.find_one(self._scope({}), sort=[("executed_at", 1)],
                                                projection={"executed_at": 1})
        horizon = horizon_doc.get("executed_at") if horizon_doc else None

        # Ημερομηνία έναρξης ανά σειρά: εκτελεσμένες → πραγματική· κενές → προβολή με anchor
        # την πρώτη εκτελεσμένη σειρά (ευθυγραμμίζει τις προβλέψεις με τα πραγματικά δεδομένα).
        exec_by_seq = {p["seq"]: p for p in periods}
        anchor = periods[0] if periods else None

        def opening_for(seq: int) -> datetime | None:
            if anchor and anchor["executed_at"]:
                return add_months(anchor["executed_at"], (seq - anchor["seq"]) * (interval or 1))
            return add_months(start, (seq - 1) * (interval or 1)) if start else None

        slots: list[dict] = []
        for seq in range(1, total + 1):
            r = exec_by_seq.get(seq)
            opening = r["executed_at"] if r else opening_for(seq)
            if not r and horizon and opening and opening < horizon:
                continue  # προηγείται του ορίζοντα συγχρονισμού — δεν τη φαμπρικάρουμε ως χαμένη
            if r:
                state = "executed"
            else:
                win_end = add_months(opening, interval or 1) if opening else None
                state = ("lost" if win_end and win_end <= now
                         else "available" if opening and opening <= now else "future")
            slots.append({"index": seq - 1, "opening": opening, "state": state, "repeat": r})

        return jsonsafe({
            "root": root,
            "is_chain": is_repeat or has_partials,
            # Το πλήρες πλάνο είναι πλέον authoritative από το CDA (1.1.4 + σειρά)· δεν χρειάζεται
            # «θα συμπληρωθεί με sync». Κενές σειρές εντός ορίζοντα = πραγματικά χαμένες (recall).
            "plan_incomplete": False,
            "interval_months": interval,
            "total": total,
            "executed_count": sum(1 for s in slots if s["state"] == "executed"),
            "lost_count": sum(1 for s in slots if s["state"] == "lost"),
            "valid_from": start, "valid_until": end, "slots": slots,
        })

    _LIST_SORTS = {"executed_at", "amount_total", "amount_claimed", "external_id"}

    async def list_executions(self, query: dict, skip: int, limit: int,
                              sort: str = "executed_at", direction: int = -1) -> list[dict]:
        """Executions list enriched like the ΗΔΥΚΑ portal: patient name/AMKA, fund,
        status + execution case, ICD-10 and amounts. Server-side sort over the WHOLE set."""
        sort_field = sort if sort in self._LIST_SORTS else "executed_at"
        pipeline = [
            {"$match": query},
            {"$sort": {sort_field: 1 if direction >= 0 else -1, "_id": 1}},
            {"$skip": skip},
            {"$limit": limit},
            {"$lookup": {"from": "patients_anonymized", "localField": "patient_ref",
                         "foreignField": "_id", "as": "p"}},
            {"$lookup": {"from": "insurance_funds", "localField": "fund_id",
                         "foreignField": "_id", "as": "f"}},
            {"$set": {"patient_name": {"$first": "$p.full_name"},
                      "amka": {"$first": "$p.amka"},
                      "fund_name": {"$first": "$f.name"},
                      "fund_code": {"$first": "$f.code"}}},
            {"$project": {"_id": 0, "external_id": 1, "executed_at": 1, "source": 1,
                          "icd10": 1, "amount_total": 1, "amount_claimed": 1,
                          "patient_share": 1,            # Αιτούμενο/πληρωτέο από ασφαλισμένο
                          "status": 1, "has_unexecuted_substances": 1,
                          "chronic": {"$ifNull": ["$details.chronic", False]},
                          "patient_name": 1, "amka": 1, "fund_name": 1, "fund_code": 1}},
        ]
        rows = await self.aggregate(pipeline)
        from app.core.db import shared_db
        # general fund name (group, π.χ. ΕΟΠΥΥ) for the LIST — the specific fund stays in the detail.
        cfg = await shared_db()["fund_groups"].find().to_list(length=None)
        code2group = {c: g["name"] for g in cfg for c in g.get("codes", [])}
        # ICD-10 with Greek titles (code — τίτλος) for the list
        codes = {c for r in rows for c in (r.get("icd10") or [])}
        titles = {d["_id"]: d.get("title_el") async for d in
                  shared_db()["icd10_codes"].find({"_id": {"$in": list(codes)}}, {"title_el": 1})}
        for r in rows:
            r["fund_general"] = code2group.get(r.get("fund_code")) or r.get("fund_name")
            r["icd10_named"] = [f"{c} — {titles[c]}" if titles.get(c) else c
                                for c in (r.get("icd10") or [])]
            r["patient_name"] = mask_name(r.get("patient_name"), self.demo)
            r["amka"] = mask_amka(r.get("amka"), self.demo)
        return rows

    async def find_patient_refs(self, amka: str | None = None, name: str | None = None) -> list:
        """Patient _ids (tenant-scoped) matching ΑΜΚΑ (prefix) ή/και όνομα (case-insensitive,
        διακριτικά-agnostic) — για φιλτράρισμα εκτελέσεων ανά ασθενή."""
        q: dict = {"tenant_id": self.tenant_id}
        if amka and amka.strip():
            q["amka"] = {"$regex": "^" + re.escape(amka.strip())}
        if name and name.strip():
            q["full_name"] = {"$regex": re.escape(name.strip()), "$options": "i"}
        if len(q) == 1:  # κανένα κριτήριο
            return []
        return [p["_id"] async for p in
                self._db["patients_anonymized"].find(q, {"_id": 1})]

    # Χαρακτηριστικά συνταγής (πεδία details) για ανάλυση «ανά είδος».
    _BREAKDOWN_FLAGS = ["chronic", "high_cost", "narcotic", "antibiotic", "special_antibiotic",
                        "n3816", "ifet", "ifet_import", "heparin", "vaccines", "desensitization",
                        "single_dose", "by_brand", "ekas", "eopyy_only", "hospital_only",
                        "eopyy_preapproval", "outside_eopyy", "negative_list", "home_delivery",
                        "intangible", "consumables", "supplementary_cover"]

    async def characteristics_breakdown(self, date_from: datetime, date_to: datetime) -> dict:
        """Πλήθος + αξία εκτελέσεων ανά χαρακτηριστικό συνταγής για την περίοδο (ένα pass)."""
        group: dict = {"_id": None, "total": {"$sum": 1}, "value": {"$sum": "$amount_total"}}
        for f in self._BREAKDOWN_FLAGS:
            cond = {"$eq": [f"$details.{f}", True]}
            group[f] = {"$sum": {"$cond": [cond, 1, 0]}}
            group[f"{f}__v"] = {"$sum": {"$cond": [cond, "$amount_total", 0]}}
        # διάρκεια + επαναληψιμότητα
        specials = {
            "monthly": {"$eq": ["$details.interval_months", 1]},
            "bimonthly": {"$eq": ["$details.interval_months", 2]},
            "repeat": {"$gt": ["$repeat_total", 1]},
            "simple": {"$lte": ["$repeat_total", 1]},
            "r3": {"$eq": ["$repeat_total", 3]}, "r4": {"$eq": ["$repeat_total", 4]},
            "r5": {"$eq": ["$repeat_total", 5]}, "r6": {"$eq": ["$repeat_total", 6]},
        }
        for k, cond in specials.items():
            group[k] = {"$sum": {"$cond": [cond, 1, 0]}}
            group[f"{k}__v"] = {"$sum": {"$cond": [cond, "$amount_total", 0]}}
        rows = await self.aggregate([
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}, "status": {"$ne": "cancelled"}}},
            {"$group": group}])
        raw = rows[0] if rows else {}
        items = {k: {"count": int(raw.get(k, 0) or 0), "value": int(raw.get(f"{k}__v", 0) or 0)}
                 for k in (self._BREAKDOWN_FLAGS + list(specials))}
        # ΓΑΛΗΝΙΚΑ: not an execution flag — it's a prescription_item category. Count DISTINCT
        # executions that contain a γαληνικό line (+ their retail value) over the same period.
        gal = await self._db["prescription_items"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "category": "galenic", "cancelled": {"$ne": True},
                        "executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {"_id": "$execution_id", "v": {"$sum": "$retail_price"}}},
            {"$group": {"_id": None, "count": {"$sum": 1}, "value": {"$sum": "$v"}}},
        ]).to_list(length=None)
        g = gal[0] if gal else {}
        items["galenic"] = {"count": int(g.get("count", 0) or 0), "value": int(g.get("value", 0) or 0)}
        return {"total": int(raw.get("total", 0) or 0), "value": int(raw.get("value", 0) or 0),
                "items": items}

    async def galenic_exec_ids(self, date_from: datetime, date_to: datetime) -> list:
        """Execution _ids that contain a γαληνικό line in the period (for the «Γαληνικά» filter)."""
        rows = await self._db["prescription_items"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "category": "galenic", "cancelled": {"$ne": True},
                        "executed_at": {"$gte": date_from, "$lt": date_to}}},
            {"$group": {"_id": "$execution_id"}},
        ]).to_list(length=None)
        return [r["_id"] for r in rows]

    async def by_fund(self, date_from: datetime, date_to: datetime) -> list[dict]:
        """Per-fund breakdown for the period (rx/value/claimed/unexecuted), folded into
        the central fund GROUPS (ΗΔΥΚΑ code → group). Funds with no group stay as
        themselves; grouped funds are summed. Each row carries its member `funds`."""
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}, "status": {"$ne": "cancelled"}}},
            {"$group": {"_id": "$fund_id",
                        "rx": {"$sum": 1},
                        "value": {"$sum": "$amount_total"},
                        "claimed": {"$sum": "$amount_claimed"},
                        "unexecuted": {"$sum": {"$cond": ["$has_unexecuted_substances", 1, 0]}}}},
            {"$lookup": {"from": "insurance_funds", "localField": "_id",
                         "foreignField": "_id", "as": "f"}},
            {"$set": {"fund_name": {"$ifNull": [{"$first": "$f.name"}, "— (χωρίς ταμείο)"]},
                      "code": {"$first": "$f.code"}}},
            {"$project": {"_id": 0, "fund_name": 1, "code": 1, "rx": 1, "value": 1,
                          "claimed": 1, "unexecuted": 1}},
        ]
        funds = await self.aggregate(pipeline)

        from app.core.db import shared_db
        cfg = await shared_db()["fund_groups"].find().to_list(length=None)
        code2group = {c: g["name"] for g in cfg for c in g.get("codes", [])}

        groups: dict[str, dict] = {}
        for f in funds:
            gname = code2group.get(f.get("code")) or f["fund_name"]
            g = groups.get(gname)
            if g is None:
                g = groups[gname] = {"fund_name": gname, "rx": 0, "value": 0,
                                     "claimed": 0, "unexecuted": 0, "funds": []}
            g["rx"] += f["rx"]
            g["value"] += f["value"]
            g["claimed"] += f["claimed"]
            g["unexecuted"] += f["unexecuted"]
            g["funds"].append({k: f.get(k) for k in
                               ("fund_name", "rx", "value", "claimed", "unexecuted")})
        for g in groups.values():
            g["is_group"] = len(g["funds"]) > 1
        return sorted(groups.values(), key=lambda x: -x["value"])

    async def delete_range(self, date_from: datetime, date_to: datetime) -> dict:
        """Hard-delete all executions (+ their items + derived future prescriptions) whose
        executed_at falls in [date_from, date_to). Tenant-scoped. Destructive — used by the
        Settings 'delete a period' action so the operator can re-ingest cleanly."""
        q = {"executed_at": {"$gte": date_from, "$lt": date_to}}
        ids = [e["_id"] async for e in self._coll.find(self._scope(q), {"_id": 1})]
        db = self._db
        fut = await db["future_prescriptions"].delete_many(
            {"tenant_id": self.tenant_id, "source_execution_id": {"$in": ids}})
        items = await db["prescription_items"].delete_many(
            {"tenant_id": self.tenant_id, "executed_at": {"$gte": date_from, "$lt": date_to}})
        execs = await self._coll.delete_many(self._scope(q))
        return {"executions": execs.deleted_count, "items": items.deleted_count,
                "future": fut.deleted_count}

    async def dashboard_summary(self, date_from: datetime, date_to: datetime) -> dict:
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}, "status": {"$ne": "cancelled"}}},
            {"$group": {
                "_id": None,
                "executions": {"$sum": 1},
                "value": {"$sum": "$amount_total"},
                "claimed": {"$sum": "$amount_claimed"},
                "cost": {"$sum": "$wholesale_cost"},
                "patients": {"$addToSet": "$patient_ref"},
            }},
            {"$project": {
                "_id": 0, "executions": 1, "value": 1, "claimed": 1,
                # gross margin = retail − wholesale (the pharmacy collects full retail
                # from patient+fund); NOT claimed−cost (claimed is only the fund share).
                "gross_profit": {"$subtract": ["$value", "$cost"]},
                "patient_count": {"$size": "$patients"},
            }},
        ]
        rows = await self.aggregate(pipeline)
        return rows[0] if rows else {
            "executions": 0, "value": 0, "claimed": 0, "gross_profit": 0, "patient_count": 0,
        }

    async def timeseries(self, *, metric: str, grain: str, date_from: datetime,
                         date_to: datetime) -> list[dict]:
        field = _METRIC_FIELD[metric]
        agg = {"$sum": 1} if field is None else {"$sum": field}
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}, "status": {"$ne": "cancelled"}}},
            {"$group": {
                "_id": {"$dateToString": {"format": _GRAIN_FMT[grain],
                                          "date": "$executed_at", "timezone": "Europe/Athens"}},
                "value": agg,
            }},
            {"$sort": {"_id": 1}},
            {"$project": {"_id": 0, "bucket": "$_id", "value": 1}},
        ]
        return await self.aggregate(pipeline)

    async def hourly_heatmap(self, *, metric: str, date_from: datetime,
                             date_to: datetime) -> list[dict]:
        """Executions (or value/claimed) bucketed by ISO weekday (1=Mon..7=Sun) × hour
        (0-23), in Europe/Athens local time — the pharmacy "busy hours" matrix."""
        field = _METRIC_FIELD[metric]
        agg = {"$sum": 1} if field is None else {"$sum": field}
        tz = {"timezone": "Europe/Athens"}
        pipeline = [
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}, "status": {"$ne": "cancelled"}}},
            {"$group": {
                "_id": {
                    "dow": {"$isoDayOfWeek": {"date": "$executed_at", **tz}},
                    "hour": {"$hour": {"date": "$executed_at", **tz}},
                },
                "value": agg,
            }},
            {"$sort": {"_id.dow": 1, "_id.hour": 1}},
            {"$project": {"_id": 0, "dow": "$_id.dow", "hour": "$_id.hour", "value": 1}},
        ]
        return await self.aggregate(pipeline)

    async def top(self, *, dim: str, limit: int, date_from: datetime,
                  date_to: datetime) -> list[dict]:
        match = {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}, "status": {"$ne": "cancelled"}}}
        if dim == "icd10":
            pipeline = [match, {"$unwind": "$icd10"},
                        {"$group": {"_id": "$icd10", "rx": {"$sum": 1},
                                    "value": {"$sum": "$amount_total"}}},
                        {"$sort": {"rx": -1}}, {"$limit": limit},
                        {"$lookup": {"from": "icd10_codes", "localField": "_id",
                                     "foreignField": "_id", "as": "c"}},
                        {"$set": {"name": {"$first": "$c.title_el"}}},
                        {"$project": {"c": 0}}]
        elif dim == "doctors":
            pipeline = [match,
                        {"$group": {"_id": "$doctor_id", "rx": {"$sum": 1},
                                    "value": {"$sum": "$amount_total"}}},
                        {"$sort": {"value": -1}}, {"$limit": limit},
                        {"$lookup": {"from": "doctors", "localField": "_id",
                                     "foreignField": "_id", "as": "d"}},
                        {"$set": {"name": {"$first": "$d.full_name"}}},
                        {"$project": {"d": 0}}]
        else:  # products — aggregate from items
            return await self._top_products(limit, date_from, date_to)
        return await self.aggregate(pipeline)

    async def _top_products(self, limit, date_from, date_to) -> list[dict]:
        items = BaseRepository(tenant_id=self.tenant_id)
        items.collection_name = "prescription_items"
        return await items.aggregate([
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to}, "is_executed": True}},
            {"$group": {"_id": "$product_id", "qty": {"$sum": "$quantity"}}},
            {"$sort": {"qty": -1}}, {"$limit": limit},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.name"}}}, {"$project": {"p": 0}},
        ])

    async def unexecuted_substances(self, *, date_from: datetime, date_to: datetime,
                                    limit: int = 50) -> dict:
        """Concept doc §9 — ανεκτέλεστες δραστικές: prescription lines that were NOT
        dispensed (is_executed=False), grouped by product, with lost retail value."""
        items = BaseRepository(tenant_id=self.tenant_id)
        items.collection_name = "prescription_items"
        rows = await items.aggregate([
            {"$match": {"executed_at": {"$gte": date_from, "$lt": date_to},
                        "is_executed": False}},
            # which prescription each unexecuted line came from (barcode + patient + date)
            {"$lookup": {"from": "prescription_executions", "localField": "execution_id",
                         "foreignField": "_id", "as": "ex"}},
            {"$set": {"ex": {"$first": "$ex"}}},
            {"$lookup": {"from": "patients_anonymized", "localField": "ex.patient_ref",
                         "foreignField": "_id", "as": "pt"}},
            {"$set": {"rx": {"barcode": "$ex.external_id",
                             "patient": {"$first": "$pt.full_name"},
                             "date": "$ex.executed_at"}}},
            {"$group": {"_id": "$product_id",
                        "occurrences": {"$sum": 1},
                        "qty": {"$sum": "$quantity"},
                        "lost_value": {"$sum": "$retail_price"},
                        "category": {"$first": "$category"},
                        "barcodes": {"$addToSet": "$ex.external_id"},
                        "rxs": {"$addToSet": "$rx"}}},
            {"$sort": {"occurrences": -1}}, {"$limit": limit},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$set": {"name": {"$first": "$p.name"}}},
            {"$project": {"_id": 0, "product_id": "$_id",
                          "occurrences": 1, "qty": 1, "lost_value": 1,
                          "category": 1, "name": 1, "barcodes": 1, "rxs": 1}},
        ])
        return {
            "items": rows,
            "total_occurrences": sum(r["occurrences"] for r in rows),
            "total_lost_value": sum(r["lost_value"] for r in rows),
        }
