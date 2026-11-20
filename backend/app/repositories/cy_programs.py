"""RxVision Κύπρος: «Θεραπείες με Επανάληψη» (π.χ. Prolia κάθε 6 μήνες) με τα ΙΔΙΑ σχήματα και την ΙΔΙΑ
οθόνη με την Ελλάδα (`repositories/vaccine_programs.py`).

Η κλάση ΚΛΗΡΟΝΟΜΕΙ την ελληνική και αλλάζει ΜΟΝΟ τις πηγές:
  - σκευάσματα προς επιλογή: ο κατάλογος Κύπρου (`cy_catalog_items`, ATC ΓεΣΥ ή ταύτισης) — ο
    «κωδικός» του προγράμματος είναι ο κωδικός φαρμάκου ΓεΣΥ (DrugCode), όχι ΕΟΦ.
  - δόσεις: οι γραμμές των εκτελέσεων ΓεΣΥ (`cy_dispensings.lines`, QtyDisp > 0).
  - πελάτες: `cy_patients` (όνομα, κωδικός ΟΑΥ, επαφή/συγκατάθεση, «απεβίωσε»).
Ο κανόνας κάλυψης (`_coverage`), οι χειροκίνητες δόσεις «αλλού» και οι ρυθμίσεις μένουν αυτούσια.
Στην Κύπρο ΔΕΝ υπάρχουν εμβόλια σε αυτό το κύκλωμα — κάθε πρόγραμμα είναι «θεραπεία».
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from app.core.db import shared_db
from app.repositories.cy import CyDispensingRepository, CyPatientRepository
from app.repositories.cy_intelligence import _sex
from app.repositories.vaccine_programs import VaccineProgramRepository
from app.services.cy.atc_link import norm_code
from app.utils.masking import mask_amka, mask_name

ITEMS = "cy_catalog_items"


def _atc_of(d: dict) -> str | None:
    raw = d.get("raw") or {}
    a = str((raw.get("gesy") or {}).get("ATC") or "").split("-")[0].strip().upper()
    return a or ((d.get("atc_match") or {}).get("atc"))


def _birth_year(dob) -> int | None:
    m = re.match(r"(\d{4})", str(dob or ""))
    return int(m.group(1)) if m else None


class CyTherapyProgramRepository(VaccineProgramRepository):

    @staticmethod
    async def atc_groups() -> list[dict]:
        return []                                   # όχι εμβόλια στην Κύπρο

    @staticmethod
    async def products(atc_prefix: str | None = None, search: str | None = None) -> list[dict]:
        """Σκευάσματα του καταλόγου Κύπρου (φάρμακα) — με όνομα ή με ATC."""
        q: dict = {"active": True, "raw.supergroup": "MEDICINE", "raw.drug_code": {"$nin": [None, ""]}}
        ors: list[dict] = []
        if atc_prefix:
            rx = {"$regex": f"^{re.escape(atc_prefix.upper())}"}
            ors += [{"raw.gesy.ATC": rx}, {"atc_match.atc": rx}]
        if search and search.strip():
            ors.append({"raw.name": {"$regex": re.escape(search.strip()), "$options": "i"}})
        if not ors:
            return []
        q["$or"] = ors
        out, seen = [], set()
        async for d in shared_db()[ITEMS].find(q, {"raw.name": 1, "raw.drug_code": 1, "raw.gesy": 1,
                                                   "raw.barcodes": 1, "atc_match": 1}).sort("raw.name", 1).limit(200):
            code = norm_code((d.get("raw") or {}).get("drug_code"))
            if not code or code in seen:
                continue
            seen.add(code)
            out.append({"eof_code": code, "name": (d.get("raw") or {}).get("name"), "atc": _atc_of(d),
                        "barcode": ((d.get("raw") or {}).get("barcodes") or [None])[0]})
        return out

    @staticmethod
    def kind_of(program: dict) -> str:
        return "therapy"

    async def list(self, kind: str | None = None) -> list[dict]:
        rows = await self.find(sort=[("name", 1)], limit=200)
        return rows if kind in (None, "therapy") else []

    async def resolve_codes(self, program: dict) -> set[str]:
        """Πρόγραμμα → κωδικοί φαρμάκου ΓεΣΥ (ρητά σκευάσματα ΥΠΕΡΙΣΧΥΟΥΝ της ομάδας ATC)."""
        codes = {norm_code(c) for c in (program.get("eof_codes") or []) if c} - {""}
        if codes:
            return codes
        prefixes = [str(p).upper() for p in (program.get("atc_prefixes") or []) if p]
        if prefixes:
            rx = {"$regex": "|".join(f"^{re.escape(p)}" for p in prefixes)}
            async for d in shared_db()[ITEMS].find(
                    {"active": True, "$or": [{"raw.gesy.ATC": rx}, {"atc_match.atc": rx}]}, {"raw.drug_code": 1}):
                c = norm_code((d.get("raw") or {}).get("drug_code"))
                if c:
                    codes.add(c)
        return codes

    async def _shots(self, codes: set[str], patient_ref: str | None = None) -> dict[str, list[dict]]:
        """{pseudo → [{at, code, name}]} από τις εκτελέσεις ΓεΣΥ (μόνο όσα ΔΟΘΗΚΑΝ)."""
        match: dict = {"lines.qty_disp": {"$gt": 0}}
        if patient_ref:
            match["patient_ref"] = patient_ref
        rows = await CyDispensingRepository(tenant_id=self.tenant_id).aggregate([
            {"$match": match}, {"$unwind": "$lines"}, {"$match": {"lines.qty_disp": {"$gt": 0}}},
            {"$project": {"patient_ref": 1, "dispensed_at": 1, "code": "$lines.code", "name": "$lines.description"}}])
        out: dict[str, list[dict]] = {}
        for r in rows:
            if r.get("patient_ref") and norm_code(r.get("code")) in codes:
                at = r["dispensed_at"]
                out.setdefault(r["patient_ref"], []).append(
                    {"at": at if at.tzinfo else at.replace(tzinfo=timezone.utc), "code": norm_code(r.get("code")),
                     "name": r.get("name"), "lot": None, "elsewhere": False, "note": ""})
        return out

    async def coverage_for_patient(self, program: dict, patient_id: str) -> dict | None:
        codes = await self.resolve_codes(program)
        if not codes:
            return None
        shots = (await self._shots(codes, patient_id)).get(patient_id, [])
        for d in (await self._manual_doses(str(program.get("_id") or ""), [patient_id])).get(patient_id, []):
            shots.append({"at": d["at"], "code": None, "elsewhere": True, "note": d["note"]})
        if not shots:
            return None
        now = datetime.now(tz=timezone.utc)
        dates = sorted(s["at"] for s in shots if s.get("at"))
        st, due = self._coverage(dates[0], self.repeat_months_of(program), int(program.get("notify_before_days") or 30),
                                 now, len(shots), int(program.get("doses_required") or 1), last_at=dates[-1],
                                 dose_interval_days=program.get("dose_interval_days"),
                                 repeat_from=program.get("repeat_from") or "first")
        return {"status": st, "due_at": due, "doses": len(shots),
                "doses_required": int(program.get("doses_required") or 1), "last_at": dates[-1],
                "shots": sorted(shots, key=lambda x: x.get("at") or now)}

    async def patients_for(self, program: dict, *, status: str = "all",
                           q: str | None = None, limit: int = 200, skip: int = 0) -> dict:
        codes = await self.resolve_codes(program)
        if not codes:
            return {"items": [], "total": 0, "counts": {}}
        by_pat = await self._shots(codes)
        manual = await self._manual_doses(str(program.get("_id") or ""), list(by_pat))
        pats = {p["pseudo_id"]: p for p in await CyPatientRepository(tenant_id=self.tenant_id).find(
            {"pseudo_id": {"$in": list(by_pat)}}, limit=len(by_pat) + 1)} if by_pat else {}
        repeat_months = self.repeat_months_of(program)
        doses_required = int(program.get("doses_required") or 1)
        notify_before = int(program.get("notify_before_days") or 30)
        now = datetime.now(tz=timezone.utc)
        items, counts = [], {"covered": 0, "due_soon": 0, "expired": 0, "incomplete": 0}
        for ref, shots in by_pat.items():
            p = pats.get(ref) or {}
            if (p.get("deceased") or {}).get("at"):
                continue                             # ΠΟΤΕ θανόντες σε λίστα επικοινωνίας
            by = _birth_year(p.get("dob"))
            age = (now.year - by) if by else None
            if program.get("min_age") is not None and age is not None and age < int(program["min_age"]):
                continue
            if program.get("max_age") is not None and age is not None and age > int(program["max_age"]):
                continue
            if program.get("sex") and _sex(p.get("gender")) and _sex(p.get("gender")) != str(program["sex"])[:1].upper():
                continue
            name = p.get("full_name") or ""
            if q and q.strip() and q.strip().lower() not in name.lower() and q.strip() not in str(p.get("hio_code") or ""):
                continue
            all_shots = shots + [{"at": d["at"], "code": None, "name": None, "lot": None, "elsewhere": True,
                                  "note": d["note"]} for d in manual.get(ref, [])]
            dates = sorted(s["at"] for s in all_shots if s.get("at"))
            st, due = self._coverage(dates[0], repeat_months, notify_before, now, len(all_shots), doses_required,
                                     last_at=dates[-1], dose_interval_days=program.get("dose_interval_days"),
                                     repeat_from=program.get("repeat_from") or "first")
            counts[st] = counts.get(st, 0) + 1
            c = p.get("contact") or {}
            items.append({
                "patient_id": ref, "name": mask_name(name, self.demo) or "—",
                "amka": mask_amka(p.get("hio_code"), self.demo),
                "age_group": None, "age": age, "last_at": dates[-1], "first_at": dates[0],
                "doses": len(all_shots), "doses_required": doses_required, "status": st, "due_at": due,
                "vaccines": sorted({s["name"] for s in shots if s.get("name")}),
                "shots": [{"at": s["at"], "vaccine": s.get("name") or "— εκτός φαρμακείου —", "lot": None,
                           "elsewhere": bool(s.get("elsewhere")), "note": s.get("note") or ""}
                          for s in sorted(all_shots, key=lambda x: x.get("at") or now)],
                "lots": [], "mobile": None if self.demo else (c.get("mobile") or None),
                "email": None if self.demo else (c.get("email") or None),
                "consent": bool(c.get("marketing_consent")) and not c.get("unsubscribed_at"),
                "has_contact": bool(c.get("mobile") or c.get("email"))})
        items.sort(key=lambda i: i["last_at"], reverse=True)
        if status != "all":
            items = [i for i in items if i["status"] == status]
        return {"items": items[skip:skip + limit], "total": len(items), "counts": counts}


async def programs_repo(tenant_id: str, demo: bool = False):
    """ΕΝΑ σημείο επιλογής χώρας για τα προγράμματα (router)."""
    from app.services.cy.gate import tenant_country
    if await tenant_country(tenant_id) == "CY":
        return CyTherapyProgramRepository(tenant_id=tenant_id, demo=demo)
    return VaccineProgramRepository(tenant_id=tenant_id, demo=demo)
