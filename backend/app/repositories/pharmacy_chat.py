"""Συνομιλία μεταξύ συνεργαζόμενων φαρμακείων — ομάδες, προσκλήσεις, μηνύματα.

ΓΙΑΤΙ ΔΕΝ ΠΕΡΝΑΕΙ ΑΠΟ BaseRepository: όλα τα άλλα δεδομένα ανήκουν σε ΕΝΑ φαρμακείο και ο
φρουρός του tenant είναι σωστός από κατασκευή. Εδώ το αντικείμενο είναι εξ ορισμού ΔΙΑΤΕΝΑΝΤ —
μια ομάδα ΑΝΗΚΕΙ σε πολλά φαρμακεία. Ένα `tenant_id` φίλτρο θα ήταν είτε λάθος είτε ψευδής
ασφάλεια. Γι' αυτό η ορατότητα ορίζεται ΜΙΑ φορά, στο `_visible_q()`, και κάθε ανάγνωση περνά
υποχρεωτικά από εκεί.

ΤΙ ΒΛΕΠΕΙ ΕΝΑΣ ΣΥΜΜΕΤΕΧΩΝ: μήνυμα ομάδας στην οποία ΑΝΗΚΕΙ, και μέσα σ' αυτήν είτε μήνυμα προς
όλους, είτε μήνυμα που έστειλε ο ίδιος, είτε μήνυμα που απευθύνεται σ' αυτόν. Τίποτα άλλο.

GDPR: η συνομιλία είναι ΜΕΤΑΞΥ ΔΙΑΦΟΡΕΤΙΚΩΝ ΥΠΕΥΘΥΝΩΝ ΕΠΕΞΕΡΓΑΣΙΑΣ. Δεν μεταφέρεται κανένα
δεδομένο ασθενή αυτόματα· ό,τι γράψει ο φαρμακοποιός είναι δική του ευθύνη και η οθόνη το λέει.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db

GROUPS = "pharmacy_groups"
INVITES = "pharmacy_group_invites"
MESSAGES = "pharmacy_chat_messages"

PENDING, ACCEPTED, DECLINED = "pending", "accepted", "declined"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _afm(v: Any) -> str:
    """ΑΦΜ = μόνο ψηφία. Ο φαρμακοποιός το γράφει με κενά/τελείες και δεν πρέπει να αποτύχει."""
    return re.sub(r"\D", "", str(v or ""))[:20]


def _oid(v: Any) -> ObjectId | None:
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


class PharmacyChatRepository:
    """Όλες οι λειτουργίες δουλεύουν ΓΙΑ ΤΟΝ `me` — ποτέ «για όλους»."""

    def __init__(self, *, tenant_id: str) -> None:
        self.me = tenant_id
        self._db = shared_db()

    # ── ομάδες ───────────────────────────────────────────────────────────────────────────────
    async def my_group_ids(self) -> list[ObjectId]:
        return [g["_id"] async for g in
                self._db[GROUPS].find({"members": self.me}, {"_id": 1})]

    async def _member_of(self, group_id: ObjectId) -> bool:
        return bool(await self._db[GROUPS].find_one({"_id": group_id, "members": self.me},
                                                    {"_id": 1}))

    async def groups(self) -> list[dict]:
        """Οι ομάδες μου: και η δική μου και όσες με δέχτηκαν."""
        out = []
        async for g in self._db[GROUPS].find({"members": self.me}).sort("created_at", 1):
            names = await self._names(g.get("members") or [])
            unread = await self._db[MESSAGES].count_documents({
                "group_id": g["_id"], "from_tenant_id": {"$ne": self.me},
                "read_by": {"$ne": self.me},
                "$or": [{"to_tenant_id": None}, {"to_tenant_id": self.me}]})
            out.append({"id": str(g["_id"]), "name": g.get("name"),
                        "owner": g.get("owner_tenant_id") == self.me,
                        "members": [{"tenant_id": m, "name": names.get(m, m)}
                                    for m in (g.get("members") or [])],
                        "unread": unread})
        return out

    async def _names(self, tenant_ids: list[str]) -> dict[str, str]:
        return {t["_id"]: t.get("name") or t["_id"] async for t in
                self._db["tenants"].find({"_id": {"$in": tenant_ids}}, {"name": 1})}

    async def create_group(self, name: str) -> dict:
        doc = {"name": (name or "").strip()[:80] or "Η ομάδα μου",
               "owner_tenant_id": self.me, "members": [self.me], "created_at": _now()}
        res = await self._db[GROUPS].insert_one(doc)
        return {"ok": True, "id": str(res.inserted_id), "name": doc["name"]}

    # ── προσκλήσεις ──────────────────────────────────────────────────────────────────────────
    async def invite(self, group_id: str, afm: str) -> dict:
        """Πρόσκληση φαρμακείου με ΑΦΜ. ΜΟΝΟ ο ιδιοκτήτης της ομάδας προσκαλεί."""
        gid = _oid(group_id)
        g = await self._db[GROUPS].find_one({"_id": gid, "owner_tenant_id": self.me})
        if not g:
            return {"ok": False, "error": "not_owner",
                    "message": "Μόνο ο δημιουργός της ομάδας μπορεί να προσκαλεί."}
        num = _afm(afm)
        if not num:
            return {"ok": False, "error": "bad_afm", "message": "Γράψε έγκυρο ΑΦΜ."}
        target = await self._find_by_afm(num)
        if not target:
            return {"ok": False, "error": "not_found",
                    "message": "Δεν βρέθηκε φαρμακείο με αυτό το ΑΦΜ στο RxVision."}
        if target == self.me:
            return {"ok": False, "error": "self", "message": "Αυτό είναι το δικό σου ΑΦΜ."}
        if target in (g.get("members") or []):
            return {"ok": False, "error": "already", "message": "Είναι ήδη στην ομάδα."}
        block = await self._subscription_block(target)
        if block:
            return block
        if await self._db[INVITES].find_one({"group_id": gid, "to_tenant_id": target,
                                             "status": PENDING}):
            return {"ok": False, "error": "pending",
                    "message": "Υπάρχει ήδη πρόσκληση που περιμένει απάντηση."}
        await self._db[INVITES].insert_one({
            "group_id": gid, "group_name": g.get("name"), "from_tenant_id": self.me,
            "to_tenant_id": target, "to_afm": num, "status": PENDING, "created_at": _now()})
        return {"ok": True, "invited": target}

    async def _subscription_block(self, target: str) -> dict | None:
        """Μπορεί αυτό το ΑΦΜ να μπει σε ομάδα; None = ναι, αλλιώς το μήνυμα άρνησης.

        ΚΑΝΟΝΑΣ (ιδιοκτήτης 23/09/2026): χρειάζεται ΕΝΕΡΓΗ συνδρομή. Η **δοκιμαστική ΔΕΝ
        αρκεί** — αλλιώς θα έμπαινε στο δίκτυο κάποιος που σε δεκαπέντε μέρες φεύγει, και τα
        μηνύματά του θα έμεναν σε ομάδες πληρωμένων πελατών. Σε δοκιμαστικό το ανοίγουμε ΕΜΕΙΣ
        χειροκίνητα: αν του έχει δοθεί ρητά το module, περνάει κανονικά.
        """
        from app.services.billing_service import effective_status
        t = await self._db["tenants"].find_one({"_id": target}, {"name": 1, "modules": 1}) or {}
        granted = (t.get("modules") or {}).get("pharmacy_chat") in ("enabled", "trial")
        if granted:
            return None
        sub = await self._db["subscriptions"].find_one({"tenant_id": target})
        st = effective_status(sub)
        if st == "active":
            return None
        name = t.get("name") or "Το φαρμακείο"
        if st == "trial":
            return {"ok": False, "error": "trial_only",
                    "message": f"Το «{name}» είναι σε δοκιμαστική περίοδο. Επικοινώνησε μαζί μας "
                               "για να ενεργοποιηθεί η συμμετοχή του σε ομάδες."}
        return {"ok": False, "error": "no_subscription",
                "message": f"Το «{name}» δεν έχει ενεργή συνδρομή RxVision."}

    async def _find_by_afm(self, num: str) -> str | None:
        """Το ΑΦΜ ζει σε δύο σημεία (company/billing_profile) — κοιτάμε και τα δύο, γιατί
        αλλιώς η πρόσκληση αποτυγχάνει για μισούς πελάτες χωρίς προφανή λόγο."""
        for f in ("company.vat", "company.afm", "billing_profile.vat", "billing_profile.afm",
                  "vat", "afm"):
            t = await self._db["tenants"].find_one({f: {"$regex": f"^0*{num}$"}}, {"_id": 1})
            if t:
                return t["_id"]
        return None

    async def my_invites(self) -> list[dict]:
        out = []
        async for i in self._db[INVITES].find({"to_tenant_id": self.me, "status": PENDING}):
            names = await self._names([i["from_tenant_id"]])
            out.append({"id": str(i["_id"]), "group": i.get("group_name"),
                        "from": names.get(i["from_tenant_id"], i["from_tenant_id"]),
                        "created_at": i.get("created_at")})
        return out

    async def respond(self, invite_id: str, accept: bool) -> dict:
        iid = _oid(invite_id)
        inv = await self._db[INVITES].find_one({"_id": iid, "to_tenant_id": self.me,
                                                "status": PENDING})
        if not inv:
            return {"ok": False, "error": "not_found"}
        await self._db[INVITES].update_one(
            {"_id": iid}, {"$set": {"status": ACCEPTED if accept else DECLINED,
                                    "responded_at": _now()}})
        if accept:
            await self._db[GROUPS].update_one({"_id": inv["group_id"]},
                                              {"$addToSet": {"members": self.me}})
        return {"ok": True, "accepted": accept}

    async def leave(self, group_id: str) -> dict:
        """Αποχώρηση. Ο ιδιοκτήτης δεν φεύγει — θα έμενε ομάδα χωρίς υπεύθυνο."""
        gid = _oid(group_id)
        g = await self._db[GROUPS].find_one({"_id": gid})
        if not g or self.me not in (g.get("members") or []):
            return {"ok": False, "error": "not_member"}
        if g.get("owner_tenant_id") == self.me:
            return {"ok": False, "error": "owner",
                    "message": "Είσαι ο δημιουργός — διέγραψε την ομάδα αντί να αποχωρήσεις."}
        await self._db[GROUPS].update_one({"_id": gid}, {"$pull": {"members": self.me}})
        return {"ok": True}

    # ── μηνύματα ─────────────────────────────────────────────────────────────────────────────
    def _visible_q(self, group_ids: list[ObjectId]) -> dict:
        """Ο ΜΟΝΟΣ ορισμός του τι βλέπει ο `me`. Κάθε ανάγνωση περνά από εδώ.

        Μήνυμα ομάδας στην οποία ανήκει ΚΑΙ (προς όλους Ή δικό του Ή προς αυτόν).
        """
        return {"group_id": {"$in": group_ids},
                "$or": [{"to_tenant_id": None},
                        {"to_tenant_id": self.me},
                        {"from_tenant_id": self.me}]}

    async def send(self, group_id: str, body: str, *, to_tenant_id: str | None = None,
                   user_name: str | None = None) -> dict:
        gid = _oid(group_id)
        if not gid or not await self._member_of(gid):
            return {"ok": False, "error": "not_member"}
        text = (body or "").strip()[:2000]
        if not text:
            return {"ok": False, "error": "empty"}
        if to_tenant_id:
            # Ιδιωτικό μήνυμα ΜΟΝΟ σε μέλος της ίδιας ομάδας — αλλιώς η ομάδα θα γινόταν
            # δίοδος για να γράψει κανείς σε οποιονδήποτε.
            g = await self._db[GROUPS].find_one({"_id": gid, "members": to_tenant_id},
                                                {"_id": 1})
            if not g:
                return {"ok": False, "error": "not_in_group"}
        res = await self._db[MESSAGES].insert_one({
            "group_id": gid, "from_tenant_id": self.me, "from_user": (user_name or "")[:80],
            "to_tenant_id": to_tenant_id, "body": text,
            "read_by": [self.me], "created_at": _now()})
        return {"ok": True, "id": str(res.inserted_id)}

    async def thread(self, group_id: str, *, with_tenant: str | None = None,
                     limit: int = 200) -> dict:
        gid = _oid(group_id)
        if not gid or not await self._member_of(gid):
            return {"ok": False, "error": "not_member"}
        q = self._visible_q([gid])
        if with_tenant:                      # ιδιωτική συνομιλία με συγκεκριμένο φαρμακείο
            q = {"$and": [q, {"$or": [
                {"from_tenant_id": self.me, "to_tenant_id": with_tenant},
                {"from_tenant_id": with_tenant, "to_tenant_id": self.me}]}]}
        else:                                # μόνο τα «προς όλους»
            q = {"$and": [q, {"to_tenant_id": None}]}
        rows = [m async for m in self._db[MESSAGES].find(q).sort("created_at", -1).limit(limit)]
        rows.reverse()
        names = await self._names(list({m["from_tenant_id"] for m in rows}))
        ids = [m["_id"] for m in rows]
        if ids:
            await self._db[MESSAGES].update_many({"_id": {"$in": ids}},
                                                 {"$addToSet": {"read_by": self.me}})
        return {"ok": True, "items": [{
            "id": str(m["_id"]), "body": m.get("body"),
            "from_tenant_id": m.get("from_tenant_id"),
            "from": names.get(m.get("from_tenant_id"), m.get("from_tenant_id")),
            "from_user": m.get("from_user"), "mine": m.get("from_tenant_id") == self.me,
            "private": bool(m.get("to_tenant_id")), "created_at": m.get("created_at"),
        } for m in rows]}

    async def unread_total(self) -> int:
        gids = await self.my_group_ids()
        if not gids:
            return 0
        return await self._db[MESSAGES].count_documents({
            **self._visible_q(gids), "from_tenant_id": {"$ne": self.me},
            "read_by": {"$ne": self.me}})
