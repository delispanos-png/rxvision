"""PharmaCat Clinical Assistant repository — orchestrates the CDSS service, enriches drug
suggestions with REAL products from our medicine catalogue (price/margin), and records every
case + audit trail (legal safety). Aggregates daily AI insights.

Case + audit collections are tenant-scoped (BaseRepository). The medicine catalogue is a shared
platform reference (like fund_groups) — read with an explicit `# tenant-ok` marker.
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timezone

from app.repositories.base import BaseRepository, jsonsafe
from app.services import pharmacat_service


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


class PharmaCatRepository(BaseRepository):
    collection_name = "pharmacat_cases"

    # ── product recommendation (section 16): map a suggested substance → our catalogue ──────
    async def products_for(self, substances: list[dict]) -> list[dict]:
        out: list[dict] = []
        seen: set[str] = set()
        for s in substances[:6]:
            term = (s.get("name") or "").strip()
            atc = (s.get("atc") or "").strip()
            if not term and not atc:
                continue
            ors: list[dict] = []
            if term:
                # match on the substance name (first significant word is enough for Greek INNs)
                word = re.escape(term.split()[0]) if term.split() else re.escape(term)
                ors += [{"substance_name": {"$regex": word, "$options": "i"}},
                        {"active_substances": {"$regex": word, "$options": "i"}}]
            if atc:
                ors.append({"atc": {"$regex": f"^{re.escape(atc)}", "$options": "i"}})
            rows = await self._db["medicine_catalog"].find(  # tenant-ok: shared platform catalogue
                {"$or": ors}).sort("retail_cents", -1).limit(4).to_list(8)
            prods = []
            for r in rows:
                if r["_id"] in seen:
                    continue
                seen.add(r["_id"])
                retail = r.get("retail_cents") or 0
                whole = r.get("wholesale_cents") or 0
                prods.append({
                    "name": r.get("name"), "barcode": r.get("barcode"), "atc": r.get("atc"),
                    "retail": retail, "wholesale": whole, "margin": max(retail - whole, 0),
                    "narcotic": bool(r.get("narcotic")), "category": r.get("drug_category")})
            if prods:
                out.append({"substance": term or atc, "products": prods})
        return out

    async def chat(self, ctx_user: str, messages: list[dict], context: dict | None = None) -> dict:
        res = await pharmacat_service.ask(messages, context)
        if not res.get("ok"):
            return res
        res["products"] = await self.products_for(res.get("substances") or [])
        await self._record(ctx_user, messages, context, res, kind="chat")
        return jsonsafe(res)

    async def interactions(self, ctx_user: str, drugs: list[str], context: dict | None = None) -> dict:
        drugs = [d.strip() for d in drugs if d and d.strip()]
        if len(drugs) < 1:
            return {"ok": False, "error": "no_drugs"}
        prompt = ("Έλεγξε αλληλεπιδράσεις (Drug-Drug, Drug-Food, Drug-Alcohol, Drug-Disease) για τον "
                  "συνδυασμό: " + ", ".join(drugs) + ". Δώσε βαρύτητα, μηχανισμό, κίνδυνο, ενέργεια και "
                  "ασφαλέστερες εναλλακτικές. Εντόπισε και διπλές δραστικές / θεραπευτικές κατηγορίες.")
        res = await pharmacat_service.ask([{"role": "user", "content": prompt}], context)
        if not res.get("ok"):
            return res
        await self._record(ctx_user, [{"role": "user", "content": prompt}], context, res,
                           kind="interaction", drugs=drugs)
        return jsonsafe(res)

    async def _record(self, user: str, messages: list[dict], context: dict | None,
                      res: dict, *, kind: str, drugs: list[str] | None = None) -> None:
        symptom = next((m["content"] for m in messages if m["role"] == "user"), "")
        doc = {
            "tenant_id": self.tenant_id, "user_id": user, "kind": kind, "at": _now(),
            "symptom": symptom[:500], "context": context or {}, "drugs": drugs or [],
            "stage": res.get("stage"),
            "red_flags": [f.get("flag") for f in res.get("red_flags") or []],
            "otc_categories": res.get("otc_categories") or [],
            "substances": [s.get("name") for s in res.get("substances") or []],
            "interaction_severities": [i.get("severity") for i in res.get("interactions") or []],
            "referral": (res.get("referral") or {}).get("urgency"),
            "reply": (res.get("reply") or "")[:2000],
        }
        await self._coll.insert_one(doc)  # case = audit trail (section 18/19)

    async def cases(self, limit: int = 40) -> dict:
        rows = [c async for c in self._coll.find({"tenant_id": self.tenant_id})
                .sort("at", -1).limit(min(limit, 100))]
        return jsonsafe({"items": [{
            "id": str(c["_id"]), "kind": c.get("kind"), "at": c.get("at"),
            "symptom": c.get("symptom"), "stage": c.get("stage"),
            "red_flags": c.get("red_flags", []), "substances": c.get("substances", []),
            "referral": c.get("referral"), "user_id": c.get("user_id"),
        } for c in rows]})

    async def insights(self) -> dict:
        rows = [c async for c in self._coll.find({"tenant_id": self.tenant_id})
                .sort("at", -1).limit(1000)]
        symptoms: Counter = Counter()
        otc: Counter = Counter()
        subs: Counter = Counter()
        sev: Counter = Counter()
        referrals = 0
        red = 0
        for c in rows:
            if c.get("symptom"):
                symptoms[c["symptom"][:60]] += 1
            for o in c.get("otc_categories", []):
                otc[o] += 1
            for s in c.get("substances", []):
                subs[s] += 1
            for sv in c.get("interaction_severities", []):
                sev[sv] += 1
            if c.get("referral") and c["referral"] != "none":
                referrals += 1
            if c.get("red_flags"):
                red += 1

        def top(counter: Counter, n: int = 8) -> list[dict]:
            return [{"label": k, "count": v} for k, v in counter.most_common(n)]

        return jsonsafe({
            "total": len(rows), "referrals": referrals, "red_flags": red,
            "top_symptoms": top(symptoms), "top_otc": top(otc),
            "top_substances": top(subs), "severities": top(sev, 4)})

    async def status(self) -> dict:
        return await pharmacat_service.status()
