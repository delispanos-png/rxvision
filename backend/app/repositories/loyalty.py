"""Customer loyalty — rewards chronic patients for ADHERENCE to their repeat prescriptions.

The gauge is the repeat-chain compliance already computed by Patient Intelligence: every on-time
refill earns points (deterministic, derived from immutable execution history), points convert to a
€ wallet the patient spends at the counter (services / παραφάρμακα). Redemptions + manual
adjustments are the only stored events (`loyalty_ledger`); earnings are always recomputed from
history so there is no double-award risk.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

from bson import ObjectId

from app.repositories.base import BaseRepository, jsonsafe
from app.repositories.patient_intelligence import PatientIntelligenceRepository


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


DEFAULT_CONFIG = {
    "enabled": False,
    "points_per_refill": 10,     # points earned per on-time repeat refill
    "cents_per_point": 5,        # € value of one point (cents) → 10pts = 0.50€
    "min_redeem_cents": 100,     # smallest redemption (1.00€)
    "welcome_cents": 0,          # optional signup credit (cents) — applied as an adjust on first read
}

# lifetime-points tiers (the «πιστότητα» ladder)
TIERS = [(0, "Bronze"), (400, "Silver"), (1000, "Gold"), (2500, "Platinum")]

DEFAULT_TERMS = (
    "ΟΡΟΙ ΣΥΜΜΕΤΟΧΗΣ ΣΤΟ ΠΡΟΓΡΑΜΜΑ ΕΠΙΒΡΑΒΕΥΣΗΣ\n\n"
    "1. Η συμμετοχή είναι προαιρετική και δωρεάν.\n"
    "2. Πόντοι συγκεντρώνονται με τη συνεπή εκτέλεση των επαναλαμβανόμενων συνταγών σας.\n"
    "3. Οι πόντοι εξαργυρώνονται σε προϊόντα, υπηρεσίες ή έκπτωση, αποκλειστικά στο φαρμακείο.\n"
    "4. Οι πόντοι δεν μετατρέπονται σε μετρητά και δεν μεταβιβάζονται.\n"
    "5. Το φαρμακείο διατηρεί το δικαίωμα τροποποίησης των όρων με προηγούμενη ενημέρωση.\n"
    "6. Τα δεδομένα σας χρησιμοποιούνται μόνο για τη λειτουργία του προγράμματος (GDPR).\n"
    "7. Μπορείτε να αποχωρήσετε οποτεδήποτε με αίτημά σας στο φαρμακείο."
)


def _tier_info(points: int) -> dict:
    tier = TIERS[0][1]
    nxt_name, nxt_at = None, None
    for at, name in TIERS:
        if points >= at:
            tier = name
        else:
            nxt_name, nxt_at = name, at
            break
    cur_at = max((at for at, _ in TIERS if points >= at), default=0)
    return {
        "tier": tier, "next_tier": nxt_name, "next_at": nxt_at,
        "to_next": (nxt_at - points) if nxt_at else 0,
        "progress_pct": round((points - cur_at) / (nxt_at - cur_at) * 100) if nxt_at and nxt_at > cur_at else 100,
    }


class LoyaltyRepository(BaseRepository):
    collection_name = "loyalty_ledger"

    # ── config ──────────────────────────────────────────────────────────────
    async def config(self) -> dict:
        doc = await self._db["loyalty_config"].find_one({"tenant_id": self.tenant_id}) or {}
        out = {k: (doc[k] if doc.get(k) is not None else DEFAULT_CONFIG[k]) for k in DEFAULT_CONFIG}
        out["terms"] = doc.get("terms") or DEFAULT_TERMS
        return out

    async def save_config(self, cfg: dict) -> dict:
        clean = {}
        for k in DEFAULT_CONFIG:
            if k in cfg and cfg[k] is not None:
                clean[k] = bool(cfg[k]) if k == "enabled" else max(0, int(cfg[k]))
        if "terms" in cfg and cfg["terms"] is not None:
            clean["terms"] = str(cfg["terms"])[:5000]
        await self._db["loyalty_config"].update_one(
            {"tenant_id": self.tenant_id},
            {"$set": {**clean, "tenant_id": self.tenant_id, "updated_at": _now()}}, upsert=True)
        return await self.config()

    # ── enrollment (opt-in με αποδοχή όρων) ─────────────────────────────────
    async def is_enrolled(self, patient_ref: str) -> dict | None:
        return await self._db["loyalty_members"].find_one(
            {"tenant_id": self.tenant_id, "patient_ref": str(patient_ref)})

    async def enrolled_refs(self) -> set:
        return {r["patient_ref"] async for r in self._db["loyalty_members"].find(
            {"tenant_id": self.tenant_id}, {"patient_ref": 1})}

    async def enroll(self, patient_ref: str, *, method: str, name: str | None = None) -> dict:
        await self._db["loyalty_members"].update_one(
            {"tenant_id": self.tenant_id, "patient_ref": str(patient_ref)},
            {"$set": {"tenant_id": self.tenant_id, "patient_ref": str(patient_ref),
                      "accept_method": method, "name": name},
             "$setOnInsert": {"enrolled_at": _now()}}, upsert=True)
        return {"ok": True}

    async def unenroll(self, patient_ref: str) -> dict:
        await self._db["loyalty_members"].delete_one(
            {"tenant_id": self.tenant_id, "patient_ref": str(patient_ref)})
        return {"ok": True}

    # ── ledger (redeem + adjust; voided excluded from balance) ──────────────
    async def _ledger_sums(self) -> dict:
        out: dict = defaultdict(lambda: {"redeemed_cents": 0, "adjust_cents": 0})
        cur = self._coll.aggregate([
            {"$match": {"tenant_id": self.tenant_id, "voided": {"$ne": True}}},
            {"$group": {"_id": {"p": "$patient_ref", "t": "$type"}, "cents": {"$sum": "$cents"}}},
        ])
        async for r in cur:
            pid, typ = r["_id"].get("p"), r["_id"].get("t")
            if not pid:
                continue
            if typ == "redeem":
                out[pid]["redeemed_cents"] += r["cents"]
            elif typ == "adjust":
                out[pid]["adjust_cents"] += r["cents"]
        return out

    async def ledger(self, patient_ref: str, limit: int = 50) -> list[dict]:
        return await self.find({"patient_ref": str(patient_ref)}, sort=[("at", -1)], limit=limit)

    async def _refills_since(self, enrolled: dict) -> dict:
        """Count repeat refills (distinct Rx barcodes) each enrolled patient executed ON/AFTER their
        enrolment date — points count only forward, not for past executions."""
        oids = []
        for r in enrolled:
            try:
                oids.append(ObjectId(r))
            except Exception:  # noqa: BLE001
                pass
        out: dict = defaultdict(int)
        if not oids:
            return out
        cur = self._db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": self.tenant_id, "patient_ref": {"$in": oids}}},
            {"$group": {"_id": {"p": "$patient_ref",
                                "bc": {"$arrayElemAt": [{"$split": ["$external_id", ":"]}, 0]}},
                        "first": {"$min": "$executed_at"}}},
        ])
        async for g in cur:
            ref = str(g["_id"].get("p"))
            first, en = g.get("first"), enrolled.get(ref)
            if first and en and first >= en:
                out[ref] += 1
        return out

    # ── core: members with adherence-derived points/wallet ──────────────────
    async def _build_members(self, cfg: dict, *, restrict: set | None = None) -> list[dict]:
        chain = await PatientIntelligenceRepository(tenant_id=self.tenant_id)._chain_analysis()
        sums = await self._ledger_sums()
        enrolled = {m["patient_ref"]: m.get("enrolled_at") async for m in
                    self._db["loyalty_members"].find({"tenant_id": self.tenant_id})}
        refills_since = await self._refills_since(enrolled)
        refs = [r for r in chain.keys() if r]
        names: dict = {}
        async for p in self._db["patients_anonymized"].find(
                {"tenant_id": self.tenant_id, "_id": {"$in": refs}}, {"full_name": 1}):
            names[str(p["_id"])] = p.get("full_name")
        ppr, cpp = cfg["points_per_refill"], cfg["cents_per_point"]
        rows: list[dict] = []
        for ref, c in chain.items():
            if not ref or not c.get("chains"):
                continue
            rid = str(ref)
            if restrict is not None and rid not in restrict:
                continue
            executed = int(refills_since.get(rid, 0))   # ← refills since enrolment only
            points = executed * ppr
            earned_cents = points * cpp
            s = sums.get(rid, {})
            redeemed = s.get("redeemed_cents", 0)
            adjust = s.get("adjust_cents", 0) + (cfg.get("welcome_cents", 0) if cfg.get("welcome_cents") else 0)
            balance = max(0, earned_cents + adjust - redeemed)
            ti = _tier_info(points)
            rows.append({
                "patient_ref": rid, "name": names.get(rid) or "—",
                "compliance": c.get("compliance"), "refills": executed, "expected": int(c.get("expected", 0)),
                "open_refills": int(c.get("available", 0)),   # repeats ready to fill now → earnable
                "points": points, "balance_cents": balance,
                "earned_cents": earned_cents, "redeemed_cents": redeemed,
                **ti,
            })
        rows.sort(key=lambda x: (-x["points"], -(x["compliance"] or 0)))
        return rows

    async def overview(self) -> dict:
        cfg = await self.config()
        members = await self._build_members(cfg, restrict=await self.enrolled_refs())  # enrolled only
        comps = [m["compliance"] for m in members if m["compliance"] is not None]
        return jsonsafe({
            "config": cfg,
            "kpis": {
                "members": len(members),
                "total_points": sum(m["points"] for m in members),
                "liability_cents": sum(m["balance_cents"] for m in members),
                "redeemed_cents": sum(m["redeemed_cents"] for m in members),
                "avg_compliance": round(sum(comps) / len(comps)) if comps else 0,
                "open_refills": sum(m["open_refills"] for m in members),
            },
            "members": members,
        })

    async def candidates(self, q: str = "", limit: int = 40) -> list[dict]:
        """Chain patients NOT yet enrolled — for the pharmacist to sign up in-store."""
        cfg = await self.config()
        enrolled = await self.enrolled_refs()
        s = (q or "").strip().lower()
        out = []
        for m in await self._build_members(cfg):
            if m["patient_ref"] in enrolled:
                continue
            if s and s not in (m["name"] or "").lower():
                continue
            out.append({"patient_ref": m["patient_ref"], "name": m["name"],
                        "compliance": m["compliance"], "would_points": m["points"]})
            if len(out) >= limit:
                break
        return jsonsafe(out)

    async def member(self, patient_ref: str) -> dict | None:
        cfg = await self.config()
        members = await self._build_members(cfg)
        rid = str(patient_ref)
        row = next((m for m in members if m["patient_ref"] == rid), None)
        if not row:
            return None
        ppr, cpp = cfg["points_per_refill"], cfg["cents_per_point"]
        row = dict(row)
        row["config"] = cfg
        row["points_per_refill"] = ppr
        row["cents_per_point"] = cpp
        # gamification: value of acting now
        row["potential_points"] = row["open_refills"] * ppr
        row["ledger"] = await self.ledger(rid)
        mdoc = await self.is_enrolled(rid)
        row["enrolled"] = bool(mdoc)
        row["enrolled_method"] = (mdoc or {}).get("accept_method")
        row["enrolled_at"] = (mdoc or {}).get("enrolled_at")
        return jsonsafe(row)

    # ── redemptions log + reversal ──────────────────────────────────────────
    async def redemptions(self, limit: int = 120) -> list[dict]:
        rows = await self.find({"type": "redeem"}, sort=[("at", -1)], limit=limit)
        refs = []
        for r in rows:
            try:
                refs.append(ObjectId(r["patient_ref"]))
            except Exception:  # noqa: BLE001
                pass
        names: dict = {}
        async for p in self._db["patients_anonymized"].find(
                {"tenant_id": self.tenant_id, "_id": {"$in": refs}}, {"full_name": 1}):
            names[str(p["_id"])] = p.get("full_name")
        for r in rows:
            r["patient_name"] = names.get(r.get("patient_ref")) or "—"
        return rows

    async def reverse(self, ledger_id: str) -> dict:
        """Void a redemption (patient changed their mind) → its cents return to the wallet."""
        try:
            oid = ObjectId(ledger_id)
        except Exception:  # noqa: BLE001
            return {"ok": False}
        await self._coll.update_one(
            {"_id": oid, "tenant_id": self.tenant_id, "type": "redeem"},
            {"$set": {"voided": True, "voided_at": _now()}})
        return {"ok": True}

    # ── redemption + manual adjust (counter) ────────────────────────────────
    async def redeem(self, patient_ref: str, cents: int, *, reason: str, kind: str) -> dict:
        cents = int(cents)
        if cents <= 0:
            return {"ok": False, "error": "bad_amount"}
        m = await self.member(patient_ref)
        if not m:
            return {"ok": False, "error": "not_found"}
        if cents > m["balance_cents"]:
            return {"ok": False, "error": "insufficient", "balance_cents": m["balance_cents"]}
        await self.insert_one({
            "patient_ref": str(patient_ref), "type": "redeem", "cents": cents,
            "kind": kind, "reason": (reason or "")[:160], "at": _now()})
        return {"ok": True, "balance_cents": m["balance_cents"] - cents}

    async def adjust(self, patient_ref: str, cents: int, *, reason: str) -> dict:
        await self.insert_one({
            "patient_ref": str(patient_ref), "type": "adjust", "cents": int(cents),
            "reason": (reason or "")[:160], "at": _now()})
        return {"ok": True}

    # ── rewards catalogue (εξαργύρωση σε προϊόντα / υπηρεσίες / έκπτωση) ──────
    async def rewards(self, *, only_active: bool = False) -> list[dict]:
        q: dict = {"tenant_id": self.tenant_id}
        if only_active:
            q["active"] = {"$ne": False}
        rows = [r async for r in self._db["loyalty_rewards"].find(q).sort("cost_points", 1)]
        cfg = await self.config()
        for r in rows:
            r["cost_cents"] = int(r.get("cost_points", 0)) * cfg["cents_per_point"]
        return jsonsafe(rows)

    async def add_reward(self, doc: dict) -> str:
        res = await self._db["loyalty_rewards"].insert_one({
            "tenant_id": self.tenant_id, "title": (doc.get("title") or "")[:120],
            "type": doc.get("type", "product"), "cost_points": max(1, int(doc.get("cost_points", 100))),
            "note": (doc.get("note") or "")[:200], "active": bool(doc.get("active", True)),
            "created_at": _now()})
        return str(res.inserted_id)

    async def update_reward(self, reward_id: str, doc: dict) -> dict:
        try:
            oid = ObjectId(reward_id)
        except Exception:  # noqa: BLE001
            return {"ok": False}
        fields = {k: doc[k] for k in ("title", "type", "cost_points", "note", "active") if k in doc}
        if "cost_points" in fields:
            fields["cost_points"] = max(1, int(fields["cost_points"]))
        await self._db["loyalty_rewards"].update_one(
            {"_id": oid, "tenant_id": self.tenant_id}, {"$set": fields})
        return {"ok": True}

    async def delete_reward(self, reward_id: str) -> dict:
        try:
            oid = ObjectId(reward_id)
        except Exception:  # noqa: BLE001
            return {"ok": False}
        await self._db["loyalty_rewards"].delete_one({"_id": oid, "tenant_id": self.tenant_id})
        return {"ok": True}

    async def redeem_reward(self, patient_ref: str, reward_id: str) -> dict:
        try:
            oid = ObjectId(reward_id)
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": "bad_reward"}
        reward = await self._db["loyalty_rewards"].find_one({"_id": oid, "tenant_id": self.tenant_id})
        if not reward or reward.get("active") is False:
            return {"ok": False, "error": "not_found"}
        cfg = await self.config()
        cost_cents = int(reward.get("cost_points", 0)) * cfg["cents_per_point"]
        m = await self.member(patient_ref)
        if not m:
            return {"ok": False, "error": "no_member"}
        if cost_cents > m["balance_cents"]:
            return {"ok": False, "error": "insufficient", "balance_cents": m["balance_cents"]}
        await self.insert_one({
            "patient_ref": str(patient_ref), "type": "redeem", "cents": cost_cents,
            "kind": reward.get("type", "product"), "reward_id": str(oid),
            "reason": reward.get("title", "Δώρο"), "at": _now()})
        return {"ok": True, "balance_cents": m["balance_cents"] - cost_cents, "reward": reward.get("title")}
