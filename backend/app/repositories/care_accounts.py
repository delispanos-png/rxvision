"""Δομές Φροντίδας — κύκλος ετοιμασίας & λογαριασμός.

ΤΙ ΧΡΩΣΤΑ Η ΔΟΜΗ: ΜΟΝΟ τη ΣΥΜΜΕΤΟΧΗ των ασφαλισμένων. Ό,τι καλύπτει το ταμείο είναι δική μας
υπόθεση και τρέχει αμετάβλητο στο κύκλωμα Αποζημίωσης — δεν αγγίζεται και δεν εμφανίζεται εδώ.

    amount_total = amount_claimed  +  patient_share
                   └─ ταμείο          └─ ΑΥΤΟ χρωστά η δομή

ΟΙ ΧΡΕΩΣΕΙΣ ΔΕΝ ΑΠΟΘΗΚΕΥΟΝΤΑΙ — ΠΑΡΑΓΟΝΤΑΙ. Θα μπορούσαμε να γράφουμε μια γραμμή καθολικού σε
κάθε εκτέλεση, αλλά τότε θα χρειαζόταν εργασία συγχρονισμού, και κάθε επανα-άντληση ή διόρθωση
ποσού θα άφηνε διπλή ή ξεπερασμένη γραμμή. Η χρέωση ΕΙΝΑΙ το `patient_share` των εκτελέσεων των
μελών· την αθροίζουμε τη στιγμή που τη ρωτάμε και είναι πάντα σωστή.

ΑΠΟΘΗΚΕΥΟΝΤΑΙ ΜΟΝΟ ΟΣΑ ΔΕΝ ΜΠΟΡΟΥΜΕ ΝΑ ΞΕΡΟΥΜΕ: οι ΕΙΣΠΡΑΞΕΙΣ (ποσό που καταχωρεί ο
φαρμακοποιός, όπως με τα ταμεία) και οι ΧΕΙΡΟΚΙΝΗΤΕΣ χρεώσεις (παραφάρμακα κ.λπ.).

⚠ ΔΕΝ ΞΕΡΟΥΜΕ ΠΟΙΕΣ ΣΥΝΤΑΓΕΣ ΕΞΟΦΛΗΘΗΚΑΝ. Η δομή δεν πληρώνει «τη συνταγή Χ», φέρνει ένα ποσό.
Καμία κατανομή σε γραμμές (ούτε FIFO): θα κατασκεύαζε πληροφορία που δεν έχουμε. Ο λογαριασμός
διαβάζεται σαν εκκαθαριστικό — υπόλοιπο από προηγούμενο, χρεώσεις, εισπράξεις, νέο υπόλοιπο.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository
from app.services import recoverable
from app.utils.masking import mask_name

RECEIPT, MANUAL, ADJUST = "receipt", "manual", "adjustment"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc).replace(tzinfo=None)


def _naive(dt: Any) -> datetime | None:
    """Σε naive UTC — οι ημερομηνίες μελών γράφονται με ζώνη, οι εκτελέσεις χωρίς."""
    if not isinstance(dt, datetime):
        return None
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def _oid(v: Any) -> ObjectId | None:
    try:
        return v if isinstance(v, ObjectId) else ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


def _month_bounds(month: str) -> tuple[datetime, datetime]:
    """'2026-09' → [1/9, 1/10). Άκυρο/κενό → ο τρέχων μήνας."""
    try:
        y, m = (int(x) for x in str(month).split("-")[:2])
        start = datetime(y, m, 1)
    except (ValueError, TypeError):
        n = _now()
        start = datetime(n.year, n.month, 1)
    end = datetime(start.year + (start.month == 12), (start.month % 12) + 1, 1)
    return start, end


class CareAccountRepository(BaseRepository):
    """Το καθολικό. Η ομάδα/μέλη ζουν στο `patient_groups` (PatientGroupRepository)."""

    collection_name = "care_ledger"

    # ── βοηθητικά ─────────────────────────────────────────────────────────────────────
    async def _group(self, gid: str) -> dict | None:
        return await self._db["patient_groups"].find_one(
            {"tenant_id": self.tenant_id, "_id": _oid(gid), "kind": "care"})

    async def _member_windows(self, g: dict) -> list[dict]:
        """Ανά μέλος: από πότε μετράνε οι χρεώσεις του.

        ΓΙΑΤΙ ΟΧΙ ΑΠΛΟ «ΟΛΑ ΤΑ ΜΕΛΗ, ΟΛΕΣ ΟΙ ΕΚΤΕΛΕΣΕΙΣ»: ένας τρόφιμος που μπήκε τον Μάιο δεν
        χρωστά για τον Μάρτιο. Αφετηρία = το αργότερο από τη ρύθμιση «χρεώσεις από» της δομής
        και την ημερομηνία που μπήκε ΑΥΤΟΣ.
        """
        cfrom = g.get("charges_from") or g.get("created_at") or datetime(2000, 1, 1)
        pseudos = [m["pseudo_id"] for m in (g.get("members") or [])
                   if m.get("pseudo_id") and not m.get("left_at")]
        if not pseudos:
            return []
        by_pseudo = {}
        async for p in self._db["patients_anonymized"].find(
                {"tenant_id": self.tenant_id, "pseudo_id": {"$in": pseudos}},
                {"pseudo_id": 1, "full_name": 1, "deceased": 1}):
            by_pseudo[p["pseudo_id"]] = p
        out = []
        for m in (g.get("members") or []):
            p = by_pseudo.get(m.get("pseudo_id"))
            if not p:
                continue                        # «σε αναμονή» — δεν έχει εκτελέσεις να χρεωθούν
            # Ρητό `charges_from` του μέλους υπερισχύει (το γράφει η ρύθμιση της δομής)·
            # αλλιώς το αργότερο από «πότε μπήκε» και «από πότε χρεώνει η δομή».
            own = _naive(m.get("charges_from"))
            joined = _naive(m.get("joined_at")) or _naive(cfrom)
            base = _naive(cfrom)
            start = own or (max(joined, base) if (joined and base) else (joined or base))
            out.append({"_id": p["_id"], "pseudo_id": p["pseudo_id"],
                        "name": mask_name(p.get("full_name"), self.demo),
                        "deceased": bool(p.get("deceased")),
                        "from": start,
                        "to": _naive(m.get("left_at"))})
        return out

    @staticmethod
    def _charge_match(wins: list[dict], df: datetime | None, dt: datetime | None) -> dict | None:
        """Ένα $or με ένα σκέλος ανά μέλος — το παράθυρο του καθενός είναι διαφορετικό."""
        clauses = []
        for w in wins:
            lo = max(w["from"], df) if df else w["from"]
            hi = min(w["to"], dt) if (w["to"] and dt) else (w["to"] or dt)
            if hi and lo >= hi:
                continue
            rng = {"$gte": lo}
            if hi:
                rng["$lt"] = hi
            clauses.append({"patient_ref": w["_id"], "executed_at": rng})
        return {"$or": clauses} if clauses else None

    async def _charges(self, wins: list[dict], df: datetime | None,
                       dt: datetime | None) -> dict[str, int]:
        """patient_id (str) → σύνολο συμμετοχών στο παράθυρο."""
        match = self._charge_match(wins, df, dt)
        if not match:
            return {}
        out: dict[str, int] = {}
        async for r in self._db["prescription_executions"].aggregate([
                {"$match": {"tenant_id": self.tenant_id, "status": {"$ne": "cancelled"}, **match}},
                {"$group": {"_id": "$patient_ref", "s": {"$sum": {"$ifNull": ["$patient_share", 0]}},
                            "n": {"$sum": 1}}}]):
            out[str(r["_id"])] = r["s"]
        return out

    async def _manual_total(self, gid: str, df: datetime | None, dt: datetime | None) -> dict:
        """Χειροκίνητες χρεώσεις & εισπράξεις του καθολικού στο διάστημα."""
        q: dict = {"group_id": _oid(gid)}
        if df or dt:
            rng: dict = {}
            if df:
                rng["$gte"] = df
            if dt:
                rng["$lt"] = dt
            q["at"] = rng
        agg = {"charges": 0, "receipts": 0}
        async for r in self._coll.aggregate([
                {"$match": self._scope(q)},
                {"$group": {"_id": "$kind", "s": {"$sum": "$amount_cents"}}}]):
            if r["_id"] == RECEIPT:
                agg["receipts"] += r["s"]
            else:                                # manual / adjustment → χρέωση (adjustment μπορεί αρνητικό)
                agg["charges"] += r["s"]
        return agg

    # ── κατάσταση λογαριασμού ─────────────────────────────────────────────────────────
    async def statement(self, gid: str, month: str) -> dict | None:
        """Εκκαθαριστικό μήνα με ΜΕΤΑΦΟΡΑ ΥΠΟΛΟΙΠΟΥ — όπως το διαβάζει ήδη ο φαρμακοποιός."""
        g = await self._group(gid)
        if not g:
            return None
        start, end = _month_bounds(month)
        wins = await self._member_windows(g)

        prev_c = sum((await self._charges(wins, None, start)).values())
        prev_m = await self._manual_total(gid, None, start)
        opening = prev_c + prev_m["charges"] - prev_m["receipts"]

        cur = await self._charges(wins, start, end)
        cur_m = await self._manual_total(gid, start, end)
        charges = sum(cur.values()) + cur_m["charges"]
        closing = opening + charges - cur_m["receipts"]

        rows = [{"patient_id": str(w["_id"]), "name": w["name"], "deceased": w["deceased"],
                 "amount": cur.get(str(w["_id"]), 0)} for w in wins]
        rows.sort(key=lambda r: -r["amount"])

        entries = [e async for e in self._coll.find(
            self._scope({"group_id": _oid(gid), "at": {"$gte": start, "$lt": end}})
        ).sort("at", 1)]
        for e in entries:
            e["_id"], e["group_id"] = str(e["_id"]), str(e["group_id"])

        return {"group": {"id": str(g["_id"]), "name": g.get("name"),
                          "care_type": g.get("care_type")},
                "month": f"{start.year}-{start.month:02d}",
                "opening": opening, "charges": charges,
                "receipts": cur_m["receipts"], "closing": closing,
                "by_member": rows, "entries": entries}

    async def balance(self, gid: str) -> int:
        g = await self._group(gid)
        if not g:
            return 0
        wins = await self._member_windows(g)
        m = await self._manual_total(gid, None, None)
        return sum((await self._charges(wins, None, None)).values()) + m["charges"] - m["receipts"]

    async def portfolio(self) -> dict:
        """Όλες οι δομές μαζί: ανοιχτό υπόλοιπο, από πότε, πότε πληρώθηκε τελευταία φορά."""
        groups = [g async for g in self._db["patient_groups"].find(
            {"tenant_id": self.tenant_id, "kind": "care", "active": {"$ne": False}}).sort("name", 1)]
        items, total = [], 0
        for g in groups:
            gid = str(g["_id"])
            bal = await self.balance(gid)
            last = await self._coll.find_one(self._scope({"group_id": g["_id"], "kind": RECEIPT}),
                                             sort=[("at", -1)])
            # «Από πότε κουβαλιέται»: η παλαιότερη εκτέλεση που δεν έχει ακόμη καλυφθεί δεν
            # μπορεί να προσδιοριστεί (δεν ξέρουμε τι πλήρωσε τι) — δίνουμε την τελευταία
            # είσπραξη, που είναι το μόνο αληθινό σημείο αναφοράς.
            items.append({"id": gid, "name": g.get("name"), "care_type": g.get("care_type"),
                          "members": len([m for m in (g.get("members") or [])
                                          if not m.get("left_at")]),
                          "balance": bal,
                          "last_receipt_at": (last or {}).get("at"),
                          "last_receipt": (last or {}).get("amount_cents")})
            total += bal
        items.sort(key=lambda x: -x["balance"])
        return {"items": items, "total_open": total}

    # ── εγγραφές καθολικού ────────────────────────────────────────────────────────────
    async def add_entry(self, gid: str, *, kind: str, amount_cents: int,
                        at: datetime | None = None, note: str = "",
                        by: str | None = None) -> dict:
        if kind not in (RECEIPT, MANUAL, ADJUST):
            return {"ok": False, "error": "bad_kind"}
        amt = int(amount_cents or 0)
        if amt == 0:
            return {"ok": False, "error": "zero_amount"}
        if kind == RECEIPT and amt < 0:
            return {"ok": False, "error": "negative_receipt"}
        g = await self._group(gid)
        if not g:
            return {"ok": False, "error": "no_group"}
        doc = {"tenant_id": self.tenant_id, "group_id": g["_id"], "kind": kind,
               "amount_cents": amt, "at": at or _now(),
               "note": str(note or "").strip()[:200], "by_user": by, "created_at": _now()}
        res = await self._coll.insert_one(doc)     # tenant-ok: το doc κουβαλά tenant_id
        return {"ok": True, "id": str(res.inserted_id), "balance": await self.balance(gid)}

    async def delete_entry(self, gid: str, eid: str) -> dict:
        r = await self.delete_many({"_id": _oid(eid), "group_id": _oid(gid)})
        return {"ok": bool(r.deleted_count), "balance": await self.balance(gid)}

    # ── ο κύκλος ετοιμασίας ───────────────────────────────────────────────────────────
    async def cycle(self, gid: str, *, days: int = 30) -> dict | None:
        """Τι πρέπει να έχει έτοιμο το φαρμακείο για αυτή τη δομή.

        Η λογική ζει στο `services/group_lists.py` — ΤΗΝ ΙΔΙΑ χρησιμοποιεί και η οθόνη των
        Οικογενειών. Δύο αντίγραφα θα απαντούσαν με διαφορετικούς κανόνες στο ίδιο ερώτημα.
        """
        from app.services import group_lists
        g = await self._group(gid)
        if not g:
            return None
        wins = await self._member_windows(g)
        ids = [w["_id"] for w in wins]
        names = {str(w["_id"]): w["name"] for w in wins}
        lists = await group_lists.everything(self._db, self.tenant_id, ids, names, days=days)
        dead = {str(w["_id"]) for w in wins if w["deceased"]}
        for o in lists["opening"]:
            o["deceased"] = o["patient_id"] in dead
        return {"group": {"id": str(g["_id"]), "name": g.get("name"),
                          "care_type": g.get("care_type")},
                "horizon_days": days, **lists}
