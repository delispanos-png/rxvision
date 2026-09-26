"""Ομάδες ασφαλισμένων — Φάση 1: ΟΙΚΟΓΕΝΕΙΕΣ.

Η ίδια συλλογή θα εξυπηρετήσει και τις ΔΟΜΕΣ ΦΡΟΝΤΙΔΑΣ (Φάση 2) με `kind="care"`: κύκλος
ετοιμασίας + καθολικό χρεώσεων/εισπράξεων. Γι' αυτό το `kind` είναι παράμετρος από την πρώτη
μέρα και το πρόσθετο ελέγχεται ανά είδος — δες `docs/patient-groups-design.md`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.patient_groups import FAMILY, PatientGroupRepository

router = APIRouter()
_MODULE = "family_groups"
_PERM = "patients:read"
# ΕΝΑ δικαίωμα για όλο το πρόσθετο, όπως στις Προχορηγήσεις. ΔΕΝ φτιάχνουμε «patients:write»:
# τα δικαιώματα είναι deny-by-default, οπότε ένα καινούργιο που δεν έχει σπαρθεί στους ρόλους
# θα έδινε 403 σε ΟΛΟΥΣ — και το 403 εμφανίζεται ως «με πετάει έξω», που δεν διαγιγνώσκεται εύκολα.
_WRITE = _PERM


def _repo(ctx: TenantContext) -> PatientGroupRepository:
    return PatientGroupRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


def _period(months: int) -> tuple[datetime, datetime]:
    now = datetime.now(tz=timezone.utc).replace(tzinfo=None)
    return now - timedelta(days=30 * max(1, months)), now + timedelta(days=1)


class GroupIn(BaseModel):
    name: str


class MemberIn(BaseModel):
    # Ένα από τα δύο: ΑΜΚΑ (για άτομο που μπορεί να ΜΗΝ έχει ακόμη δεδομένα) ή έτοιμο
    # ψευδώνυμο από την αναζήτηση. Το ΑΜΚΑ δεν αποθηκεύεται ποτέ — γίνεται ψευδώνυμο και χάνεται.
    amka: str | None = None
    pseudo_id: str | None = None
    patient_id: str | None = None      # από την αναζήτηση — δεν ταξιδεύει ΑΜΚΑ
    label: str | None = None
    role: str | None = None


class MemberPatch(BaseModel):
    label: str | None = None
    role: str | None = None


@router.get("")
async def list_groups(q: str | None = Query(None),
                      include_inactive: bool = Query(False),
                      skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Η αναζήτηση πιάνει όνομα οικογένειας, ΑΜΚΑ μέλους και όνομα μέλους."""
    return await _repo(ctx).list_groups(kind=FAMILY, q=q, include_inactive=include_inactive,
                                        skip=skip, limit=limit)


@router.get("/patients")
async def search_patients(q: str = Query(..., min_length=2),
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Αναζήτηση για προσθήκη μέλους.

    ΓΙΑΤΙ ΕΔΩ ΚΑΙ ΟΧΙ ΤΟ `/patients/search`: εκείνο απαιτεί το πρόσθετο «Ασφαλισμένοι». Όποιος
    αγόρασε ΜΟΝΟ τις Οικογένειες θα έπαιρνε 403 και το πεδίο δεν θα έβρισκε ποτέ κανέναν — το
    ίδιο λάθος είχε γίνει στις Προχορηγήσεις.
    """
    from app.repositories.patients import PatientExecutionsRepository
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return {"items": await repo.search(q)}


@router.post("")
async def create_group(body: GroupIn,
                       ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    return await _repo(ctx).create(kind=FAMILY, name=body.name, by=ctx.user_id)


@router.get("/{gid}")
async def group_detail(gid: str, months: int = Query(12, ge=1, le=60),
                       ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    df, dt = _period(months)
    d = await _repo(ctx).detail(gid, date_from=df, date_to=dt)
    return d or {"error": "not_found"}


@router.get("/{gid}/lists")
async def group_lists_all(gid: str, days: int = Query(45, ge=1, le=120),
                          months: int = Query(12, ge=1, le=60),
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """ΤΙ ΑΚΡΙΒΩΣ τρέχει σε κάθε μέλος — όλες οι λίστες με ΜΙΑ κλήση.

    ΓΙΑΤΙ ΜΑΖΙ ΚΑΙ ΟΧΙ ΑΝΑ ΜΕΛΟΣ: ο φαρμακοποιός πατάει μπαμπά → μαμά → παιδί μέσα σε δύο
    δευτερόλεπτα. Με ένα αίτημα ανά μέλος κάθε κλικ θα περίμενε τον διακομιστή· έτσι η
    εναλλαγή είναι ακαριαία, γιατί τα δεδομένα είναι ήδη εκεί.
    """
    from app.services import group_lists
    repo = _repo(ctx)
    g = await repo.find_one({"_id": __import__("bson").ObjectId(gid)}) if gid else None
    if not g:
        return {"error": "not_found"}
    pseudos = [m["pseudo_id"] for m in (g.get("members") or [])
               if m.get("pseudo_id") and not m.get("left_at")]
    names, ids = {}, []
    if pseudos:
        from app.utils.masking import mask_name
        async for p in repo._db["patients_anonymized"].find(
                {"tenant_id": ctx.tenant_id, "pseudo_id": {"$in": pseudos}},
                {"pseudo_id": 1, "full_name": 1}):
            ids.append(p["_id"])
            names[str(p["_id"])] = mask_name(p.get("full_name"), ctx.demo)
    return await group_lists.everything(repo._db, ctx.tenant_id, ids, names,
                                        days=days, months=months)


@router.patch("/{gid}")
async def rename_group(gid: str, body: GroupIn,
                       ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    return await _repo(ctx).rename(gid, body.name)


@router.delete("/{gid}")
async def delete_group(gid: str,
                       ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    return await _repo(ctx).delete(gid)


@router.post("/{gid}/members")
async def add_member(gid: str, body: MemberIn,
                     ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    return await _repo(ctx).add_member(gid, amka=body.amka, pseudo_id=body.pseudo_id,
                                       patient_id=body.patient_id,
                                       label=body.label, role=body.role)


@router.patch("/{gid}/members/{pseudo_id}")
async def update_member(gid: str, pseudo_id: str, body: MemberPatch,
                        ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    return await _repo(ctx).update_member(gid, pseudo_id, label=body.label, role=body.role)


@router.delete("/{gid}/members/{pseudo_id}")
async def remove_member(gid: str, pseudo_id: str,
                        ctx: TenantContext = Depends(require(_WRITE, module=_MODULE))):
    """Αφαίρεση μέλους — ΚΑΙ ανάκληση των εξουσιοδοτήσεων μέσα σε αυτή την οικογένεια.

    ΓΙΑΤΙ ΜΑΖΙ (διαζύγιο, 26/09/2026): η γονική μέριμνα σταματά μόνη της (υπολογίζεται από τη
    συμμετοχή), αλλά η ΡΗΤΗ εξουσιοδότηση ζει σε άλλο μηχανισμό. Ο φαρμακοποιός έβγαζε τον
    έναν από την οικογένεια και νόμιζε ότι τελείωσε — ενώ ο πρώην σύζυγος συνέχιζε να βλέπει
    την πρώην σύζυγο. Δύο πόρτες, έκλεινε η μία.
    """
    from app.services import portal_access
    out = await _repo(ctx).remove_member(gid, pseudo_id)
    if out.get("ok"):
        rev = await portal_access.revoke_between(ctx.tenant_id, pseudo_id,
                                                 out.get("others") or [], by=ctx.user_id)
        out["revoked"] = rev.get("revoked", 0)
    out.pop("others", None)          # εσωτερικό — δεν το χρειάζεται η οθόνη
    return out


@router.get("/family-alerts/{patient_id}")
async def family_alerts(patient_id: str,
                        ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Τι τρέχει στους ΥΠΟΛΟΙΠΟΥΣ της οικογένειας — δανεικά και ανεκτέλεστα.

    ΓΙΑΤΙ ΜΕΣΑ ΣΤΗΝ ΕΙΚΟΝΑ ΠΕΛΑΤΗ: ο άνθρωπος είναι ΜΠΡΟΣΤΑ στον φαρμακοποιό. Είναι η μόνη
    στιγμή που μπορεί να ρωτήσει «ξέρετε ότι ο σύζυγός σας χρωστά δύο δανεικά;» και να πάρει
    απάντηση. Αν το δει αργότερα στην οθόνη της οικογένειας, ο πελάτης έχει ήδη φύγει.

    ΜΟΝΟ ΟΙ ΑΛΛΟΙ: τα δικά του δανεικά/ανεκτέλεστα τα δείχνει ήδη η ίδια η καρτέλα — η αξία
    εδώ είναι αποκλειστικά η πληροφορία που ΔΕΝ φαίνεται αλλού.
    """
    from app.services import group_lists
    from app.utils.masking import mask_name
    repo = _repo(ctx)
    me = await repo._db["patients_anonymized"].find_one(
        {"tenant_id": ctx.tenant_id, "_id": __import__("bson").ObjectId(patient_id)},
        {"pseudo_id": 1}) if patient_id else None
    if not me or not me.get("pseudo_id"):
        return {"items": []}
    out = []
    async for g in repo._db["patient_groups"].find(
            {"tenant_id": ctx.tenant_id, "kind": FAMILY, "active": {"$ne": False},
             "members.pseudo_id": me["pseudo_id"]}).limit(5):
        others = [m["pseudo_id"] for m in (g.get("members") or [])
                  if m.get("pseudo_id") and not m.get("left_at")
                  and m["pseudo_id"] != me["pseudo_id"]]
        if not others:
            continue
        names, ids = {}, []
        async for p in repo._db["patients_anonymized"].find(
                {"tenant_id": ctx.tenant_id, "pseudo_id": {"$in": others}},
                {"pseudo_id": 1, "full_name": 1}):
            ids.append(p["_id"])
            names[str(p["_id"])] = mask_name(p.get("full_name"), ctx.demo)
        if not ids:
            continue
        lo = await group_lists.loans(repo._db, ctx.tenant_id, ids, names, limit=50)
        pe = await group_lists.pending(repo._db, ctx.tenant_id, ids, names, limit=50)
        if lo or pe:
            out.append({"group_id": str(g["_id"]), "group_name": g.get("name"),
                        "loans": lo, "pending": pe})
    return {"items": out}


@router.get("/for-patient/{patient_id}")
async def for_patient(patient_id: str,
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Σε ποιες ομάδες ανήκει — το καταναλώνει η Εικόνα Πελάτη."""
    return {"items": await _repo(ctx).groups_for_patient(patient_id)}
