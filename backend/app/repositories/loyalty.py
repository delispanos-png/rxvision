"""Customer loyalty — rewards chronic patients for ADHERENCE to their repeat prescriptions.

The gauge is the repeat-chain compliance already computed by Patient Intelligence: every on-time
refill earns points (deterministic, derived from immutable execution history), points convert to a
€ wallet the patient spends at the counter (services / παραφάρμακα). Redemptions + manual
adjustments are the only stored events (`loyalty_ledger`); earnings are always recomputed from
history so there is no double-award risk.
"""
from __future__ import annotations

import secrets
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.repositories.base import BaseRepository, jsonsafe
from app.repositories.patient_intelligence import PatientIntelligenceRepository


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _parse_day(s) -> datetime | None:
    """«YYYY-MM-DD» → aware datetime (UTC midnight). Ανθεκτικό — None αν δεν παρσάρεται."""
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=timezone.utc)
    try:
        return datetime.strptime(str(s)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except Exception:  # noqa: BLE001
        return None


def _campaign_pct(dt: datetime, campaigns: list[dict]) -> int:
    """Πολλαπλασιαστής % που ισχύει για εκτέλεση στην ημερομηνία dt (πρώτη καμπάνια που ταιριάζει,
    αλλιώς 100). Καμπάνιες: [{start,end,multiplier_pct}] με ημερομηνίες «YYYY-MM-DD» (inclusive)."""
    if not campaigns:
        return 100
    d = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    for c in campaigns:
        st, en = _parse_day(c.get("start")), _parse_day(c.get("end"))
        if st and en and st <= d <= en + timedelta(days=1):
            return int(c.get("multiplier_pct", 100) or 100)
    return 100


DEFAULT_CONFIG = {
    "enabled": False,
    "points_per_refill": 10,     # points earned per on-time repeat refill
    "cents_per_point": 5,        # € value of one point (cents) → 10pts = 0.50€
    "min_redeem_cents": 100,     # smallest redemption (1.00€)
    "welcome_cents": 0,          # optional signup credit (cents) — applied as an adjust on first read
    # Med-intake adherence rewards — PHARMACIST-ONLY opt-in, OFF by default (points cost real €).
    "adherence_points_enabled": False,
    "adherence_rule": "per_day",     # WHEN points are earned: per_med | per_day | full_day
    "points_per_adherence": 1,       # points per earning event (per the rule)
    "adherence_streak_bonus": 5,     # extra points each 7-day streak (per_day/full_day only)
    # Tier multipliers — higher tiers EARN MORE per refill (opt-in, OFF by default). Values are
    # percentages (100 = ×1.0). The tier ladder itself stays on BASE points, so the multiplier is a
    # pure wallet perk that never feeds back into the tier calculation (no runaway loop).
    "tier_multipliers_enabled": False,
    "tier_multipliers": {"Bronze": 100, "Silver": 110, "Gold": 125, "Platinum": 150},
    # Καμπάνιες διπλών πόντων — εκτελέσεις μέσα στο χρονικό παράθυρο κερδίζουν ×multiplier_pct/100.
    # Λίστα {name, start:"YYYY-MM-DD", end:"YYYY-MM-DD", multiplier_pct}. Κενή = καμία.
    "campaigns": [],
    # Λήξη πόντων — μόνο εκτελέσεις εντός κυλιόμενου παραθύρου N μηνών κερδίζουν (0 = ποτέ).
    "points_expire_months": 0,
    # Referral «σύστησε φίλο» — bonus στον συστήνοντα + έξτρα welcome στον νέο (opt-in).
    "referral_enabled": False,
    "referral_referrer_cents": 500,     # bonus στον πελάτη που έφερε τον φίλο
    "referral_referred_cents": 300,     # έξτρα welcome στον νέο πελάτη (πάνω από welcome_cents)
    # Δώρο γενεθλίων — bonus πόντων τον μήνα των γενεθλίων (από ωμό ΑΜΚΑ λογαριασμού· opt-in).
    "birthday_enabled": False,
    "birthday_bonus_cents": 500,
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

    _BOOL_KEYS = {"enabled", "adherence_points_enabled", "tier_multipliers_enabled",
                  "referral_enabled", "birthday_enabled"}
    _STR_KEYS = {"adherence_rule"}
    _DICT_KEYS = {"tier_multipliers"}
    _LIST_KEYS = {"campaigns"}

    async def save_config(self, cfg: dict) -> dict:
        clean = {}
        for k in DEFAULT_CONFIG:
            if k in cfg and cfg[k] is not None:
                if k in self._BOOL_KEYS:
                    clean[k] = bool(cfg[k])
                elif k in self._STR_KEYS:
                    clean[k] = str(cfg[k])
                elif k in self._DICT_KEYS:
                    # tier_multipliers: keep only known tiers, clamp 0–1000% (int)
                    src = cfg[k] if isinstance(cfg[k], dict) else {}
                    clean[k] = {name: max(0, min(1000, int(src.get(name, DEFAULT_CONFIG[k][name]))))
                                for _, name in TIERS}
                elif k in self._LIST_KEYS:
                    clean[k] = self._clean_campaigns(cfg[k])
                else:
                    clean[k] = max(0, int(cfg[k]))
        if "terms" in cfg and cfg["terms"] is not None:
            clean["terms"] = str(cfg["terms"])[:5000]
        await self._db["loyalty_config"].update_one(
            {"tenant_id": self.tenant_id},
            {"$set": {**clean, "tenant_id": self.tenant_id, "updated_at": _now()}}, upsert=True)
        return await self.config()

    @staticmethod
    def _clean_campaigns(raw) -> list[dict]:
        """Καθάρισμα λίστας καμπανιών: κράτα μόνο έγκυρες εγγραφές {name,start,end,multiplier_pct}."""
        out: list[dict] = []
        for c in (raw or [])[:50]:
            if not isinstance(c, dict):
                continue
            start, end = _parse_day(c.get("start")), _parse_day(c.get("end"))
            if not start or not end or end < start:
                continue
            out.append({
                "name": str(c.get("name") or "")[:80],
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
                "multiplier_pct": max(0, min(1000, int(c.get("multiplier_pct", 200) or 200))),
            })
        return out

    async def balances_for_refs(self, refs) -> dict:
        """{patient_ref: {points, balance_cents}} για συγκεκριμένους ασθενείς με ΘΕΤΙΚΟ υπόλοιπο.
        Μία δόμηση όλων των μελών & φιλτράρισμα (για τη λίστα υπολοίπων θανόντων)."""
        want = {str(r) for r in refs}
        if not want:
            return {}
        cfg = await self.config()
        members = await self._build_members(cfg)
        return {m["patient_ref"]: {"points": m["points"], "balance_cents": m["balance_cents"]}
                for m in members if m["patient_ref"] in want and (m.get("balance_cents") or 0) > 0}

    # ── enrollment (opt-in με αποδοχή όρων) ─────────────────────────────────
    async def is_enrolled(self, patient_ref: str) -> dict | None:
        return await self._db["loyalty_members"].find_one(
            {"tenant_id": self.tenant_id, "patient_ref": str(patient_ref)})

    async def enrolled_refs(self) -> set:
        return {r["patient_ref"] async for r in self._db["loyalty_members"].find(
            {"tenant_id": self.tenant_id}, {"patient_ref": 1})}

    async def enroll(self, patient_ref: str, *, method: str, name: str | None = None,
                     referred_by_code: str | None = None) -> dict:
        existed = await self.is_enrolled(patient_ref)
        await self._db["loyalty_members"].update_one(
            {"tenant_id": self.tenant_id, "patient_ref": str(patient_ref)},
            {"$set": {"tenant_id": self.tenant_id, "patient_ref": str(patient_ref),
                      "accept_method": method, "name": name},
             "$setOnInsert": {"enrolled_at": _now()}}, upsert=True)
        out = {"ok": True}
        # Referral μόνο σε ΝΕΑ εγγραφή (όχι σε επανεγγραφή) & αν δόθηκε έγκυρος κωδικός
        if not existed and referred_by_code:
            out["referral"] = await self.apply_referral(str(patient_ref), referred_by_code)
        return out

    # ── referral «σύστησε φίλο» ─────────────────────────────────────────────
    async def referral_code_for(self, patient_ref: str) -> str | None:
        """Σταθερός μοναδικός κωδικός σύστασης του μέλους (δημιουργείται με το πρώτο ζήτημα)."""
        m = await self.is_enrolled(patient_ref)
        if not m:
            return None
        if m.get("referral_code"):
            return m["referral_code"]
        for _ in range(8):
            code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
            clash = await self._db["loyalty_members"].find_one(
                {"tenant_id": self.tenant_id, "referral_code": code})
            if clash:
                continue
            await self._db["loyalty_members"].update_one(
                {"tenant_id": self.tenant_id, "patient_ref": str(patient_ref)},
                {"$set": {"referral_code": code}})
            return code
        return None

    async def _credit_once(self, patient_ref: str, cents: int, *, source: str, dedup_key: str,
                           reason: str) -> bool:
        """Πίστωση πόντων μία φορά (adjust ledger row) με idempotency μέσω dedup_key. cents≤0 → no-op."""
        if cents <= 0:
            return False
        if await self._coll.find_one({"tenant_id": self.tenant_id, "dedup_key": dedup_key}):
            return False
        cpp = (await self.config())["cents_per_point"]
        await self._coll.insert_one({
            "tenant_id": self.tenant_id, "patient_ref": str(patient_ref), "type": "adjust",
            "cents": int(cents), "points": round(cents / cpp) if cpp else 0, "reason": reason,
            "source": source, "dedup_key": dedup_key, "at": _now()})
        return True

    async def apply_referral(self, new_ref: str, code: str) -> dict:
        """Ο νέος πελάτης (new_ref) ήρθε με κωδικό σύστασης `code`. Πιστώνει τον συστήνοντα + τον νέο,
        μία φορά ανά συσταθέντα. Αγνοεί self-referral / ήδη-συσταθέντα / ανενεργό referral."""
        cfg = await self.config()
        if not cfg.get("referral_enabled"):
            return {"ok": False, "error": "disabled"}
        referrer = await self._db["loyalty_members"].find_one(
            {"tenant_id": self.tenant_id, "referral_code": (code or "").strip().upper()})
        if not referrer:
            return {"ok": False, "error": "code_not_found"}
        rref = referrer["patient_ref"]
        if str(rref) == str(new_ref):
            return {"ok": False, "error": "self"}
        me = await self.is_enrolled(new_ref)
        if me and me.get("referred_by"):
            return {"ok": False, "error": "already_referred"}
        await self._db["loyalty_members"].update_one(
            {"tenant_id": self.tenant_id, "patient_ref": str(new_ref)},
            {"$set": {"referred_by": str(rref), "referred_at": _now()}})
        credited_r = await self._credit_once(
            str(rref), int(cfg.get("referral_referrer_cents", 0) or 0),
            source="referral", dedup_key=f"ref:{new_ref}", reason="Σύσταση φίλου")
        credited_n = await self._credit_once(
            str(new_ref), int(cfg.get("referral_referred_cents", 0) or 0),
            source="referral_welcome", dedup_key=f"refw:{new_ref}", reason="Καλωσόρισμα (σύσταση)")
        return {"ok": True, "referrer_credited": credited_r, "referred_credited": credited_n}

    async def unenroll(self, patient_ref: str) -> dict:
        await self._db["loyalty_members"].delete_one(
            {"tenant_id": self.tenant_id, "patient_ref": str(patient_ref)})
        return {"ok": True}

    # ── birthday bonus (μήνας γενεθλίων από ωμό ΑΜΚΑ = ΗΗΜΜΕΕ...) ───────────
    async def award_birthdays(self, month: int, year: int) -> list[str]:
        """Πιστώνει bonus γενεθλίων σε όσα εγγεγραμμένα μέλη έχουν γενέθλια τον `month`. Μία φορά/έτος
        ανά μέλος (dedup «bday:{ref}:{year}»). Επιστρέφει τα patient_ref που πιστώθηκαν (για push)."""
        cfg = await self.config()
        cents = int(cfg.get("birthday_bonus_cents", 0) or 0)
        if not cfg.get("birthday_enabled") or cents <= 0:
            return []
        refs = [r["patient_ref"] async for r in self._db["loyalty_members"].find(
            {"tenant_id": self.tenant_id}, {"patient_ref": 1})]
        oids = []
        for r in refs:
            try:
                oids.append(ObjectId(r))
            except Exception:  # noqa: BLE001
                pass
        amkas: dict = {}
        async for p in self._db["patients_anonymized"].find(
                {"tenant_id": self.tenant_id, "_id": {"$in": oids}}, {"amka": 1}):
            amkas[str(p["_id"])] = str(p.get("amka") or "")
        credited: list[str] = []
        for ref in refs:
            am = amkas.get(ref, "")
            if len(am) < 4:
                continue
            try:
                bmonth = int(am[2:4])          # ΑΜΚΑ = ΗΗ ΜΜ ΕΕ + 5 → chars[2:4] = μήνας
            except ValueError:
                continue
            if bmonth != month or not (1 <= bmonth <= 12):
                continue
            if await self._credit_once(ref, cents, source="birthday",
                                       dedup_key=f"bday:{ref}:{year}", reason="Δώρο γενεθλίων 🎂"):
                credited.append(ref)
        return credited

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

    async def award_adherence(self, patient_ref: str, points: int, *, reason: str, dedup_key: str) -> dict:
        """Award med-intake adherence points → wallet. NO-OP unless the pharmacist enabled it AND the
        patient is enrolled. Idempotent via `dedup_key` (one award per patient per day)."""
        cfg = await self.config()
        if not cfg.get("adherence_points_enabled") or points <= 0:
            return {"ok": True, "skipped": "disabled"}
        enrolled = await self._db["loyalty_members"].find_one(
            {"tenant_id": self.tenant_id, "patient_ref": str(patient_ref)})
        if not enrolled:
            return {"ok": True, "skipped": "not_enrolled"}
        if await self._coll.find_one({"tenant_id": self.tenant_id, "dedup_key": dedup_key}):
            return {"ok": True, "duplicate": True}
        cents = int(points) * int(cfg["cents_per_point"])
        await self._coll.insert_one({
            "tenant_id": self.tenant_id, "patient_ref": str(patient_ref), "type": "adjust",
            "cents": cents, "points": int(points), "reason": reason, "source": "adherence",
            "dedup_key": dedup_key, "at": _now()})
        return {"ok": True, "points": int(points), "cents": cents}

    async def _refills_since(self, enrolled: dict, cfg: dict | None = None) -> dict:
        """Count refill EXECUTIONS each enrolled patient did ON/AFTER enrolment — ΚΑΘΕ εκτέλεση δίνει
        πόντους (όχι μία ανά διακριτή συνταγή). Ακυρωμένες εξαιρούνται· κάθε external_id (barcode:execNo)
        είναι μοναδικό → idempotent (re-ingest δεν διπλομετρά). Οι πόντοι μετρούν μόνο εμπρός (από εγγραφή).

        Επιστρέφει ανά ref: {"n": πλήθος εκτελέσεων, "wsum_pct": Σ πολλαπλασιαστών %}. Χωρίς
        καμπάνιες/λήξη → wsum_pct = n×100 (base_earned = ppr×n, αμετάβλητο). Καμπάνια διπλών πόντων
        προσθέτει 200 αντί 100· λήξη (points_expire_months) αγνοεί εκτελέσεις πριν το κυλιόμενο cutoff."""
        cfg = cfg or {}
        campaigns = cfg.get("campaigns") or []
        exp_months = int(cfg.get("points_expire_months") or 0)
        cutoff = None
        if exp_months > 0:
            cutoff = _now() - timedelta(days=exp_months * 30)
        oids = []
        for r in enrolled:
            try:
                oids.append(ObjectId(r))
            except Exception:  # noqa: BLE001
                pass
        out: dict = defaultdict(lambda: {"n": 0, "wsum_pct": 0})
        if not oids:
            return out
        cur = self._db["prescription_executions"].find(
            {"tenant_id": self.tenant_id, "patient_ref": {"$in": oids}, "cancelled": {"$ne": True}},
            {"patient_ref": 1, "executed_at": 1})
        async for e in cur:
            ref = str(e.get("patient_ref"))
            ex, en = e.get("executed_at"), enrolled.get(ref)
            if not (ex and en and ex >= en):
                continue
            exa = ex if getattr(ex, "tzinfo", None) else ex.replace(tzinfo=timezone.utc)
            if cutoff and exa < cutoff:
                continue                      # πόντοι έληξαν (εκτός κυλιόμενου παραθύρου)
            out[ref]["n"] += 1
            out[ref]["wsum_pct"] += _campaign_pct(exa, campaigns)
        return out

    # ── core: members with adherence-derived points/wallet ──────────────────
    async def _build_members(self, cfg: dict, *, restrict: set | None = None) -> list[dict]:
        chain = await PatientIntelligenceRepository(tenant_id=self.tenant_id)._chain_analysis()
        sums = await self._ledger_sums()
        enrolled = {m["patient_ref"]: m.get("enrolled_at") async for m in
                    self._db["loyalty_members"].find({"tenant_id": self.tenant_id})}
        refills_since = await self._refills_since(enrolled, cfg)
        refs = [r for r in chain.keys() if r]
        names: dict = {}
        async for p in self._db["patients_anonymized"].find(
                {"tenant_id": self.tenant_id, "_id": {"$in": refs}}, {"full_name": 1}):
            names[str(p["_id"])] = p.get("full_name")
        ppr, cpp = cfg["points_per_refill"], cfg["cents_per_point"]
        tmult = cfg.get("tier_multipliers") or {}
        tmult_on = bool(cfg.get("tier_multipliers_enabled"))
        rows: list[dict] = []
        for ref, c in chain.items():
            if not ref or not c.get("chains"):
                continue
            rid = str(ref)
            if restrict is not None and rid not in restrict:
                continue
            rs = refills_since.get(rid) or {"n": 0, "wsum_pct": 0}
            executed = int(rs["n"])                      # ← refills (εκτελέσεις) από την εγγραφή
            # base_earned = ppr × Σ(πολλαπλασιαστών%)/100 → καμπάνιες διπλών πόντων ενσωματωμένες
            base_earned = round(ppr * rs["wsum_pct"] / 100)
            s = sums.get(rid, {})
            redeemed_cents = s.get("redeemed_cents", 0)
            # ΣΥΝΕΠΕΙΑ: ΟΛΑ σε πόντους ώστε πόντοι & € να συμφωνούν ΠΑΝΤΑ (balance = points × cpp) και ο
            # έλεγχος εξαργύρωσης (cents ≤ balance) να ισοδυναμεί με points ≤ points. welcome & manual
            # adjusts μετρούν & ως πόντοι → ανεβάζουν και το tier (πριν έμεναν «φάντασμα» μόνο σε €).
            bonus_cents = s.get("adjust_cents", 0) + (cfg.get("welcome_cents", 0) or 0)
            bonus_points = round(bonus_cents / cpp) if cpp else 0
            redeemed_points = round(redeemed_cents / cpp) if cpp else 0
            # Το tier κρίνεται από τα BASE points (σταθερή σκάλα)· ο multiplier ανεβάζει ΜΟΝΟ τα κερδισμένα.
            base_points = max(0, base_earned + bonus_points - redeemed_points)
            ti = _tier_info(base_points)
            mult = int(tmult.get(ti["tier"], 100)) if tmult_on else 100
            earned_points = round(base_earned * mult / 100)
            points = max(0, earned_points + bonus_points - redeemed_points)
            balance = points * cpp
            rows.append({
                "patient_ref": rid, "name": names.get(rid) or "—",
                "compliance": c.get("compliance"), "refills": executed, "expected": int(c.get("expected", 0)),
                "open_refills": int(c.get("available", 0)),   # repeats ready to fill now → earnable
                "points": points, "balance_cents": balance, "tier_multiplier": mult,
                "earned_cents": earned_points * cpp, "redeemed_cents": redeemed_cents,
                **ti,
            })
        rows.sort(key=lambda x: (-x["points"], -(x["compliance"] or 0)))
        return rows

    async def overview(self) -> dict:
        cfg = await self.config()
        members = await self._build_members(cfg, restrict=await self.enrolled_refs())  # enrolled only
        comps = [m["compliance"] for m in members if m["compliance"] is not None]
        earned = sum(m["earned_cents"] for m in members)
        redeemed = sum(m["redeemed_cents"] for m in members)
        tier_counts: dict = {name: 0 for _, name in TIERS}
        for m in members:
            tier_counts[m.get("tier", TIERS[0][1])] = tier_counts.get(m.get("tier", TIERS[0][1]), 0) + 1
        return jsonsafe({
            "config": cfg,
            "kpis": {
                "members": len(members),
                "total_points": sum(m["points"] for m in members),
                "liability_cents": sum(m["balance_cents"] for m in members),
                "earned_cents": earned,
                "redeemed_cents": redeemed,
                # Ποσοστό αξιοποίησης: πόσο απ' όσα κερδήθηκαν έχει ήδη εξαργυρωθεί (engagement δείκτης).
                "redemption_rate": round(redeemed / earned * 100) if earned else 0,
                "avg_compliance": round(sum(comps) / len(comps)) if comps else 0,
                "open_refills": sum(m["open_refills"] for m in members),
                "tier_counts": tier_counts,
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

    # ── SELF-REDEEM: ο πελάτης δεσμεύει δώρο (pending) → κωδικός → ο φαρμακοποιός επιβεβαιώνει ─────
    _RES_TTL_HOURS = 48

    async def _expire_pending(self) -> None:
        """Void δεσμεύσεων που έληξαν → οι πόντοι επιστρέφουν αυτόματα."""
        await self._coll.update_many(
            {"tenant_id": self.tenant_id, "type": "redeem", "pending": True,
             "voided": {"$ne": True}, "expires_at": {"$lte": _now()}},
            {"$set": {"voided": True, "voided_at": _now(), "expired": True}})

    async def request_reward(self, patient_ref: str, reward_id: str) -> dict:
        """Πύλη: ο πελάτης ΔΕΣΜΕΥΕΙ δώρο — κρατά τους πόντους (pending redeem· το balance ήδη τους
        αφαιρεί) & παίρνει 6ψήφιο κωδικό που δείχνει στο φαρμακείο. Λήγει σε 48ω αν δεν εξαργυρωθεί."""
        await self._expire_pending()
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
        code = f"{secrets.randbelow(1_000_000):06d}"
        exp = _now() + timedelta(hours=self._RES_TTL_HOURS)
        await self.insert_one({
            "patient_ref": str(patient_ref), "type": "redeem", "cents": cost_cents,
            "kind": reward.get("type", "product"), "reward_id": str(oid),
            "reason": reward.get("title", "Δώρο"), "at": _now(),
            "pending": True, "code": code, "expires_at": exp})
        return {"ok": True, "code": code, "reward": reward.get("title"),
                "cost_points": int(reward.get("cost_points", 0)), "expires_at": exp,
                "balance_cents": m["balance_cents"] - cost_cents}

    async def cancel_request(self, code: str, patient_ref: str | None = None) -> dict:
        """Ακύρωση δέσμευσης (από τον πελάτη) → void → επιστροφή πόντων."""
        q = {"tenant_id": self.tenant_id, "type": "redeem", "pending": True, "code": (code or "").strip()}
        if patient_ref:
            q["patient_ref"] = str(patient_ref)
        r = await self._coll.update_one(q, {"$set": {"voided": True, "voided_at": _now(), "cancelled": True}})
        return {"ok": r.modified_count > 0}

    async def confirm_reward(self, code: str) -> dict:
        """Ο φαρμακοποιός επιβεβαιώνει τη δέσμευση με τον κωδικό → οριστική εξαργύρωση (pending=False)."""
        await self._expire_pending()
        doc = await self._coll.find_one(
            {"tenant_id": self.tenant_id, "type": "redeem", "pending": True,
             "voided": {"$ne": True}, "code": (code or "").strip()})
        if not doc:
            return {"ok": False, "error": "not_found_or_expired"}
        await self._coll.update_one({"_id": doc["_id"]},
                                    {"$set": {"pending": False, "confirmed_at": _now()}})
        m = await self.member(doc["patient_ref"])
        return {"ok": True, "reward": doc.get("reason"), "patient_ref": doc["patient_ref"],
                "name": (m or {}).get("name"), "balance_cents": (m or {}).get("balance_cents")}

    async def active_reservation(self, patient_ref: str) -> dict | None:
        """Η ενεργή δέσμευση δώρου του πελάτη (για εμφάνιση κωδικού στην πύλη)."""
        await self._expire_pending()
        doc = await self._coll.find_one(
            {"tenant_id": self.tenant_id, "type": "redeem", "pending": True, "voided": {"$ne": True},
             "patient_ref": str(patient_ref)}, sort=[("at", -1)])
        if not doc:
            return None
        cfg = await self.config()
        cpp = cfg["cents_per_point"] or 1
        return jsonsafe({"code": doc.get("code"), "reward": doc.get("reason"),
                         "cost_points": round((doc.get("cents", 0)) / cpp), "expires_at": doc.get("expires_at")})

    async def pending_redemptions(self, limit: int = 60) -> list[dict]:
        """Ενεργές δεσμεύσεις (για τον φαρμακοποιό) — κωδικός, πελάτης, δώρο, λήξη."""
        await self._expire_pending()
        rows = await self.find({"type": "redeem", "pending": True, "voided": {"$ne": True}},
                               sort=[("at", -1)], limit=limit)
        names: dict = {}
        for r in rows:
            pr = r.get("patient_ref")
            if pr and pr not in names and len(str(pr)) == 24:
                p = await self._db["patients_anonymized"].find_one({"_id": ObjectId(pr)}, {"full_name": 1})
                names[pr] = (p or {}).get("full_name")
        return jsonsafe([{"code": r.get("code"), "reward": r.get("reason"),
                          "patient_ref": r.get("patient_ref"), "name": names.get(r.get("patient_ref")) or "—",
                          "cost_cents": r.get("cents"), "at": r.get("at"), "expires_at": r.get("expires_at")}
                         for r in rows])
