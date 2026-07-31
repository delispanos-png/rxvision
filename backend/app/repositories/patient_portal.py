"""Patient-portal accounts & cross-pharmacy links — GLOBAL, keyed by ΑΜΚΑ (NOT tenant-scoped).

A patient has ONE account (the ΑΜΚΑ is the universal key). Their records live in each pharmacy
(tenant) under a per-tenant pseudonym = HMAC(ΑΜΚΑ, tenant_pepper). We auto-discover every pharmacy
whose pseudonym matches an existing patient record and cache it as a `patient_link` — no pharmacist
approval. The patient picks an active pharmacy per session; the profile aggregates across all links.

These two collections are cross-tenant BY DESIGN (a patient spans pharmacies), so they do NOT go
through BaseRepository. Every read of a pharmacy's data still carries an explicit tenant_id.
"""
from __future__ import annotations

import hashlib
import io
import math
import re
import secrets
from datetime import datetime, timedelta, timezone

from bson import Binary, ObjectId

from app.core.db import shared_db
from app.repositories.base import BaseRepository, jsonsafe
from app.services.vault_service import vault
from app.utils.anonymization import pseudonymize


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _exec_ts(row: dict) -> float:
    """Χρονική σφραγίδα εκτέλεσης για ταξινόμηση ΔΙΑ-φαρμακειακά. Ανθεκτικό σε datetime (naive ή
    aware), ISO string ή τίποτα — αλλιώς η ένωση λιστών από διαφορετικά tenants σκάει με TypeError."""
    v = row.get("executed_at")
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).timestamp()
    if isinstance(v, str):
        try:
            d = datetime.fromisoformat(v.replace("Z", "+00:00"))
            return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except Exception:  # noqa: BLE001
        return None


# ΗΔΥΚΑ CDA frequency table (effectiveTime PIVL_TS period value+unit → human text), per the
# official CDA spec §2.1.2.4. Anything not in the table falls back to a "κάθε N <μονάδα>" form.
_FREQ_MAP = {
    ("2", "wk"): "κάθε 2 εβδομάδες", ("1", "wk"): "1 φορά/εβδομάδα",
    ("1", "d"): "1 φορά/ημέρα", ("4", "d"): "2 φορές/εβδομάδα", ("2", "d"): "3 φορές/εβδομάδα",
    ("12", "h"): "2 φορές/ημέρα", ("8", "h"): "3 φορές/ημέρα", ("6", "h"): "4 φορές/ημέρα",
    ("1", "once"): "εφάπαξ", ("1", "pain"): "επί πόνου",
    ("1", "dyspnea"): "επί δύσπνοιας", ("1", "without"): "άνευ",
}
_UNIT_EL = {"h": "ώρες", "d": "ημέρες", "wk": "εβδομάδες", "mo": "μήνες"}


def _parse_qty(val):
    """'12 h' / '12.0 h' → ('12', 'h'); None on no match."""
    m = re.match(r"\s*([\d.]+)\s*([A-Za-z]+)", str(val or ""))
    if not m:
        return None
    num = m.group(1)
    try:
        num = str(int(float(num)))
    except ValueError:
        pass
    return num, m.group(2)


def _format_dosage(dose, freq, dur) -> str | None:
    """Doctor's posology from the ΗΔΥΚΑ CDA, formatted EXACTLY per the CDA spec §2.1.2.4:
    dose (doseQuantity, π.χ. «1 ΔΙΣΚΙΑ»), frequency (PIVL_TS period → πίνακας συχνότητας,
    π.χ. «12 h» → «2 φορές/ημέρα»), duration (rateQuantity σε ημέρες → «για N ημέρες»)."""
    parts: list[str] = []
    if dose:
        parts.append(str(dose).replace("_", " ").strip())
    fq = _parse_qty(freq)
    if fq:
        num, unit = fq
        parts.append(_FREQ_MAP.get((num, unit)) or f"κάθε {num} {_UNIT_EL.get(unit, unit)}")
    dq = _parse_qty(dur)
    if dq:
        num, unit = dq
        parts.append(f"για {num} {_UNIT_EL.get(unit, unit)}")
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
                     phone: str | None, amka: str, password_hash: str,
                     must_change_password: bool = False) -> dict:
        # NB: raw ΑΜΚΑ stored — it is the universal matching key and is needed to (re)derive each
        # pharmacy's pseudonym when the patient is served at a new pharmacy. Encrypt-at-rest is a
        # follow-up (consistent with the existing controller AMKA-at-rest decision).
        doc = {
            "first_name": (first_name or "").strip(), "last_name": (last_name or "").strip(),
            "email": (email or "").strip().lower(), "phone": (phone or "").strip(),
            "amka": (amka or "").strip(), "password_hash": password_hash,
            "must_change_password": bool(must_change_password),
            "refresh_token_version": 0, "created_at": _now(),
        }
        res = await self.db["patient_accounts"].insert_one(doc)  # tenant-ok
        doc["_id"] = res.inserted_id
        return doc

    async def set_favorite(self, account_id, tenant_id: str) -> None:
        oid = _oid(account_id)
        if oid:
            await self.db["patient_accounts"].update_one(  # tenant-ok: global patient account
                {"_id": oid}, {"$set": {"favorite_tenant_id": tenant_id}})

    async def set_password(self, account_id, password_hash: str) -> None:
        """Ορίζει κωδικό, καθαρίζει το must_change_password + τυχόν set-password token, και ακυρώνει
        παλιά refresh tokens (bump version)."""
        oid = _oid(account_id)
        if oid:
            await self.db["patient_accounts"].update_one(  # tenant-ok
                {"_id": oid},
                {"$set": {"password_hash": password_hash, "must_change_password": False},
                 "$inc": {"refresh_token_version": 1},
                 "$unset": {"set_pw_token_hash": "", "set_pw_expires": ""}})

    async def create_set_password_token(self, account_id, ttl_hours: int = 168) -> str | None:
        """Δημιουργεί single-use token «ορισμού κωδικού» (7 ημέρες). Αποθηκεύεται SHA-256-hashed."""
        oid = _oid(account_id)
        if not oid:
            return None
        token = secrets.token_urlsafe(32)
        await self.db["patient_accounts"].update_one(  # tenant-ok: global patient account
            {"_id": oid},
            {"$set": {"set_pw_token_hash": hashlib.sha256(token.encode()).hexdigest(),
                      "set_pw_expires": _now() + timedelta(hours=ttl_hours)}})
        return token

    async def get_by_set_password_token(self, token: str) -> dict | None:
        h = hashlib.sha256((token or "").strip().encode()).hexdigest()
        return await self.db["patient_accounts"].find_one(  # tenant-ok: global patient account
            {"set_pw_token_hash": h, "set_pw_expires": {"$gt": _now()}})

    async def update_profile(self, account_id, **fields) -> None:
        """Ενημέρωση επεξεργάσιμων πεδίων προφίλ (ΟΧΙ email/ΑΜΚΑ — ταυτότητα)."""
        oid = _oid(account_id)
        allowed = {k: v for k, v in fields.items()
                   if k in ("first_name", "last_name", "phone", "address", "city",
                            "postal_code", "theme") and v is not None}
        if not oid or not allowed:
            return
        # αλλαγή τηλεφώνου → ακυρώνει την επιβεβαίωση (το νέο νούμερο πρέπει να ξανα-επιβεβαιωθεί)
        if "phone" in allowed:
            cur = await self.db["patient_accounts"].find_one({"_id": oid}, {"phone": 1})
            if (cur or {}).get("phone") != allowed["phone"]:
                allowed["phone_verified"] = False
        await self.db["patient_accounts"].update_one(  # tenant-ok: global patient account
            {"_id": oid}, {"$set": allowed})

    async def set_phone_verified(self, account_id, phone: str) -> None:
        oid = _oid(account_id)
        if oid:
            await self.db["patient_accounts"].update_one(  # tenant-ok: global patient account
                {"_id": oid}, {"$set": {"phone": (phone or "").strip(), "phone_verified": True}})

    async def save_avatar(self, account_id, raw: bytes, content_type: str) -> str | None:
        """Resize σε ≤400px + JPEG, αποθήκευση σε `patient_avatars`· θέτει avatar_id στον λογαριασμό."""
        oid = _oid(account_id)
        if not oid:
            return None
        try:
            from PIL import Image
            im = Image.open(io.BytesIO(raw))
            im.thumbnail((400, 400))
            if im.mode == "P":
                im = im.convert("RGBA")
            if im.mode in ("RGBA", "LA"):
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[-1])
                im = bg
            elif im.mode != "RGB":
                im = im.convert("RGB")
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=82, optimize=True)
            data = buf.getvalue()
        except Exception:  # noqa: BLE001 — κακή/εχθρική εικόνα → None, ποτέ 500
            return None
        res = await self.db["patient_avatars"].insert_one(  # tenant-ok: global, opaque id
            {"account_id": str(account_id), "content_type": "image/jpeg",
             "data": Binary(data), "created_at": _now()})
        await self.db["patient_accounts"].update_one(  # tenant-ok: global patient account
            {"_id": oid}, {"$set": {"avatar_id": res.inserted_id}})
        return str(res.inserted_id)

    async def set_consent(self, account_id, kind: str, granted: bool) -> dict | None:
        """Θέτει μια συγκατάθεση GDPR (health_data | marketing) + καταγράφει σε append-only log
        (ημερομηνία + ανάκληση = πλήρες ίχνος). Επιστρέφει την τρέχουσα εγγραφή {granted, at}."""
        oid = _oid(account_id)
        if not oid or kind not in ("health_data", "marketing"):
            return None
        now = _now()
        entry = {"granted": bool(granted), "at": now}
        await self.db["patient_accounts"].update_one(  # tenant-ok: global patient account
            {"_id": oid}, {"$set": {f"consents.{kind}": entry}})
        await self.db["patient_consent_log"].insert_one(  # tenant-ok: global GDPR audit trail
            {"account_id": str(account_id), "kind": kind, "granted": bool(granted), "at": now})
        return entry

    @staticmethod
    async def get_avatar(image_id: str) -> tuple[bytes, str] | None:
        """Public read by opaque id (η δική του φωτογραφία· ObjectId μη-μαντεύσιμο, όπως τα product images)."""
        try:
            oid = ObjectId(image_id)
        except Exception:  # noqa: BLE001
            return None
        d = await shared_db()["patient_avatars"].find_one({"_id": oid})
        if not d or not d.get("data"):
            return None
        return bytes(d["data"]), d.get("content_type") or "image/jpeg"

    async def revoke_tokens(self, account_id) -> None:
        """Bump refresh_token_version → invalidate ALL of this patient's refresh tokens (logout).
        Access tokens (15-min) lapse on their own; a stolen refresh token can no longer mint new ones."""
        oid = _oid(account_id)
        if oid:
            await self.db["patient_accounts"].update_one(  # tenant-ok: global patient account
                {"_id": oid}, {"$inc": {"refresh_token_version": 1}})

    # ── cross-pharmacy linking (by ΑΜΚΑ) ──────────────────────
    async def refresh_links(self, account_id, amka: str) -> list[dict]:
        """Scan every pharmacy with the portal enabled; match the patient by the per-tenant
        pseudonym of ΑΜΚΑ and upsert a link. Returns the patient's links (their pharmacies)."""
        oid = _oid(account_id)
        amka = (amka or "").strip()
        out: list[dict] = []
        if not oid or not amka:
            return out
        from app.services.auth_service import resolve_tenant_modules, tenant_has
        async for t in self.db["tenants"].find(  # tenant-ok: cross-tenant discovery by design
                {}, {"_id": 1, "name": 1, "company": 1}):
            tid = str(t["_id"])
            # only pharmacies that have the portal ENABLED (effective: plan modules_included OR override —
            # not just the per-tenant override, otherwise a portal granted via the package is missed)
            if not tenant_has(await resolve_tenant_modules(tid), "patient_portal"):
                continue
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

    async def find_amka_contacts(self, amka: str) -> list[dict]:
        """On-file contacts (mobile/email) that a PHARMACY already holds for this ΑΜΚΑ, across every
        portal-enabled pharmacy where the ΑΜΚΑ matches a patient record. Used to send an ownership-proof
        OTP to a channel the registrant must already control — NOT to whatever they typed in the form."""
        from app.services.auth_service import resolve_tenant_modules, tenant_has
        amka = (amka or "").strip()
        out: list[dict] = []
        if not amka:
            return out
        async for t in self.db["tenants"].find({}, {"_id": 1}):  # tenant-ok: cross-tenant discovery
            tid = str(t["_id"])
            if not tenant_has(await resolve_tenant_modules(tid), "patient_portal"):
                continue
            try:
                pseudo = pseudonymize(amka, tenant_pepper=vault.tenant_pepper(tid))
            except Exception:  # noqa: BLE001
                continue
            pat = await self.db["patients_anonymized"].find_one(
                {"tenant_id": tid, "pseudo_id": pseudo}, {"_id": 1})
            if not pat:
                continue
            ct = await self.db["patient_contacts"].find_one(
                {"tenant_id": tid, "_id": pat["_id"]}, {"mobile": 1, "phone": 1, "email": 1})
            if ct:
                out.append({"tenant_id": tid,
                            "mobile": (ct.get("mobile") or ct.get("phone") or "").strip(),
                            "email": (ct.get("email") or "").strip().lower()})
        return out

    # ── registration OTP challenges (ΑΜΚΑ ownership proof) ─────
    async def create_otp_challenge(self, doc: dict) -> None:
        await self.db["patient_otp_challenges"].insert_one(doc)  # tenant-ok: global, TTL-reaped

    async def get_otp_challenge(self, cid: str) -> dict | None:
        return await self.db["patient_otp_challenges"].find_one({"_id": cid})

    async def bump_otp_attempt(self, cid: str) -> None:
        await self.db["patient_otp_challenges"].update_one({"_id": cid}, {"$inc": {"attempts": 1}})

    async def delete_otp_challenge(self, cid: str) -> None:
        await self.db["patient_otp_challenges"].delete_one({"_id": cid})

    async def links(self, account_id) -> list[dict]:
        oid = _oid(account_id)
        if not oid:
            return []
        rows = [r async for r in self.db["patient_links"].find({"account_id": oid})]  # tenant-ok
        return [{"tenant_id": r["tenant_id"], "patient_ref": str(r["patient_ref"]),
                 "pharmacy_name": r.get("pharmacy_name")} for r in rows]

    async def all_prescriptions(self, account_id, *, limit: int = 200) -> list[dict]:
        """ΟΛΕΣ οι εκτελέσεις του πελάτη, από ΟΛΑ τα φαρμακεία του, με ΕΤΙΚΕΤΑ φαρμακείου.

        Η συνταγή είναι του πελάτη → βλέπει τα δικά του παντού. Κάθε ερώτημα παραμένει
        tenant-scoped (ένα PatientRxRepository ανά link) — δεν σπάει η απομόνωση: κανένα
        φαρμακείο δεν βλέπει τα δεδομένα άλλου, μόνο ο ίδιος ο πελάτης.
        """
        out: list[dict] = []
        for ln in await self.links(account_id):
            try:
                rows = await PatientRxRepository(tenant_id=ln["tenant_id"]).my_prescriptions(
                    ln["patient_ref"], limit=limit)
            except Exception:  # noqa: BLE001
                continue                      # ένα προβληματικό φαρμακείο δεν ρίχνει όλη τη λίστα
            for r in rows:
                r["tenant_id"] = ln["tenant_id"]
                r["pharmacy_name"] = ln.get("pharmacy_name")
                out.append(r)
        out.sort(key=_exec_ts, reverse=True)
        return out[:limit]

    async def link_for(self, account_id, tenant_id: str) -> dict | None:
        oid = _oid(account_id)
        if not oid:
            return None
        return await self.db["patient_links"].find_one(  # tenant-ok
            {"account_id": oid, "tenant_id": tenant_id})

    async def link_or_create(self, account_id, tenant_id: str) -> dict | None:
        """Link του account με το φαρμακείο· αν ΔΕΝ υπάρχει και το φαρμακείο έχει ενεργή πύλη,
        δημιουργεί «καρτέλα χωρίς κίνηση» (patients_anonymized, rx_count 0) + link — ο πελάτης
        επιλέγει ΝΕΟ φαρμακείο για να το εξυπηρετηθεί (ερωτήματα/αγορές/ανάθεση). Ίδιο μοτίβο
        ψευδωνυμοποίησης με το onboarding — κάθε tenant έχει δικό του pepper (καμία διαρροή)."""
        existing = await self.link_for(account_id, tenant_id)
        if existing:
            return {"tenant_id": tenant_id, "patient_ref": str(existing["patient_ref"]),
                    "pharmacy_name": existing.get("pharmacy_name")}
        from app.services.auth_service import resolve_tenant_modules, tenant_has
        oid = _oid(account_id)
        acc = await self.get(account_id)
        amka = ((acc or {}).get("amka") or "").strip()
        if not oid or not amka or not tenant_has(await resolve_tenant_modules(tenant_id), "patient_portal"):
            return None
        try:
            pseudo = pseudonymize(amka, tenant_pepper=vault.tenant_pepper(tenant_id))
        except Exception:  # noqa: BLE001
            return None
        now = _now()
        await self.db["patients_anonymized"].update_one(  # tenant-ok: explicit tenant_id
            {"tenant_id": tenant_id, "pseudo_id": pseudo},
            {"$setOnInsert": {"tenant_id": tenant_id, "pseudo_id": pseudo, "rx_count": 0,
                              "rx_value_total": 0, "lifecycle": "new", "source": "portal_selected",
                              "created_at": now}}, upsert=True)
        pat = await self.db["patients_anonymized"].find_one(
            {"tenant_id": tenant_id, "pseudo_id": pseudo}, {"_id": 1})
        if not pat:
            return None
        t = await self.db["tenants"].find_one({"_id": tenant_id}, {"name": 1, "company": 1})
        name = ((t or {}).get("company") or {}).get("name") or (t or {}).get("name") or tenant_id
        await self.db["patient_links"].update_one(  # tenant-ok: global link doc
            {"account_id": oid, "tenant_id": tenant_id},
            {"$set": {"patient_ref": pat["_id"], "pharmacy_name": name, "updated_at": now},
             "$setOnInsert": {"created_at": now}}, upsert=True)
        return {"tenant_id": tenant_id, "patient_ref": str(pat["_id"]), "pharmacy_name": name}

    async def toggle_shop_favorite(self, account_id, tenant_id: str, barcode: str) -> bool:
        """Αγαπημένο ΠΡΟΪΟΝ e-shop (toggle). Κρατά την τιμή/απόθεμα τη στιγμή που το πρόσθεσε ώστε
        να ειδοποιούμε για πτώση τιμής / επιστροφή σε απόθεμα. Επιστρέφει την ΝΕΑ κατάσταση (fav;)."""
        oid = _oid(account_id)
        if not oid or not barcode:
            return False
        ex = await self.db["shop_favorites"].find_one(
            {"account_id": oid, "tenant_id": tenant_id, "barcode": barcode})
        if ex:
            await self.db["shop_favorites"].delete_one({"_id": ex["_id"]})
            return False
        from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
        p = await PharmacyCatalogRepository(tenant_id=tenant_id).get(barcode) or {}
        await self.db["shop_favorites"].insert_one({
            "account_id": oid, "tenant_id": tenant_id, "barcode": barcode,
            "price_at_add": p.get("price_cents"), "stock_at_add": p.get("stock_qty") or 0,
            "added_at": _now()})
        return True

    async def shop_favorites(self, account_id, tenant_id: str) -> list[dict]:
        """Αγαπημένα προϊόντα του ΕΝΕΡΓΟΥ φαρμακείου με ΤΡΕΧΟΝΤΑ στοιχεία + σημαίες αλλαγών."""
        oid = _oid(account_id)
        if not oid:
            return []
        from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
        cat = PharmacyCatalogRepository(tenant_id=tenant_id)
        out: list[dict] = []
        async for f in self.db["shop_favorites"].find({"account_id": oid, "tenant_id": tenant_id}):
            p = await cat.get(f["barcode"])
            if not p:
                continue
            pat, sat = f.get("price_at_add"), f.get("stock_at_add") or 0
            out.append({**p, "favorite": True, "price_at_add": pat,
                        "price_dropped": bool(pat) and (p.get("price_cents") or 0) < pat,
                        "back_in_stock": sat == 0 and (p.get("stock_qty") or 0) > 0})
        return jsonsafe(out)

    async def shop_favorite_barcodes(self, account_id, tenant_id: str) -> list[str]:
        oid = _oid(account_id)
        if not oid:
            return []
        return [f["barcode"] async for f in self.db["shop_favorites"].find(
            {"account_id": oid, "tenant_id": tenant_id}, {"barcode": 1})]

    async def set_favorite(self, account_id, tenant_id: str) -> str | None:
        """Δήλωση «αγαπημένου» φαρμακείου (toggle) — γίνεται το προεπιλεγμένο active στο login."""
        oid = _oid(account_id)
        if not oid:
            return None
        acc = await self.get(account_id)
        new = None if (acc or {}).get("favorite_tenant_id") == tenant_id else tenant_id
        await self.db["patient_accounts"].update_one(  # tenant-ok: global patient account
            {"_id": oid}, {"$set": {"favorite_tenant_id": new}})
        return new

    async def portal_customers(self, tenant_id: str, *, limit: int = 300) -> dict:
        """Pharmacist view: how many of THIS pharmacy's patients are registered in the portal
        («favourite» customers) vs how many remain to invite. patient_links.patient_ref ==
        patients_anonymized._id."""
        db = self.db
        links = [l async for l in db["patient_links"].find({"tenant_id": tenant_id})]  # tenant-ok: scoped
        by_ref = {l.get("patient_ref"): l for l in links if l.get("patient_ref")}
        reg_refs = list(by_ref.keys())
        total = await db["patients_anonymized"].count_documents(
            {"tenant_id": tenant_id, "lifecycle": {"$in": ["active", "new"]}})
        registered = len(reg_refs)
        reg_list: list = []
        if reg_refs:
            async for p in db["patients_anonymized"].find(
                    {"tenant_id": tenant_id, "_id": {"$in": reg_refs}},
                    {"full_name": 1, "last_seen_at": 1}):
                lk = by_ref.get(p["_id"]) or {}
                reg_list.append({"name": p.get("full_name") or "—",
                                 "since": lk.get("created_at"), "last_seen": p.get("last_seen_at")})
        reg_list.sort(key=lambda x: str(x.get("since") or ""), reverse=True)
        # patients we could proactively contact (have a mobile/email on file, not yet registered)
        contactable = await db["patient_contacts"].count_documents(
            {"tenant_id": tenant_id, "active": {"$ne": False},
             "$or": [{"mobile": {"$nin": [None, ""]}}, {"email": {"$nin": [None, ""]}}]})
        tenant = await db["tenants"].find_one({"_id": tenant_id}, {"name": 1})  # tenant-ok: own tenant
        return jsonsafe({
            "registered": registered,
            "total": total,
            "to_invite": max(0, total - registered),
            "adoption_pct": round(registered / total * 100, 1) if total else 0.0,
            "contactable": contactable,
            "registered_list": reg_list[:limit],
            "tenant_id": tenant_id,
            "pharmacy_name": (tenant or {}).get("name"),
            # QR / share link → pre-selects THIS pharmacy as the patient's «αγαπημένο»
            "register_url": f"https://my.rxvision.gr/portal/register?ph={tenant_id}",
        })

    # ── pharmacy directory (nearby) ───────────────────────────
    async def nearby_pharmacies(self, lat: float, lon: float, *, limit: int = 25) -> list[dict]:
        """Portal-enabled pharmacies that published a location, sorted by distance (Haversine).
        A patient may ask availability / book at ANY of these — not only where they have history."""
        from app.services.auth_service import resolve_tenant_modules, tenant_has
        out: list[dict] = []
        async for t in self.db["tenants"].find(  # tenant-ok: public pharmacy directory
                {"status": {"$in": ["active", "trial"]}},
                {"_id": 1, "name": 1, "company": 1, "contact_phone": 1, "location": 1}):
            loc = t.get("location") or {}
            la, lo = loc.get("lat"), loc.get("lon")
            if la is None or lo is None:
                continue
            # portal ΕΝΕΡΓΟ effective (plan OR override) — όχι το raw modules (που δεν το έχει)
            if not tenant_has(await resolve_tenant_modules(str(t["_id"])), "patient_portal"):
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

    async def directory(self, *, linked_ids: set[str] | None = None,
                        favorite_id: str | None = None, limit: int = 200) -> list[dict]:
        """Δημόσιος κατάλογος ΟΛΩΝ των φαρμακείων του δικτύου με ενεργή πύλη πελατών — ζωντανή
        κατάσταση + διεύθυνση/τηλέφωνο/lat-lon (για χιλιομετρική απόσταση client-side) + badges
        «αγαπημένο»/«δικό μου». Σειρά: αγαπημένο → δικά μου → υπόλοιπα (ανοιχτά πρώτα)."""
        from app.repositories.pharmacy_availability import PharmacyAvailabilityRepository
        from app.services.auth_service import resolve_tenant_modules, tenant_has
        linked = linked_ids or set()
        out: list[dict] = []
        async for t in self.db["tenants"].find(  # tenant-ok: public pharmacy directory (no PII)
                {"status": {"$in": ["active", "trial"]}},
                {"_id": 1, "name": 1, "company": 1, "contact_phone": 1, "location": 1}):
            tid = str(t["_id"])
            # portal ΕΝΕΡΓΟ effective (plan modules_included OR override) — όχι μόνο το per-tenant override.
            if not tenant_has(await resolve_tenant_modules(tid), "patient_portal"):
                continue
            comp = t.get("company") or {}
            loc = t.get("location") or {}
            try:
                st = await PharmacyAvailabilityRepository(tenant_id=tid).status()
            except Exception:  # noqa: BLE001 — μη-διαθέσιμο ωράριο δεν πρέπει να κρύβει το φαρμακείο
                st = None
            out.append({
                "tenant_id": tid,
                "name": comp.get("name") or t.get("name") or tid,
                "address": loc.get("address") or comp.get("address"),
                "city": loc.get("city") or comp.get("city"),
                "phone": t.get("contact_phone") or comp.get("phone"),
                "lat": loc.get("lat"), "lon": loc.get("lon"),
                "status": st,
                "mine": tid in linked,
                "favorite": bool(favorite_id) and tid == favorite_id,
            })
        # αγαπημένο → δικά μου → υπόλοιπα· μέσα σε κάθε ομάδα ανοιχτά/εφημερεύοντα πρώτα, μετά αλφαβητικά
        def _rank(p: dict) -> tuple:
            s = p.get("status") or {}
            return (0 if p.get("favorite") else 1, 0 if p.get("mine") else 1,
                    0 if (s.get("isOpen") or s.get("isOnDuty")) else 1, (p.get("name") or "").upper())
        out.sort(key=_rank)
        return out[:limit]

    async def pharmacy_has_portal(self, tenant_id: str) -> bool:
        # effective module resolution (plan modules_included OR override) — το raw tenants.modules
        # κρατά ΜΟΝΟ overrides, οπότε το patient_portal (που έρχεται από το πλάνο) έλειπε.
        from app.services.auth_service import resolve_tenant_modules, tenant_has
        return tenant_has(await resolve_tenant_modules(tenant_id), "patient_portal")

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
        """ΟΛΑ τα ραντεβού του πελάτη σε ΟΛΑ τα φαρμακεία (account-scoped), με το όνομα του κάθε
        φαρμακείου ανά ραντεβού — ώστε να ξεχωρίζει «αυτό αφορά το φαρμακείο Χ»."""
        oid = _oid(account_id)
        if not oid:
            return []
        rows = [r async for r in self.db["appointments"]  # tenant-ok: patient's own by account
                .find({"account_id": oid}).sort("requested_at", -1).limit(100)]
        names = {l["tenant_id"]: l.get("pharmacy_name") for l in await self.links(account_id)}
        for r in rows:
            tid = r.get("tenant_id")
            if tid and tid not in names:
                t = await self.db["tenants"].find_one({"_id": tid}, {"name": 1, "company": 1})
                names[tid] = ((t or {}).get("company") or {}).get("name") or (t or {}).get("name") or tid
            r["pharmacy_name"] = names.get(tid)
        return jsonsafe(rows)

    # ── on-demand notifications feed (across the patient's pharmacies) ──
    async def dismiss_notification(self, account_id, notif_id: str) -> bool:
        """Ο ασθενής «είδε» μια ειδοποίηση → μη την ξαναδείξεις. Οι ειδοποιήσεις υπολογίζονται
        on-demand (δεν αποθηκεύονται), οπότε κρατάμε ΜΟΝΟ τα dismissed ids ανά account."""
        oid = _oid(account_id)
        if not oid or not notif_id:
            return False
        await self.db["patient_notif_dismissed"].update_one(  # tenant-ok: patient's own by account
            {"account_id": oid, "notif_id": str(notif_id)},
            {"$set": {"account_id": oid, "notif_id": str(notif_id),
                      "at": datetime.now(tz=timezone.utc)}}, upsert=True)
        return True

    async def set_pickup_intent(self, account_id, notif_id: str, *, coming: bool,
                                date: str | None) -> bool:
        """Απάντηση διαθεσιμότητας (`av-<reqid>`): ο ασθενής δηλώνει αν θα περάσει να το πάρει
        (+ πότε) → γράφεται στο availability_request ώστε να το δει ο φαρμακοποιός, και η
        ειδοποίηση θεωρείται «ειδωμένη» (dismiss)."""
        oid = _oid(account_id)
        if not oid or not str(notif_id).startswith("av-"):
            return False
        rid = _oid(str(notif_id)[3:])
        if not rid:
            return False
        await self.db["availability_requests"].update_one(  # tenant-ok: patient's own by account
            {"_id": rid, "account_id": oid},
            {"$set": {"pickup_intent": {"coming": bool(coming), "date": date or None,
                                        "at": datetime.now(tz=timezone.utc)}}})
        await self.dismiss_notification(account_id, notif_id)
        return True

    async def notifications(self, account_id) -> list[dict]:
        oid = _oid(account_id)
        if not oid:
            return []
        now = datetime.now(tz=timezone.utc)
        dismissed = {d["notif_id"] async for d in                    # ήδη «ειδωμένες» → εξαίρεση
                     self.db["patient_notif_dismissed"].find({"account_id": oid}, {"notif_id": 1})}
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
        # 5) αγαπημένα προϊόντα e-shop — πτώση τιμής / επιστροφή σε απόθεμα (σε ΟΛΑ τα φαρμακεία)
        from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
        async for f in self.db["shop_favorites"].find({"account_id": oid}):  # tenant-ok: patient's own
            p = await PharmacyCatalogRepository(tenant_id=f["tenant_id"]).get(f.get("barcode"))
            if not p:
                continue
            nm = p.get("name") or f.get("barcode")
            price, pat = p.get("price_cents") or 0, f.get("price_at_add")
            if pat and price < pat:   # id με την τιμή → νέα πτώση ξανα-ειδοποιεί
                out.append({"id": f"favdrop-{f['barcode']}-{price}", "type": "fav_price", "when": now,
                            "title": "💶 Πτώση τιμής σε αγαπημένο",
                            "body": f"{nm}: {price/100:.2f}€ (από {pat/100:.2f}€)"})
            if (f.get("stock_at_add") or 0) == 0 and (p.get("stock_qty") or 0) > 0:
                out.append({"id": f"favstock-{f['barcode']}", "type": "fav_stock", "when": now,
                            "title": "📦 Διαθέσιμο ξανά",
                            "body": f"{nm} — ήρθε ξανά σε απόθεμα"})
        out = [o for o in out if o["id"] not in dismissed]   # κρύψε τις «ειδωμένες»
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
                # doctor's posology for this line (dose · frequency · duration), from the ΗΔΥΚΑ CDA
                "dosage": _format_dosage(d.get("dose"), d.get("frequency"), d.get("duration")),
                "details": d,
            })
        return jsonsafe({
            "barcode": str(ex.get("external_id", "")).split(":")[0],
            "executed_at": ex.get("executed_at"), "status": ex.get("status"),
            "patient_share": ex.get("patient_share", 0), "amount_total": ex.get("amount_total", 0),
            "repeat_current": ex.get("repeat_current", 1), "repeat_total": ex.get("repeat_total", 1),
            "repeat_root": ex.get("repeat_root"), "next_open_date": ex.get("next_open_date"),
            "icd10": await self._icd10_named(ex.get("icd10", [])),
            "doctor": (doctor or {}).get("full_name"), "specialty": (doctor or {}).get("specialty"),
            "details": ex.get("details") or {}, "items": items,
        })

    async def medication_schedule(self, patient_ref: str) -> dict:
        """The patient's ACTIVE therapies (course still running) with the doctor's posology turned
        into an intake plan + run-out date, plus a 7-day calendar grid for the opted-in ones."""
        from app.services import med_schedule as ms
        pid = _oid(patient_ref)
        if not pid:
            return {"therapies": [], "week": [], "slot_times": ms.SLOT_TIMES}
        now = datetime.now(tz=timezone.utc)
        horizon = now - timedelta(days=180)
        therapies: dict = {}
        async for ex in self._coll.find(  # tenant-ok: _scope adds tenant_id
                self._scope({"patient_ref": pid, "executed_at": {"$gte": horizon}})).sort("executed_at", -1):
            async for it in self._db["prescription_items"].find(
                    {"tenant_id": self.tenant_id, "execution_id": ex["_id"]}):
                if not it.get("is_executed", True):
                    continue
                d = it.get("details") or {}
                prod = (await self._db["products"].find_one({"_id": it.get("product_id")})
                        if it.get("product_id") else None)
                name = (prod or {}).get("name") or d.get("eof_code") or "Φάρμακο"
                med_key = str(it.get("product_id") or d.get("eof_code") or name)
                if med_key in therapies:        # keep only the most recent execution per medicine
                    continue
                plan = ms.frequency_plan(d.get("frequency"))
                ro = ms.runout_date(ex.get("executed_at"), d.get("duration"))
                active = (ro >= now) if ro else (ex.get("executed_at") and ex["executed_at"] >= now - timedelta(days=90))
                if not active:
                    continue
                therapies[med_key] = {
                    "med_key": med_key, "name": name,
                    "dose": (str(d.get("dose")).replace("_", " ").strip() if d.get("dose") else None),
                    "dosage_text": _format_dosage(d.get("dose"), d.get("frequency"), d.get("duration")),
                    "plan": plan, "kind": plan["kind"], "per_day": plan["per_day"],
                    "runout": ro, "last_dispensed": ex.get("executed_at"),
                    "days_left": ((ro - now).days if ro else None)}
        enabled = set()
        rem_cfg: dict = {}   # med_key → {time, meal} (ανά φάρμακο, ό,τι όρισε ο ασθενής στην ενεργοποίηση)
        async for r in self._db["med_reminders"].find(
                {"tenant_id": self.tenant_id, "patient_ref": pid, "enabled": True}):
            enabled.add(r.get("med_key"))
            rem_cfg[r.get("med_key")] = {"time": r.get("time"), "meal": r.get("meal"), "interval_hours": r.get("interval_hours")}
        setting = await self._db["med_settings"].find_one(
            {"tenant_id": self.tenant_id, "patient_ref": pid})
        slot_times = {**ms.SLOT_TIMES, **((setting or {}).get("slot_times") or {})}
        streak = await self._intake_streak(pid)
        # ποιες δόσεις (med_key + slot) πάρθηκαν ΣΗΜΕΡΑ — persisted, per-slot (πρωί≠βράδυ)
        today = now.strftime("%Y-%m-%d")
        taken_today = [{"med_key": r.get("med_key"), "slot": r.get("slot")}
                       async for r in self._db["med_intake_log"].find(
                           {"tenant_id": self.tenant_id, "patient_ref": pid, "date": today},
                           {"med_key": 1, "slot": 1})]
        ths = list(therapies.values())
        for t in ths:
            t["enabled"] = t["med_key"] in enabled
            t["reservable"] = t["days_left"] is not None and t["days_left"] <= 7
            cfg = rem_cfg.get(t["med_key"]) or {}
            t["time"] = cfg.get("time")      # custom ώρα λήψης (ή None → slot time)
            t["meal"] = cfg.get("meal")      # before/after/none
            t["interval_hours"] = cfg.get("interval_hours")  # «κάθε X ώρες» (ή None/0)
        plans = [{"med_key": t["med_key"], "name": t["name"], "dose": t["dose"], "plan": t["plan"]}
                 for t in ths if t["enabled"]]
        return jsonsafe({"therapies": ths, "week": ms.weekly_grid(plans, slot_times),
                         "slot_times": slot_times, "streak": streak, "taken_today": taken_today})

    async def _intake_streak(self, pid) -> int:
        dates: set = set()
        async for r in self._db["med_intake_log"].find(
                {"tenant_id": self.tenant_id, "patient_ref": pid}, {"date": 1}).sort("date", -1).limit(180):
            dates.add(r.get("date"))
        streak = 0
        d = datetime.now(tz=timezone.utc)
        while d.strftime("%Y-%m-%d") in dates:
            streak += 1
            d -= timedelta(days=1)
        return streak

    async def delete_intake(self, patient_ref: str, med_key: str, slot: str | None = None) -> dict:
        """Αναίρεση «✓ Το πήρα» — σβήνει την εγγραφή λήψης της συγκεκριμένης δόσης (med_key+slot) σήμερα."""
        pid = _oid(patient_ref)
        if not pid:
            return {"ok": False}
        today = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
        q = {"tenant_id": self.tenant_id, "patient_ref": pid, "med_key": med_key, "date": today}
        if slot is not None:
            q["slot"] = slot
        await self._db["med_intake_log"].delete_many(q)
        return {"ok": True, "streak": await self._intake_streak(pid)}

    async def log_intake(self, patient_ref: str, med_key: str, slot: str | None = None) -> dict:
        """«✓ Το πήρα» → record ΑΝΑ ΔΟΣΗ (med_key+slot, idempotent/μέρα), update streak, και (ΜΟΝΟ αν ο
        φαρμακοποιός το έχει ενεργοποιήσει + ο ασθενής είναι μέλος) δίνει πόντους συμμόρφωσης."""
        pid = _oid(patient_ref)
        if not pid:
            return {"ok": False}
        now = datetime.now(tz=timezone.utc)
        today = now.strftime("%Y-%m-%d")
        await self._db["med_intake_log"].update_one(
            {"tenant_id": self.tenant_id, "patient_ref": pid, "med_key": med_key, "slot": slot, "date": today},
            {"$set": {"at": now}}, upsert=True)
        streak = await self._intake_streak(pid)
        from app.repositories.loyalty import LoyaltyRepository
        lrepo = LoyaltyRepository(tenant_id=self.tenant_id)
        cfg = await lrepo.config()
        points = 0
        if cfg.get("adherence_points_enabled"):
            rule = cfg.get("adherence_rule", "per_day")
            base = int(cfg.get("points_per_adherence", 1))
            bonus = int(cfg.get("adherence_streak_bonus", 0)) if (streak and streak % 7 == 0) else 0
            award: tuple | None = None
            if rule == "per_med":          # κάθε φάρμακο που επιβεβαιώνεις
                award = (base, f"adh:{pid}:{med_key}:{today}", "Λήψη φαρμάκου")
            elif rule == "full_day":       # ΜΟΝΟ αν πάρει ΟΛΑ τα φάρμακα της ημέρας
                sched = await self.medication_schedule(patient_ref)
                dow = now.weekday()
                def _due(t):
                    days = (t.get("plan") or {}).get("days")
                    return days == "all" or (isinstance(days, list) and dow in days)
                due = [t for t in sched.get("therapies", []) if _due(t)]   # ΟΛΕΣ οι ενεργές, όχι μόνο opt-in
                confirmed = len(await self._db["med_intake_log"].distinct(  # distinct φάρμακα (όχι δόσεις)
                    "med_key", {"tenant_id": self.tenant_id, "patient_ref": pid, "date": today}))
                if due and confirmed >= len(due):
                    award = (base + bonus, f"adh:{pid}:{today}", f"Πλήρης λήψη ημέρας (σερί {streak})")
            else:                          # per_day — μία λήψη/ημέρα αρκεί
                award = (base + bonus, f"adh:{pid}:{today}", f"Συνεπής λήψη (σερί {streak} ημ.)")
            if award:
                res = await lrepo.award_adherence(str(patient_ref), award[0],
                                                  reason=award[2], dedup_key=award[1])
                points = res.get("points", 0)
        return {"ok": True, "streak": streak, "points_awarded": points}

    async def set_slot_times(self, patient_ref: str, times: dict) -> dict:
        pid = _oid(patient_ref)
        if not pid:
            return {"ok": False}
        clean = {k: str(times[k]) for k in ("morning", "noon", "evening", "night")
                 if times.get(k) and re.match(r"^\d{1,2}:\d{2}$", str(times[k]))}
        await self._db["med_settings"].update_one(
            {"tenant_id": self.tenant_id, "patient_ref": pid},
            {"$set": {"slot_times": clean, "updated_at": datetime.now(tz=timezone.utc)}}, upsert=True)
        return {"ok": True, "slot_times": clean}

    async def reserve_refill(self, *, account_id, patient_ref: str, med_name: str,
                             patient_name: str = "") -> dict:
        """Click-&-collect: κράτηση επανάληψης → «ραντεβού» kind=refill → μπαίνει στο worklist του
        φαρμακείου (ίδιο inbox/Copilot) → ο φαρμακοποιός το κάνει «έτοιμο» (υπάρχουσα ενέργεια)."""
        appt = AppointmentRepository(tenant_id=self.tenant_id)
        await appt.create(account_id=str(account_id), service_id=None,
                          service_name=f"Επανάληψη: {med_name}", requested_at=None,
                          note="Κράτηση επανάληψης από το πρόγραμμα λήψης", kind="refill",
                          patient_ref=patient_ref, patient_name=patient_name)
        return {"ok": True}

    async def set_reminder(self, patient_ref: str, med_key: str, enabled: bool,
                           time: str | None = None, meal: str | None = None,
                           interval_hours: int | None = None) -> dict:
        pid = _oid(patient_ref)
        if not pid or not med_key:
            return {"ok": False}
        upd: dict = {"enabled": enabled, "updated_at": datetime.now(tz=timezone.utc)}
        if time and re.match(r"^\d{1,2}:\d{2}$", str(time)):   # ώρα (πρώτης) λήψης
            upd["time"] = str(time)
        if meal in ("before", "after", "none"):                # σε σχέση με το γεύμα
            upd["meal"] = meal
        if interval_hours is not None:                         # «κάθε X ώρες» (0/None = συγκεκριμένη ώρα)
            upd["interval_hours"] = max(0, min(24, int(interval_hours)))
        await self._db["med_reminders"].update_one(
            {"tenant_id": self.tenant_id, "patient_ref": pid, "med_key": med_key},
            {"$set": upd}, upsert=True)
        return {"ok": True}

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

    async def delete(self, service_id: str):
        oid = _oid(service_id)
        if oid:
            await self.delete_many({"_id": oid})


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


class RxRequestRepository(BaseRepository):
    """Patient → pharmacy «Ανάθεση συνταγής»: by Rx barcode OR a photo of the doctor's paper Rx
    (stored in GridFS on our own infra). The pharmacist sees it and prepares/downloads the Rx."""

    collection_name = "rx_requests"

    def _bucket(self):
        from motor.motor_asyncio import AsyncIOMotorGridFSBucket
        return AsyncIOMotorGridFSBucket(self._db, bucket_name="rx_requests")

    async def create(self, *, account_id, patient_ref, patient_name, patient_phone,
                     kind: str, barcode: str | None = None, note: str | None = None,
                     image: bytes | None = None, content_type: str | None = None,
                     cda: dict | None = None) -> str:
        image_id = None
        if image is not None:
            image_id = await self._bucket().upload_from_stream(
                "rx", image, metadata={"tenant_id": self.tenant_id})
        return str(await self.insert_one({
            "account_id": _oid(account_id),
            "patient_ref": _oid(patient_ref) if patient_ref else None,
            "patient_name": patient_name, "patient_phone": patient_phone,
            "kind": kind, "barcode": ((barcode or "").strip()[:40] or None),
            "image_id": image_id, "content_type": content_type,
            "cda": cda,                          # live ΗΔΥΚΑ snapshot (barcode requests)
            "note": (note or "").strip()[:300], "status": "new", "created_at": _now()}))

    async def mine(self, account_id) -> list[dict]:
        return await self.find({"account_id": _oid(account_id)}, sort=[("created_at", -1)], limit=100)

    async def pending(self) -> list[dict]:
        return await self.find({"status": "new"}, sort=[("created_at", -1)], limit=100)

    async def list_all(self) -> list[dict]:
        return await self.find({}, sort=[("created_at", -1)], limit=300)

    async def set_status(self, req_id: str, status: str) -> dict | None:
        oid = _oid(req_id)
        if not oid:
            return None
        await self.update_one({"_id": oid}, {"$set": {"status": status, "updated_at": _now()}})
        return await self.find_one({"_id": oid})

    async def reply(self, req_id: str, text: str, available_date: str | None = None) -> dict | None:
        """Pharmacist replies to the patient (shortage info / availability date) + marks answered."""
        oid = _oid(req_id)
        if not oid:
            return None
        upd = {"reply": (text or "").strip()[:600], "replied_at": _now(), "status": "answered"}
        if available_date:
            upd["available_date"] = available_date
        await self.update_one({"_id": oid}, {"$set": upd})
        return await self.find_one({"_id": oid})

    async def image(self, req_id: str):
        oid = _oid(req_id)
        r = await self.find_one({"_id": oid}) if oid else None
        if not r or not r.get("image_id"):
            return None, None
        stream = await self._bucket().open_download_stream(_oid(r["image_id"]))
        return await stream.read(), r.get("content_type", "image/jpeg")
