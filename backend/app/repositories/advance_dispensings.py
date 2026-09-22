"""Προχορηγήσεις σκευασμάτων («δανεικά») — καταγραφή και ξεχρέωση.

ΤΙ ΔΕΝ ΕΙΝΑΙ: λογιστική απεικόνιση αποθέματος. Ο φαρμακοποιός δεν θέλει διπλογραφικό· θέλει να
θυμάται ποιος του χρωστά κουτί και να το σβήνει όταν έρθει η συνταγή.

Η ΤΑΥΤΙΣΗ ΓΙΝΕΤΑΙ ΣΤΗΝ ΑΝΑΓΝΩΣΗ, ΟΧΙ ΣΤΗΝ ΑΝΤΛΗΣΗ. Θα μπορούσαμε να ψάχνουμε ταίριασμα την
ώρα που κατεβαίνει η συνταγή, αλλά η άντληση είναι το πιο εύθραυστο κομμάτι του συστήματος και
τρέχει για 24.000 εκτελέσεις — ένα λάθος εκεί σταματά τον συγχρονισμό όλων. Το ερώτημα
ταύτισης είναι φθηνό, επαναλήψιμο και δεν μπορεί να χαλάσει δεδομένα.

ΠΡΟΤΕΙΝΟΥΜΕ, ΔΕΝ ΑΠΟΦΑΣΙΖΟΥΜΕ. Μετρημένο: το `strip` (ταινία) ΔΕΝ είναι μοναδικό — 17.325 από
115.476 εμφανίζονται πάνω από μία φορά. Γι' αυτό η ταύτιση συνδυάζει GTIN + παρτίδα + ταινία,
και το τελικό «ναι» το δίνει ΠΑΝΤΑ ο φαρμακοποιός. Μια αυτόματη ξεχρέωση σε λάθος ταίριασμα θα
έσβηνε χρέος που υπάρχει.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository

OPEN, CLEARED, WRITTEN_OFF = "open", "cleared", "written_off"

#: Πότε ένα δανεικό θεωρείται «αργεί». Τα QR πιέζουν περισσότερο επειδή πρέπει να αναρτηθούν
#: στον HMVO — δες τη λίστα `overdue()`.
QR_DAYS, PLAIN_DAYS = 10, 30


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _clean(s: Any) -> str:
    return str(s or "").strip().upper()


class AdvanceDispensingRepository(BaseRepository):
    collection_name = "advance_dispensings"

    # ── καταγραφή ────────────────────────────────────────────────────────────────────────────
    async def create(self, *, patient_name: str, items: list[dict], patient_ref: str | None = None,
                     amka: str | None = None, note: str = "", by: str | None = None) -> dict:
        """Ένα δανεικό = ένας πελάτης + ένα ή περισσότερα σκευάσματα, εκείνη τη στιγμή."""
        if not (patient_name or "").strip():
            raise ValueError("patient_name_required")
        clean_items = []
        for it in items or []:
            gtin, batch = _clean(it.get("gtin")), _clean(it.get("batch"))
            strip = _clean(it.get("strip"))
            plain = _clean(it.get("lot")) or (it.get("name") or "").strip()
            if not (gtin or batch or strip or plain):
                continue          # γραμμή χωρίς κανένα αναγνωριστικό δεν χρησιμεύει
            clean_items.append({
                "name": (it.get("name") or "").strip()[:160],
                "eof_code": _clean(it.get("eof_code")) or None,
                "gtin": gtin or None, "batch": batch or None, "strip": strip or None,
                "lot": _clean(it.get("lot")) or None,
                "expiry": _clean(it.get("expiry")) or None,
                "qty": max(1, int(it.get("qty") or 1)),
                "has_qr": bool(gtin or strip),
                "hmvo_uploaded": bool(it.get("hmvo_uploaded")),
            })
        if not clean_items:
            raise ValueError("items_required")
        doc = {"tenant_id": self.tenant_id, "patient_name": patient_name.strip()[:160],
               "patient_ref": patient_ref, "amka": (amka or "").strip() or None,
               "items": clean_items, "status": OPEN, "note": (note or "").strip()[:500],
               "created_at": _now(), "created_by": by}
        res = await self.insert_one(doc)
        return {"_id": str(res.inserted_id if hasattr(res, "inserted_id") else res)}

    async def set_status(self, loan_id: str, status: str, *, by: str | None = None,
                         reason: str = "", execution_id: Any = None) -> int:
        try:
            oid = ObjectId(loan_id)
        except (InvalidId, TypeError):
            return 0
        upd = {"status": status, "closed_at": _now(), "closed_by": by,
               "closed_reason": (reason or "")[:300]}
        if execution_id is not None:
            upd["cleared_execution_id"] = execution_id
        if status == OPEN:                     # επαναφορά: καθαρίζουμε το κλείσιμο
            r = await self.update_one({"_id": oid}, {
                "$set": {"status": OPEN},
                "$unset": {"closed_at": "", "closed_by": "", "closed_reason": "",
                           "cleared_execution_id": ""}})
            return r.modified_count
        r = await self.update_one({"_id": oid}, {"$set": upd})
        return r.modified_count

    # ── λίστες ───────────────────────────────────────────────────────────────────────────────
    async def overdue(self) -> dict:
        """Τι αργεί. Δύο κατώφλια επίτηδες: τα QR πρέπει να αναρτηθούν στον HMVO, οπότε πιέζουν
        νωρίτερα από ένα απλό κουτί."""
        now = _now()
        qr_cut, plain_cut = now - timedelta(days=QR_DAYS), now - timedelta(days=PLAIN_DAYS)
        rows = await self.find({"status": OPEN}, sort=[("created_at", 1)], limit=500)
        qr, plain = [], []
        for r in rows:
            at = r.get("created_at")
            if not at:
                continue
            has_qr = any(i.get("has_qr") for i in (r.get("items") or []))
            if has_qr and at <= qr_cut:
                qr.append(r)
            elif at <= plain_cut:
                plain.append(r)
        return {"qr_over_10d": qr, "over_30d": plain,
                "counts": {"qr_over_10d": len(qr), "over_30d": len(plain), "open": len(rows)}}

    # ── ταύτιση με εκτελεσμένες συνταγές (Β φάση) ────────────────────────────────────────────
    async def matches(self, *, days: int = 45, limit: int = 50) -> list[dict]:
        """Ανοιχτά δανεικά που ΜΟΙΑΖΟΥΝ με πρόσφατη εκτέλεση — προτάσεις προς επιβεβαίωση.

        Ψάχνουμε ΜΟΝΟ τις εκτελέσεις ΤΟΥ ΙΔΙΟΥ πελάτη όταν τον ξέρουμε· αλλιώς όλες του
        φαρμακείου. Ένα δανεικό χωρίς ταυτοποιημένο πελάτη είναι συνηθισμένο (περαστικός).
        """
        loans = await self.find({"status": OPEN}, sort=[("created_at", 1)], limit=200)
        if not loans:
            return []
        since = _now() - timedelta(days=days)
        out: list[dict] = []
        for loan in loans:
            its = loan.get("items") or []
            strips = {_clean(i.get("strip")) for i in its if i.get("strip")}
            lots = {_clean(i.get("lot")) for i in its if i.get("lot")}
            q: dict = {"tenant_id": self.tenant_id, "executed_at": {"$gte": since},
                       "$or": [
                           {"details.coupons.strip": {"$in": sorted(strips)}} if strips
                           else {"_id": None},
                           {"details.lot": {"$in": sorted(lots)}} if lots else {"_id": None}]}
            hit = await self._db["prescription_items"].find_one(
                q, {"execution_id": 1, "executed_at": 1})
            if not hit:
                continue
            ex = await self._db["prescription_executions"].find_one(
                {"_id": hit.get("execution_id"), "tenant_id": self.tenant_id},
                {"external_id": 1, "executed_at": 1, "patient_ref": 1})
            out.append({
                "loan_id": str(loan["_id"]), "patient_name": loan.get("patient_name"),
                "created_at": loan.get("created_at"),
                "items": [i.get("name") or i.get("gtin") or i.get("lot") for i in its],
                "execution": {"external_id": (ex or {}).get("external_id"),
                              "executed_at": (ex or {}).get("executed_at")},
                # ΓΙΑΤΙ ταιριάζει — ο φαρμακοποιός πρέπει να βλέπει τη βάση της πρότασης, όχι
                # να την εμπιστεύεται στα τυφλά.
                "matched_on": "ταινία/σειριακό" if strips else "παρτίδα (LOT)",
                "same_patient": bool(loan.get("patient_ref") is not None
                                     and (ex or {}).get("patient_ref") == loan["patient_ref"]),
            })
            if len(out) >= limit:
                break
        return out
