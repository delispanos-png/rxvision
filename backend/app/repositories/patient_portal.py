"""Patient-portal accounts & cross-pharmacy links — GLOBAL, keyed by ΑΜΚΑ (NOT tenant-scoped).

A patient has ONE account (the ΑΜΚΑ is the universal key). Their records live in each pharmacy
(tenant) under a per-tenant pseudonym = HMAC(ΑΜΚΑ, tenant_pepper). We auto-discover every pharmacy
whose pseudonym matches an existing patient record and cache it as a `patient_link` — no pharmacist
approval. The patient picks an active pharmacy per session; the profile aggregates across all links.

These two collections are cross-tenant BY DESIGN (a patient spans pharmacies), so they do NOT go
through BaseRepository. Every read of a pharmacy's data still carries an explicit tenant_id.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.core.db import shared_db
from app.repositories.base import BaseRepository, jsonsafe
from app.services.vault_service import vault
from app.utils.anonymization import pseudonymize


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except Exception:  # noqa: BLE001
        return None


def _format_dosage(dose, freq, dur) -> str | None:
    """Readable doctor's posology from the ΗΔΙΚΑ CDA fields: dose («1 ΔΙΣΚΙΑ…»),
    frequency (period, π.χ. «12 h»/«1 d») και duration («30 d»)."""
    parts: list[str] = []
    if dose:
        parts.append(str(dose).replace("_", " ").strip())
    for val, is_freq in ((freq, True), (dur, False)):
        if not val:
            continue
        m = re.match(r"\s*([\d.]+)\s*([hd])", str(val))
        if not m:
            continue
        num, unit = m.group(1), m.group(2)
        try:
            n = int(float(num))
        except ValueError:
            n = None
        if is_freq:
            if unit == "d":
                parts.append("1 φορά/ημέρα" if n == 1 else f"κάθε {num} ημέρες")
            else:
                parts.append("1 φορά/ημέρα" if n == 24 else f"κάθε {num} ώρες")
        else:
            parts.append(f"για {num} {'ημέρες' if unit == 'd' else 'ώρες'}")
    return " · ".join(parts) if parts else None


class PatientAccountRepository:
    def __init__(self):
        self.db = shared_db()

    # ── accounts ──────────────────────────────────────────────
    async def get_by_email(self, email: str) -> dict | None:
        return await self.db["patient_accounts"].find_one(  # tenant-ok: global patient account
            {"email": (email or "").strip().lower()})

    async def get_by_amka(self, amka: str) -> dict | None:
        return await self.db["patient_accounts"].find_one({"amka": (amka or "").strip()})  # tenant-ok

    async def get(self, account_id) -> dict | None:
        oid = _oid(account_id)
        return await self.db["patient_accounts"].find_one({"_id": oid}) if oid else None  # tenant-ok

    async def create(self, *, first_name: str, last_name: str, email: str,
                     phone: str | None, amka: str, password_hash: str) -> dict:
        # NB: raw ΑΜΚΑ stored — it is the universal matching key and is needed to (re)derive each
        # pharmacy's pseudonym when the patient is served at a new pharmacy. Encrypt-at-rest is a
        # follow-up (consistent with the existing controller AMKA-at-rest decision).
        doc = {
            "first_name": (first_name or "").strip(), "last_name": (last_name or "").strip(),
            "email": (email or "").strip().lower(), "phone": (phone or "").strip(),
            "amka": (amka or "").strip(), "password_hash": password_hash,
            "refresh_token_version": 0, "created_at": _now(),
        }
        res = await self.db["patient_accounts"].insert_one(doc)  # tenant-ok
        doc["_id"] = res.inserted_id
        return doc

    async def set_password(self, account_id, password_hash: str) -> None:
        oid = _oid(account_id)
        if oid:
            await self.db["patient_accounts"].update_one(  # tenant-ok
                {"_id": oid}, {"$set": {"password_hash": password_hash},
                               "$inc": {"refresh_token_version": 1}})

    # ── cross-pharmacy linking (by ΑΜΚΑ) ──────────────────────
    async def refresh_links(self, account_id, amka: str) -> list[dict]:
        """Scan every pharmacy with the portal enabled; match the patient by the per-tenant
        pseudonym of ΑΜΚΑ and upsert a link. Returns the patient's links (their pharmacies)."""
        oid = _oid(account_id)
        amka = (amka or "").strip()
        out: list[dict] = []
        if not oid or not amka:
            return out
        async for t in self.db["tenants"].find(  # tenant-ok: cross-tenant discovery by design
                {}, {"_id": 1, "name": 1, "company": 1, "modules": 1}):
            tid = str(t["_id"])
            if ((t.get("modules") or {}).get("patient_portal")) in (None, "locked"):
                continue  # only pharmacies that turned the portal on
            try:
                pseudo = pseudonymize(amka, tenant_pepper=vault.tenant_pepper(tid))
            except Exception:  # noqa: BLE001
                continue
            pat = await self.db["patients_anonymized"].find_one(  # tenant-ok: explicit tenant_id
                {"tenant_id": tid, "pseudo_id": pseudo}, {"_id": 1})
            if not pat:
                continue
            name = (t.get("company") or {}).get("name") or t.get("name") or tid
            await self.db["patient_links"].update_one(  # tenant-ok: global link doc
                {"account_id": oid, "tenant_id": tid},
                {"$set": {"patient_ref": pat["_id"], "pharmacy_name": name, "updated_at": _now()},
                 "$setOnInsert": {"created_at": _now()}}, upsert=True)
            out.append({"tenant_id": tid, "patient_ref": str(pat["_id"]), "pharmacy_name": name})
        return out

    async def links(self, account_id) -> list[dict]:
        oid = _oid(account_id)
        if not oid:
            return []
        rows = [r async for r in self.db["patient_links"].find({"account_id": oid})]  # tenant-ok
        return [{"tenant_id": r["tenant_id"], "patient_ref": str(r["patient_ref"]),
                 "pharmacy_name": r.get("pharmacy_name")} for r in rows]

    async def link_for(self, account_id, tenant_id: str) -> dict | None:
        oid = _oid(account_id)
        if not oid:
            return None
        return await self.db["patient_links"].find_one(  # tenant-ok
            {"account_id": oid, "tenant_id": tenant_id})

    # ── pharmacy directory (nearby) ───────────────────────────
    async def nearby_pharmacies(self, lat: float, lon: float, *, limit: int = 25) -> list[dict]:
        """Portal-enabled pharmacies that published a location, sorted by distance (Haversine).
        A patient may ask availability / book at ANY of these — not only where they have history."""
        out: list[dict] = []
        async for t in self.db["tenants"].find(  # tenant-ok: public pharmacy directory
                {}, {"_id": 1, "name": 1, "company": 1, "contact_phone": 1, "modules": 1, "location": 1}):
            if ((t.get("modules") or {}).get("patient_portal")) in (None, "locked"):
                continue
            loc = t.get("location") or {}
            la, lo = loc.get("lat"), loc.get("lon")
            if la is None or lo is None:
                continue
            d = _haversine_km(lat, lon, float(la), float(lo))
            comp = t.get("company") or {}
            out.append({
                "tenant_id": str(t["_id"]),
                "name": comp.get("name") or t.get("name") or str(t["_id"]),
                "address": loc.get("address") or comp.get("address"),
                "phone": t.get("contact_phone") or comp.get("phone"),
                "distance_km": round(d, 1), "lat": float(la), "lon": float(lo),
            })
        out.sort(key=lambda x: x["distance_km"])
        return out[:limit]

    async def pharmacy_has_portal(self, tenant_id: str) -> bool:
        t = await self.db["tenants"].find_one({"_id": tenant_id}, {"modules": 1})  # tenant-ok
        return bool(t and (t.get("modules") or {}).get("patient_portal") not in (None, "locked"))

    # ── medicine catalogue (shared) ───────────────────────────
    async def search_medicines(self, q: str, *, limit: int = 15) -> list[dict]:
        rx = re.escape((q or "").strip())
        if len(rx) < 2:
            return []
        cur = self.db["medicine_catalog"].find(  # tenant-ok: shared drug reference, no PII
            {"$or": [{"full_name": {"$regex": rx, "$options": "i"}},
                     {"name": {"$regex": rx, "$options": "i"}}]},
            {"_id": 0, "barcode": 1, "full_name": 1, "name": 1}).limit(limit)
        return [{"barcode": d.get("barcode"), "name": d.get("full_name") or d.get("name")}
                async for d in cur]

    async def medicine_by_barcode(self, code: str) -> dict | None:
        code = (code or "").strip()
        if not code:
            return None
        d = await self.db["medicine_catalog"].find_one(  # tenant-ok: shared reference
            {"barcode": code}, {"_id": 0, "barcode": 1, "full_name": 1, "name": 1})
        return {"barcode": d.get("barcode"), "name": d.get("full_name") or d.get("name")} if d else None

    # ── patient's own requests ACROSS pharmacies (by account) ──
    async def my_availability(self, account_id) -> list[dict]:
        oid = _oid(account_id)
        if not oid:
            return []
        rows = [r async for r in self.db["availability_requests"]  # tenant-ok: patient's own by account
                .find({"account_id": oid}).sort("created_at", -1).limit(100)]
        return jsonsafe(rows)

    async def my_appointments(self, account_id) -> list[dict]:
        oid = _oid(account_id)
        if not oid:
            return []
        rows = [r async for r in self.db["appointments"]  # tenant-ok: patient's own by account
                .find({"account_id": oid}).sort("requested_at", -1).limit(100)]
        return jsonsafe(rows)

    # ── on-demand notifications feed (across the patient's pharmacies) ──
    async def notifications(self, account_id) -> list[dict]:
        oid = _oid(account_id)
        if not oid:
            return []
        now = datetime.now(tz=timezone.utc)
        out: list[dict] = []
        # 1) repeats opening within 7 days (per linked pharmacy)
        for ln in await self.links(account_id):
            pid = _oid(ln["patient_ref"])
            if not pid:
                continue
            async for e in self.db["prescription_executions"].find(  # tenant-ok: explicit tenant_id
                    {"tenant_id": ln["tenant_id"], "patient_ref": pid,
                     "next_open_date": {"$gte": now, "$lte": now + timedelta(days=7)}},
                    {"next_open_date": 1}).sort("next_open_date", 1):
                d = e["next_open_date"]
                out.append({"id": f"rx-{e['_id']}", "type": "repeat", "when": d,
                            "title": "Ανοίγει συνταγή σου",
                            "body": f"{ln['pharmacy_name']} — διαθέσιμη από {d.strftime('%d/%m/%Y')}"})
        # 2) appointments within 48h
        async for a in self.db["appointments"].find(  # tenant-ok: patient's own by account
                {"account_id": oid, "status": {"$in": ["requested", "confirmed"]},
                 "requested_at": {"$gte": now, "$lte": now + timedelta(days=2)}}).sort("requested_at", 1):
            d = a["requested_at"]
            out.append({"id": f"ap-{a['_id']}", "type": "appointment", "when": d,
                        "title": "Πλησιάζει το ραντεβού σου",
                        "body": f"{a.get('service_name')} — {d.strftime('%d/%m %H:%M')}"})
        # 3) availability answers in the last 7 days
        async for r in self.db["availability_requests"].find(  # tenant-ok: patient's own by account
                {"account_id": oid, "status": "answered",
                 "answered_at": {"$gte": now - timedelta(days=7)}}).sort("answered_at", -1):
            out.append({"id": f"av-{r['_id']}", "type": "answer", "when": r.get("answered_at"),
                        "title": "Απάντηση διαθεσιμότητας",
                        "body": f"{r.get('medicine_name') or r.get('query')}: {r.get('answer')}"})
        # 4) appointment/pickup status updates by the pharmacist (confirmed / ready) in the last 7 days
        async for a in self.db["appointments"].find(  # tenant-ok: patient's own by account
                {"account_id": oid, "status": {"$in": ["confirmed", "ready"]},
                 "updated_at": {"$gte": now - timedelta(days=7)}}).sort("updated_at", -1):
            ready = a.get("status") == "ready"
            is_pickup = a.get("kind") == "pickup"
            when = a.get("requested_at")
            label = a.get("service_name") or ("Παραλαβή" if is_pickup else "Ραντεβού")
            title = ("✅ Έτοιμη για παραλαβή" if ready and is_pickup
                     else "✅ Επιβεβαιώθηκε η παραλαβή" if is_pickup
                     else "✅ Επιβεβαιώθηκε το ραντεβού σου")
            body = label + (f" — {when.strftime('%d/%m %H:%M')}" if when else "")
            out.append({"id": f"apst-{a['_id']}-{a.get('status')}", "type": "appointment_status",
                        "when": a.get("updated_at"), "title": title, "body": body})
        out.sort(key=lambda x: x.get("when") or now)
        return jsonsafe(out)


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


class PatientRxRepository(BaseRepository):
    """Tenant-scoped reads of ONE patient's own data (the patient_ref comes from their token).
    Patient-appropriate projection only — date, medicines, what they paid, repeat/next-open."""

    collection_name = "prescription_executions"

    async def my_prescriptions(self, patient_ref: str, *, limit: int = 60) -> list[dict]:
        pid = _oid(patient_ref)
        if not pid:
            return []
        pipe = [
            {"$match": {"patient_ref": pid}},
            {"$sort": {"executed_at": -1}},
            {"$limit": limit},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "items"}},
            {"$lookup": {"from": "products", "localField": "items.product_id",
                         "foreignField": "_id", "as": "prods"}},
            {"$lookup": {"from": "doctors", "localField": "doctor_id",
                         "foreignField": "_id", "as": "doc"}},
            {"$project": {"_id": 0, "barcode": "$external_id", "executed_at": 1, "status": 1,
                          "patient_share": 1, "repeat_current": 1, "repeat_total": 1,
                          "next_open_date": 1, "icd10": 1,
                          "doctor": {"$ifNull": [{"$first": "$doc.full_name"}, None]},
                          "specialty": {"$ifNull": [{"$first": "$doc.specialty"}, None]},
                          # was the prescription executed in full, or are some substances still pending?
                          "partial": {"$ifNull": ["$has_unexecuted_substances", False]},
                          "medicines": {"$map": {"input": "$prods", "as": "p", "in": "$$p.name"}},
                          # names of the medicines the patient has NOT received yet (is_executed=false)
                          "pending": {"$map": {
                              "input": {"$filter": {"input": "$items", "as": "it",
                                                    "cond": {"$eq": ["$$it.is_executed", False]}}},
                              "as": "it",
                              "in": {"$let": {
                                  "vars": {"m": {"$first": {"$filter": {
                                      "input": "$prods", "as": "p",
                                      "cond": {"$eq": ["$$p._id", "$$it.product_id"]}}}}},
                                  "in": {"$ifNull": ["$$m.name", "Φάρμακο"]}}}}}}},
        ]
        return await self.aggregate(pipe)

    async def my_prescription_detail(self, patient_ref: str, barcode: str) -> dict | None:
        """Full drill-down for ONE of the patient's own prescriptions (ownership enforced by
        patient_ref + tenant scope). Per-line: medicine, qty, what they paid, executed flag."""
        pid = _oid(patient_ref)
        if not pid:
            return None
        bc = str(barcode).split(":")[0]
        ex = await self._coll.find_one(self._scope(
            {"patient_ref": pid, "external_id": {"$regex": "^" + re.escape(bc)}}))
        if not ex:
            return None
        doctor = await self._db["doctors"].find_one({"_id": ex.get("doctor_id")}) if ex.get("doctor_id") else None
        items = []
        async for it in self._db["prescription_items"].find(
                {"tenant_id": self.tenant_id, "execution_id": ex["_id"]}):
            prod = await self._db["products"].find_one({"_id": it.get("product_id")}) if it.get("product_id") else None
            d = it.get("details") or {}
            items.append({
                "name": (prod or {}).get("name"),
                "quantity": it.get("quantity", 1),
                "retail_price": it.get("retail_price", 0),
                "is_executed": it.get("is_executed", True),
                # doctor's posology for this line (dose · frequency · duration), from the ΗΔΙΚΑ CDA
                "dosage": _format_dosage(d.get("dose"), d.get("frequency"), d.get("duration")),
                "details": d,
            })
        return jsonsafe({
            "barcode": str(ex.get("external_id", "")).split(":")[0],
            "executed_at": ex.get("executed_at"), "status": ex.get("status"),
            "patient_share": ex.get("patient_share", 0), "amount_total": ex.get("amount_total", 0),
            "repeat_current": ex.get("repeat_current", 1), "repeat_total": ex.get("repeat_total", 1),
            "next_open_date": ex.get("next_open_date"),
            "icd10": await self._icd10_named(ex.get("icd10", [])),
            "doctor": (doctor or {}).get("full_name"), "specialty": (doctor or {}).get("specialty"),
            "details": ex.get("details") or {}, "items": items,
        })

    async def summary(self, patient_ref: str) -> dict:
        """Patient KPI snapshot for the portal home: how many prescriptions, what they paid out of
        pocket, how much their insurance fund covered (savings), active repeats + next open date,
        and how many distinct doctors/medicines. All scoped to the patient's own record."""
        empty = {"rx_count": 0, "paid_cents": 0, "covered_cents": 0, "total_cents": 0,
                 "doctors": 0, "medicines": 0, "repeats_active": 0,
                 "next_open_date": None, "first_at": None, "last_at": None}
        pid = _oid(patient_ref)
        if not pid:
            return empty
        base = await self.aggregate([
            {"$match": {"patient_ref": pid, "status": "executed"}},
            {"$group": {"_id": None,
                        "rx_count": {"$sum": 1},
                        "paid_cents": {"$sum": {"$ifNull": ["$patient_share", 0]}},
                        "total_cents": {"$sum": {"$ifNull": ["$amount_total", 0]}},
                        "doctors": {"$addToSet": "$doctor_id"},
                        "first_at": {"$min": "$executed_at"},
                        "last_at": {"$max": "$executed_at"}}},
        ])
        g = base[0] if base else {}
        meds = await self.aggregate([
            {"$match": {"patient_ref": pid, "status": "executed"}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "items"}},
            {"$unwind": "$items"},
            {"$group": {"_id": None, "set": {"$addToSet": "$items.product_id"}}},
        ])
        rep = await self.aggregate([
            {"$match": {"patient_ref": pid, "next_open_date": {"$gte": _now()}}},
            {"$group": {"_id": None, "n": {"$sum": 1}, "next": {"$min": "$next_open_date"}}},
        ])
        r = rep[0] if rep else {}
        total = g.get("total_cents", 0) or 0
        paid = g.get("paid_cents", 0) or 0
        return jsonsafe({
            "rx_count": g.get("rx_count", 0),
            "paid_cents": paid,
            "total_cents": total,
            "covered_cents": max(0, total - paid),
            "doctors": len([d for d in (g.get("doctors") or []) if d]),
            "medicines": len((meds[0].get("set") if meds else []) or []),
            "repeats_active": r.get("n", 0),
            "next_open_date": r.get("next"),
            "first_at": g.get("first_at"),
            "last_at": g.get("last_at"),
        })

    async def _icd10_named(self, codes: list[str]) -> list[str]:
        """«J45» → «J45 — Βρογχικό άσθμα» από το icd10_codes (title_el). Για υποκατηγορία
        που λείπει (π.χ. E79.8) πέφτει στον γονικό κωδικό (E79)."""
        if not codes:
            return []
        want = set(codes)
        for c in codes:
            if "." in c:
                want.add(c.split(".")[0])
        names: dict = {}
        async for d in self._db["icd10_codes"].find({"_id": {"$in": list(want)}}):
            names[d["_id"]] = d.get("title_el") or d.get("description")
        out = []
        for c in codes:
            nm = names.get(c) or (names.get(c.split(".")[0]) if "." in c else None)
            out.append(f"{c} — {nm}" if nm else c)
        return out

    async def my_repeats(self, patient_ref: str) -> list[dict]:
        """Repeats that are open / about to open (the patient's recurring therapy).
        Only FUTURE open-dates — a repeat that 'opens' in the past makes no sense to the patient
        (and keeps this list consistent with the 'active repeats' KPI)."""
        pid = _oid(patient_ref)
        if not pid:
            return []
        pipe = [
            {"$match": {"patient_ref": pid, "next_open_date": {"$gte": _now()}}},
            {"$sort": {"next_open_date": 1}},
            {"$limit": 60},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "items"}},
            {"$lookup": {"from": "products", "localField": "items.product_id",
                         "foreignField": "_id", "as": "prods"}},
            {"$project": {"_id": 0, "barcode": "$external_id", "next_open_date": 1,
                          "repeat_current": 1, "repeat_total": 1,
                          # one entry per line: medicine name + the doctor's dosage details
                          "medicines": {"$map": {
                              "input": "$items", "as": "it",
                              "in": {"$let": {
                                  "vars": {"m": {"$first": {"$filter": {
                                      "input": "$prods", "as": "p",
                                      "cond": {"$eq": ["$$p._id", "$$it.product_id"]}}}}},
                                  "in": {"name": {"$ifNull": ["$$m.name", "Φάρμακο"]},
                                         "dose": "$$it.details.dose",
                                         "frequency": "$$it.details.frequency",
                                         "duration": "$$it.details.duration"}}}}}}},
        ]
        rows = await self.aggregate(pipe)
        for r in rows:
            for m in r.get("medicines", []):
                m["dosage"] = _format_dosage(m.get("dose"), m.get("frequency"), m.get("duration"))
        return rows


class PharmacyServiceRepository(BaseRepository):
    """Per-pharmacy catalogue of bookable services (vaccinations, measurements, etc.)."""

    collection_name = "pharmacy_services"

    async def list_active(self) -> list[dict]:
        return await self.find({"active": True}, sort=[("name", 1)], limit=200)

    async def list_all(self) -> list[dict]:
        return await self.find({}, sort=[("name", 1)], limit=200)

    async def create(self, doc: dict) -> str:
        return str(await self.insert_one({**doc, "active": doc.get("active", True),
                                          "created_at": _now()}))

    async def set(self, service_id: str, fields: dict):
        oid = _oid(service_id)
        if oid:
            await self.update_one({"_id": oid}, {"$set": {**fields, "updated_at": _now()}})


class AvailabilityRepository(BaseRepository):
    """Patient → pharmacist 'do you have medicine X?' questions, with the pharmacist's answer."""

    collection_name = "availability_requests"

    async def create(self, *, account_id: str, query: str, patient_ref: str | None = None,
                     patient_name: str = "", patient_phone: str = "",
                     medicine_barcode: str | None = None, medicine_name: str | None = None) -> str:
        return str(await self.insert_one({
            "patient_ref": _oid(patient_ref) if patient_ref else None,
            "account_id": _oid(account_id),
            "patient_name": patient_name, "patient_phone": patient_phone,
            "medicine_barcode": medicine_barcode, "medicine_name": medicine_name,
            "query": (query or "").strip()[:300], "status": "open", "answer": None,
            "created_at": _now(), "answered_at": None}))

    async def mine(self, patient_ref: str) -> list[dict]:
        return await self.find({"patient_ref": _oid(patient_ref)},
                               sort=[("created_at", -1)], limit=100)

    async def inbox(self, *, only_open: bool = False) -> list[dict]:
        q = {"status": "open"} if only_open else {}
        return await self.find(q, sort=[("created_at", -1)], limit=300)

    async def answer(self, request_id: str, answer: str) -> dict | None:
        oid = _oid(request_id)
        if not oid:
            return None
        await self.update_one({"_id": oid}, {"$set": {
            "answer": answer.strip()[:600], "status": "answered", "answered_at": _now()}})
        return await self.find_one({"_id": oid})


class AppointmentRepository(BaseRepository):
    """Patient appointment bookings (vaccination / pharmacy services)."""

    collection_name = "appointments"

    async def create(self, *, account_id: str, service_id: str | None, service_name: str,
                     requested_at, note: str | None, patient_ref: str | None = None,
                     patient_name: str = "", patient_phone: str = "", kind: str = "service") -> str:
        return str(await self.insert_one({
            "patient_ref": _oid(patient_ref) if patient_ref else None,
            "account_id": _oid(account_id),
            "patient_name": patient_name, "patient_phone": patient_phone,
            "service_id": _oid(service_id) if service_id else None,
            "service_name": service_name, "kind": kind, "requested_at": requested_at,
            "note": (note or "").strip()[:300], "status": "requested", "created_at": _now()}))

    async def mine(self, patient_ref: str) -> list[dict]:
        return await self.find({"patient_ref": _oid(patient_ref)},
                               sort=[("requested_at", -1)], limit=100)

    async def list_all(self, *, upcoming: bool = False) -> list[dict]:
        q = {"requested_at": {"$gte": _now()}} if upcoming else {}
        return await self.find(q, sort=[("requested_at", 1)], limit=300)

    async def pending(self) -> list[dict]:
        """New bookings the pharmacist hasn't acted on yet (status=requested)."""
        return await self.find({"status": "requested"}, sort=[("created_at", -1)], limit=100)

    async def set_status(self, appt_id: str, status: str) -> dict | None:
        oid = _oid(appt_id)
        if not oid:
            return None
        await self.update_one({"_id": oid}, {"$set": {"status": status, "updated_at": _now()}})
        return await self.find_one({"_id": oid})
