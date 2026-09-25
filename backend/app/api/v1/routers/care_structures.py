"""Δομές Φροντίδας — κύκλος ετοιμασίας & λογαριασμός.

ΞΕΧΩΡΙΣΤΟ ΠΡΟΣΘΕΤΟ από τις Οικογένειες, παρότι μοιράζονται τη συλλογή `patient_groups`. Κάθε
πληρωμένο πρόσθετο πρέπει να δουλεύει ΜΟΝΟ του: όποιος αγόρασε τις Δομές και όχι τις Οικογένειες
δεν πρέπει να πάρει 403 πουθενά.

«Δομή» ΔΕΝ σημαίνει κτίριο. Το `care_type` καλύπτει ΜΦΗ/γηροκομείο, ξενώνα ΑμεΑ, δομή ψυχικής
υγείας, θεραπευτική κοινότητα, παιδικό ίδρυμα, κατ' οίκον φροντίδα, ακόμη και ιδιώτη φροντιστή.
Η μηχανή είναι ίδια — δες `docs/patient-groups-design.md` §5γ.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.care_accounts import CareAccountRepository
from app.repositories.patient_groups import CARE, PatientGroupRepository

router = APIRouter()
_MODULE = "care_homes"
_PERM = "patients:read"          # ΕΝΑ δικαίωμα· νέο θα έδινε 403 σε όλους (deny-by-default)

CARE_TYPES = ["ΜΦΗ / Γηροκομείο", "Ξενώνας ΑμεΑ", "Δομή ψυχικής υγείας",
              "Θεραπευτική κοινότητα", "Δομή φιλοξενίας", "Παιδικό ίδρυμα",
              "Κατ' οίκον φροντίδα", "Ιδιώτης φροντιστής", "Άλλο"]


def _groups(ctx: TenantContext) -> PatientGroupRepository:
    return PatientGroupRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


def _acc(ctx: TenantContext) -> CareAccountRepository:
    return CareAccountRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


class GroupIn(BaseModel):
    name: str


class CareSettings(BaseModel):
    care_type: str | None = None
    cycle_days: int | None = None
    charges_from: str | None = None      # YYYY-MM-DD — από πότε μετράνε οι χρεώσεις
    # ΣΤΟΙΧΕΙΑ ΕΠΙΚΟΙΝΩΝΙΑΣ: η δομή είναι ΠΕΛΑΤΗΣ, όχι ασθενής. Ο φαρμακοποιός πρέπει να ξέρει
    # ποιον παίρνει τηλέφωνο, πού παραδίδει και ποιος υπογράφει — χωρίς να ψάχνει σε χαρτάκια.
    billing: dict | None = None          # {afm, address, phone, email, contact_name,
                                         #  contact_phone, hours, authorization, authorized_at, notes}


class MemberIn(BaseModel):
    amka: str | None = None
    patient_id: str | None = None
    label: str | None = None
    role: str | None = None


class EntryIn(BaseModel):
    kind: str = "receipt"                # receipt | manual | adjustment
    amount_cents: int
    at: str | None = None                # YYYY-MM-DD
    note: str = ""


def _date(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s)[:10])
    except ValueError:
        return None


# ── δομές ─────────────────────────────────────────────────────────────────────────────
@router.get("")
async def list_structures(q: str | None = Query(None),
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    r = await _groups(ctx).list_groups(kind=CARE, q=q, limit=200)
    return {**r, "care_types": CARE_TYPES}


@router.get("/portfolio")
async def portfolio(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Όλες οι δομές με το ανοιχτό υπόλοιπό τους — η οθόνη που ανοίγει πρώτη."""
    return await _acc(ctx).portfolio()


@router.get("/patients")
async def search_patients(q: str = Query(..., min_length=2),
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Δική της αναζήτηση: το `/patients/search` απαιτεί άλλο πρόσθετο."""
    from app.repositories.patients import PatientExecutionsRepository
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return {"items": await repo.search(q)}


@router.post("")
async def create_structure(body: GroupIn,
                           ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _groups(ctx).create(kind=CARE, name=body.name, by=ctx.user_id)


@router.get("/{gid}")
async def structure_detail(gid: str, months: int = Query(12, ge=1, le=60),
                           ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    now = datetime.now(tz=timezone.utc).replace(tzinfo=None)
    d = await _groups(ctx).detail(gid, date_from=now - timedelta(days=30 * months),
                                  date_to=now + timedelta(days=1))
    if not d:
        return {"error": "not_found"}
    d["balance"] = await _acc(ctx).balance(gid)
    return d


@router.patch("/{gid}")
async def rename_structure(gid: str, body: GroupIn,
                           ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _groups(ctx).rename(gid, body.name)


@router.patch("/{gid}/settings")
async def care_settings(gid: str, body: CareSettings,
                        ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    cycle = {"days": body.cycle_days} if body.cycle_days else None
    return await _groups(ctx).update_care(gid, care_type=body.care_type, cycle=cycle,
                                          billing=body.billing,
                                          charges_from=_date(body.charges_from))


@router.delete("/{gid}")
async def delete_structure(gid: str,
                           ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _groups(ctx).delete(gid)


# ── τρόφιμοι ──────────────────────────────────────────────────────────────────────────
@router.post("/{gid}/members")
async def add_member(gid: str, body: MemberIn,
                     ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _groups(ctx).add_member(gid, amka=body.amka, patient_id=body.patient_id,
                                         label=body.label, role=body.role)


@router.delete("/{gid}/members/{pseudo_id}")
async def remove_member(gid: str, pseudo_id: str,
                        ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _groups(ctx).remove_member(gid, pseudo_id)


# ── λογαριασμός ───────────────────────────────────────────────────────────────────────
@router.get("/{gid}/statement")
async def statement(gid: str, month: str | None = Query(None),
                    ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Εκκαθαριστικό μήνα: υπόλοιπο από προηγούμενο → χρεώσεις → εισπράξεις → νέο υπόλοιπο."""
    d = await _acc(ctx).statement(gid, month or "")
    return d or {"error": "not_found"}


@router.post("/{gid}/entries")
async def add_entry(gid: str, body: EntryIn,
                    ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Είσπραξη ή χειροκίνητη χρέωση. Τις ΣΥΜΜΕΤΟΧΕΣ δεν τις καταχωρεί κανείς — παράγονται."""
    return await _acc(ctx).add_entry(gid, kind=body.kind, amount_cents=body.amount_cents,
                                     at=_date(body.at), note=body.note, by=ctx.user_id)


@router.delete("/{gid}/entries/{eid}")
async def delete_entry(gid: str, eid: str,
                       ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return await _acc(ctx).delete_entry(gid, eid)


# ── η λίστα ΠΡΟΣ ΤΗ ΔΟΜΗ ──────────────────────────────────────────────────────────────
def _owed_html(name: str, rows: list[dict], days: int) -> str:
    """Το κείμενο που φεύγει στη δομή. ΟΧΙ «φέρτε μας συνταγές» — η δομή δεν εκδίδει συνταγές.

    Στην Ελλάδα τη συνταγή τη γράφει ο ΓΙΑΤΡΟΣ. Η δομή πρέπει να φροντίσει να εκδοθεί και να
    φτάσει σε εμάς. Αυτό λέει το κείμενο, αλλιώς ζητάμε κάτι που δεν μπορούν να κάνουν.
    """
    def rx(r: dict) -> str:
        tag = ("<span style='color:#0a7'>άυλη — δεν χρειάζεται χαρτί</span>"
               if r.get("intangible") else "<span style='color:#a60'>έντυπη</span>")
        d = r.get("opens_at")
        when = d.strftime("%d/%m/%Y") if hasattr(d, "strftime") else "—"
        meds = ", ".join(r.get("items") or [])[:160]
        return (f"<li><b>{r['barcode']}</b> — ανοίγει {when} · {tag}"
                + (f"<br><span style='color:#666;font-size:12px'>{meds}</span>" if meds else "")
                + "</li>")
    body = "".join(
        f"<h3 style='margin:18px 0 4px'>{b['name']}</h3><ul style='margin:0;padding-left:18px'>"
        + "".join(rx(r) for r in b["rx"]) + "</ul>" for b in rows)
    return (f"<div style='font-family:system-ui,sans-serif;font-size:14px;color:#222'>"
            f"<h2 style='margin:0 0 6px'>Αγωγές που ανανεώνονται — {name}</h2>"
            f"<p style='color:#555;margin:0 0 4px'>Οι παρακάτω αγωγές ανοίγουν μέσα στις επόμενες "
            f"{days} ημέρες. Για να τις έχουμε έτοιμες, χρειάζεται να φροντίσετε να εκδοθούν από "
            f"τον θεράποντα ιατρό και να φτάσουν σε εμάς.</p>"
            f"<p style='color:#555;margin:0 0 10px'>Όπου αναφέρεται «άυλη», δεν χρειάζεται να "
            f"φέρετε χαρτί — αρκεί ο κωδικός.</p>{body}</div>")


@router.get("/{gid}/owed")
async def owed(gid: str, days: int = Query(30, ge=1, le=365),
               ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """ΑΝΑ ΤΡΟΦΙΜΟ: ποια barcode πρέπει να φτάσουν σε εμάς. Αυτό στέλνεται στη δομή."""
    from app.services import group_lists
    cy = await _acc(ctx).cycle(gid, days=days)
    if not cy:
        return {"error": "not_found"}
    rows = group_lists.by_person(cy.get("opening") or [])
    g = await _groups(ctx).find_one({"_id": __import__("bson").ObjectId(gid)})
    return {"group": cy["group"], "days": days, "people": rows,
            "email": ((g or {}).get("billing") or {}).get("email"),
            "contact": ((g or {}).get("billing") or {}).get("contact_name"),
            "html": _owed_html(cy["group"].get("name") or "", rows, days)}


@router.post("/{gid}/owed/send")
async def owed_send(gid: str, days: int = Query(30, ge=1, le=365),
                    to: str | None = Query(None),
                    ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Αποστολή της λίστας με email στη δομή."""
    from app.services import group_lists
    from app.services.mailer import send_email
    cy = await _acc(ctx).cycle(gid, days=days)
    if not cy:
        return {"ok": False, "error": "not_found"}
    g = await _groups(ctx).find_one({"_id": __import__("bson").ObjectId(gid)})
    addr = (to or "").strip() or ((g or {}).get("billing") or {}).get("email")
    if not addr:
        return {"ok": False, "error": "no_email"}
    rows = group_lists.by_person(cy.get("opening") or [])
    if not rows:
        return {"ok": False, "error": "empty"}
    name = cy["group"].get("name") or ""
    try:
        await send_email(addr, f"Αγωγές που ανανεώνονται — {name}",
                         _owed_html(name, rows, days))
    except Exception:                      # noqa: BLE001 — το SMTP δεν ρίχνει την οθόνη
        return {"ok": False, "error": "send_failed"}
    return {"ok": True, "to": addr, "people": len(rows)}


# ── φύλλο οδηγιών λήψης ───────────────────────────────────────────────────────────────
def _instr_html(name: str, rows: list[dict]) -> str:
    def person(b: dict) -> str:
        meds = "".join(
            f"<tr><td style='padding:4px 10px 4px 0;border-bottom:1px solid #eee'>{m['name']}</td>"
            f"<td style='padding:4px 0;border-bottom:1px solid #eee;color:#444'>{m['dosage'] or '—'}</td></tr>"
            for m in b["meds"])
        return (f"<h3 style='margin:20px 0 6px'>{b['name']}</h3>"
                f"<table style='border-collapse:collapse;width:100%;font-size:13px'>{meds}</table>")
    return (f"<div style='font-family:system-ui,sans-serif;font-size:14px;color:#222'>"
            f"<h2 style='margin:0 0 6px'>Οδηγίες λήψης — {name}</h2>"
            f"<p style='color:#555;margin:0 0 4px'>Η αγωγή κάθε τροφίμου όπως την έχει ορίσει ο "
            f"θεράπων ιατρός, με βάση τις εκτελέσεις του τελευταίου εξαμήνου.</p>"
            f"<p style='color:#a00;margin:0 0 10px;font-size:12px'>Σε κάθε αλλαγή αγωγής από τον "
            f"ιατρό, το φύλλο πρέπει να αντικατασταθεί. Δεν υποκαθιστά ιατρική οδηγία.</p>"
            + "".join(person(b) for b in rows) + "</div>")


async def _instr_rows(ctx: TenantContext, gid: str) -> tuple[dict | None, list[dict]]:
    from app.services import group_lists
    acc = _acc(ctx)
    g = await acc._group(gid)
    if not g:
        return None, []
    wins = await acc._member_windows(g)
    names = {str(w["_id"]): w["name"] for w in wins}
    rows = await group_lists.instructions(acc._db, ctx.tenant_id,
                                          [w["_id"] for w in wins], names)
    return g, rows


@router.get("/{gid}/instructions")
async def instructions(gid: str, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Τι παίρνει ο κάθε τρόφιμος και ΠΩΣ — για το προσωπικό της δομής."""
    g, rows = await _instr_rows(ctx, gid)
    if not g:
        return {"error": "not_found"}
    return {"people": rows, "email": ((g.get("billing") or {}).get("email")),
            "html": _instr_html(g.get("name") or "", rows)}


@router.post("/{gid}/instructions/send")
async def instructions_send(gid: str, to: str | None = Query(None),
                            ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    from app.services.mailer import send_email
    g, rows = await _instr_rows(ctx, gid)
    if not g:
        return {"ok": False, "error": "not_found"}
    addr = (to or "").strip() or ((g.get("billing") or {}).get("email"))
    if not addr:
        return {"ok": False, "error": "no_email"}
    if not rows:
        return {"ok": False, "error": "empty"}
    name = g.get("name") or ""
    try:
        await send_email(addr, f"Οδηγίες λήψης — {name}", _instr_html(name, rows))
    except Exception:                      # noqa: BLE001
        return {"ok": False, "error": "send_failed"}
    return {"ok": True, "to": addr, "people": len(rows)}


# ── κύκλος ετοιμασίας ─────────────────────────────────────────────────────────────────
@router.get("/{gid}/cycle")
async def cycle(gid: str, days: int = Query(30, ge=1, le=365),
                ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Τι ανοίγει, τι να παραγγείλεις, τι εκκρεμεί — για τον επόμενο κύκλο."""
    d = await _acc(ctx).cycle(gid, days=days)
    return d or {"error": "not_found"}
