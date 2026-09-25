"""Ομάδες ασφαλισμένων — Φάση 1: ΟΙΚΟΓΕΝΕΙΕΣ.

ΤΙ ΕΙΝΑΙ: ο φαρμακοποιός ομαδοποιεί ασφαλισμένους που τους εξυπηρετεί μαζί, και βλέπει με μια
ματιά τι τρέχει σε ΟΛΟΥΣ — εκτελέσεις, τι μένει ανεκτέλεστο, τι χρωστούν σε δανεικά, πότε
ανοίγει η επόμενη επανάληψη.

ΤΟ ΜΕΛΟΣ ΕΙΝΑΙ ΨΕΥΔΩΝΥΜΟ, ΟΧΙ ΕΓΓΡΑΦΗ ΑΣΘΕΝΗ. Κρατάμε `pseudo_id` = HMAC(ΑΜΚΑ, pepper του
φαρμακείου) — ντετερμινιστικό, οπότε ο φαρμακοποιός μπορεί να καταχωρήσει ΑΜΚΑ ατόμου που ΔΕΝ
έχει ακόμη καμία εκτέλεση σε εμάς, και το μέλος «ανάβει» μόνο του μόλις κατέβει η πρώτη
συνταγή. Επαληθεύτηκε 25/09/2026: 500/500 ανακατασκευή ψευδωνύμου από ΑΜΚΑ.

⚠ ΠΟΤΕ ΑΚΑΤΕΡΓΑΣΤΟ ΑΜΚΑ ΣΤΗΝ ΟΜΑΔΑ. Το ΑΜΚΑ μπαίνει μόνο ως είσοδος, γίνεται ψευδώνυμο στη
μνήμη και πετιέται — ακριβώς όπως στην άντληση.

⚠ ΔΥΟ ΔΙΑΦΟΡΕΤΙΚΑ ΑΝΑΓΝΩΡΙΣΤΙΚΑ. Το `patients_anonymized._id` είναι ObjectId και ΑΥΤΟ κρατούν
οι εκτελέσεις ως `patient_ref`· το `pseudo_id` είναι το HMAC. Αποθηκεύουμε το δεύτερο (σταθερό,
υπολογίσιμο) και μεταφράζουμε στο πρώτο τη στιγμή της ανάγνωσης.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository
from app.services import recoverable
from app.utils.amka import is_minor, turns_adult_on
from app.utils.masking import mask_amka, mask_name

FAMILY, CARE = "family", "care"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v: Any) -> ObjectId | None:
    try:
        return v if isinstance(v, ObjectId) else ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


class PatientGroupRepository(BaseRepository):
    collection_name = "patient_groups"

    # ── ομάδες ────────────────────────────────────────────────────────────────────────
    async def list_groups(self, *, kind: str = FAMILY, q: str | None = None,
                          include_inactive: bool = False) -> list[dict]:
        query: dict = {"kind": kind}
        if not include_inactive:
            query["active"] = {"$ne": False}
        if q and q.strip():
            import re
            query["name"] = {"$regex": re.escape(q.strip()), "$options": "i"}
        rows = await self.find(query, sort=[("name", 1)], limit=500)
        for r in rows:
            r["_id"] = str(r["_id"])
            r["member_count"] = len([m for m in (r.get("members") or []) if not m.get("left_at")])
            r.pop("members", None)          # η λίστα δεν χρειάζεται τα ψευδώνυμα
        return rows

    async def create(self, *, kind: str, name: str, by: str | None = None) -> dict:
        name = str(name or "").strip()
        if not name:
            return {"ok": False, "error": "no_name"}
        doc = {"tenant_id": self.tenant_id, "kind": kind, "name": name[:120],
               "members": [], "active": True,
               "created_at": _now(), "updated_at": _now(), "created_by": by}
        res = await self._coll.insert_one(doc)   # tenant-ok: το doc κουβαλά tenant_id
        return {"ok": True, "id": str(res.inserted_id)}

    async def rename(self, gid: str, name: str) -> dict:
        name = str(name or "").strip()
        if not name:
            return {"ok": False, "error": "no_name"}
        r = await self.update_one({"_id": _oid(gid)},
                                  {"$set": {"name": name[:120], "updated_at": _now()}})
        return {"ok": bool(r.matched_count)}

    async def update_care(self, gid: str, **fields) -> dict:
        """Ρυθμίσεις ΔΟΜΗΣ: τύπος φορέα, κύκλος, στοιχεία τιμολόγησης, «χρεώσεις από»."""
        allowed = {"care_type", "cycle", "billing", "charges_from"}
        sets = {k: v for k, v in fields.items() if k in allowed and v is not None}
        if not sets:
            return {"ok": False, "error": "nothing_to_set"}
        sets["updated_at"] = _now()
        # «Χρεώσεις από» σημαίνει «γι' ΑΥΤΗ τη δομή, από εδώ». Πρέπει να πιάσει και όσους είναι
        # ΗΔΗ μέσα: στο στήσιμο ο φαρμακοποιός καταχωρεί 40 τροφίμους που μένουν εκεί μήνες, και
        # το `joined_at` τους είναι «τώρα» — χωρίς αυτό θα έβγαζαν όλοι μηδέν χρέωση.
        # Όποιος μπει ΑΡΓΟΤΕΡΑ χρεώνεται από τη μέρα που μπήκε.
        if "charges_from" in sets:
            sets["members.$[].charges_from"] = sets["charges_from"]
        r = await self.update_one({"_id": _oid(gid), "kind": CARE}, {"$set": sets})
        return {"ok": bool(r.matched_count)}

    async def set_active(self, gid: str, active: bool) -> dict:
        r = await self.update_one({"_id": _oid(gid)},
                                  {"$set": {"active": bool(active), "updated_at": _now()}})
        return {"ok": bool(r.matched_count)}

    async def delete(self, gid: str) -> dict:
        r = await self.delete_many({"_id": _oid(gid)})
        return {"ok": bool(r.deleted_count)}

    # ── μέλη ──────────────────────────────────────────────────────────────────────────
    async def add_member(self, gid: str, *, amka: str | None = None, pseudo_id: str | None = None,
                         patient_id: str | None = None,
                         label: str | None = None, role: str | None = None) -> dict:
        """Τρεις είσοδοι, ένα αποτέλεσμα: ψευδώνυμο.

        `patient_id` → από την αναζήτηση (ο πελάτης υπάρχει ήδη). ΠΡΟΤΙΜΗΣΕ ΑΥΤΟ: το ΑΜΚΑ δεν
        χρειάζεται καν να ταξιδέψει, και στους πελάτες παρουσίασης έρχεται καλυμμένο.
        `amka`       → για άτομο που ΔΕΝ έχει ακόμη δεδομένα.
        `pseudo_id`  → όταν το ξέρει ήδη ο καλών.
        """
        ps = (pseudo_id or "").strip()
        if not ps and patient_id:
            pid = _oid(patient_id)
            p = await self._db["patients_anonymized"].find_one(
                {"tenant_id": self.tenant_id, "_id": pid}, {"pseudo_id": 1}) if pid else None
            if not p or not p.get("pseudo_id"):
                return {"ok": False, "error": "no_patient"}
            ps = p["pseudo_id"]
        if not ps:
            raw = str(amka or "").strip()
            if not raw.isdigit() or len(raw) != 11:
                return {"ok": False, "error": "bad_amka"}
            from app.services.vault_service import vault
            from app.utils.anonymization import pseudonymize
            # Το ακατέργαστο ΑΜΚΑ ζει ΜΟΝΟ εδώ, μέσα σε αυτή τη γραμμή.
            ps = pseudonymize(raw, tenant_pepper=vault.tenant_pepper(self.tenant_id))
        # ΦΡΑΓΜΑ ΘΑΝΟΝΤΑ — ΕΝΑ σημείο, στην είσοδο. Ιστορικό βλέπει όποιος ήταν ήδη μέλος·
        # ΝΕΑ ένταξη θανόντα δεν επιτρέπεται, γιατί η ομάδα υπάρχει για να γίνονται ενέργειες.
        # (Η αναζήτηση ήδη τους αποκλείει — αυτό πιάνει τον δρόμο «με ΑΜΚΑ».)
        dead = await self._db["patients_anonymized"].find_one(
            {"tenant_id": self.tenant_id, "pseudo_id": ps, "deceased": True}, {"_id": 1})
        if dead:
            return {"ok": False, "error": "deceased"}
        g = await self._coll.find_one(self._scope({"_id": _oid(gid)}), {"members": 1})
        if not g:
            return {"ok": False, "error": "no_group"}
        if any(m.get("pseudo_id") == ps and not m.get("left_at") for m in (g.get("members") or [])):
            return {"ok": False, "error": "already_member"}
        await self.update_one({"_id": _oid(gid)}, {
            "$push": {"members": {"pseudo_id": ps, "label": (label or "").strip()[:60] or None,
                                  "role": (role or "").strip()[:30] or None,
                                  "joined_at": _now(), "left_at": None}},
            "$set": {"updated_at": _now()}})
        return {"ok": True, "pseudo_id": ps}

    async def remove_member(self, gid: str, pseudo_id: str) -> dict:
        """Αφαίρεση ΟΡΙΣΤΙΚΗ. Δεν κρατάμε «πρώην μέλη» — η ομάδα είναι εργαλείο του σήμερα,
        όχι αρχείο συγγένειας· ένα ιστορικό «ποιος ήταν κάποτε στην οικογένεια» θα ήταν
        δεδομένο που κανείς δεν ζήτησε και κανείς δεν θα συντηρούσε."""
        r = await self.update_one({"_id": _oid(gid)},
                                  {"$pull": {"members": {"pseudo_id": pseudo_id}},
                                   "$set": {"updated_at": _now()}})
        return {"ok": bool(r.matched_count)}

    async def update_member(self, gid: str, pseudo_id: str, *, label: str | None = None,
                            role: str | None = None) -> dict:
        sets: dict = {"updated_at": _now()}
        if label is not None:
            sets["members.$[m].label"] = str(label).strip()[:60] or None
        if role is not None:
            sets["members.$[m].role"] = str(role).strip()[:30] or None
        r = await self._coll.update_one(
            self._scope({"_id": _oid(gid)}), {"$set": sets},
            array_filters=[{"m.pseudo_id": pseudo_id}])
        return {"ok": bool(r.matched_count)}

    async def groups_for_patient(self, patient_id: Any) -> list[dict]:
        """Σε ποιες ομάδες ανήκει ένας ασθενής — για το σήμα στην Εικόνα Πελάτη."""
        pid = _oid(patient_id)
        if pid is None:
            return []
        p = await self._db["patients_anonymized"].find_one(
            {"tenant_id": self.tenant_id, "_id": pid}, {"pseudo_id": 1})
        if not p or not p.get("pseudo_id"):
            return []
        rows = await self.find({"members.pseudo_id": p["pseudo_id"], "active": {"$ne": False}},
                               limit=20)
        return [{"id": str(r["_id"]), "kind": r.get("kind"), "name": r.get("name")} for r in rows]

    # ── η συγκεντρωτική εικόνα ────────────────────────────────────────────────────────
    async def detail(self, gid: str, *, date_from: datetime, date_to: datetime) -> dict | None:
        """Ομάδα + μία γραμμή ανά μέλος.

        ΟΛΑ ΤΑ ΕΡΩΤΗΜΑΤΑ ΕΙΝΑΙ ΟΜΑΔΙΚΑ, ΟΧΙ ΑΝΑ ΜΕΛΟΣ: μια οικογένεια έχει 4 μέλη, ένα
        γηροκομείο 40. Ένα ερώτημα ανά μέλος θα σήμαινε 200 ταξίδια στη βάση για μία οθόνη.
        """
        g = await self._coll.find_one(self._scope({"_id": _oid(gid)}))
        if not g:
            return None
        members = [m for m in (g.get("members") or []) if not m.get("left_at")]
        pseudos = [m["pseudo_id"] for m in members if m.get("pseudo_id")]

        # ψευδώνυμο → εγγραφή ασθενή (όσοι έχουν ήδη δεδομένα· οι υπόλοιποι μένουν «σε αναμονή»)
        pat_by_pseudo: dict[str, dict] = {}
        if pseudos:
            async for p in self._db["patients_anonymized"].find(
                    {"tenant_id": self.tenant_id, "pseudo_id": {"$in": pseudos}},
                    {"pseudo_id": 1, "full_name": 1, "amka": 1, "sex": 1, "birth_year": 1,
                     "deceased": 1, "lifecycle": 1, "last_seen_at": 1}):
                pat_by_pseudo[p["pseudo_id"]] = p

        ids = [p["_id"] for p in pat_by_pseudo.values()]
        stats = await self._member_stats(ids, date_from=date_from, date_to=date_to)

        rows, totals = [], {"executions": 0, "value": 0, "patient_share": 0,
                            "unexec_value": 0, "loans": 0, "pending": 0}
        for m in members:
            ps = m.get("pseudo_id")
            p = pat_by_pseudo.get(ps)
            st = stats.get(str(p["_id"])) if p else None
            minor = bool(p) and is_minor(p.get("amka"), p.get("birth_year"))
            row = {
                "pseudo_id": ps,
                "patient_id": str(p["_id"]) if p else None,
                "label": m.get("label"),
                "role": m.get("role"),
                # «Σε αναμονή» = καταχωρήθηκε το ΑΜΚΑ αλλά δεν έχει έρθει ακόμη καμία συνταγή.
                "pending": p is None,
                "name": mask_name(p.get("full_name"), self.demo) if p else (m.get("label") or "—"),
                "amka": mask_amka(p.get("amka"), self.demo) if p else None,
                "sex": (p or {}).get("sex"),
                "deceased": bool((p or {}).get("deceased")),
                "minor": minor,
                "adult_on": turns_adult_on(p.get("amka"), p.get("birth_year")).isoformat()
                            if minor else None,
                **(st or {"executions": 0, "value": 0, "patient_share": 0,
                          "unexec": 0, "unexec_value": 0, "loans": 0, "next_open": None}),
            }
            rows.append(row)
            for k in ("executions", "value", "patient_share", "unexec_value", "loans"):
                totals[k] += row.get(k) or 0
            totals["pending"] += 1 if row["pending"] else 0

        # Οι εκκρεμότητες πρώτες — η οθόνη υπάρχει για να δείχνει τι θέλει ενέργεια.
        rows.sort(key=lambda r: (-(r["unexec_value"] or 0), -(r["loans"] or 0), r["name"] or ""))
        return {"id": str(g["_id"]), "kind": g.get("kind"), "name": g.get("name"),
                "active": g.get("active", True), "members": rows, "totals": totals}

    async def _member_stats(self, ids: list, *, date_from: datetime,
                            date_to: datetime) -> dict[str, dict]:
        """patient_id (str) → μετρήσεις περιόδου. Τέσσερα ομαδικά ερωτήματα, όχι Ν×4."""
        if not ids:
            return {}
        out: dict[str, dict] = {str(i): {"executions": 0, "value": 0, "patient_share": 0,
                                         "unexec": 0, "unexec_value": 0, "loans": 0,
                                         "next_open": None} for i in ids}
        ex = self._db["prescription_executions"]
        period = {"tenant_id": self.tenant_id, "patient_ref": {"$in": ids},
                  "status": {"$ne": "cancelled"},
                  "executed_at": {"$gte": date_from, "$lt": date_to}}

        # 1) εκτελέσεις: πλήθος, αξία, και ΤΙ ΠΛΗΡΩΣΕ ο ασφαλισμένος (χρήσιμο και στις δομές)
        async for r in ex.aggregate([
                {"$match": period},
                {"$group": {"_id": "$patient_ref", "n": {"$sum": 1},
                            "v": {"$sum": "$amount_total"},
                            "ps": {"$sum": "$patient_share"}}}]):
            b = out.get(str(r["_id"]))
            if b:
                b["executions"], b["value"], b["patient_share"] = r["n"], r["v"], r["ps"]

        # 2) ΑΝΑΚΤΗΣΙΜΑ ανεκτέλεστα — όχι κάθε ανεκτέλεστο. Χάνεται μόνο το ΥΠΟΛΟΙΠΟ των
        #    τεμαχίων, και μόνο όσο η συνταγή είναι ακόμη σε ισχύ (services/recoverable.py).
        async for r in ex.aggregate([
                {"$match": {**period, **recoverable.mongo_filter()}},
                {"$lookup": {"from": "prescription_items", "localField": "_id",
                             "foreignField": "execution_id", "as": "it"}},
                {"$unwind": "$it"},
                {"$set": {"_left": {"$max": [0, {"$subtract": [
                    "$it.quantity", {"$ifNull": ["$it.executed_qty", 0]}]}]}}},
                {"$match": {"_left": {"$gt": 0}}},
                {"$group": {"_id": "$patient_ref", "n": {"$addToSet": "$_id"},
                            "v": {"$sum": {"$multiply": ["$it.retail_price", "$_left"]}}}}]):
            b = out.get(str(r["_id"]))
            if b:
                b["unexec"], b["unexec_value"] = len(r["n"]), r["v"]

        # 3) πότε ανοίγει η επόμενη επανάληψη — η βάση της «λίστας ετοιμασίας» των δομών
        async for r in ex.aggregate([
                {"$match": {"tenant_id": self.tenant_id, "patient_ref": {"$in": ids},
                            "status": {"$ne": "cancelled"},
                            "next_open_date": {"$gte": _now().replace(tzinfo=None)}}},
                {"$group": {"_id": "$patient_ref", "d": {"$min": "$next_open_date"}}}]):
            b = out.get(str(r["_id"]))
            if b:
                b["next_open"] = r["d"]

        # 4) ανοιχτά δανεικά — το `patient_ref` εκεί άλλοτε ObjectId κι άλλοτε κείμενο
        strs = [str(i) for i in ids]
        async for r in self._db["advance_dispensings"].aggregate([
                {"$match": {"tenant_id": self.tenant_id, "status": "open",
                            "patient_ref": {"$in": ids + strs}}},
                {"$group": {"_id": {"$toString": "$patient_ref"}, "n": {"$sum": 1}}}]):
            b = out.get(str(r["_id"]))
            if b:
                b["loans"] = r["n"]
        return out
