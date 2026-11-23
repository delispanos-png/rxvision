"""ΕΝΑ σημείο απόφασης: «ποιον επιτρέπεται να δει αυτός ο χρήστης της πύλης;».

ΤΡΕΙΣ ΕΝΤΕΛΩΣ ΔΙΑΦΟΡΕΤΙΚΟΙ ΜΗΧΑΝΙΣΜΟΙ — η σύγχυσή τους είναι το πιο εύκολο λάθος εδώ:

  1. ΓΟΝΙΚΗ ΜΕΡΙΜΝΑ — αυτόματη. Μέλος οικογένειας με ρόλο «Γονέας» βλέπει τα ΑΝΗΛΙΚΑ μέλη της
     ίδιας οικογένειας. **Παύει ΜΟΝΗ ΤΗΣ τη μέρα των 18ων γενεθλίων.**
  2. ΕΞΟΥΣΙΟΔΟΤΗΣΗ ΦΡΟΝΤΙΔΑΣ — ρητή, από τον ΙΔΙΟ τον ενήλικο, προς οποιοδήποτε ΑΜΚΑ,
     ανακλητή οποτεδήποτε. Για ηλικιωμένο που ορίζει ένα παιδί του — ή, αν δεν έχει παιδιά,
     όποιον εμπιστεύεται. ΔΕΝ χρειάζεται συγγένεια.
  3. Ο ΕΑΥΤΟΣ ΤΟΥ — πάντα.

⚠ ΤΙ ΔΕΝ ΙΣΧΥΕΙ: ενήλικο μέλος οικογένειας ΔΕΝ βλέπει άλλο ενήλικο μέλος επειδή «είναι
οικογένεια». Η οικογένεια είναι εργαλείο ΤΟΥ ΦΑΡΜΑΚΟΠΟΙΟΥ· η πύλη ακολουθεί ΣΥΓΚΑΤΑΘΕΣΗ, όχι
συγγένεια. Μια τέτοια σιωπηλή επέκταση θα ήταν γνωστοποίηση δεδομένων υγείας.

⚠ Η ΗΛΙΚΙΑ ΥΠΟΛΟΓΙΖΕΤΑΙ ΣΕ ΚΑΘΕ ΑΝΑΓΝΩΣΗ (`utils/amka.py`) — ποτέ αποθηκευμένη σημαία. Μια
«τεμπέλικη» λήξη εδώ σημαίνει γονέα που συνεχίζει να βλέπει δεδομένα υγείας ΕΝΗΛΙΚΟΥ.

⚠ Η ΠΡΟΣΒΑΣΗ ΕΙΝΑΙ ΑΝΑ ΦΑΡΜΑΚΕΙΟ. Την οικογένεια τη δήλωσε ΕΝΑ φαρμακείο· ισχύει εκεί. Το ίδιο
και η εξουσιοδότηση.

ΘΑΝΟΝΤΕΣ: το ιστορικό παραμένει ορατό σε όποιον είχε ήδη πρόσβαση (υπάρχουν εκκρεμότητες που
κάποιος πρέπει να κλείσει), αλλά η προβολή είναι **read_only** — καμία ενέργεια στο όνομά του.
"""

from __future__ import annotations

import unicodedata
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from app.core.db import shared_db
from app.utils.amka import is_minor
from app.utils.masking import mask_name

SELF, PARENTAL, AUTHORIZED = "self", "parental", "authorized"
AUTH_COLL = "care_authorizations"


def _fold(s: Any) -> str:
    """Χωρίς τόνους, πεζά — ο ρόλος γράφεται από άνθρωπο («Γονέας», «ΓΟΝΕΑΣ», «γονεας»)."""
    t = unicodedata.normalize("NFD", str(s or ""))
    return "".join(c for c in t if unicodedata.category(c) != "Mn").lower().strip()


def is_parent_role(role: Any) -> bool:
    return _fold(role) in {"γονεας", "γονεις", "parent", "μητερα", "πατερας"}


def _oid(v: Any) -> ObjectId | None:
    try:
        return v if isinstance(v, ObjectId) else ObjectId(str(v))
    except (InvalidId, TypeError):
        return None


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _is_cy(tenant_id: str) -> bool:
    from app.services.cy.gate import tenant_country
    return await tenant_country(tenant_id) == "CY"


def _minor(p: dict) -> bool:
    """Ανήλικος ΤΩΡΑ. Κύπρος: από την ΑΚΡΙΒΗ ημερομηνία γέννησης του ΓεΣΥ· Ελλάδα: ΑΜΚΑ/έτος.
    Άγνωστο → ΟΧΙ (κλειστή αποτυχία, ίδιος κανόνας με το `is_minor`)."""
    if p.get("cy"):
        from app.repositories.cy_groups import _minor as cy_minor
        return cy_minor(p.get("dob"))
    return is_minor(p.get("amka"), p.get("birth_year"))


async def _cy_patients_by_pseudo(tenant_id: str, pseudos: list[str]) -> dict[str, dict]:
    """ΚΥΠΡΟΣ (23/11/2026): οι άνθρωποι είναι πελάτες ΓεΣΥ (`cy_patients`, ψευδώνυμο ΓεΣΥ)· η «καρτέλα
    πύλης» (`_id`) είναι η γέφυρα `cy_portal` — υπάρχει μόνο αν ο άνθρωπος έχει ήδη μπει σε κοινό κύκλωμα."""
    from app.repositories.cy import CyPatientRepository, find_all
    rows = await find_all(CyPatientRepository(tenant_id=tenant_id), {"pseudo_id": {"$in": pseudos}})
    shells = {d["cy_pseudo_id"]: d["_id"] async for d in shared_db()["patients_anonymized"].find(  # tenant-ok
        {"tenant_id": tenant_id, "source": "cy_portal", "cy_pseudo_id": {"$in": pseudos}}, {"cy_pseudo_id": 1})}
    return {p["pseudo_id"]: {"_id": shells.get(p["pseudo_id"]), "pseudo_id": p["pseudo_id"], "cy": True,
                             "full_name": p.get("full_name"), "dob": p.get("dob"), "amka": None,
                             "deceased": bool((p.get("deceased") or {}).get("at"))} for p in rows}


async def _ref_of(tenant_id: str, p: dict) -> str:
    """Η καρτέλα πύλης του ανθρώπου (για την «προβολή ως» στην πύλη). Κύπρος: δημιουργείται αν λείπει."""
    if p.get("_id") is None and p.get("cy"):
        from app.repositories.patient_portal import PatientAccountRepository
        p["_id"] = await PatientAccountRepository().cy_shell(tenant_id, p["pseudo_id"], p.get("full_name"))
    return str(p["_id"])


def _public_id(p: dict) -> str | None:
    """Το αναγνωριστικό που δείχνει η οθόνη του φαρμακοποιού: Κύπρος = ψευδώνυμο ΓεΣΥ (καρτέλα /cy/patients),
    Ελλάδα = η καρτέλα (`patients_anonymized._id`)."""
    if p.get("cy"):
        return p.get("pseudo_id")
    return str(p["_id"]) if p.get("_id") else None


async def _patients_by_pseudo(tenant_id: str, pseudos: list[str]) -> dict[str, dict]:
    if not pseudos:
        return {}
    if await _is_cy(tenant_id):
        return await _cy_patients_by_pseudo(tenant_id, pseudos)
    db = shared_db()
    out = {}
    async for p in db["patients_anonymized"].find(
            {"tenant_id": tenant_id, "pseudo_id": {"$in": pseudos}},
            {"pseudo_id": 1, "full_name": 1, "amka": 1, "birth_year": 1, "deceased": 1}):
        out[p["pseudo_id"]] = p
    return out


async def _pseudo_of(tenant_id: str, patient_ref: Any) -> str | None:
    """Καρτέλα (ObjectId) → ψευδώνυμο. Κύπρος: η καρτέλα-γέφυρα δείχνει στο ψευδώνυμο ΓεΣΥ· δεκτό και
    το ίδιο το ψευδώνυμο ΓεΣΥ (από την οθόνη του φαρμακοποιού), αφού ελεγχθεί ότι υπάρχει ΣΕ ΑΥΤΟ το φαρμακείο."""
    oid = _oid(patient_ref)
    if oid:
        p = await shared_db()["patients_anonymized"].find_one(
            {"tenant_id": tenant_id, "_id": oid}, {"pseudo_id": 1, "source": 1, "cy_pseudo_id": 1})
        if (p or {}).get("source") == "cy_portal":
            return p.get("cy_pseudo_id")
        return (p or {}).get("pseudo_id")
    if patient_ref and await _is_cy(tenant_id):
        from app.repositories.cy import CyPatientRepository
        c = await CyPatientRepository(tenant_id=tenant_id).find_one({"pseudo_id": str(patient_ref)})
        return c["pseudo_id"] if c else None
    return None


async def viewable_in_tenant(tenant_id: str, viewer_ref: Any, *,
                             demo: bool = False) -> list[dict]:
    """Ποιους ΑΛΛΟΥΣ μπορεί να δει αυτός ο χρήστης μέσα σε ΑΥΤΟ το φαρμακείο."""
    db = shared_db()
    me = await _pseudo_of(tenant_id, viewer_ref)
    if not me:
        return []
    found: dict[str, dict] = {}

    # ── 1) ΓΟΝΙΚΗ ΜΕΡΙΜΝΑ ────────────────────────────────────────────────────────────
    async for g in db["patient_groups"].find(
            {"tenant_id": tenant_id, "kind": "family", "active": {"$ne": False},
             "members.pseudo_id": me}):
        members = [m for m in (g.get("members") or []) if not m.get("left_at")]
        mine = next((m for m in members if m.get("pseudo_id") == me), None)
        if not mine or not is_parent_role(mine.get("role")):
            continue                                    # δεν είναι δηλωμένος γονέας εδώ
        others = [m["pseudo_id"] for m in members
                  if m.get("pseudo_id") and m["pseudo_id"] != me]
        pats = await _patients_by_pseudo(tenant_id, others)
        for ps, p in pats.items():
            # ΑΝΗΛΙΚΟΣ, υπολογισμένο ΤΩΡΑ. Ενηλικιώθηκε → φεύγει από μόνο του.
            if not _minor(p):
                continue
            found[ps] = {"patient_ref": await _ref_of(tenant_id, p), "pseudo_id": ps,
                         "name": mask_name(p.get("full_name"), demo),
                         "relation": PARENTAL, "via": g.get("name"),
                         "deceased": bool(p.get("deceased"))}

    # ── 2) ΕΞΟΥΣΙΟΔΟΤΗΣΗ ─────────────────────────────────────────────────────────────
    grantors = [a["grantor_pseudo"] async for a in db[AUTH_COLL].find(
        {"tenant_id": tenant_id, "grantee_pseudo": me, "revoked_at": None},
        {"grantor_pseudo": 1})]
    if grantors:
        for ps, p in (await _patients_by_pseudo(tenant_id, grantors)).items():
            found[ps] = {"patient_ref": await _ref_of(tenant_id, p), "pseudo_id": ps,
                         "name": mask_name(p.get("full_name"), demo),
                         "relation": AUTHORIZED, "via": None,
                         "deceased": bool(p.get("deceased"))}
    return list(found.values())


async def can_view(tenant_id: str, viewer_ref: Any, target_ref: Any) -> dict | None:
    """{relation, read_only} αν επιτρέπεται· None αν ΟΧΙ. Ο έλεγχος γίνεται ΠΑΝΤΑ εδώ."""
    if str(viewer_ref) == str(target_ref):
        return {"relation": SELF, "read_only": False}
    tgt = await _pseudo_of(tenant_id, target_ref)
    if not tgt:
        return None
    for row in await viewable_in_tenant(tenant_id, viewer_ref):
        if row["pseudo_id"] == tgt:
            # Θανών → ιστορικό ναι, ενέργειες όχι.
            return {"relation": row["relation"], "read_only": bool(row["deceased"])}
    return None


async def viewable_for_account(account_id: Any, *, demo: bool = False) -> list[dict]:
    """Όλοι οι άνθρωποι που μπορεί να δει ο λογαριασμός, σε ΟΛΑ τα φαρμακεία του."""
    db = shared_db()
    out = []
    async for link in db["patient_links"].find({"account_id": _oid(account_id)}):
        tid = link.get("tenant_id")
        for row in await viewable_in_tenant(tid, link.get("patient_ref"), demo=demo):
            out.append({**row, "tenant_id": tid,
                        "pharmacy_name": link.get("pharmacy_name")})
    return out


# ── διαχείριση εξουσιοδοτήσεων (από τον φαρμακοποιό ή τον ίδιο τον ασθενή) ───────────
async def list_all(tenant_id: str, *, demo: bool = False, limit: int = 300) -> list[dict]:
    """ΟΛΕΣ οι ενεργές εξουσιοδοτήσεις του φαρμακείου — ποιος έδωσε πρόσβαση σε ποιον.

    ΓΙΑΤΙ ΧΡΕΙΑΖΕΤΑΙ: η οθόνη ζητούσε να ψάξεις ασφαλισμένο ΠΡΙΝ δεις οτιδήποτε. Άρα ο
    φαρμακοποιός δεν μπορούσε να απαντήσει στο «ποιοι μου έχουν δώσει συγκατάθεση;» — έπρεπε
    να τους ξέρει ήδη για να τους βρει.

    ⚠ Η γονική μέριμνα ΔΕΝ είναι εδώ: δεν είναι συγκατάθεση που δόθηκε, είναι αυτόματη από την
    ηλικία και παύει μόνη της. Αυτή η λίστα δείχνει ό,τι ΔΗΛΩΘΗΚΕ ρητά.
    """
    db = shared_db()
    rows = [a async for a in db[AUTH_COLL].find(
        {"tenant_id": tenant_id, "revoked_at": None}).sort("granted_at", -1).limit(limit)]
    if not rows:
        return []
    pseudos = list({p for a in rows for p in (a["grantor_pseudo"], a["grantee_pseudo"])})
    pats = await _patients_by_pseudo(tenant_id, pseudos)

    def who(ps: str) -> dict:
        p = pats.get(ps) or {}
        return {"patient_id": _public_id(p),
                "name": mask_name(p.get("full_name"), demo) or "—",
                "deceased": bool(p.get("deceased"))}

    return [{"id": str(a["_id"]), "at": a.get("granted_at"), "note": a.get("note"),
             "grantor": who(a["grantor_pseudo"]), "grantee": who(a["grantee_pseudo"])}
            for a in rows]


async def grant(tenant_id: str, *, grantor_pseudo: str, grantee_pseudo: str,
                by: str | None = None, note: str = "") -> dict:
    if grantor_pseudo == grantee_pseudo:
        return {"ok": False, "error": "self"}
    db = shared_db()
    pats = await _patients_by_pseudo(tenant_id, [grantor_pseudo, grantee_pseudo])
    gr = pats.get(grantor_pseudo)
    if not gr:
        return {"ok": False, "error": "no_grantor"}
    if gr.get("deceased"):
        return {"ok": False, "error": "deceased"}
    # Ο ΑΝΗΛΙΚΟΣ δεν δίνει εξουσιοδότηση — γι' αυτόν ισχύει η γονική μέριμνα, που είναι
    # αυτόματη και παύει μόνη της. Αν το επιτρέπαμε, θα επιβίωνε μετά τα 18.
    if _minor(gr):
        return {"ok": False, "error": "grantor_minor"}
    exists = await db[AUTH_COLL].find_one({"tenant_id": tenant_id, "grantor_pseudo": grantor_pseudo,
                                           "grantee_pseudo": grantee_pseudo, "revoked_at": None})
    if exists:
        return {"ok": False, "error": "already"}
    await db[AUTH_COLL].insert_one({
        "tenant_id": tenant_id, "grantor_pseudo": grantor_pseudo,
        "grantee_pseudo": grantee_pseudo, "granted_at": _now(), "granted_by": by,
        "note": str(note or "").strip()[:200], "revoked_at": None, "revoked_by": None})
    return {"ok": True}


async def revoke(tenant_id: str, auth_id: str, *, by: str | None = None) -> dict:
    r = await shared_db()[AUTH_COLL].update_one(
        {"_id": _oid(auth_id), "tenant_id": tenant_id, "revoked_at": None},
        {"$set": {"revoked_at": _now(), "revoked_by": by}})
    return {"ok": bool(r.modified_count)}


async def revoke_between(tenant_id: str, pseudo: str, others: list[str],
                         *, by: str | None = None) -> dict:
    """Ανάκληση ΜΟΝΟ των εξουσιοδοτήσεων που συνδέουν τον `pseudo` με τους `others`.

    ΓΙΑΤΙ ΥΠΑΡΧΕΙ: στο διαζύγιο ο φαρμακοποιός βγάζει τον έναν από την οικογένεια και θεωρεί
    ότι τελείωσε. Η γονική μέριμνα όντως σταματά μόνη της (υπολογίζεται από τη συμμετοχή).
    Η ΡΗΤΗ εξουσιοδότηση όμως ζει σε άλλο μηχανισμό και ΔΕΝ επηρεάζεται — ο πρώην σύζυγος
    έπαυε να βλέπει τα παιδιά και συνέχιζε να βλέπει την πρώην σύζυγο.

    ⚠️ ΓΙΑΤΙ ΟΧΙ «ΟΛΕΣ ΤΟΥ ΤΙΣ ΕΞΟΥΣΙΟΔΟΤΗΣΕΙΣ»: η εξουσιοδότηση είναι ΣΚΟΠΙΜΑ ανεξάρτητη
    από την οικογένεια (η βασική της χρήση είναι ο ηλικιωμένος ΧΩΡΙΣ παιδιά που εμπιστεύεται
    κάποιον). Αν ο πατέρας που φεύγει έχει και εξουσιοδότηση από τη ΔΙΚΗ ΤΟΥ μητέρα σε άλλη
    οικογένεια, αυτή δεν αγγίζεται: το διαζύγιο δεν ακυρώνει τη σχέση με τη μαμά του.

    Και προς τις ΔΥΟ κατευθύνσεις — «αυτός βλέπει εκείνους» και «εκείνοι βλέπουν αυτόν».
    """
    others = [o for o in (others or []) if o and o != pseudo]
    if not pseudo or not others:
        return {"revoked": 0}
    r = await shared_db()[AUTH_COLL].update_many(
        {"tenant_id": tenant_id, "revoked_at": None,
         "$or": [{"grantor_pseudo": pseudo, "grantee_pseudo": {"$in": others}},
                 {"grantee_pseudo": pseudo, "grantor_pseudo": {"$in": others}}]},
        {"$set": {"revoked_at": _now(), "revoked_by": by}})
    return {"revoked": int(r.modified_count)}


async def list_for_patient(tenant_id: str, patient_ref: Any, *, demo: bool = False) -> dict:
    """Και οι δύο κατευθύνσεις: ποιους βλέπω — και **ποιος βλέπει εμένα**.

    Το δεύτερο είναι απαίτηση διαφάνειας: όποιος έδωσε πρόσβαση πρέπει να τη βλέπει και να
    μπορεί να την πάρει πίσω.
    """
    db = shared_db()
    me = await _pseudo_of(tenant_id, patient_ref)
    if not me:
        return {"granted_by_me": [], "granted_to_me": []}
    rows = [a async for a in db[AUTH_COLL].find(
        {"tenant_id": tenant_id, "revoked_at": None,
         "$or": [{"grantor_pseudo": me}, {"grantee_pseudo": me}]})]
    pseudos = {p for a in rows for p in (a["grantor_pseudo"], a["grantee_pseudo"])}
    pats = await _patients_by_pseudo(tenant_id, list(pseudos))

    def who(ps: str) -> str:
        return mask_name((pats.get(ps) or {}).get("full_name"), demo) or "—"

    return {
        "granted_by_me": [{"id": str(a["_id"]), "name": who(a["grantee_pseudo"]),
                           "at": a.get("granted_at"), "note": a.get("note")}
                          for a in rows if a["grantor_pseudo"] == me],
        "granted_to_me": [{"id": str(a["_id"]), "name": who(a["grantor_pseudo"]),
                           "at": a.get("granted_at"), "note": a.get("note")}
                          for a in rows if a["grantee_pseudo"] == me],
    }
