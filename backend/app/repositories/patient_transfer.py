"""Μεταφορά πελάτη σε άλλο φαρμακείο — ξεκινά το ΝΕΟ φαρμακείο, εγκρίνει ο ΠΕΛΑΤΗΣ.

ΤΙ ΜΕΤΑΦΕΡΕΤΑΙ: πρόγραμμα λήψης, μετρήσεις υγείας, στοιχεία επικοινωνίας (αντιγράφονται).
ΤΙ ΔΕΝ ΜΕΤΑΦΕΡΕΤΑΙ: οι εκτελέσεις — είναι γεγονότα του φαρμακείου όπου έγιναν και μένουν εκεί.
Το νέο φαρμακείο ξεκινά με ΚΕΝΗ καρτέλα· τυχόν ΔΙΚΕΣ ΤΟΥ παλιότερες εκτελέσεις του ίδιου ΑΜΚΑ
ταυτίζονται αυτόματα από το `link_or_create` (ψευδωνυμοποίηση με το pepper του tenant).

Ο ΠΕΛΑΤΗΣ συνεχίζει να βλέπει ΟΛΕΣ τις εκτελέσεις του (κάθε μία με ετικέτα φαρμακείου) — βλ.
`PatientAccountRepository.all_prescriptions`. Ο ΦΑΡΜΑΚΟΠΟΙΟΣ βλέπει μόνο τα δικά του (tenant-scoped).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.core.db import shared_db
from app.repositories.base import jsonsafe
from app.utils.masking import mask_row, mask_rows

_TTL_DAYS = 14          # αίτημα που δεν απαντήθηκε → λήγει

# Προκαθορισμένοι λόγοι μεταφοράς (όχι ελεύθερο κείμενο): αποφεύγουμε τριβές μεταξύ φαρμακείων
# και ισχυρισμούς για τον πελάτη, και κερδίζουμε μετρήσιμα στατιστικά. Το σχόλιο είναι προαιρετικό.
REASONS: dict[str, str] = {
    "moved": "Ο πελάτης μετακόμισε",
    "customer_choice": "Επιθυμία του πελάτη",
    "proximity": "Εγγύτητα στο φαρμακείο μας",
    "other": "Άλλο",
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    try:
        return ObjectId(str(v))
    except Exception:  # noqa: BLE001
        return None


class PatientTransferRepository:
    """Global (cross-tenant) — όπως τα `patient_links`. Κάθε πρόσβαση φιλτράρεται ρητά."""

    def __init__(self, *, demo: bool = False) -> None:
        self.demo = demo            # «πελάτης παρουσίασης» → ψευδωνυμοποίηση PII στα reads

    @property
    def db(self):
        return shared_db()

    # ── ΝΕΟ φαρμακείο: αίτημα μεταφοράς με ΑΜΚΑ ──────────────────────────────
    async def _pharmacy_name(self, tenant_id: str) -> str:
        t = await self.db["tenants"].find_one({"_id": tenant_id}) or {}   # tenant-ok: global registry
        return (t.get("company") or {}).get("name") or t.get("name") or tenant_id

    async def request(self, *, to_tenant_id: str, amka: str, reason: str, note: str | None = None,
                      requested_by: str | None = None) -> dict:
        from app.repositories.patient_portal import PatientAccountRepository
        accrepo = PatientAccountRepository()
        to_pharmacy_name = await self._pharmacy_name(to_tenant_id)
        acc = await accrepo.get_by_amka((amka or "").strip())
        if not acc:
            # Χωρίς λογαριασμό πύλης δεν υπάρχει τρόπος να δώσει συγκατάθεση.
            return {"ok": False, "error": "no_portal_account"}
        account_id = acc["_id"]
        if await accrepo.link_for(account_id, to_tenant_id):
            return {"ok": False, "error": "already_linked"}
        dup = await self.db["patient_transfers"].find_one(
            {"account_id": account_id, "to_tenant_id": to_tenant_id, "status": "pending"})
        if dup:
            return {"ok": False, "error": "already_pending"}
        doc = {
            "account_id": account_id, "to_tenant_id": to_tenant_id,
            "to_pharmacy_name": to_pharmacy_name, "requested_by": requested_by,
            "reason": reason if reason in REASONS else "other",
            "note": (note or "").strip()[:300] or None,
            "status": "pending", "created_at": _now(),
            "expires_at": _now() + timedelta(days=_TTL_DAYS),
        }
        res = await self.db["patient_transfers"].insert_one(doc)   # tenant-ok: global, φιλτράρεται ρητά
        # ειδοποίησε τον πελάτη να εγκρίνει
        try:
            from app.services import push_service
            await push_service.send_to_account(
                str(account_id), title="🏥 Αίτημα μεταφοράς φαρμακείου",
                body=f"Το {to_pharmacy_name} ζητά να σε εξυπηρετεί. Άνοιξε την πύλη για έγκριση.",
                url="/portal")
        except Exception:  # noqa: BLE001
            pass
        # ΔΕΝ επιστρέφουμε patient_name: το endpoint δέχεται αυθαίρετο ΑΜΚΑ και θα ήταν oracle ύπαρξης/
        # ονόματος (ο φαρμακοποιός θα δοκίμαζε ΑΜΚΑ για να μάθει ονόματα μη-πελατών). Ο πελάτης βλέπει το
        # φαρμακείο-αιτούντα στη δική του οθόνη έγκρισης· η επιβεβαίωση εδώ αρκεί ως {ok, transfer_id}.
        return {"ok": True, "transfer_id": str(res.inserted_id)}

    async def list_for_tenant(self, tenant_id: str) -> list[dict]:
        rows = [r async for r in self.db["patient_transfers"]
                .find({"to_tenant_id": tenant_id}).sort("created_at", -1).limit(100)]
        return jsonsafe(rows)

    # ── ΠΕΛΑΤΗΣ: εκκρεμή αιτήματα + απόφαση ─────────────────────────────────
    async def pending_for_account(self, account_id) -> list[dict]:
        oid = _oid(account_id)
        if not oid:
            return []
        rows = [r async for r in self.db["patient_transfers"].find(
            {"account_id": oid, "status": "pending", "expires_at": {"$gt": _now()}})]
        return [{"id": str(r["_id"]), "pharmacy_name": r.get("to_pharmacy_name"),
                 "tenant_id": r.get("to_tenant_id"), "created_at": r.get("created_at"),
                 # ο πελάτης ΠΡΕΠΕΙ να δει την αιτιολογία πριν εγκρίνει — θα σταλεί στο παλιό φαρμακείο
                 "reason": r.get("reason"), "reason_label": REASONS.get(r.get("reason") or "", "—"),
                 "note": r.get("note")} for r in rows]

    async def decide(self, transfer_id: str, account_id, accept: bool) -> dict:
        oid, aid = _oid(transfer_id), _oid(account_id)
        if not oid or not aid:
            return {"ok": False, "error": "bad_id"}
        t = await self.db["patient_transfers"].find_one(
            {"_id": oid, "account_id": aid, "status": "pending"})
        if not t:
            return {"ok": False, "error": "not_found"}
        if t.get("expires_at") and t["expires_at"] < _now():
            await self.db["patient_transfers"].update_one({"_id": oid}, {"$set": {"status": "expired"}})
            return {"ok": False, "error": "expired"}
        if not accept:
            await self.db["patient_transfers"].update_one(
                {"_id": oid}, {"$set": {"status": "declined", "decided_at": _now()}})
            return {"ok": True, "status": "declined"}

        from app.repositories.patient_portal import PatientAccountRepository
        accrepo = PatientAccountRepository()
        to_tid = t["to_tenant_id"]
        # 1) Άνοιγμα καρτέλας στο ΝΕΟ φαρμακείο. Ταυτίζει ΜΟΝΟ δικές του παλιότερες εκτελέσεις
        #    (ίδιο ΑΜΚΑ, δικό του pepper)· αλλιώς κενή καρτέλα.
        link = await accrepo.link_or_create(aid, to_tid)
        if not link:
            return {"ok": False, "error": "link_failed"}
        # 2) Πηγή αντιγραφής = το τρέχον «κύριο» φαρμακείο του πελάτη (αγαπημένο, αλλιώς 1ο άλλο).
        acc = await accrepo.get(aid)
        links = await accrepo.links(aid)
        fav = (acc or {}).get("favorite_tenant_id")
        src = next((l for l in links if l["tenant_id"] == fav and l["tenant_id"] != to_tid), None) \
            or next((l for l in links if l["tenant_id"] != to_tid), None)
        copied = await self._copy_personal(src, to_tid, link["patient_ref"]) if src else {}
        # 2β) Ενημέρωση του ΠΑΛΙΟΥ φαρμακείου: όνομα + ΑΜΚΑ + αιτιολογία — ΧΩΡΙΣ το όνομα του νέου
        #     φαρμακείου (αποφυγή τριβών). Ο πελάτης το έχει δει και το ενέκρινε στην οθόνη έγκρισης.
        if src:
            await self._notify_old(src, acc, t)
        # 3) Το ΝΕΟ γίνεται προεπιλεγμένο. Το ΠΑΛΙΟ ΜΕΝΕΙ ενεργό (απόφαση ιδιοκτήτη).
        #    Γράφουμε απευθείας — το set_favorite είναι toggle και θα το μηδένιζε σε επανάληψη.
        await self.db["patient_accounts"].update_one(   # tenant-ok: global patient account
            {"_id": aid}, {"$set": {"favorite_tenant_id": to_tid}})
        await self.db["patient_transfers"].update_one(
            {"_id": oid}, {"$set": {"status": "accepted", "decided_at": _now(), "copied": copied}})
        return {"ok": True, "status": "accepted", "tenant_id": to_tid, "copied": copied}

    async def _notify_old(self, src: dict, acc: dict, t: dict) -> None:
        """Ειδοποίηση στο ΠΑΛΙΟ φαρμακείο ότι ο πελάτης του άλλαξε φαρμακείο εξυπηρέτησης.

        ΔΕΝ αποθηκεύουμε ΑΜΚΑ εδώ — μένει ΜΟΝΟ στο patient_accounts (το ένα σημείο που το κρατά
        σκόπιμα ως κλειδί ταύτισης)· διαβάζεται τη στιγμή της ανάγνωσης μέσω του account_id.
        """
        await self.db["patient_transfer_notices"].update_one(   # tenant-ok: tenant_id στο doc & στα queries
            {"tenant_id": src["tenant_id"], "account_id": acc["_id"]},
            {"$set": {
                "tenant_id": src["tenant_id"], "account_id": acc["_id"],
                "patient_ref": _oid(src["patient_ref"]),
                "patient_name": f"{acc.get('first_name', '')} {acc.get('last_name', '')}".strip(),
                "reason": t.get("reason"), "note": t.get("note"),
                "at": _now(), "read": False,
            }}, upsert=True)

    async def notices_for_tenant(self, tenant_id: str) -> list[dict]:
        from app.repositories.patient_portal import PatientAccountRepository
        accrepo = PatientAccountRepository()
        out = []
        rows = [r async for r in self.db["patient_transfer_notices"]
                .find({"tenant_id": tenant_id}).sort("at", -1).limit(100)]
        for r in rows:
            acc = await accrepo.get(r.get("account_id"))
            out.append({
                "id": str(r["_id"]), "patient_ref": str(r.get("patient_ref") or ""),
                "patient_name": r.get("patient_name"),
                "amka": (acc or {}).get("amka"),          # διαβάζεται εδώ, δεν αποθηκεύεται ξανά
                "reason": r.get("reason"), "reason_label": REASONS.get(r.get("reason") or "", "—"),
                "note": r.get("note"), "at": r.get("at"), "read": bool(r.get("read")),
            })
        # demo: pseudonymize the patient's name + ΑΜΚΑ shown to the old pharmacy (GDPR).
        return jsonsafe(mask_rows(out, self.demo))

    async def mark_notice_read(self, notice_id: str, tenant_id: str) -> dict:
        oid = _oid(notice_id)
        if not oid:
            return {"ok": False}
        await self.db["patient_transfer_notices"].update_one(
            {"_id": oid, "tenant_id": tenant_id}, {"$set": {"read": True}})
        return {"ok": True}

    async def _copy_personal(self, src: dict, to_tid: str, to_ref: str) -> dict:
        """Αντιγραφή ΠΡΟΣΩΠΙΚΩΝ δεδομένων (όχι εκτελέσεων) στο νέο φαρμακείο.
        Δεν σβήνει τίποτα από το παλιό — αντιγραφή, όχι μετακίνηση."""
        out = {"reminders": 0, "measurements": 0, "contact": False}
        src_ref, src_tid = _oid(src["patient_ref"]), src["tenant_id"]
        to_oid = _oid(to_ref)
        if not src_ref or not to_oid:
            return out
        db = self.db
        # πρόγραμμα λήψης
        async for r in db["med_reminders"].find({"tenant_id": src_tid, "patient_ref": src_ref}):
            await db["med_reminders"].update_one(
                {"tenant_id": to_tid, "patient_ref": to_oid, "med_key": r.get("med_key")},
                {"$set": {k: r[k] for k in ("enabled", "time", "meal", "interval_hours") if k in r}},
                upsert=True)
            out["reminders"] += 1
        # μετρήσεις υγείας
        async for m in db["patient_measurements"].find({"tenant_id": src_tid, "patient_ref": src_ref}):
            doc = {k: v for k, v in m.items() if k != "_id"}
            doc.update({"tenant_id": to_tid, "patient_ref": to_oid})
            if not await db["patient_measurements"].find_one(
                    {"tenant_id": to_tid, "patient_ref": to_oid, "kind": doc.get("kind"), "at": doc.get("at")}):
                await db["patient_measurements"].insert_one(doc)
                out["measurements"] += 1
        # στοιχεία επικοινωνίας — ΠΡΟΣΟΧΗ: το patient_contacts έχει κλειδί _id = patient_ref
        c = await db["patient_contacts"].find_one({"_id": src_ref, "tenant_id": src_tid})
        if c:
            keep = {k: c[k] for k in ("phone", "mobile", "email", "address", "city", "postal_code",
                                      "height_cm", "preferred_channel") if c.get(k) is not None}
            if keep:
                await db["patient_contacts"].update_one(
                    {"_id": to_oid, "tenant_id": to_tid},
                    {"$set": {**keep, "tenant_id": to_tid}, "$setOnInsert": {"_id": to_oid}},
                    upsert=True)
                out["contact"] = True
        return out
