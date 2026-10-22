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
        from app.services import gs1_scan
        for it in items or []:
            # Το ΑΚΑΤΕΡΓΑΣΤΟ σκανάρισμα (αν ήρθε) διαβάζεται ΕΔΩ με τον ΕΝΑΝ αναγνώστη — αυτό αποφασίζει,
            # όχι ό,τι κατάλαβε η οθόνη. Κρατιέται και το raw, για μελλοντική επανα-ανάγνωση.
            p = gs1_scan.parse(it.get("raw") or "") if it.get("raw") else None
            if p and p.get("corrupt"):
                raise ValueError("corrupt_scan")   # χαλασμένο GTIN δεν γράφεται ποτέ ως χρέος
            if p and p.get("gtin"):
                it = {**it, "gtin": p["gtin"], "batch": p.get("batch") or it.get("batch"),
                      "expiry": p.get("expiry") or it.get("expiry"),
                      "strip": p.get("serial") or it.get("strip"), "lot": p.get("serial") or it.get("lot")}
            gtin, batch = _clean(it.get("gtin")), _clean(it.get("batch"))
            strip = _clean(it.get("strip"))
            # LOT ταινίας (12ψήφιο) ΥΠΟΧΡΕΩΤΙΚΑ μαζί με το κουπόνι ΕΟΦ (κανόνας ιδιοκτήτη 22/10/2026)
            if (not gtin and not _clean(it.get("barcode"))
                    and gs1_scan.classify(strip or _clean(it.get("lot")))["kind"] == "eof_lot"):
                raise ValueError("lot_needs_eof_coupon")
            plain = (_clean(it.get("lot")) or _clean(it.get("barcode"))
                     or (it.get("name") or "").strip())
            if not (gtin or batch or strip or plain):
                continue          # γραμμή χωρίς κανένα αναγνωριστικό δεν χρησιμεύει
            clean_items.append({
                "name": (it.get("name") or "").strip()[:160],
                "eof_code": _clean(it.get("eof_code")) or None,
                "barcode": _clean(it.get("barcode")) or None,      # κουπόνι ΕΟΦ «280…» / barcode προϊόντος
                "gtin": gtin or None, "batch": batch or None, "strip": strip or None,
                "lot": _clean(it.get("lot")) or None,
                "expiry": _clean(it.get("expiry")) or None,
                "qty": max(1, int(it.get("qty") or 1)),
                "raw": (it.get("raw") or "")[:200] or None,
                "status": OPEN,                    # ξεχρέωση ΑΝΑ σκεύασμα (15/10/2026)
            })
        if not clean_items:
            raise ValueError("items_required")
        # ΟΝΟΜΑ από το GTIN του QR (HMVS): ο κατάλογος ΗΔΥΚΑ έχει κωδικούς ΕΟΦ, όχι GTIN → «(χωρίς όνομα)»
        # (15/10/2026, Μπινίκος). Τα κουπόνια QR των εκτελέσεων δίνουν GTIN ↔ φάρμακο.
        for ci in clean_items:
            if ci.get("barcode") and not ci.get("name"):
                found = await self.name_for_barcode(ci["barcode"])
                if found:
                    ci["name"], ci["eof_code"] = found["name"], ci.get("eof_code") or found.get("eof_code")
            if ci.get("gtin") and not ci.get("name"):
                found = await self.name_for_gtin(ci["gtin"])
                if found:
                    ci["name"], ci["eof_code"] = found["name"], ci.get("eof_code") or found.get("eof_code")
        # Όνομα & ΑΜΚΑ από την ΚΑΡΤΕΛΑ του ασθενή, όχι από την οθόνη: σε λειτουργία παρουσίασης η οθόνη
        # δείχνει ήδη κρυμμένο επώνυμο («Τ**** ΠΑΝΑΓΙΩΤΗΣ») και αυτό αποθηκευόταν μόνιμα (14/10/2026).
        from bson import ObjectId
        try:
            card = await self._db["patients_anonymized"].find_one(
                {"tenant_id": self.tenant_id, "_id": ObjectId(str(patient_ref))}, {"full_name": 1, "amka": 1})
        except Exception:  # noqa: BLE001 — άκυρο id → κρατάμε ό,τι ήρθε
            card = None
        if card and card.get("full_name"):
            patient_name = card["full_name"]
            amka = card.get("amka") or amka
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
                         reason: str = "", execution_id: Any = None, external_id: str | None = None) -> int:
        try:
            oid = ObjectId(loan_id)
        except (InvalidId, TypeError):
            return 0
        # ΤΡΟΠΟΣ κλεισίματος (15/10/2026): «από συνταγή» (πρόταση με εκτέλεση) / «με το χέρι» / διαγραφή χρέους
        via = ("write_off" if status == WRITTEN_OFF
               else "prescription" if execution_id or external_id else "manual")
        upd = {"status": status, "closed_at": _now(), "closed_by": by,
               "closed_reason": (reason or "")[:300], "cleared_via": via}
        if execution_id is not None:
            upd["cleared_execution_id"] = execution_id
        if external_id:
            upd["cleared_external_id"] = str(external_id)[:40]
        if status != OPEN:   # τα ΑΝΟΙΧΤΑ σκευάσματα κλείνουν μαζί, με τον ίδιο τρόπο (ιστορικό ανά σκεύασμα)
            loan = await self.find_one({"_id": oid}) or {}
            items = [{**i, "status": status, "closed_at": _now(), "closed_by": by, "cleared_via": via,
                      **({"cleared_external_id": str(external_id)[:40]} if external_id else {})}
                     if (i.get("status") or OPEN) == OPEN else i for i in (loan.get("items") or [])]
            if items:
                upd["items"] = items
        if status == OPEN:                     # επαναφορά: καθαρίζουμε το κλείσιμο
            r = await self.update_one({"_id": oid}, {
                "$set": {"status": OPEN},
                "$unset": {"closed_at": "", "closed_by": "", "closed_reason": "",
                           "cleared_execution_id": "", "cleared_external_id": "", "cleared_via": ""}})
            return r.modified_count
        r = await self.update_one({"_id": oid}, {"$set": upd})
        return r.modified_count

    async def set_item_status(self, loan_id: str, idx: int, status: str, *, by: str | None = None) -> dict:
        """Ξεχρέωση ΑΝΑ ΣΚΕΥΑΣΜΑ: ένα δανεικό με δύο φάρμακα μπορεί να ξεχρεωθεί το ένα πριν το άλλο.
        Όταν ξεχρεωθούν ΟΛΑ → κλείνει και το δανεικό· αν ξανανοίξει ένα → ανοίγει και το δανεικό."""
        try:
            oid = ObjectId(loan_id)
        except (InvalidId, TypeError):
            return {"ok": False, "error": "not_found"}
        loan = await self.find_one({"_id": oid})
        if not loan or not (0 <= idx < len(loan.get("items") or [])):
            return {"ok": False, "error": "not_found"}
        items = loan["items"]
        items[idx] = {**items[idx], "status": status, "closed_at": _now() if status != OPEN else None,
                      "closed_by": by if status != OPEN else None,
                      "cleared_via": "manual" if status != OPEN else None}
        all_closed = all((i.get("status") or OPEN) != OPEN for i in items)
        sets: dict = {"items": items}
        if all_closed:
            sets.update({"status": CLEARED, "closed_at": _now(), "closed_by": by, "cleared_via": "manual",
                         "closed_reason": "όλα τα σκευάσματα ξεχρεώθηκαν"})
        elif loan.get("status") != OPEN:
            sets["status"] = OPEN
        await self.update_one({"_id": oid}, {"$set": sets})
        return {"ok": True, "loan_status": sets.get("status", loan.get("status")), "items": items}

    async def rescan_item(self, loan_id: str, idx: int, raw: str) -> dict:
        """ΞΑΝΑΣΚΑΝΑΡΙΣΜΑ ενός κουτιού με ελλιπή ανάγνωση: διορθώνει ΜΟΝΟ τα στοιχεία του κουτιού (παρτίδα,
        λήξη, σειριακό) — το δανεικό μένει ίδιο (ημερομηνία, πελάτης). Δεκτό ΜΟΝΟ για το ΙΔΙΟ φάρμακο
        (ίδιο GTIN): λάθος κουτί δεν «ξεχρεώνει» και «ξαναχρεώνει» κάτι άλλο."""
        from app.services import gs1_scan
        try:
            oid = ObjectId(loan_id)
        except (InvalidId, TypeError):
            return {"ok": False, "error": "not_found"}
        loan = await self.find_one({"_id": oid})
        if not loan or not (0 <= idx < len(loan.get("items") or [])):
            return {"ok": False, "error": "not_found"}
        p = gs1_scan.parse(raw)
        if p and p.get("corrupt"):
            return {"ok": False, "error": "corrupt_scan"}
        if not p or not p.get("gtin"):
            return {"ok": False, "error": "not_gs1"}
        cur = loan["items"][idx]
        if cur.get("gtin") and _clean(cur["gtin"]) != _clean(p["gtin"]):
            return {"ok": False, "error": "other_product"}
        if not p.get("complete"):
            return {"ok": False, "error": "still_incomplete", "scanner": p.get("scanner")}
        await self.update_one({"_id": oid}, {"$set": {
            f"items.{idx}.gtin": p["gtin"], f"items.{idx}.batch": p["batch"], f"items.{idx}.expiry": p["expiry"],
            f"items.{idx}.strip": p["serial"], f"items.{idx}.lot": p["serial"], f"items.{idx}.raw": raw[:200],
            f"items.{idx}.rescanned_at": _now()}})
        if p.get("scanner"):
            await self.learn_scanner(p["scanner"])
        return {"ok": True}

    async def clear_items_from_prescription(self, loan_id: str, idxs: list[int], *, by: str | None,
                                            execution_id: str | None, external_id: str | None) -> dict:
        """Επιβεβαίωση πρότασης: ξεχρεώνει ΜΟΝΟ τα σκευάσματα που ταίριαξαν με τη συνταγή (τρόπος «από συνταγή»)."""
        try:
            oid = ObjectId(loan_id)
        except (InvalidId, TypeError):
            return {"ok": False, "error": "not_found"}
        loan = await self.find_one({"_id": oid})
        if not loan:
            return {"ok": False, "error": "not_found"}
        items = loan.get("items") or []
        now = _now()
        for n in idxs:
            if 0 <= n < len(items) and (items[n].get("status") or OPEN) == OPEN:
                items[n] = {**items[n], "status": CLEARED, "closed_at": now, "closed_by": by,
                            "cleared_via": "prescription", "cleared_execution_id": execution_id,
                            "cleared_external_id": (str(external_id)[:40] if external_id else None)}
        sets: dict = {"items": items}
        if all((i.get("status") or OPEN) != OPEN for i in items):
            sets.update({"status": CLEARED, "closed_at": now, "closed_by": by, "cleared_via": "prescription",
                         "cleared_execution_id": execution_id,
                         "cleared_external_id": (str(external_id)[:40] if external_id else None)})
        await self.update_one({"_id": oid}, {"$set": sets})
        return {"ok": True, "loan_status": sets.get("status", loan.get("status"))}

    async def set_item_name(self, loan_id: str, idx: int, name: str) -> bool:
        """Όνομα σκευάσματος για ταινία ΕΟΦ (δεν περιέχει κωδικό φαρμάκου — το γράφει ο φαρμακοποιός)."""
        try:
            oid = ObjectId(loan_id)
        except (InvalidId, TypeError):
            return False
        r = await self.update_one({"_id": oid, f"items.{int(idx)}": {"$exists": True}},
                                  {"$set": {f"items.{int(idx)}.name": (name or "").strip()[:160]}})
        return bool(r.modified_count)

    async def history(self, *, kind: str = "all", q: str | None = None, product: str | None = None,
                      code: str | None = None, date_from: str | None = None, date_to: str | None = None,
                      by: str | None = None, via: str | None = None, limit: int = 2000) -> dict:
        """ΙΣΤΟΡΙΚΟ ΞΕΧΡΕΩΣΕΩΝ — μία γραμμή ανά ΣΚΕΥΑΣΜΑ που έκλεισε (ξεχρέωση ανά σκεύασμα, 15/10/2026).
        Παλιά δανεικά που έκλεισαν ολόκληρα (πριν την ξεχρέωση ανά σκεύασμα) → κάθε σκεύασμά τους
        μετρά ως κλεισμένο με την ημερομηνία/χρήστη του δανεικού. `kind`: cleared | written_off | all."""
        import re as _re
        flt: dict = {"$or": [{"status": {"$in": [CLEARED, WRITTEN_OFF]}}, {"items.status": {"$in": [CLEARED, WRITTEN_OFF]}}]}
        if q and q.strip():
            rx = {"$regex": _re.escape(q.strip()), "$options": "i"}
            flt = {"$and": [flt, {"$or": [{"patient_name": rx}, {"amka": rx}]}]}
        rows = await self.find(flt, sort=[("closed_at", -1), ("created_at", -1)], limit=5000)
        users = {str(u["_id"]): u.get("full_name") or u.get("email") async for u in self._db["users"].find(
            {"tenant_id": self.tenant_id}, {"full_name": 1, "email": 1})}
        prx = _re.compile(_re.escape(product.strip()), _re.I) if product and product.strip() else None
        crx = _clean(code) if code and code.strip() else None
        out: list[dict] = []
        for loan in rows:
            for n, it in enumerate(loan.get("items") or []):
                st = it.get("status") or (loan.get("status") if loan.get("status") != OPEN else OPEN)
                if st == OPEN or (kind != "all" and st != kind):
                    continue
                closed_at = it.get("closed_at") or loan.get("closed_at")
                closed_by = it.get("closed_by") or loan.get("closed_by")
                day = closed_at.date().isoformat() if closed_at else None
                if (date_from and (not day or day < date_from)) or (date_to and (not day or day > date_to)):
                    continue
                if by and str(closed_by or "") != by:
                    continue
                # ΤΡΟΠΟΣ: από συνταγή / με το χέρι / διαγραφή χρέους (παλιά: εκτέλεση στο δανεικό = από συνταγή)
                how = ("write_off" if st == WRITTEN_OFF else it.get("cleared_via") or loan.get("cleared_via")
                       or ("prescription" if loan.get("cleared_execution_id") else "manual"))
                if via and how != via:
                    continue
                if prx and not prx.search(it.get("name") or ""):
                    continue
                if crx and crx not in {_clean(it.get(k)) for k in ("gtin", "strip", "lot", "batch")}:
                    continue
                created = loan.get("created_at")
                out.append({
                    "loan_id": str(loan["_id"]), "idx": n, "status": st,
                    "patient_name": loan.get("patient_name"), "amka": loan.get("amka"),
                    "patient_ref": loan.get("patient_ref"),
                    "name": it.get("name") or "", "gtin": it.get("gtin"), "serial": it.get("strip") or it.get("lot"),
                    "batch": it.get("batch"), "qty": it.get("qty") or 1,
                    "given_at": created, "closed_at": closed_at,
                    "days": (closed_at - created).days if closed_at and created else None,
                    "closed_by": closed_by, "closed_by_name": users.get(str(closed_by or ""), ""),
                    "reason": loan.get("closed_reason") if st == WRITTEN_OFF else None,
                    "via": how, "rx": it.get("cleared_external_id") or loan.get("cleared_external_id"),
                    "execution": loan.get("cleared_execution_id")})
        out.sort(key=lambda r: str(r.get("closed_at") or ""), reverse=True)
        people = sorted({(r["closed_by"], r["closed_by_name"]) for r in out if r.get("closed_by")},
                        key=lambda x: x[1] or "")
        return {"items": out[:limit], "total": len(out),
                "counts": {"cleared": sum(1 for r in out if r["status"] == CLEARED),
                           "prescription": sum(1 for r in out if r["via"] == "prescription"),
                           "manual": sum(1 for r in out if r["via"] == "manual"),
                           "written_off": sum(1 for r in out if r["status"] == WRITTEN_OFF)},
                "users": [{"id": str(u), "name": nm or "—"} for u, nm in people]}

    async def learn_scanner(self, scanner: dict) -> None:
        """Ο σαρωτής ΑΥΤΟΥ του φαρμακείου (διαχωριστής, πληκτρολόγιο) — από το πρώτο πλήρες σκανάρισμα."""
        await self._db["tenants"].update_one(  # tenant-ok: το ΔΙΚΟ του φαρμακείο
            {"_id": self.tenant_id}, {"$set": {"scanner_profile": {**scanner, "learned_at": _now()}}})

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
    async def name_for_gtin(self, gtin: str) -> dict | None:
        """GTIN (QR HMVS) → {name, eof_code}, από τα κουπόνια QR που έχει δώσει η ΗΔΥΚΑ (ίδιο φάρμακο
        σε οποιοδήποτε φαρμακείο — ταυτότητα προϊόντος, όχι δεδομένα ασθενή)."""
        g = _clean(gtin)
        if not g:
            return None
        it = await self._db["prescription_items"].find_one(  # tenant-ok: μόνο ταυτότητα προϊόντος (GTIN→φάρμακο)
            {"details.coupons.qr_product_code": g}, {"product_id": 1, "details.eof_code": 1})
        if not it:
            return None
        eof = (it.get("details") or {}).get("eof_code")
        cat = await self._db["medicine_catalog"].find_one({"_id": eof}, {"name": 1}) if eof else None  # tenant-ok: κοινός κατάλογος
        prod = None if cat else await self._db["products"].find_one({"_id": it.get("product_id")}, {"name": 1})  # tenant-ok: όνομα προϊόντος
        name = (cat or prod or {}).get("name")
        return {"name": name, "eof_code": eof} if name else None

    async def name_for_barcode(self, barcode: str) -> dict | None:
        """Barcode προϊόντος (κουπόνι ΕΟΦ «280…» ή άλλο) → {name, eof_code}: πρώτα ο κατάλογος ΗΔΥΚΑ, μετά
        τα προϊόντα των εκτελέσεων, τέλος η αποθήκη του φαρμακείου (παραφάρμακα/ΜΗ.ΣΥ.ΦΑ.)."""
        bc = _clean(barcode)
        if not bc:
            return None
        cat = await self._db["medicine_catalog"].find_one(  # tenant-ok: κοινός κατάλογος ΗΔΥΚΑ
            {"barcode": bc}, {"full_name": 1, "name": 1})
        if cat:
            return {"name": cat.get("full_name") or cat.get("name"), "eof_code": cat.get("_id")}
        prod = await self._db["products"].find_one({"barcode": bc}, {"name": 1})  # tenant-ok: όνομα προϊόντος
        if prod and prod.get("name"):
            return {"name": prod["name"], "eof_code": None}
        mine = await self._db["pharmacy_products"].find_one(
            {"tenant_id": self.tenant_id, "$or": [{"barcode": bc}, {"barcodes": bc}]}, {"name": 1})
        return {"name": mine["name"], "eof_code": None} if mine and mine.get("name") else None

    async def matches(self, *, days: int = 45, limit: int = 50) -> list[dict]:
        """Ανοιχτά δανεικά που ΜΟΙΑΖΟΥΝ με πρόσφατη εκτέλεση — προτάσεις προς επιβεβαίωση.

        ΑΝΑ ΣΚΕΥΑΣΜΑ (15/10/2026): κάθε ανοιχτό σκεύασμα ψάχνει τη ΔΙΚΗ του συνταγή· η πρόταση δείχνει
        ΜΟΝΟ όσα ταιριάζουν με εκείνη τη συνταγή (πριν: όλο το δανεικό — 5 φάρμακα για 1 που ταίριαζε)
        και η επιβεβαίωση ξεχρεώνει ΜΟΝΟ αυτά. Ταύτιση: (α) ίδιος κωδικός ταινίας/QR· (β) αλλιώς ίδιο
        φάρμακο (GTIN) στον ΙΔΙΟ πελάτη, σε συνταγή μετά το δανεικό.
        """
        loans = await self.find({"status": OPEN}, sort=[("created_at", 1)], limit=200)
        if not loans:
            return []
        since = _now() - timedelta(days=days)
        out: list[dict] = []
        ex_cache: dict = {}

        async def _ex(eid):
            if eid not in ex_cache:
                ex_cache[eid] = await self._db["prescription_executions"].find_one(
                    {"_id": eid, "tenant_id": self.tenant_id},
                    {"external_id": 1, "executed_at": 1, "patient_ref": 1}) or {}
            return ex_cache[eid]

        for loan in loans:
            after = loan.get("created_at")
            if after is not None and after.tzinfo is None:
                after = after.replace(tzinfo=timezone.utc)
            after = max(since, after) if after else since
            groups: dict = {}            # execution_id → {"idxs": [...], "names": [...], "how": ...}
            for n, it in enumerate(loan.get("items") or []):
                if (it.get("status") or OPEN) != OPEN:
                    continue                                  # ήδη ξεχρεωμένο σκεύασμα
                hit, how = None, None
                codes = sorted({_clean(it.get(k)) for k in ("strip", "lot") if it.get(k)})
                if codes:
                    hit = await self._db["prescription_items"].find_one(  # tenant-ok: tenant_id στο φίλτρο
                        {"tenant_id": self.tenant_id, "executed_at": {"$gte": since},
                         "$or": [{"details.coupons.strip": {"$in": codes}}, {"details.lot": {"$in": codes}}]},
                        {"execution_id": 1})
                    how = "code" if hit else None
                if not hit and it.get("gtin") and loan.get("patient_ref"):
                    async for cand in self._db["prescription_items"].find(  # tenant-ok: tenant_id στο φίλτρο
                            {"tenant_id": self.tenant_id, "executed_at": {"$gte": after},
                             "details.coupons.qr_product_code": _clean(it["gtin"])},
                            {"execution_id": 1}).limit(20):
                        e = await _ex(cand.get("execution_id"))
                        if str(e.get("patient_ref") or "") == str(loan["patient_ref"]):
                            hit, how = cand, "gtin"
                            break
                if not hit and loan.get("patient_ref"):
                    # ίδιο ΦΑΡΜΑΚΟ από το barcode του κουτιού (κουπόνι ΕΟΦ «280…» ή GTIN του QR χωρίς το
                    # αρχικό 0) — η συνταγή μπορεί να εκτελέστηκε με ΑΛΛΟ κουτί (ταινία αντί QR ή ανάποδα)
                    eans = {_clean(it.get("barcode"))} if it.get("barcode") else set()
                    g14 = _clean(it.get("gtin"))
                    if len(g14) == 14 and g14.startswith("0"):
                        eans.add(g14[1:])
                    eans.discard("")
                    pids = [p["_id"] async for p in self._db["products"].find(  # tenant-ok: ταυτότητα προϊόντος
                        {"barcode": {"$in": sorted(eans)}}, {"_id": 1})] if eans else []
                    if pids:
                        async for cand in self._db["prescription_items"].find(  # tenant-ok: tenant_id στο φίλτρο
                                {"tenant_id": self.tenant_id, "executed_at": {"$gte": after},
                                 "product_id": {"$in": pids}}, {"execution_id": 1}).limit(20):
                            e = await _ex(cand.get("execution_id"))
                            if str(e.get("patient_ref") or "") == str(loan["patient_ref"]):
                                hit, how = cand, "gtin"
                                break
                if not hit:
                    continue
                g = groups.setdefault(hit.get("execution_id"), {"idxs": [], "names": [], "how": set()})
                g["idxs"].append(n)
                g["names"].append(it.get("name") or it.get("gtin") or it.get("lot") or "—")
                g["how"].add(how)
            for eid, g in groups.items():
                ex = await _ex(eid)
                out.append({
                    "loan_id": str(loan["_id"]), "patient_name": loan.get("patient_name"),
                    "created_at": loan.get("created_at"),
                    "items": g["names"], "item_idxs": g["idxs"],     # ΜΟΝΟ όσα ταιριάζουν με ΑΥΤΗ τη συνταγή
                    "execution": {"id": str(eid or ""), "external_id": ex.get("external_id"),
                                  "executed_at": ex.get("executed_at")},
                    # ΓΙΑΤΙ ταιριάζει — ο φαρμακοποιός βλέπει τη βάση της πρότασης, δεν την εμπιστεύεται στα τυφλά.
                    "matched_on": ("ίδιος κωδικός ταινίας/QR" if g["how"] == {"code"}
                                   else "ίδιο φάρμακο (GTIN) στον ίδιο πελάτη — όχι απαραίτητα ίδιο κουτί"
                                   if g["how"] == {"gtin"} else "ίδιος κωδικός ή ίδιο φάρμακο"),
                    # ⚠ executions: patient_ref ObjectId· δανεικά: string → σύγκριση ως κείμενο
                    "same_patient": bool(loan.get("patient_ref")
                                         and str(ex.get("patient_ref") or "") == str(loan["patient_ref"])),
                })
                if len(out) >= limit:
                    return out
        return out
