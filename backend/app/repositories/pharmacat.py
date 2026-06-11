"""PharmaCat Clinical Assistant repository — orchestrates the CDSS service, enriches drug
suggestions with REAL products from our medicine catalogue (price/margin), and records every
case + audit trail (legal safety). Aggregates daily AI insights.

Case + audit collections are tenant-scoped (BaseRepository). The medicine catalogue is a shared
platform reference (like fund_groups) — read with an explicit `# tenant-ok` marker.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter
from datetime import datetime, timezone

from app.repositories.base import BaseRepository, jsonsafe
from app.services import pharmacat_service

# New (non-cached) LLM queries allowed per pharmacy per day. Cache hits are FREE and uncounted.
DAILY_LIMIT = 50


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _sig(messages: list[dict], context: dict | None) -> str:
    """Stable signature of a query (accent/case/punctuation-insensitive) → cache key. The clinical
    knowledge is generic (no patient PII), so the cache is shared platform-wide for max hit rate."""
    parts = [f"{m.get('role')}:{m.get('content', '')}" for m in messages]
    if context:
        parts.append("ctx:" + "|".join(f"{k}={context[k]}" for k in sorted(context)))
    text = unicodedata.normalize("NFKD", " || ".join(parts))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    text = re.sub(r"[^\w ]", " ", text, flags=re.UNICODE)
    return hashlib.sha256(re.sub(r"\s+", " ", text).strip().encode("utf-8")).hexdigest()


class PharmaCatRepository(BaseRepository):
    collection_name = "pharmacat_cases"

    # ── product recommendation (section 16): suggested substance → real market products (NAMES only).
    # We address a PHARMACIST, not an end consumer — NO price/margin (they see prices in their own
    # system) and NO stock (we don't receive the pharmacy's availability). Just the commercial names.
    async def products_for(self, substances: list[dict]) -> list[dict]:
        out: list[dict] = []
        seen_names: set[str] = set()
        for s in substances[:6]:
            term = (s.get("name") or "").strip()
            atc = (s.get("atc") or "").strip()
            if not term and not atc:
                continue
            ors: list[dict] = []
            if atc:  # ATC is the precise match
                ors.append({"atc": {"$regex": f"^{re.escape(atc)}", "$options": "i"}})
            if term:
                word = re.escape(term.split()[0]) if term.split() else re.escape(term)
                ors += [{"substance_name": {"$regex": word, "$options": "i"}},
                        {"active_substances": {"$regex": word, "$options": "i"}}]
            rows = await self._db["medicine_catalog"].find(  # tenant-ok: shared platform catalogue
                {"$or": ors}).limit(60).to_list(60)
            names = []
            for r in rows:
                nm = (r.get("full_name") or r.get("name") or "").strip()  # full name w/ strength/form
                key = nm.lower()
                if not nm or key in seen_names:
                    continue
                seen_names.add(key)
                names.append({"name": nm, "narcotic": bool(r.get("narcotic")), "eof": r.get("_id")})
                if len(names) >= 8:
                    break
            if names:
                out.append({"substance": term or atc, "products": names})
        return out

    async def medicine(self, eof: str) -> dict:
        """Full ΗΔΙΚΑ catalogue info for one medicine (clicked from a recommendation)."""
        d = await self._db["medicine_catalog"].find_one({"_id": eof})  # tenant-ok: shared catalogue
        if not d:
            return {"ok": False}
        return jsonsafe({
            "ok": True, "eof": d.get("_id"),
            "full_name": d.get("full_name") or d.get("name"), "name": d.get("name"),
            "substance": d.get("substance_name"), "atc": d.get("atc"),
            "content": d.get("content"), "form_code": d.get("form_code"),
            "package_form": d.get("package_form"), "barcode": d.get("barcode"),
            "retail_cents": d.get("retail_cents"), "wholesale_cents": d.get("wholesale_cents"),
            "reference_cents": d.get("reference_cents"), "participation": d.get("participation"),
            "narcotic": bool(d.get("narcotic")), "high_cost": bool(d.get("high_cost")),
            "category": d.get("drug_category")})

    async def _today_llm_count(self) -> int:
        day0 = _now().replace(hour=0, minute=0, second=0, microsecond=0)
        return await self._coll.count_documents(
            {"tenant_id": self.tenant_id, "source": "llm", "at": {"$gte": day0}})

    async def _cached_ask(self, user: str, messages: list[dict], context: dict | None,
                          *, kind: str, drugs: list[str] | None = None) -> dict:
        sig = _sig(messages, context)
        kb = self._db["pharmacat_knowledge"]  # tenant-ok: shared clinical KB (generic, no patient PII)
        hit = await kb.find_one({"sig": sig})
        if hit:  # FREE, instant — serve from our growing knowledge base
            await kb.update_one({"sig": sig}, {"$inc": {"hits": 1}, "$set": {"last_at": _now()}})
            res = dict(hit["result"])
            res["ok"] = True
            res["source"] = "cache"
            res["products"] = await self.products_for(res.get("substances") or [])
            await self._record(user, messages, context, res, kind=kind, drugs=drugs, source="cache")
            return jsonsafe(res)
        if await self._today_llm_count() >= DAILY_LIMIT:
            return {"ok": False, "error": "daily_limit", "limit": DAILY_LIMIT}
        res = await pharmacat_service.ask(messages, context)
        if not res.get("ok"):
            return res
        store = {k: v for k, v in res.items() if k != "ok"}  # products re-matched fresh each serve
        await kb.update_one({"sig": sig}, {"$set": {"sig": sig, "result": store, "last_at": _now()},
                                           "$setOnInsert": {"created_at": _now(), "hits": 0}}, upsert=True)
        res["source"] = "llm"
        res["products"] = await self.products_for(res.get("substances") or [])
        await self._record(user, messages, context, res, kind=kind, drugs=drugs, source="llm")
        return jsonsafe(res)

    async def chat(self, ctx_user: str, messages: list[dict], context: dict | None = None) -> dict:
        return await self._cached_ask(ctx_user, messages, context, kind="chat")

    async def interactions(self, ctx_user: str, drugs: list[str], context: dict | None = None) -> dict:
        drugs = [d.strip() for d in drugs if d and d.strip()]
        if len(drugs) < 1:
            return {"ok": False, "error": "no_drugs"}
        prompt = ("Έλεγξε αλληλεπιδράσεις (Drug-Drug, Drug-Food, Drug-Alcohol, Drug-Disease) για τον "
                  "συνδυασμό: " + ", ".join(drugs) + ". Δώσε βαρύτητα, μηχανισμό, κίνδυνο, ενέργεια και "
                  "ασφαλέστερες εναλλακτικές. Εντόπισε και διπλές δραστικές / θεραπευτικές κατηγορίες.")
        return await self._cached_ask(ctx_user, [{"role": "user", "content": prompt}], context,
                                      kind="interaction", drugs=drugs)

    async def _record(self, user: str, messages: list[dict], context: dict | None,
                      res: dict, *, kind: str, drugs: list[str] | None = None,
                      source: str = "llm") -> None:
        symptom = next((m["content"] for m in messages if m["role"] == "user"), "")
        doc = {
            "tenant_id": self.tenant_id, "user_id": user, "kind": kind, "at": _now(),
            "source": source,
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

        cache_hits = sum(1 for c in rows if c.get("source") == "cache")
        llm_calls = sum(1 for c in rows if c.get("source") == "llm")
        kb_size = await self._db["pharmacat_knowledge"].count_documents({})  # tenant-ok: shared KB stat
        return jsonsafe({
            "total": len(rows), "referrals": referrals, "red_flags": red,
            "cache_hits": cache_hits, "llm_calls": llm_calls, "kb_size": kb_size,
            "top_symptoms": top(symptoms), "top_otc": top(otc),
            "top_substances": top(subs), "severities": top(sev, 4)})

    async def status(self) -> dict:
        s = await pharmacat_service.status()
        s["today_used"] = await self._today_llm_count()
        s["daily_limit"] = DAILY_LIMIT
        return s
