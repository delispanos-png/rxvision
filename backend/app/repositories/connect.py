"""RxVision Connect — δίκτυα συνεργασίας φαρμακείων: ομάδες, αιτήματα, προσφορές, κινήσεις.

ΓΙΑΤΙ ΔΕΝ ΠΕΡΝΑΕΙ ΑΠΟ BaseRepository (τεκμηριωμένη εξαίρεση στον ΕΝΑ κανόνα του CLAUDE.md):
κάθε άλλο δεδομένο ανήκει σε ΕΝΑ φαρμακείο, οπότε ο φρουρός `tenant_id` είναι σωστός από
κατασκευή. Εδώ το αντικείμενο είναι εξ ορισμού ΔΙΑΤΕΝΑΝΤ — μια ομάδα ανήκει σε πολλά
φαρμακεία και ένα αίτημα διαβάζεται από άλλον tenant. Ένα `tenant_id` φίλτρο θα ήταν ψευδής
ασφάλεια. Γι' αυτό η ορατότητα ορίζεται ΜΙΑ φορά, στο `_my_groups()` + `_visible_*_q()`, και
κάθε ανάγνωση περνά υποχρεωτικά από εκεί. Το `tests/test_connect.py` το κρατά ειλικρινές.

ΤΙ ΒΛΕΠΕΙ ΕΝΑΣ ΣΥΜΜΕΤΕΧΩΝ: ομάδες στις οποίες ανήκει· αιτήματα που απευθύνονται σε αυτές τις
ομάδες ή που έστειλε ο ίδιος· προσφορές πάνω σε αιτήματα που βλέπει, και από αυτές μόνο τις
δικές του ή όσες απευθύνονται σε αυτόν· κινήσεις όπου είναι αφετηρία ή προορισμός. Τίποτα άλλο.
Ποτέ δεν αποκαλύπτεται η ύπαρξη ομάδας στην οποία δεν ανήκει (§3 της προδιαγραφής).

ΚΑΝΕΝΑ ΔΕΔΟΜΕΝΟ ΑΣΘΕΝΗ: το κύκλωμα είναι φαρμακείο ↔ φαρμακείο ↔ προϊόν (§29).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db
from app.repositories.base import BaseRepository, jsonsafe
from app.services import pharmacy_directory as directory
from app.services.connect_availability import DEFAULTS, available_qty

GROUPS = "connect_groups"
INVITES = "connect_invites"
REQUESTS = "connect_requests"
OFFERS = "connect_offers"
RESERVATIONS = "connect_reservations"
MOVEMENTS = "connect_movements"
RETURNS = "connect_returns"
SETTLEMENTS = "connect_settlements"
DISPUTES = "connect_disputes"

MODULE = "connect"

# Καταστάσεις — ρητές, γιατί μια κίνηση που «δεν ξέρεις τι είναι» δεν τακτοποιείται ποτέ.
REQ_OPEN, REQ_COVERED, REQ_CLOSED, REQ_CANCELLED = "open", "covered", "closed", "cancelled"
OFF_PENDING, OFF_ACCEPTED, OFF_REJECTED, OFF_WITHDRAWN = ("pending", "accepted", "rejected",
                                                          "withdrawn")
RES_ACTIVE, RES_CONSUMED, RES_EXPIRED, RES_RELEASED = ("active", "consumed", "expired",
                                                       "released")
MOV_PENDING, MOV_COMPLETED, MOV_CANCELLED, MOV_REVIEW = ("pending", "completed", "cancelled",
                                                         "under_review")
RET_REQUESTED, RET_ACCEPTED, RET_COMPLETED, RET_REJECTED = ("requested", "accepted",
                                                            "completed", "rejected")

URGENCIES = ("normal", "today", "urgent")


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v: Any) -> ObjectId | None:
    try:
        return ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


def _qty(v: Any, *, lo: int = 1, hi: int = 9999) -> int:
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return lo


class ConnectPolicyRepository(BaseRepository):
    """Πολιτική διαθεσιμότητας ΑΝΑ ΦΑΡΜΑΚΕΙΟ — ενδοτενάντ, άρα κανονικά μέσω BaseRepository."""

    collection_name = "connect_policies"

    async def get(self) -> dict:
        doc = await self.find_one({}) or {}
        return {**DEFAULTS, "per_group": {}, **{k: v for k, v in doc.items()
                                                if k not in ("_id", "tenant_id")}}

    async def save(self, data: dict) -> dict:
        upd: dict = {}
        for k in ("global_pct", "safety_qty", "reservation_minutes"):
            if data.get(k) is not None:
                upd[k] = max(0, int(data[k]))
        if "global_pct" in upd:
            upd["global_pct"] = min(100, upd["global_pct"])
        if "reservation_minutes" in upd:
            upd["reservation_minutes"] = max(5, min(1440, upd["reservation_minutes"]))
        for k in ("auto_offer", "require_doc_ref"):
            if data.get(k) is not None:
                upd[k] = bool(data[k])
        if isinstance(data.get("per_group"), dict):
            upd["per_group"] = {str(g): max(0, min(100, int(p or 0)))
                                for g, p in data["per_group"].items()}
        upd["updated_at"] = _now()
        await self.update_one({}, {"$set": upd}, upsert=True)
        return await self.get()


class ConnectRepository:
    """Όλες οι λειτουργίες δουλεύουν ΓΙΑ ΤΟΝ `me` — ποτέ «για όλους»."""

    def __init__(self, *, tenant_id: str) -> None:
        self.me = tenant_id
        self._db = shared_db()

    # ── δίκτυο: ομάδες & προσκλήσεις ─────────────────────────────────────────────────────────
    async def _my_groups(self) -> list[ObjectId]:
        return [g["_id"] async for g in self._db[GROUPS].find({"members": self.me}, {"_id": 1})]

    async def _member_of(self, gid: ObjectId) -> bool:
        return bool(await self._db[GROUPS].find_one({"_id": gid, "members": self.me}, {"_id": 1}))

    async def groups(self) -> list[dict]:
        out = []
        async for g in self._db[GROUPS].find({"members": self.me}).sort("created_at", 1):
            names = await directory.names_of(g.get("members") or [])
            out.append({"id": str(g["_id"]), "name": g.get("name"),
                        "owner": g.get("owner_tenant_id") == self.me,
                        "members": [{"tenant_id": m, "name": names.get(m, m)}
                                    for m in (g.get("members") or [])]})
        return out

    async def create_group(self, name: str) -> dict:
        doc = {"name": (name or "").strip()[:80] or "Το δίκτυό μου",
               "owner_tenant_id": self.me, "members": [self.me], "created_at": _now()}
        res = await self._db[GROUPS].insert_one(doc)
        return {"ok": True, "id": str(res.inserted_id), "name": doc["name"]}

    async def delete_group(self, group_id: str) -> dict:
        """Διαγραφή — μόνο από τον δημιουργό, και ΜΟΝΟ αν δεν μένει τίποτα ανοιχτό.

        ΓΙΑΤΙ Ο ΦΡΟΥΡΟΣ: μια ομάδα με ανοιχτές κινήσεις κουβαλά υποχρεώσεις μεταξύ φαρμακείων.
        Αν σβηνόταν, τα υπόλοιπα θα εξαφανίζονταν από τη μια πλευρά και θα έμεναν στην άλλη.
        """
        gid = _oid(group_id)
        g = await self._db[GROUPS].find_one({"_id": gid, "owner_tenant_id": self.me})
        if not g:
            return {"ok": False, "error": "not_owner",
                    "message": "Μόνο ο δημιουργός μπορεί να διαγράψει το δίκτυο."}
        open_movs = await self._db[MOVEMENTS].count_documents(
            {"group_id": gid, "status": {"$in": [MOV_PENDING, MOV_REVIEW]}})
        if open_movs:
            return {"ok": False, "error": "open_movements",
                    "message": f"Υπάρχουν {open_movs} ανοιχτές κινήσεις. Τακτοποίησέ τες πρώτα."}
        await self._db[REQUESTS].update_many({"group_ids": gid, "status": REQ_OPEN},
                                             {"$set": {"status": REQ_CANCELLED}})
        await self._db[INVITES].delete_many({"group_id": gid})
        await self._db[GROUPS].delete_one({"_id": gid})
        return {"ok": True, "members": len(g.get("members") or [])}

    async def leave(self, group_id: str) -> dict:
        gid = _oid(group_id)
        g = await self._db[GROUPS].find_one({"_id": gid})
        if not g or self.me not in (g.get("members") or []):
            return {"ok": False, "error": "not_member"}
        if g.get("owner_tenant_id") == self.me:
            return {"ok": False, "error": "owner",
                    "message": "Είσαι ο δημιουργός — διέγραψε το δίκτυο αντί να αποχωρήσεις."}
        await self._db[GROUPS].update_one({"_id": gid}, {"$pull": {"members": self.me}})
        return {"ok": True}

    async def invite(self, group_id: str, afm: str) -> dict:
        """Πρόσκληση με ΑΦΜ — ο παραλήπτης πρέπει να ΕΧΕΙ ήδη ενεργό το Connect (§3 απόφασης)."""
        gid = _oid(group_id)
        g = await self._db[GROUPS].find_one({"_id": gid, "owner_tenant_id": self.me})
        if not g:
            return {"ok": False, "error": "not_owner",
                    "message": "Μόνο ο δημιουργός του δικτύου μπορεί να προσκαλεί."}
        num = directory.normalize_afm(afm)
        if not num:
            return {"ok": False, "error": "bad_afm", "message": "Γράψε έγκυρο ΑΦΜ."}
        target = await directory.find_tenant_by_afm(num)
        if not target:
            return {"ok": False, "error": "not_found",
                    "message": "Δεν βρέθηκε φαρμακείο με αυτό το ΑΦΜ στο RxVision."}
        if target == self.me:
            return {"ok": False, "error": "self", "message": "Αυτό είναι το δικό σου ΑΦΜ."}
        if target in (g.get("members") or []):
            return {"ok": False, "error": "already", "message": "Είναι ήδη στο δίκτυο."}
        block = await directory.join_block(target, module=MODULE, require_module=True)
        if block:
            return block
        if await self._db[INVITES].find_one({"group_id": gid, "to_tenant_id": target,
                                             "status": "pending"}):
            return {"ok": False, "error": "pending",
                    "message": "Υπάρχει ήδη πρόσκληση που περιμένει απάντηση."}
        await self._db[INVITES].insert_one({
            "group_id": gid, "group_name": g.get("name"), "from_tenant_id": self.me,
            "to_tenant_id": target, "to_afm": num, "status": "pending", "created_at": _now()})
        return {"ok": True, "invited": await directory.tenant_name(target)}

    async def my_invites(self) -> list[dict]:
        out = []
        async for i in self._db[INVITES].find({"to_tenant_id": self.me, "status": "pending"}):
            out.append({"id": str(i["_id"]), "group": i.get("group_name"),
                        "from": await directory.tenant_name(i["from_tenant_id"]),
                        "created_at": i.get("created_at")})
        return out

    async def respond(self, invite_id: str, accept: bool) -> dict:
        iid = _oid(invite_id)
        inv = await self._db[INVITES].find_one({"_id": iid, "to_tenant_id": self.me,
                                                "status": "pending"})
        if not inv:
            return {"ok": False, "error": "not_found"}
        await self._db[INVITES].update_one(
            {"_id": iid}, {"$set": {"status": "accepted" if accept else "declined",
                                    "responded_at": _now()}})
        if accept:
            await self._db[GROUPS].update_one({"_id": inv["group_id"]},
                                              {"$addToSet": {"members": self.me}})
        return {"ok": True, "accepted": accept}

    # ── αιτήματα ─────────────────────────────────────────────────────────────────────────────
    def _visible_requests_q(self, gids: list[ObjectId]) -> dict:
        """Ο ΜΟΝΟΣ ορισμός του ποια αιτήματα βλέπει ο `me`: όσα απευθύνονται σε δίκτυό του,
        συν τα δικά του. Κάθε ανάγνωση αιτήματος περνά από εδώ."""
        return {"$or": [{"group_ids": {"$in": gids}}, {"from_tenant_id": self.me}]}

    async def create_request(self, *, barcode: str, name: str, qty: int, group_ids: list[str],
                             urgency: str = "normal", notes: str = "",
                             hours: int = 48) -> dict:
        mine = {str(g) for g in await self._my_groups()}
        gids = [_oid(g) for g in (group_ids or []) if str(g) in mine]
        if not gids:
            return {"ok": False, "error": "no_groups",
                    "message": "Διάλεξε τουλάχιστον ένα δίκτυο στο οποίο ανήκεις."}
        doc = {"from_tenant_id": self.me, "group_ids": gids,
               "barcode": (barcode or "").strip()[:40] or None,
               "name": (name or "").strip()[:160] or "(χωρίς όνομα)",
               "qty": _qty(qty), "qty_covered": 0,
               "urgency": urgency if urgency in URGENCIES else "normal",
               "notes": (notes or "").strip()[:400] or None,
               "status": REQ_OPEN, "created_at": _now(),
               "expires_at": _now() + timedelta(hours=max(1, min(168, int(hours or 48))))}
        res = await self._db[REQUESTS].insert_one(doc)
        auto = await self._auto_offers(res.inserted_id, doc)
        return {"ok": True, "id": str(res.inserted_id), "auto_offers": auto}

    async def _auto_offers(self, request_id: ObjectId, req: dict) -> int:
        """Αυτόματη απάντηση από όσους ΞΕΡΟΥΜΕ ότι έχουν το είδος στο ράφι τους.

        Απόφαση ιδιοκτήτη 24/09/2026: «απόθεμα που γνωρίζουμε από ράφια απαντά αυτόματα· αν δεν
        υπάρχει απόθεμα, ερώτηση στον φαρμακοποιό». Η αυτόματη προσφορά είναι ΠΑΝΤΑ ανακλητή
        όσο δεν έχει γίνει δεκτή — το φαρμακείο παραμένει κύριος του αποθέματός του.
        """
        if not req.get("barcode"):
            return 0
        made = 0
        remaining = int(req["qty"])
        async for g in self._db[GROUPS].find({"_id": {"$in": req["group_ids"]}}):
            for member in (g.get("members") or []):
                if member == self.me or remaining <= 0:
                    continue
                if await self._db[OFFERS].find_one({"request_id": request_id,
                                                    "from_tenant_id": member}):
                    continue
                qty = await self._auto_qty(member, req["barcode"], str(g["_id"]))
                if not qty:
                    continue
                qty = min(qty, remaining)
                await self._db[OFFERS].insert_one({
                    "request_id": request_id, "group_id": g["_id"], "from_tenant_id": member,
                    "to_tenant_id": self.me, "qty": qty, "mode": "auto",
                    "status": OFF_PENDING, "created_at": _now()})
                made += 1
                remaining -= qty
        return made

    async def _auto_qty(self, tenant_id: str, barcode: str, group_id: str) -> int:
        """Πόσα θα προσφέρει αυτόματα το `tenant_id`· 0 = δεν απαντά αυτόματα."""
        from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
        policy = await ConnectPolicyRepository(tenant_id=tenant_id).get()
        if not policy.get("auto_offer", True):
            return 0
        prod = await PharmacyCatalogRepository(tenant_id=tenant_id).find_one({"barcode": barcode})
        if not prod:
            return 0
        reserved = await self._reserved_qty(tenant_id, barcode)
        return available_qty(prod.get("stock_qty"), policy,
                             group_id=group_id, reserved=reserved) or 0

    async def _reserved_qty(self, tenant_id: str, barcode: str) -> int:
        """Ενεργές, μη ληγμένες κρατήσεις — ΚΑΘΟΛΙΚΑ, όχι ανά ομάδα (σενάριο 13)."""
        tot = 0
        async for r in self._db[RESERVATIONS].find({"tenant_id": tenant_id, "barcode": barcode,
                                                    "status": RES_ACTIVE,
                                                    "expires_at": {"$gt": _now()}}):
            tot += int(r.get("qty") or 0)
        return tot

    async def my_requests(self, *, limit: int = 60) -> list[dict]:
        rows = [r async for r in self._db[REQUESTS].find({"from_tenant_id": self.me})
                .sort("created_at", -1).limit(limit)]
        return [await self._request_view(r, with_offers=True) for r in rows]

    async def inbox(self, *, limit: int = 60) -> list[dict]:
        """Αιτήματα ΠΡΟΣ τα δίκτυά μου — αυτά που περιμένουν τη δική μου απάντηση."""
        gids = await self._my_groups()
        if not gids:
            return []
        rows = [r async for r in self._db[REQUESTS].find(
            {"group_ids": {"$in": gids}, "from_tenant_id": {"$ne": self.me},
             "status": REQ_OPEN}).sort("created_at", -1).limit(limit)]
        out = []
        for r in rows:
            v = await self._request_view(r, with_offers=False)
            mine = await self._db[OFFERS].find_one({"request_id": r["_id"],
                                                    "from_tenant_id": self.me})
            v["my_offer"] = ({"id": str(mine["_id"]), "qty": mine["qty"],
                              "status": mine["status"], "mode": mine.get("mode")}
                             if mine else None)
            v["suggested"] = await self._auto_qty(self.me, r.get("barcode") or "",
                                                  str((r.get("group_ids") or [None])[0]))
            out.append(v)
        return out

    async def _request_view(self, r: dict, *, with_offers: bool) -> dict:
        v = {"id": str(r["_id"]), "barcode": r.get("barcode"), "name": r.get("name"),
             "qty": r.get("qty"), "qty_covered": r.get("qty_covered", 0),
             "urgency": r.get("urgency"), "notes": r.get("notes"), "status": r.get("status"),
             "created_at": r.get("created_at"), "expires_at": r.get("expires_at"),
             "mine": r.get("from_tenant_id") == self.me,
             "from": await directory.tenant_name(r["from_tenant_id"])}
        if with_offers:
            offers = []
            async for o in self._db[OFFERS].find({"request_id": r["_id"]}).sort("created_at", 1):
                offers.append({"id": str(o["_id"]), "qty": o.get("qty"),
                               "status": o.get("status"), "mode": o.get("mode"),
                               "from": await directory.tenant_name(o["from_tenant_id"])})
            v["offers"] = offers
        return v

    async def cancel_request(self, request_id: str) -> dict:
        rid = _oid(request_id)
        r = await self._db[REQUESTS].find_one({"_id": rid, "from_tenant_id": self.me})
        if not r:
            return {"ok": False, "error": "not_found"}
        if r.get("status") not in (REQ_OPEN, REQ_COVERED):
            return {"ok": False, "error": "closed"}
        await self._db[REQUESTS].update_one({"_id": rid}, {"$set": {"status": REQ_CANCELLED}})
        await self._db[OFFERS].update_many({"request_id": rid, "status": OFF_PENDING},
                                           {"$set": {"status": OFF_WITHDRAWN}})
        return {"ok": True}

    # ── προσφορές ────────────────────────────────────────────────────────────────────────────
    async def make_offer(self, request_id: str, qty: int) -> dict:
        """Χειροκίνητη προσφορά — η «αποδοχή» του §8 για είδη χωρίς γνωστό απόθεμα."""
        rid = _oid(request_id)
        gids = await self._my_groups()
        r = await self._db[REQUESTS].find_one({"_id": rid, "status": REQ_OPEN,
                                               "group_ids": {"$in": gids}})
        if not r:
            return {"ok": False, "error": "not_found",
                    "message": "Το αίτημα δεν υπάρχει ή δεν απευθύνεται σε δίκτυό σου."}
        if r["from_tenant_id"] == self.me:
            return {"ok": False, "error": "own", "message": "Είναι το δικό σου αίτημα."}
        remaining = int(r["qty"]) - int(r.get("qty_covered") or 0)
        if remaining <= 0:
            return {"ok": False, "error": "covered", "message": "Το αίτημα καλύφθηκε ήδη."}
        locked = await self._db[OFFERS].find_one({"request_id": rid, "from_tenant_id": self.me,
                                                  "status": OFF_ACCEPTED})
        if locked:
            return {"ok": False, "error": "already_accepted",
                    "message": "Έχεις ήδη δεσμευτεί σε αυτό το αίτημα. Ακύρωσε πρώτα την "
                               "κίνηση αν θέλεις να αλλάξεις ποσότητα."}
        n = min(_qty(qty), remaining)
        gid = next((g for g in (r.get("group_ids") or []) if g in gids), None)
        await self._db[OFFERS].update_one(
            {"request_id": rid, "from_tenant_id": self.me},
            {"$set": {"qty": n, "status": OFF_PENDING, "mode": "manual", "group_id": gid,
                      "to_tenant_id": r["from_tenant_id"], "created_at": _now()}},
            upsert=True)
        return {"ok": True, "qty": n}

    async def withdraw_offer(self, offer_id: str) -> dict:
        """Ανάκληση — και για τις αυτόματες. Το φαρμακείο μένει κύριος του αποθέματός του."""
        oid = _oid(offer_id)
        o = await self._db[OFFERS].find_one({"_id": oid, "from_tenant_id": self.me,
                                             "status": OFF_PENDING})
        if not o:
            return {"ok": False, "error": "not_found",
                    "message": "Η προσφορά δεν υπάρχει ή έχει ήδη απαντηθεί."}
        await self._db[OFFERS].update_one({"_id": oid}, {"$set": {"status": OFF_WITHDRAWN}})
        return {"ok": True}

    async def decline_request(self, request_id: str) -> dict:
        """«Δεν μπορώ να καλύψω» — καταγράφεται ώστε να μην ξαναρωτηθεί ο ίδιος."""
        rid = _oid(request_id)
        gids = await self._my_groups()
        if not await self._db[REQUESTS].find_one({"_id": rid, "group_ids": {"$in": gids}}):
            return {"ok": False, "error": "not_found"}
        if await self._db[OFFERS].find_one({"request_id": rid, "from_tenant_id": self.me,
                                            "status": OFF_ACCEPTED}):
            return {"ok": False, "error": "already_accepted",
                    "message": "Έχεις ήδη δεσμευτεί — ακύρωσε την κίνηση αντί να αρνηθείς."}
        await self._db[OFFERS].update_one(
            {"request_id": rid, "from_tenant_id": self.me},
            {"$set": {"qty": 0, "status": OFF_REJECTED, "mode": "manual",
                      "created_at": _now()}}, upsert=True)
        return {"ok": True}

    # ── αποδοχή → κράτηση → κίνηση ───────────────────────────────────────────────────────────
    async def accept_offer(self, offer_id: str) -> dict:
        """Ο αιτών δέχεται. ΤΩΡΑ δεσμεύεται απόθεμα (§14) — όχι νωρίτερα.

        Η εμφάνιση διαθεσιμότητας ΔΕΝ δεσμεύει τίποτα· αν δέσμευε, ένα αίτημα που δεν
        προχώρησε ποτέ θα κρατούσε κλειδωμένο το ράφι τρίτων φαρμακείων.
        """
        oid = _oid(offer_id)
        o = await self._db[OFFERS].find_one({"_id": oid, "to_tenant_id": self.me,
                                             "status": OFF_PENDING})
        if not o or not int(o.get("qty") or 0):
            return {"ok": False, "error": "not_found"}
        r = await self._db[REQUESTS].find_one({"_id": o["request_id"],
                                               "from_tenant_id": self.me})
        if not r or r.get("status") not in (REQ_OPEN, REQ_COVERED):
            return {"ok": False, "error": "closed"}
        remaining = int(r["qty"]) - int(r.get("qty_covered") or 0)
        if remaining <= 0:
            return {"ok": False, "error": "covered", "message": "Το αίτημα καλύφθηκε ήδη."}
        qty = min(int(o["qty"]), remaining)
        source = o["from_tenant_id"]

        policy = await ConnectPolicyRepository(tenant_id=source).get()
        minutes = int(policy.get("reservation_minutes") or DEFAULTS["reservation_minutes"])
        res = await self._db[RESERVATIONS].insert_one({
            "offer_id": oid, "request_id": r["_id"], "tenant_id": source,
            "barcode": r.get("barcode"), "qty": qty, "status": RES_ACTIVE,
            "created_at": _now(), "expires_at": _now() + timedelta(minutes=minutes)})
        mov = await self._db[MOVEMENTS].insert_one({
            "request_id": r["_id"], "offer_id": oid, "reservation_id": res.inserted_id,
            "group_id": o.get("group_id"), "source_tenant_id": source,
            "dest_tenant_id": self.me, "barcode": r.get("barcode"), "name": r.get("name"),
            "qty": qty, "status": MOV_PENDING, "created_at": _now()})
        await self._db[OFFERS].update_one({"_id": oid}, {"$set": {"status": OFF_ACCEPTED,
                                                                  "accepted_qty": qty}})
        covered = int(r.get("qty_covered") or 0) + qty
        await self._db[REQUESTS].update_one({"_id": r["_id"]}, {"$set": {
            "qty_covered": covered,
            "status": REQ_COVERED if covered >= int(r["qty"]) else REQ_OPEN}})
        return {"ok": True, "movement_id": str(mov.inserted_id), "qty": qty,
                "expires_in_minutes": minutes}

    async def reject_offer(self, offer_id: str) -> dict:
        oid = _oid(offer_id)
        o = await self._db[OFFERS].find_one({"_id": oid, "to_tenant_id": self.me,
                                             "status": OFF_PENDING})
        if not o:
            return {"ok": False, "error": "not_found"}
        await self._db[OFFERS].update_one({"_id": oid}, {"$set": {"status": OFF_REJECTED}})
        return {"ok": True}

    async def complete_movement(self, movement_id: str, *, doc_ref: str = "", batch: str = "",
                                expiry: str = "") -> dict:
        """«Παρέδωσα» — το δηλώνει η ΑΦΕΤΗΡΙΑ, γιατί αυτή δίνει το κουτί από το χέρι της."""
        mid = _oid(movement_id)
        m = await self._db[MOVEMENTS].find_one({"_id": mid, "source_tenant_id": self.me,
                                                "status": MOV_PENDING})
        if not m:
            return {"ok": False, "error": "not_found"}
        policy = await ConnectPolicyRepository(tenant_id=self.me).get()
        if policy.get("require_doc_ref") and not (doc_ref or "").strip():
            return {"ok": False, "error": "doc_ref_required",
                    "message": "Το φαρμακείο σου απαιτεί αριθμό παραστατικού διακίνησης."}
        # ΣΕΙΡΑ: πρώτα κρατάμε παρτίδα/λήξη πάνω στην κίνηση και ΜΕΤΑ εφαρμόζουμε το απόθεμα,
        # ώστε το ledger και των δύο φαρμακείων να τα γράψει κι αυτά — αλλιώς η παρτίδα που
        # μόλις δήλωσε ο φαρμακοποιός δεν θα έφτανε ποτέ στην εγγραφή της κίνησης.
        fields = {"doc_ref": (doc_ref or "").strip()[:60] or None,
                  "batch": (batch or "").strip()[:60] or None,
                  "expiry": (expiry or "").strip()[:10] or None}
        await self._apply_stock({**m, **fields}, direction=-1)
        await self._db[MOVEMENTS].update_one({"_id": mid}, {"$set": {
            **fields, "status": MOV_COMPLETED, "completed_at": _now()}})
        await self._db[RESERVATIONS].update_one({"_id": m.get("reservation_id")},
                                                {"$set": {"status": RES_CONSUMED}})
        return {"ok": True}

    async def _apply_stock(self, m: dict, *, direction: int) -> None:
        """Ενημερώνει ΚΑΙ ΤΑ ΔΥΟ φαρμακεία, όπου το είδος παρακολουθείται.

        `direction=-1` = παράδοση (φεύγει από την αφετηρία), `+1` = επιστροφή. Όπου το είδος
        δεν υπάρχει στον κατάλογο του φαρμακείου, δεν συμβαίνει τίποτα — δεν δημιουργούμε
        δεύτερο απόθεμα ούτε φαντάσματα ειδών (§10/§15).
        """
        from app.repositories.pharmacy_catalog import (PharmacyCatalogRepository,
                                                       StockMovementRepository)
        bc, qty = m.get("barcode"), int(m.get("qty") or 0)
        if not bc or not qty:
            return
        src, dst = m["source_tenant_id"], m["dest_tenant_id"]
        pairs = [(src, -qty), (dst, qty)] if direction < 0 else [(src, qty), (dst, -qty)]
        for tid, delta in pairs:
            cat = PharmacyCatalogRepository(tenant_id=tid)
            new_stock = await cat.apply_stock(bc, delta=delta, batch=m.get("batch") or None,
                                              expiry=m.get("expiry") or None)
            if new_stock is None:
                continue
            other = dst if tid == src else src
            await StockMovementRepository(tenant_id=tid).add(
                barcode=bc, kind="out" if delta < 0 else "in", qty=abs(delta),
                reason=f"Connect · {'προς' if delta < 0 else 'από'} "
                       f"{await directory.tenant_name(other)}",
                batch=m.get("batch") or "", expiry=m.get("expiry") or "",
                by="connect", new_stock=new_stock)

    async def cancel_movement(self, movement_id: str) -> dict:
        """Ακύρωση πριν την παράδοση — από οποιαδήποτε πλευρά. Το αίτημα ξανανοίγει."""
        mid = _oid(movement_id)
        m = await self._db[MOVEMENTS].find_one(
            {"_id": mid, "status": MOV_PENDING,
             "$or": [{"source_tenant_id": self.me}, {"dest_tenant_id": self.me}]})
        if not m:
            return {"ok": False, "error": "not_found"}
        await self._release(m, MOV_CANCELLED)
        return {"ok": True}

    async def _release(self, m: dict, status: str) -> None:
        """Λύνει κράτηση + ξαναδίνει την ποσότητα στο αίτημα. ΕΝΑ σημείο για ακύρωση & λήξη."""
        await self._db[MOVEMENTS].update_one({"_id": m["_id"]},
                                             {"$set": {"status": status, "closed_at": _now()}})
        await self._db[RESERVATIONS].update_one(
            {"_id": m.get("reservation_id")},
            {"$set": {"status": RES_EXPIRED if status == MOV_CANCELLED else RES_RELEASED}})
        await self._db[OFFERS].update_one({"_id": m.get("offer_id")},
                                          {"$set": {"status": OFF_WITHDRAWN}})
        r = await self._db[REQUESTS].find_one({"_id": m["request_id"]})
        if r:
            covered = max(0, int(r.get("qty_covered") or 0) - int(m.get("qty") or 0))
            await self._db[REQUESTS].update_one({"_id": r["_id"]}, {"$set": {
                "qty_covered": covered,
                "status": REQ_OPEN if (r.get("status") != REQ_CANCELLED
                                       and covered < int(r["qty"])) else r.get("status")}})

    # ── κινήσεις, υπόλοιπα, επιστροφές, τακτοποιήσεις ────────────────────────────────────────
    def _mine_q(self) -> dict:
        return {"$or": [{"source_tenant_id": self.me}, {"dest_tenant_id": self.me}]}

    async def movements(self, *, status: str | None = None, limit: int = 80) -> list[dict]:
        q = self._mine_q()
        if status:
            q = {**q, "status": status}
        out = []
        async for m in self._db[MOVEMENTS].find(q).sort("created_at", -1).limit(limit):
            out.append(await self._movement_view(m))
        return out

    async def _movement_view(self, m: dict) -> dict:
        outgoing = m["source_tenant_id"] == self.me
        partner = m["dest_tenant_id"] if outgoing else m["source_tenant_id"]
        rets = [r async for r in self._db[RETURNS].find({"movement_id": m["_id"]})]
        setts = [s async for s in self._db[SETTLEMENTS].find({"movement_id": m["_id"]})]
        disp = await self._db[DISPUTES].find_one({"movement_id": m["_id"], "status": "open"})
        returned = sum(int(r.get("qty") or 0) for r in rets if r.get("status") == RET_COMPLETED)
        settled = sum(int(s.get("qty") or 0) for s in setts)
        return {"id": str(m["_id"]), "direction": "out" if outgoing else "in",
                "partner": await directory.tenant_name(partner), "partner_id": partner,
                "barcode": m.get("barcode"), "name": m.get("name"), "qty": m.get("qty"),
                "status": m.get("status"), "doc_ref": m.get("doc_ref"),
                "batch": m.get("batch"), "expiry": m.get("expiry"),
                "created_at": m.get("created_at"), "completed_at": m.get("completed_at"),
                "returned": returned, "settled": settled,
                "open_qty": max(0, int(m.get("qty") or 0) - returned - settled),
                "dispute": ({"id": str(disp["_id"]), "reason": disp.get("reason")}
                            if disp else None),
                "returns": [{"id": str(r["_id"]), "qty": r.get("qty"),
                             "status": r.get("status")} for r in rets]}

    async def balances(self) -> list[dict]:
        """Ανοιχτό υπόλοιπο ανά συνεργάτη & είδος — ΠΑΡΑΓΩΓΟ από τις κινήσεις.

        ΓΙΑΤΙ ΠΑΡΑΓΩΓΟ ΚΑΙ ΟΧΙ ΑΠΟΘΗΚΕΥΜΕΝΟΣ ΜΕΤΡΗΤΗΣ: ένας μετρητής που ξεσυγχρονίζεται
        δημιουργεί διαφωνία μεταξύ δύο φαρμακείων — το χειρότερο δυνατό σφάλμα εδώ. Οι
        κινήσεις είναι η πηγή αλήθειας και το υπόλοιπο βγαίνει πάντα από αυτές.

        Θετικό = μου οφείλουν · αρνητικό = οφείλω.
        """
        agg: dict[tuple[str, str], dict] = {}
        async for m in self._db[MOVEMENTS].find({**self._mine_q(), "status": MOV_COMPLETED}):
            outgoing = m["source_tenant_id"] == self.me
            partner = m["dest_tenant_id"] if outgoing else m["source_tenant_id"]
            key = (partner, m.get("barcode") or m.get("name") or "—")
            row = agg.setdefault(key, {"partner_id": partner, "barcode": m.get("barcode"),
                                       "name": m.get("name"), "net": 0, "movements": 0})
            qty = int(m.get("qty") or 0)
            returned = 0
            async for r in self._db[RETURNS].find({"movement_id": m["_id"],
                                                   "status": RET_COMPLETED}):
                returned += int(r.get("qty") or 0)
            settled = 0
            async for s in self._db[SETTLEMENTS].find({"movement_id": m["_id"]}):
                settled += int(s.get("qty") or 0)
            net = max(0, qty - returned - settled)
            row["net"] += net if outgoing else -net
            row["movements"] += 1
        out = []
        for (partner, _), row in agg.items():
            if not row["net"]:
                continue
            out.append({**row, "partner": await directory.tenant_name(partner),
                        "direction": "they_owe" if row["net"] > 0 else "i_owe",
                        "qty": abs(row["net"])})
        return sorted(out, key=lambda r: (-abs(r["net"]), r["partner"]))

    async def request_return(self, movement_id: str, qty: int, note: str = "") -> dict:
        """Επιστροφή σε είδος (§18Α). Τη ζητά ΟΠΟΙΟΣ ΕΛΑΒΕ — αυτός κρατά το πράγμα."""
        mid = _oid(movement_id)
        m = await self._db[MOVEMENTS].find_one({"_id": mid, "dest_tenant_id": self.me,
                                                "status": MOV_COMPLETED})
        if not m:
            return {"ok": False, "error": "not_found"}
        view = await self._movement_view(m)
        n = min(_qty(qty), view["open_qty"])
        if n <= 0:
            return {"ok": False, "error": "nothing_open",
                    "message": "Δεν υπάρχει ανοιχτή ποσότητα σε αυτή την κίνηση."}
        res = await self._db[RETURNS].insert_one({
            "movement_id": mid, "from_tenant_id": self.me,
            "to_tenant_id": m["source_tenant_id"], "qty": n, "status": RET_REQUESTED,
            "note": (note or "").strip()[:300] or None, "created_at": _now()})
        return {"ok": True, "id": str(res.inserted_id), "qty": n}

    async def respond_return(self, return_id: str, accept: bool) -> dict:
        """Απαντά η ΑΦΕΤΗΡΙΑ (αυτή που θα πάρει πίσω το είδος)."""
        rid = _oid(return_id)
        r = await self._db[RETURNS].find_one({"_id": rid, "to_tenant_id": self.me,
                                              "status": RET_REQUESTED})
        if not r:
            return {"ok": False, "error": "not_found"}
        await self._db[RETURNS].update_one({"_id": rid}, {"$set": {
            "status": RET_ACCEPTED if accept else RET_REJECTED, "responded_at": _now()}})
        return {"ok": True, "accepted": accept}

    async def complete_return(self, return_id: str) -> dict:
        """Ολοκλήρωση — το είδος γύρισε πίσω. Το δηλώνει όποιος το παρέδωσε πίσω."""
        rid = _oid(return_id)
        r = await self._db[RETURNS].find_one({"_id": rid, "from_tenant_id": self.me,
                                              "status": RET_ACCEPTED})
        if not r:
            return {"ok": False, "error": "not_found"}
        m = await self._db[MOVEMENTS].find_one({"_id": r["movement_id"]})
        if m:
            await self._apply_stock({**m, "qty": r["qty"]}, direction=+1)
        await self._db[RETURNS].update_one({"_id": rid}, {"$set": {"status": RET_COMPLETED,
                                                                   "completed_at": _now()}})
        return {"ok": True}

    async def settle(self, movement_id: str, *, amount_cents: int = 0, qty: int = 0,
                     note: str = "") -> dict:
        """Τακτοποίηση αξίας (§18Β) — ΚΑΤΑΓΡΑΦΗ, όχι παραστατικό.

        Το RxVision δεν εκδίδει τίποτα και δεν υποθέτει τίποτα για τη φορολογική φύση της
        πράξης. Κρατά ότι οι δύο πλευρές θεωρούν την ποσότητα τακτοποιημένη, και πόσο.
        """
        mid = _oid(movement_id)
        m = await self._db[MOVEMENTS].find_one({"_id": mid, "status": MOV_COMPLETED,
                                                **self._mine_q()})
        if not m:
            return {"ok": False, "error": "not_found"}
        view = await self._movement_view(m)
        n = min(_qty(qty or view["open_qty"]), view["open_qty"])
        if n <= 0:
            return {"ok": False, "error": "nothing_open"}
        await self._db[SETTLEMENTS].insert_one({
            "movement_id": mid, "kind": "value", "qty": n,
            "amount_cents": max(0, int(amount_cents or 0)), "by": self.me,
            "note": (note or "").strip()[:300] or None, "at": _now()})
        return {"ok": True, "qty": n}

    async def open_dispute(self, movement_id: str, reason: str, note: str = "") -> dict:
        mid = _oid(movement_id)
        m = await self._db[MOVEMENTS].find_one({"_id": mid, **self._mine_q()})
        if not m:
            return {"ok": False, "error": "not_found"}
        await self._db[DISPUTES].insert_one({
            "movement_id": mid, "opened_by": self.me, "reason": (reason or "other")[:40],
            "note": (note or "").strip()[:500] or None, "status": "open", "at": _now(),
            "history": [{"at": _now(), "by": self.me, "what": "opened"}]})
        await self._db[MOVEMENTS].update_one({"_id": mid}, {"$set": {"status": MOV_REVIEW}})
        return {"ok": True}

    async def resolve_dispute(self, dispute_id: str, note: str = "") -> dict:
        did = _oid(dispute_id)
        d = await self._db[DISPUTES].find_one({"_id": did, "status": "open"})
        if not d:
            return {"ok": False, "error": "not_found"}
        m = await self._db[MOVEMENTS].find_one({"_id": d["movement_id"], **self._mine_q()})
        if not m:
            return {"ok": False, "error": "not_found"}
        await self._db[DISPUTES].update_one({"_id": did}, {"$set": {"status": "resolved"},
            "$push": {"history": {"at": _now(), "by": self.me, "what": "resolved",
                                  "note": (note or "")[:300] or None}}})
        await self._db[MOVEMENTS].update_one({"_id": m["_id"]},
                                             {"$set": {"status": MOV_COMPLETED}})
        return {"ok": True}

    # ── πίνακας ──────────────────────────────────────────────────────────────────────────────
    async def dashboard(self) -> dict:
        gids = await self._my_groups()
        inbox = await self._db[REQUESTS].count_documents(
            {"group_ids": {"$in": gids}, "from_tenant_id": {"$ne": self.me},
             "status": REQ_OPEN}) if gids else 0
        waiting = await self._db[OFFERS].count_documents(
            {"to_tenant_id": self.me, "status": OFF_PENDING})
        pending_out = await self._db[MOVEMENTS].count_documents(
            {"source_tenant_id": self.me, "status": MOV_PENDING})
        pending_in = await self._db[MOVEMENTS].count_documents(
            {"dest_tenant_id": self.me, "status": MOV_PENDING})
        bal = await self.balances()
        returns_todo = await self._db[RETURNS].count_documents(
            {"to_tenant_id": self.me, "status": RET_REQUESTED})
        disputes = await self._db[DISPUTES].count_documents({"status": "open"})
        members = set()
        async for g in self._db[GROUPS].find({"members": self.me}, {"members": 1}):
            members.update(g.get("members") or [])
        members.discard(self.me)
        return {
            "inbox": inbox, "offers_waiting": waiting,
            "to_deliver": pending_out, "to_receive": pending_in,
            "they_owe": sum(b["qty"] for b in bal if b["direction"] == "they_owe"),
            "i_owe": sum(b["qty"] for b in bal if b["direction"] == "i_owe"),
            "returns_todo": returns_todo, "disputes": disputes,
            "partners": len(members), "groups": len(gids),
            "reservations": await self._db[RESERVATIONS].count_documents(
                {"tenant_id": self.me, "status": RES_ACTIVE, "expires_at": {"$gt": _now()}}),
        }


async def expire_reservations() -> dict:
    """Λήξη κρατήσεων — ΕΝΑ σημείο, τρέχει από το beat. Το απόθεμα γυρίζει στο διαθέσιμο.

    Χωρίς αυτό, μια αποδοχή που δεν ολοκληρώθηκε ποτέ θα κρατούσε το ράφι κλειδωμένο για
    πάντα — και το φαρμακείο θα έβλεπε «διαθέσιμα 0» χωρίς να καταλαβαίνει γιατί.
    """
    db = shared_db()
    n = 0
    async for m in db[MOVEMENTS].find({"status": MOV_PENDING}):
        res = await db[RESERVATIONS].find_one({"_id": m.get("reservation_id")})
        if not res or res.get("status") != RES_ACTIVE:
            continue
        if (res.get("expires_at") or _now()) > _now():
            continue
        repo = ConnectRepository(tenant_id=m["dest_tenant_id"])
        await repo._release(m, MOV_CANCELLED)
        n += 1
    return {"expired": n}
