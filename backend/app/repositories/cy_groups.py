"""RxVision Κύπρος: Οικογένειες & Δομές Φροντίδας με τα ΙΔΙΑ σχήματα και τις ΙΔΙΕΣ οθόνες με την Ελλάδα.

Οι κλάσεις ΚΛΗΡΟΝΟΜΟΥΝ τις ελληνικές (`patient_groups.py`, `care_accounts.py`) — ίδια συλλογή
`patient_groups` (ανά φαρμακείο), ίδιο καθολικό δομών, ίδιοι κανόνες. Αλλάζει ΜΟΝΟ η ταυτότητα και η πηγή:

  - ΜΕΛΟΣ = το ψευδώνυμο ΓεΣΥ (`cy_patients.pseudo_id`) — το ΙΔΙΟ που κρατούν οι εκτελέσεις ως
    `patient_ref`. Άρα εδώ ΔΕΝ υπάρχει η ελληνική «παγίδα» ObjectId ↔ pseudo_id.
  - Ο αριθμός ταυτότητας/ARC δεν αποθηκεύεται ποτέ: για νέο μέλος γράφεις κωδικό ΟΑΥ ή διαλέγεις από
    την αναζήτηση. Άτομο χωρίς καμία εκτέλεση ΓεΣΥ ΔΕΝ μπορεί να προστεθεί (το ψευδώνυμο εξαρτάται
    από το είδος εγγράφου, που δεν το ξέρουμε πριν έρθει το XML).
  - Χρέωση δομής = η ΣΥΜΜΕΤΟΧΗ του πελάτη στις εκτελέσεις ΓεΣΥ (`totals.beneficiary`: copay + PC2).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from app.repositories.care_accounts import CareAccountRepository, _naive, _oid
from app.repositories.cy import CyDispensingRepository, CyLoanRepository, CyPatientRepository
from app.repositories.cy_intelligence import _sex
from app.repositories.patient_groups import CARE, PatientGroupRepository
from app.utils.masking import mask_amka, mask_name


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _minor(dob) -> bool:
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(dob or ""))
    if not m:
        return False
    y, mo, d = (int(x) for x in m.groups())
    t = _now().date()
    return (t.year - y - ((t.month, t.day) < (mo, d))) < 18


async def search_patients(tenant_id: str, q: str, *, demo: bool = False) -> list[dict]:
    """Αναζήτηση για προσθήκη μέλους: όνομα ή κωδικός ΟΑΥ. Ίδιο σχήμα με την Ελλάδα."""
    rx = {"$regex": re.escape(q.strip()), "$options": "i"}
    rows = await CyPatientRepository(tenant_id=tenant_id).find(
        {"$or": [{"full_name": rx}, {"hio_code": {"$regex": "^" + re.escape(q.strip())}}],
         "deceased.at": {"$exists": False}, "erased": {"$ne": True}},
        sort=[("last_seen", -1)], limit=30)
    return [{"patient_id": p["pseudo_id"], "name": mask_name(p.get("full_name"), demo),
             "amka": mask_amka(p.get("hio_code"), demo), "age_group": None, "sex": _sex(p.get("gender")),
             "birth_year": None, "last_seen": p.get("last_seen"), "rx_count": None,
             "mobile": None if demo else (p.get("contact") or {}).get("mobile"), "phone": None,
             "email": None if demo else (p.get("contact") or {}).get("email"),
             "consent": bool((p.get("contact") or {}).get("marketing_consent"))} for p in rows]


class CyPatientGroupRepository(PatientGroupRepository):

    def _pats(self) -> CyPatientRepository:
        return CyPatientRepository(tenant_id=self.tenant_id)

    async def list_groups(self, *, kind: str = "family", q: str | None = None,
                          include_inactive: bool = False, skip: int = 0, limit: int = 50) -> dict:
        query: dict = {"kind": kind}
        if not include_inactive:
            query["active"] = {"$ne": False}
        term = (q or "").strip()
        if term:
            rx = {"$regex": re.escape(term), "$options": "i"}
            pseudos = [p["pseudo_id"] for p in await self._pats().find(
                {"$or": [{"full_name": rx}, {"hio_code": {"$regex": "^" + re.escape(term)}}]}, limit=200)]
            ors: list[dict] = [{"name": rx}]
            if pseudos:
                ors.append({"members.pseudo_id": {"$in": pseudos}})
            query["$or"] = ors
        total = await self.count(query)
        rows = await self.find(query, sort=[("name", 1)], skip=max(0, skip), limit=max(1, min(limit, 200)))
        for r in rows:
            r["_id"] = str(r["_id"])
            r["member_count"] = len([m for m in (r.get("members") or []) if not m.get("left_at")])
            r.pop("members", None)
        return {"items": rows, "total": total}

    async def add_member(self, gid: str, *, amka: str | None = None, pseudo_id: str | None = None,
                         patient_id: str | None = None, label: str | None = None,
                         role: str | None = None) -> dict:
        """`patient_id` (από την αναζήτηση) = ψευδώνυμο ΓεΣΥ. `amka` εδώ = κωδικός ΟΑΥ."""
        ps = (pseudo_id or patient_id or "").strip()
        if not ps and amka:
            code = re.sub(r"\s", "", str(amka))
            p = await self._pats().find_one({"hio_code": {"$in": [code, code.lstrip("0")]}})
            if not p:
                return {"ok": False, "error": "no_patient"}
            ps = p["pseudo_id"]
        if not ps:
            return {"ok": False, "error": "no_patient"}
        p = await self._pats().find_one({"pseudo_id": ps})
        if not p:
            return {"ok": False, "error": "no_patient"}
        if (p.get("deceased") or {}).get("at"):
            return {"ok": False, "error": "deceased"}
        g = await self._coll.find_one(self._scope({"_id": _oid(gid)}), {"members": 1})
        if not g:
            return {"ok": False, "error": "no_group"}
        if any(m.get("pseudo_id") == ps and not m.get("left_at") for m in (g.get("members") or [])):
            return {"ok": False, "error": "already_member"}
        await self.update_one({"_id": _oid(gid)}, {
            "$push": {"members": {"pseudo_id": ps, "label": (label or "").strip()[:60] or None,
                                  "role": (role or "").strip()[:30] or None, "joined_at": _now(),
                                  "left_at": None}},
            "$set": {"updated_at": _now()}})
        return {"ok": True, "pseudo_id": ps}

    async def groups_for_patient(self, patient_id) -> list[dict]:
        rows = await self.find({"members.pseudo_id": str(patient_id), "active": {"$ne": False}}, limit=20)
        return [{"id": str(r["_id"]), "kind": r.get("kind"), "name": r.get("name")} for r in rows]

    async def detail(self, gid: str, *, date_from: datetime, date_to: datetime) -> dict | None:
        g = await self._coll.find_one(self._scope({"_id": _oid(gid)}))
        if not g:
            return None
        members = [m for m in (g.get("members") or []) if not m.get("left_at")]
        pseudos = [m["pseudo_id"] for m in members if m.get("pseudo_id")]
        pats = {p["pseudo_id"]: p for p in await self._pats().find(
            {"pseudo_id": {"$in": pseudos}}, limit=len(pseudos) + 1)} if pseudos else {}
        stats = await self._member_stats(list(pats), date_from=date_from, date_to=date_to)
        rows, totals = [], {"executions": 0, "value": 0, "patient_share": 0, "unexec_value": 0,
                            "loans": 0, "pending": 0}
        for m in members:
            ps = m.get("pseudo_id")
            p = pats.get(ps)
            st = stats.get(ps) if p else None
            row = {"pseudo_id": ps, "patient_id": ps if p else None, "label": m.get("label"),
                   "role": m.get("role"), "pending": p is None,
                   "name": mask_name(p.get("full_name"), self.demo) if p else (m.get("label") or "—"),
                   "amka": mask_amka(p.get("hio_code"), self.demo) if p else None,
                   "sex": _sex((p or {}).get("gender")),
                   "deceased": bool(((p or {}).get("deceased") or {}).get("at")),
                   "minor": bool(p) and _minor(p.get("dob")), "adult_on": None,
                   **(st or {"executions": 0, "value": 0, "patient_share": 0, "unexec": 0, "unexec_value": 0,
                             "loans": 0, "next_open": None})}
            rows.append(row)
            for k in ("executions", "value", "patient_share", "unexec_value", "loans"):
                totals[k] += row.get(k) or 0
            totals["pending"] += 1 if row["pending"] else 0
        rows.sort(key=lambda r: (-(r["unexec"] or 0), -(r["loans"] or 0), r["name"] or ""))
        out = {"id": str(g["_id"]), "kind": g.get("kind"), "name": g.get("name"),
               "active": g.get("active", True), "members": rows, "totals": totals}
        if g.get("kind") == CARE:
            out.update({"care_type": g.get("care_type"), "cycle": g.get("cycle"),
                        "billing": g.get("billing") or {}, "charges_from": g.get("charges_from")})
        return out

    async def _member_stats(self, ids: list, *, date_from: datetime, date_to: datetime) -> dict[str, dict]:
        """pseudo → μετρήσεις περιόδου από τις εκτελέσεις ΓεΣΥ (ομαδικά ερωτήματα, όχι ανά μέλος)."""
        if not ids:
            return {}
        from app.services.cy import chains as ch
        out = {i: {"executions": 0, "value": 0, "patient_share": 0, "unexec": 0, "unexec_value": 0,
                   "loans": 0, "next_open": None} for i in ids}
        disp = CyDispensingRepository(tenant_id=self.tenant_id)
        for r in await disp.aggregate([
                {"$match": {"patient_ref": {"$in": ids}, "dispensed_at": {"$gte": date_from, "$lt": date_to}}},
                {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}, "v": {"$sum": "$totals.total"},
                            "ps": {"$sum": "$totals.beneficiary"}}}]):
            b = out.get(r["_id"])
            if b:
                b["executions"], b["value"], b["patient_share"] = r["n"], r["v"], r["ps"]
        from app.services.cy import group_lists as gl
        for r in await gl.pending(self.tenant_id, ids, {}):
            b = out.get(r["patient_id"])
            if b:
                b["unexec"] += 1
        for c in await ch.chains(self.tenant_id):
            b = out.get(c["patient_ref"])
            if b and c["status"] in ("soon", "upcoming", "late"):
                d = datetime.fromisoformat(c["next_due"])
                if not b["next_open"] or d < b["next_open"]:
                    b["next_open"] = d
        for r in await CyLoanRepository(tenant_id=self.tenant_id).aggregate([
                {"$match": {"status": "open", "patient_ref": {"$in": ids}}},
                {"$group": {"_id": "$patient_ref", "n": {"$sum": 1}}}]):
            b = out.get(r["_id"])
            if b:
                b["loans"] = r["n"]
        return out


class CyCareAccountRepository(CareAccountRepository):

    async def _member_windows(self, g: dict) -> list[dict]:
        cfrom = g.get("charges_from") or g.get("created_at") or datetime(2000, 1, 1)
        pseudos = [m["pseudo_id"] for m in (g.get("members") or []) if m.get("pseudo_id") and not m.get("left_at")]
        if not pseudos:
            return []
        pats = {p["pseudo_id"]: p for p in await CyPatientRepository(tenant_id=self.tenant_id).find(
            {"pseudo_id": {"$in": pseudos}}, limit=len(pseudos) + 1)}
        out = []
        for m in (g.get("members") or []):
            p = pats.get(m.get("pseudo_id"))
            if not p:
                continue
            own = _naive(m.get("charges_from"))
            joined = _naive(m.get("joined_at")) or _naive(cfrom)
            base = _naive(cfrom)
            start = own or (max(joined, base) if (joined and base) else (joined or base))
            out.append({"_id": p["pseudo_id"], "pseudo_id": p["pseudo_id"],
                        "name": mask_name(p.get("full_name"), self.demo),
                        "deceased": bool((p.get("deceased") or {}).get("at")),
                        "from": start, "to": _naive(m.get("left_at"))})
        return out

    async def _charges(self, wins: list[dict], df: datetime | None, dt: datetime | None) -> dict[str, int]:
        """pseudo → σύνολο ΣΥΜΜΕΤΟΧΗΣ πελάτη (copay + PC2) στο παράθυρο του καθενός."""
        clauses = []
        for w in wins:
            lo = max(w["from"], df) if df else w["from"]
            hi = min(w["to"], dt) if (w["to"] and dt) else (w["to"] or dt)
            if hi and lo >= hi:
                continue
            rng = {"$gte": lo, **({"$lt": hi} if hi else {})}
            clauses.append({"patient_ref": w["_id"], "dispensed_at": rng})
        if not clauses:
            return {}
        return {r["_id"]: int(r["s"] or 0) for r in await CyDispensingRepository(tenant_id=self.tenant_id).aggregate([
            {"$match": {"$or": clauses}},
            {"$group": {"_id": "$patient_ref", "s": {"$sum": "$totals.beneficiary"}}}])}

    async def cycle(self, gid: str, *, days: int = 30) -> dict | None:
        from app.services.cy import group_lists as gl
        g = await self._group(gid)
        if not g:
            return None
        wins = await self._member_windows(g)
        names = {w["_id"]: w["name"] for w in wins}
        lists = await gl.everything(self.tenant_id, [w["_id"] for w in wins], names, days=days)
        dead = {w["_id"] for w in wins if w["deceased"]}
        for o in lists["opening"]:
            o["deceased"] = o["patient_id"] in dead
        return {"group": {"id": str(g["_id"]), "name": g.get("name"), "care_type": g.get("care_type")},
                "horizon_days": days, **lists}


async def is_cy(tenant_id: str) -> bool:
    from app.services.cy.gate import tenant_country
    return await tenant_country(tenant_id) == "CY"
