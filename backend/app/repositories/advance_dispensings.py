"""Προχορηγήσεις σκευασμάτων («δανεικά») — καταγραφή και ξεχρέωση.

ΤΙ ΔΕΝ ΕΙΝΑΙ: λογιστική απεικόνιση αποθέματος. Ο φαρμακοποιός δεν θέλει διπλογραφικό· θέλει να
θυμάται ποιος του χρωστά κουτί και να το σβήνει όταν έρθει η συνταγή.

Η ΤΑΥΤΙΣΗ ΓΙΝΕΤΑΙ ΣΤΗΝ ΑΝΑΓΝΩΣΗ, ΟΧΙ ΣΤΗΝ ΑΝΤΛΗΣΗ. Θα μπορούσαμε να ψάχνουμε ταίριασμα την
ώρα που κατεβαίνει η συνταγή, αλλά η άντληση είναι το πιο εύθραυστο κομμάτι του συστήματος και
τρέχει για 24.000 εκτελέσεις — ένα λάθος εκεί σταματά τον συγχρονισμό όλων. Το ερώτημα
ταύτισης είναι φθηνό, επαναλήψιμο και δεν μπορεί να χαλάσει δεδομένα.

ΔΕΝ ΑΝΑΡΤΟΥΜΕ ΤΙΠΟΤΑ. Ούτε στην ΗΔΥΚΑ ούτε στον HMVO — αυτό το κάνει το εμπορικό πρόγραμμα του
φαρμακείου. Εδώ είμαστε καθαρά ενημερωτικοί, οπότε δεν κουβαλάμε κανένα από τα κατώφλια ή τα
πεδία εκείνων των υποχρεώσεων.

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

#: Πότε ένα δανεικό θεωρείται «αργεί».
#: ΔΕΝ υπάρχει ξεχωριστό, αυστηρότερο κατώφλι για τα QR. Είχε μπει με την υπόθεση ότι εμείς
#: αναρτούμε στον HMVO· δεν αναρτούμε τίποτα — αυτό το κάνει το εμπορικό πρόγραμμα του
#: φαρμακείου. Εδώ απλώς θυμίζουμε ποιος χρωστά και από πότε.
OVERDUE_DAYS = 30


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _clean(s: Any) -> str:
    return str(s or "").strip().upper()


class AdvanceDispensingRepository(BaseRepository):
    collection_name = "advance_dispensings"

    # ── καταγραφή ────────────────────────────────────────────────────────────────────────────
    async def create(self, *, patient_name: str, items: list[dict], patient_ref: str,
                     amka: str | None = None, note: str = "", by: str | None = None,
                     expected_at: str | None = None) -> dict:
        """Ένα δανεικό = ΕΝΑΣ πελάτης + ΟΣΑ σκευάσματα του δόθηκαν εκείνη τη στιγμή (μία κίνηση).

        Ο πελάτης επιλέγεται από τη λίστα, δεν γράφεται: ένα δανεικό που δεν δείχνει σε υπαρκτή
        καρτέλα δεν μπορεί ούτε να εμφανιστεί στην καρτέλα του, ούτε να ταυτιστεί με τη συνταγή
        του αργότερα. Περαστικός χωρίς καρτέλα → φτιάξε πρώτα καρτέλα.
        """
        if not (patient_name or "").strip():
            raise ValueError("patient_name_required")
        if not (patient_ref or "").strip():
            raise ValueError("patient_ref_required")
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
            })
        if not clean_items:
            raise ValueError("items_required")
        doc = {"tenant_id": self.tenant_id, "patient_name": patient_name.strip()[:160],
               "patient_ref": patient_ref, "amka": (amka or "").strip() or None,
               "items": clean_items, "status": OPEN, "note": (note or "").strip()[:500],
               # Πότε είπε ο πελάτης ότι θα φέρει τη συνταγή (YYYY-MM-DD, προαιρετικό).
               # Χωρίς αυτό ο φαρμακοποιός δεν έχει τίποτα να περιμένει — μόνο «κάποτε».
               "expected_at": (expected_at or "").strip()[:10] or None,
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
        """Τι αργεί — ένα κατώφλι για όλα, ενημερωτικά."""
        cut = _now() - timedelta(days=OVERDUE_DAYS)
        rows = await self.find({"status": OPEN}, sort=[("created_at", 1)], limit=500)
        late = [r for r in rows if r.get("created_at") and r["created_at"] <= cut]
        return {"items": late, "counts": {"overdue": len(late), "open": len(rows)}}

    async def set_expected(self, loan_id: str, expected_at: str | None) -> int:
        """Ορισμός/αλλαγή της ημερομηνίας που ο πελάτης θα φέρει τη συνταγή."""
        try:
            oid = ObjectId(loan_id)
        except (InvalidId, TypeError):
            return 0
        val = (expected_at or "").strip()[:10] or None
        r = await self.update_one({"_id": oid}, {"$set": {"expected_at": val}})
        return r.modified_count

    async def due_today(self, today: str) -> list[dict]:
        """Ανοιχτά δανεικά που ο πελάτης είπε ότι θα ξεχρεώσει ΣΗΜΕΡΑ ή νωρίτερα.

        Τροφοδοτεί τον Σύμβουλο: «σήμερα περιμένεις αυτούς». Χωρίς δηλωμένη ημερομηνία δεν
        μπαίνει κανείς — δεν εφευρίσκουμε προσδοκία που δεν συμφωνήθηκε.
        """
        rows = await self.find({"status": OPEN, "expected_at": {"$ne": None, "$lte": today}},
                               sort=[("expected_at", 1)], limit=100)
        for x in rows:
            x["_id"] = str(x["_id"])
        return rows

    async def open_for_patient(self, patient_ref: str) -> list[dict]:
        """Ανοιχτά δανεικά ΕΝΟΣ πελάτη — για την καρτέλα του και το pop-up του ταμείου.

        Ο φαρμακοποιός δεν ψάχνει τη λίστα δανεικών όταν έχει τον πελάτη μπροστά του· η
        πληροφορία πρέπει να τον βρει εκεί που ήδη κοιτάζει.
        """
        if not (patient_ref or "").strip():
            return []
        rows = await self.find({"status": OPEN, "patient_ref": str(patient_ref).strip()},
                               sort=[("created_at", 1)], limit=50)
        for r in rows:
            r["_id"] = str(r["_id"])
        return rows

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
                # ΟΧΙ «παρτίδα»: μετρημένο σε 6.000/6.000 είδη, το `details.lot` της εκτέλεσης
                # ΕΙΝΑΙ η ταινία γνησιότητας ΕΟΦ — ίδιος κωδικός, δεύτερο μονοπάτι.
                "matched_on": "ίδιος κωδικός ταινίας/QR",
                # ⚠ Τα executions κρατούν `patient_ref` ως ObjectId, τα δανεικά ως string.
                # Χωρίς str() η σύγκριση ήταν ΠΑΝΤΑ False και το «ίδιος πελάτης» δεν εμφανιζόταν
                # ποτέ — ακριβώς η ένδειξη που κάνει την πρόταση αξιόπιστη.
                "same_patient": bool(loan.get("patient_ref")
                                     and str((ex or {}).get("patient_ref") or "")
                                     == str(loan["patient_ref"])),
            })
            if len(out) >= limit:
                break
        return out
