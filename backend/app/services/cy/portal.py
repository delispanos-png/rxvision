"""RxVision Κύπρος: «Πελάτες πύλης» — ίδια οθόνη και ίδιες ενέργειες με την Ελλάδα, κυπριακή ταυτότητα.

Η Ελλάδα ταυτοποιεί με ΑΜΚΑ. Στην Κύπρο ο πελάτης ΓεΣΥ (`cy_patients`) έχει ως κλειδί το ψευδώνυμο του
**κωδικού δικαιούχου ΟΑΥ** (ή, αν λείπει, τύπος εγγράφου + αριθμός) — ο ΙΔΙΟΣ κανόνας με το XML
(`parser.patient_key`). Έτσι:

  - **Εγγραφή χωρίς συνταγές** (`register`): ο φαρμακοποιός γράφει κωδικό ΟΑΥ (ή ταυτότητα/ARC) και όνομα.
    Βγαίνει το ΙΔΙΟ ψευδώνυμο που θα έβγαζε το XML → όταν αργότερα έρθει εκτέλεση, «κουμπώνει» στην ίδια
    καρτέλα (καμία διπλή). Ο αριθμός ταυτότητας ΔΕΝ αποθηκεύεται (μόνο το ψευδώνυμό του, όπως στο XML).
  - **Πρόσκληση με email** (`invite`): για υπάρχοντα ή νέο πελάτη — την ταυτότητα την εγγυάται ο φαρμακοποιός
    (όπως στην Ελλάδα). Αν γράψει και ταυτότητα και ο πελάτης έχει ήδη ταυτότητα από το XML, πρέπει να ταιριάζει.
  - **Εικόνα υιοθέτησης** (`customers`): πληθυσμός = πελάτες ΓεΣΥ του φαρμακείου (όχι οι ελληνικές καρτέλες).

Καμία αυτο-εγγραφή με QR στην Κύπρο (απόφαση ιδιοκτήτη 17/11/2026: το XML δεν έχει στοιχεία επικοινωνίας
για να αποδείξει ο πελάτης μόνος του ποιος είναι).
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone
from typing import Any

from app.repositories.cy import CyPatientRepository

DOC_TYPES = ("NID", "ARC", "PASSPORT")


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _upper(v: str | None) -> str:
    """Κεφαλαία ΧΩΡΙΣ τόνους, όπως γράφει το ΓεΣΥ («Νίκος» → «ΝΙΚΟΣ», όχι «ΝΊΚΟΣ») — αλλιώς η αναζήτηση χάνει."""
    s = unicodedata.normalize("NFD", (v or "").strip())
    return unicodedata.normalize("NFC", "".join(c for c in s if unicodedata.category(c) != "Mn")).upper()


def _clean_hio(v: str | None) -> str:
    return re.sub(r"\D", "", v or "").lstrip("0")


def _clean_doc(v: str | None) -> str:
    return re.sub(r"\s", "", v or "").upper()


def _pepper(tenant_id: str) -> str:
    from app.services.vault_service import vault
    return vault.tenant_pepper(tenant_id)


def split_name(full: str | None) -> tuple[str, str]:
    """ΓεΣΥ: «ΟΝΟΜΑ ΕΠΙΘΕΤΟ» (first + last) → (first, last)."""
    parts = (full or "").split(" ", 1)
    return (parts[0], parts[1]) if len(parts) == 2 else ((full or ""), "")


async def find_patient(tenant_id: str, *, patient_id: str | None = None, hio_code: str | None = None,
                       doc_type: str | None = None, doc_number: str | None = None) -> dict | None:
    """Υπάρχων πελάτης ΓεΣΥ: ψευδώνυμο → κωδικός ΟΑΥ → ταυτότητα (μέσω του ψευδωνύμου της, όπως το XML)."""
    from app.services.cy.parser import patient_key
    from app.utils.anonymization import pseudonymize
    repo = CyPatientRepository(tenant_id=tenant_id)
    if patient_id:
        p = await repo.find_one({"pseudo_id": patient_id})
        if p:
            return p
    hio = _clean_hio(hio_code)
    if hio:
        p = await repo.find_one({"hio_code": {"$in": [hio, hio.zfill(6), hio.zfill(7), hio.zfill(8), hio.zfill(10)]}}) \
            or await repo.find_one({"pseudo_id": pseudonymize(patient_key(hio, "", ""), tenant_pepper=_pepper(tenant_id))})
        if p:
            return p
    doc = _clean_doc(doc_number)
    if doc:
        id_ref = pseudonymize(patient_key("", doc_type or "NID", doc), tenant_pepper=_pepper(tenant_id))
        return await repo.find_one({"$or": [{"id_ref": id_ref}, {"pseudo_id": id_ref}]})
    return None


async def register(tenant_id: str, *, first_name: str, last_name: str, hio_code: str | None = None,
                   doc_type: str | None = None, doc_number: str | None = None, dob: str | None = None,
                   gender: str | None = None, mobile: str | None = None, email: str | None = None,
                   by: str | None = None) -> dict[str, Any]:
    """Νέος πελάτης ΓεΣΥ ΧΩΡΙΣ εκτελέσεις (π.χ. αγοράζει μόνο μη συνταγογραφούμενα, μέλος οικογένειας).
    Υπάρχει ήδη → επιστρέφεται ο υπάρχων (ποτέ διπλός)."""
    from app.services.cy.parser import patient_key
    from app.utils.anonymization import pseudonymize
    first, last = _upper(first_name), _upper(last_name)
    if not (first and last):
        return {"ok": False, "error": "name_required"}
    hio, doc = _clean_hio(hio_code), _clean_doc(doc_number)
    dtype = (doc_type or "NID").upper()
    if dtype not in DOC_TYPES:
        return {"ok": False, "error": "bad_doc_type"}
    if not hio and not doc:
        return {"ok": False, "error": "id_required"}
    if dob and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", dob):
        return {"ok": False, "error": "bad_dob"}
    existing = await find_patient(tenant_id, hio_code=hio, doc_type=dtype, doc_number=doc)
    if existing:
        return {"ok": True, "patient_id": existing["pseudo_id"], "existed": True}
    pepper = _pepper(tenant_id)
    pseudo = pseudonymize(patient_key(hio, dtype, doc), tenant_pepper=pepper)
    id_ref = pseudonymize(patient_key("", dtype, doc), tenant_pepper=pepper) if doc else None
    await CyPatientRepository(tenant_id=tenant_id).update_one(
        {"pseudo_id": pseudo},
        {"$set": {"full_name": f"{first} {last}", "hio_code": hio or None, "dob": dob or None,
                  "gender": (gender or "").upper()[:1] or None, **({"id_ref": id_ref} if id_ref else {}),
                  "updated_at": _now()},
         # «χωρίς εκτελέσεις»: ΔΕΝ ορίζονται first_seen/last_seen — έρχονται με την πρώτη εκτέλεση
         "$setOnInsert": {"created_at": _now(), "source": "manual", "registered_by": by}},
        upsert=True)
    if mobile or email:
        from app.services.cy import contacts
        try:
            await contacts.set_contact(tenant_id, pseudo, {k: v for k, v in (("mobile", mobile), ("email", email)) if v},
                                       source="pharmacist")
        except ValueError as exc:
            return {"ok": True, "patient_id": pseudo, "existed": False, "contact_error": str(exc)}
    return {"ok": True, "patient_id": pseudo, "existed": False}


async def customers(tenant_id: str, *, demo: bool = False) -> dict[str, Any]:
    """Ίδιο σχήμα με την ελληνική `portal_customers` — πληθυσμός = πελάτες ΓεΣΥ του φαρμακείου."""
    from app.core.db import shared_db
    from app.repositories.cy import find_all
    from app.repositories.patient_portal import PatientAccountRepository
    from app.utils.masking import mask_name
    members = await PatientAccountRepository().cy_members(tenant_id)
    pats = {p["pseudo_id"]: p for p in await find_all(
        CyPatientRepository(tenant_id=tenant_id), {"erased": {"$ne": True}})}
    alive = {k for k, p in pats.items() if not (p.get("deceased") or {}).get("at")}
    reg = [m for m in members if m["cy_pseudo"] in alive]
    reg_set = {m["cy_pseudo"] for m in reg}
    to_invite = alive - reg_set
    contactable = sum(1 for k in to_invite if ((pats[k].get("contact") or {}).get("mobile")
                                                or (pats[k].get("contact") or {}).get("email")))
    reg_list = sorted(({"name": mask_name(pats[m["cy_pseudo"]].get("full_name"), demo) or "—",
                        "account_id": str(m["account_id"]), "patient_id": m["cy_pseudo"], "since": m.get("since"),
                        "no_dispensings": pats[m["cy_pseudo"]].get("source") == "manual"
                        and not pats[m["cy_pseudo"]].get("last_seen")} for m in reg),
                      key=lambda x: str(x.get("since") or ""), reverse=True)
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"name": 1, "company": 1}) or {}  # tenant-ok: own tenant
    total = len(alive)
    return {"registered": len(reg), "total": total, "to_invite": len(to_invite),
            "registered_active": len(reg),
            "adoption_pct": round(len(reg) / total * 100, 1) if total else 0.0,
            "contactable": contactable, "registered_list": reg_list, "tenant_id": tenant_id,
            "pharmacy_name": (t.get("company") or {}).get("name") or t.get("name"),
            "register_url": None, "country": "CY"}


async def invite(tenant_id: str, *, email: str, patient_id: str | None = None, hio_code: str | None = None,
                 doc_type: str | None = None, doc_number: str | None = None, first_name: str | None = None,
                 last_name: str | None = None, mobile: str | None = None, by: str | None = None) -> dict[str, Any]:
    """Πρόσκληση με email (ίδια με την Ελλάδα): υπάρχων πελάτης ΓεΣΥ ή νέος (εγγραφή χωρίς συνταγές)."""
    from app.core.db import shared_db
    from app.services.patient_auth_service import PatientAuthService
    email = (email or "").strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return {"ok": False, "error": "bad_email"}
    dtype, doc = (doc_type or "NID").upper(), _clean_doc(doc_number)
    p = await find_patient(tenant_id, patient_id=patient_id, hio_code=hio_code)
    if p and doc and p.get("id_ref"):
        from app.services.cy.parser import patient_key
        from app.utils.anonymization import pseudonymize
        if pseudonymize(patient_key("", dtype, doc), tenant_pepper=_pepper(tenant_id)) != p["id_ref"]:
            return {"ok": False, "error": "id_mismatch"}
    if not p and doc:
        p = await find_patient(tenant_id, doc_type=dtype, doc_number=doc)
    if not p:
        if not (first_name and last_name):
            return {"ok": False, "error": "name_required"}
        r = await register(tenant_id, first_name=first_name, last_name=last_name, hio_code=hio_code,
                           doc_type=dtype, doc_number=doc, mobile=mobile, email=email, by=by)
        if not r.get("ok"):
            return r
        p = await CyPatientRepository(tenant_id=tenant_id).find_one({"pseudo_id": r["patient_id"]})
    if (p.get("deceased") or {}).get("at"):
        return {"ok": False, "error": "deceased"}
    first, last = split_name(p.get("full_name"))
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"name": 1, "company": 1}) or {}  # tenant-ok: own tenant
    res = await PatientAuthService().cy_invite(
        tenant_id=tenant_id, cy_pseudo=p["pseudo_id"], first_name=first, last_name=last, email=email,
        phone=mobile or (p.get("contact") or {}).get("mobile"),
        pharmacy_name=(t.get("company") or {}).get("name") or t.get("name"))
    if res.get("ok"):          # το email της πρόσκλησης γίνεται και στοιχείο της καρτέλας (χωρίς συγκατάθεση)
        from app.services.cy import contacts
        try:
            await contacts.set_contact(tenant_id, p["pseudo_id"], {"email": email}, source="pharmacist")
        except ValueError:
            pass
    return {**res, "patient_id": p["pseudo_id"]}


async def resend(tenant_id: str, identifier: str, *, by: str | None = None) -> dict[str, Any]:
    """Ξεκλείδωμα: email ή κωδικός ΟΑΥ → φρέσκος σύνδεσμος κωδικού (μόνο για πελάτη ΑΥΤΟΥ του φαρμακείου)."""
    from app.core.db import shared_db
    from app.repositories.patient_portal import PatientAccountRepository
    from app.services.patient_auth_service import PatientAuthService
    ident = (identifier or "").strip()
    repo = PatientAccountRepository()
    acc, p = None, None
    if "@" in ident:
        acc = await repo.get_by_email(ident.lower())
        if acc:
            pseudo = next((m["cy_pseudo"] for m in await repo.cy_members(tenant_id) if m["account_id"] == acc["_id"]), None)
            p = await CyPatientRepository(tenant_id=tenant_id).find_one({"pseudo_id": pseudo}) if pseudo else None
        else:              # λάθος email στον λογαριασμό: ψάξε με το email της ΚΑΡΤΕΛΑΣ
            p = await CyPatientRepository(tenant_id=tenant_id).find_one({"contact.email": ident.lower()})
            acc = await repo.cy_account_for(tenant_id, p["pseudo_id"]) if p else None
    elif _clean_hio(ident):
        p = await find_patient(tenant_id, hio_code=ident)
        acc = await repo.cy_account_for(tenant_id, p["pseudo_id"]) if p else None
    if not acc:
        return {"ok": False, "error": "not_found"}
    if not await shared_db()["patient_links"].find_one({"account_id": acc["_id"], "tenant_id": tenant_id}):  # tenant-ok
        return {"ok": False, "error": "not_your_customer"}
    c = (p or {}).get("contact") or {}
    return await PatientAuthService().resend_set_password_link(
        str(acc["_id"]), card_email=c.get("email"), card_mobile=c.get("mobile"), tenant_id=tenant_id, by=by)


async def rx_snapshot(tenant_id: str, shell_ref: str | None, number: str) -> dict[str, Any]:
    """«Ανάθεση συνταγής» από την πύλη (Κύπρος): ο πελάτης γράφει τον αριθμό συνταγής ΓεΣΥ. Αντί για τον
    ζωντανό έλεγχο της ΗΔΥΚΑ (Ελλάδα) ψάχνουμε ΜΟΝΟ στις συνταγές ΤΟΥ ΙΔΙΟΥ του πελάτη (ποτέ άλλου) και
    δίνουμε στον φαρμακοποιό ό,τι χρειάζεται για την επόμενη φάση — ίδιο σχήμα με το ελληνικό `cda`."""
    from app.repositories.patient_portal import PatientAccountRepository
    from app.services.cy import chains as ch
    num = re.sub(r"\s", "", number or "")
    pseudo = await PatientAccountRepository().cy_pseudo_of(tenant_id, shell_ref) if shell_ref else None
    if not pseudo or not num:
        return {"available": True, "found": False}
    c = next((c for c in await ch.chains(tenant_id, match={"patient_ref": pseudo})
              if str(c["prescription_id"]) == num), None)
    if not c:
        return {"available": True, "found": False}
    return {"available": True, "found": True, "doctor": c.get("doctor"), "medicines": c.get("items") or [],
            "open_date": c.get("next_due"), "exec_count": c.get("instance"),
            "repeat": f"{c.get('instance')}/{c.get('instances')}" if c.get("instances") else None,
            "issue_date": None, "valid_until": None, "intangible": False}


async def loyalty_candidates(tenant_id: str, q: str = "", *, demo: bool = False, limit: int = 40) -> list[dict]:
    """«Πιστότητα → Εγγραφή μέλους» (Κύπρος): πελάτες ΓεΣΥ που ΔΕΝ είναι ακόμα μέλη, με αναζήτηση
    (όνομα ή κωδικός ΟΑΥ). Ίδιο σχήμα με τους ελληνικούς υποψηφίους· `patient_ref` = ψευδώνυμο ΓεΣΥ."""
    from app.repositories.loyalty import LoyaltyRepository
    from app.repositories.patient_portal import PatientAccountRepository
    from app.utils.masking import mask_name
    s = (q or "").strip()
    if len(s) < 2:
        return []
    enrolled = await PatientAccountRepository().cy_pseudos_of(
        tenant_id, await LoyaltyRepository(tenant_id=tenant_id).enrolled_refs())
    rx = {"$regex": re.escape(_upper(s) or s), "$options": "i"}
    rows = await CyPatientRepository(tenant_id=tenant_id).find(
        {"$or": [{"full_name": rx}, {"hio_code": {"$regex": "^" + re.escape(_clean_hio(s) or s)}}],
         "deceased.at": {"$exists": False}, "erased": {"$ne": True}},
        sort=[("last_seen", -1)], limit=limit * 2)
    return [{"patient_ref": p["pseudo_id"], "name": mask_name(p.get("full_name"), demo) or "—",
             "compliance": None, "would_points": None}
            for p in rows if p["pseudo_id"] not in enrolled][:limit]


async def loyalty_enroll(tenant_id: str, pseudo: str, *, method: str = "physical",
                         referred_by_code: str | None = None) -> dict:
    """Εγγραφή πελάτη ΓεΣΥ στην πιστότητα: μέσω της καρτέλας-γέφυρας (`cy_shell`) — η ΙΔΙΑ ροή με την
    Καρτέλα πελάτη (router cy.py::patient_loyalty)."""
    from app.repositories.loyalty import LoyaltyRepository
    from app.repositories.patient_portal import PatientAccountRepository
    p = await CyPatientRepository(tenant_id=tenant_id).find_one({"pseudo_id": pseudo})
    if not p:
        return {"ok": False, "error": "not_found"}
    shell = await PatientAccountRepository().cy_shell(tenant_id, pseudo, p.get("full_name"))
    return await LoyaltyRepository(tenant_id=tenant_id).enroll(
        str(shell), method=method, name=p.get("full_name"), referred_by_code=referred_by_code)
