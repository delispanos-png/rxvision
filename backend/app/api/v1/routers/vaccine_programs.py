"""Periodic-vaccination programmes («περιοδικά εμβόλια») — configuration endpoints.

Phase 1 of docs/vaccination-periodic-design.md: the pharmacist defines WHICH vaccines to watch
and the clinical parameters of each (dose series, booster interval, age range). Gated behind its
own paid module so it can be sold separately from the seasonal-flu circuit.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from datetime import datetime, timezone

from app.core.db import shared_db
from app.core.deps import TenantContext, require
from app.repositories.patient_portal import PatientAccountRepository
from app.repositories.vaccine_programs import VaccineProgramRepository
from app.services import comms, consent, push_service

router = APIRouter()
_MODULE = "vaccination_programs"        # paid add-on, 10 €/month — separate from the flu circuit
_PERM = "prescriptions:read"


class ProgramIn(BaseModel):
    name: str
    atc_prefixes: list[str] | None = None
    eof_codes: list[str] | None = None
    doses_required: int | None = None
    dose_interval_days: int | None = None
    repeat_years: int | None = None
    min_age: int | None = None
    max_age: int | None = None
    lookback_years: int | None = None
    notify_before_days: int | None = None
    active: bool = True
    notes: str | None = None


# ── catalogue helpers (what the pharmacist picks FROM) ───────────────────────────────────────
@router.get("/catalog/groups")
async def catalog_groups(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Vaccine ATC groups (J07*) with product counts — one-click selection."""
    return {"items": await VaccineProgramRepository.atc_groups()}


@router.get("/catalog/products")
async def catalog_products(
    atc: str | None = Query(None, description="ATC prefix, π.χ. J07BK"),
    q: str | None = Query(None, description="αναζήτηση ονόματος"),
    ctx: TenantContext = Depends(require(_PERM, module=_MODULE)),
):
    """Individual vaccine products, for finer control than a whole ATC group."""
    return {"items": await VaccineProgramRepository.products(atc, q)}


# ── programmes CRUD ──────────────────────────────────────────────────────────────────────────
@router.get("")
async def list_programs(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    return {"items": await VaccineProgramRepository(tenant_id=ctx.tenant_id).list()}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_program(body: ProgramIn,
                         ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    try:
        return await VaccineProgramRepository(tenant_id=ctx.tenant_id).save(body.model_dump())
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _msg(str(e))) from e


@router.put("/{program_id}")
async def update_program(program_id: str, body: ProgramIn,
                         ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    repo = VaccineProgramRepository(tenant_id=ctx.tenant_id)
    if not await repo.get(program_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Το πρόγραμμα δεν βρέθηκε.")
    try:
        return await repo.save(body.model_dump(), program_id=program_id)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _msg(str(e))) from e


@router.delete("/{program_id}")
async def delete_program(program_id: str,
                         ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    n = await VaccineProgramRepository(tenant_id=ctx.tenant_id).delete(program_id)
    if not n:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Το πρόγραμμα δεν βρέθηκε.")
    return {"deleted": n}


# ── ασφαλισμένοι ανά πρόγραμμα ───────────────────────────────────────────────────────────────
@router.get("/{program_id}/patients")
async def program_patients(
    program_id: str,
    status: str = Query("all", pattern="^(all|covered|due_soon|expired|incomplete)$"),
    q: str | None = Query(None, description="όνομα ή ΑΜΚΑ"),
    limit: int = Query(200, ge=1, le=1000),
    skip: int = Query(0, ge=0),
    ctx: TenantContext = Depends(require(_PERM, module=_MODULE)),
):
    """Οι ασφαλισμένοι που ανήκουν στο πρόγραμμα, με κατάσταση κάλυψης.
    Πηγή: οι εκτελεσμένες συνταγές που ήδη έχουμε — καμία κλήση ΗΔΥΚΑ."""
    repo = VaccineProgramRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    program = await repo.get(program_id)
    if not program:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Το πρόγραμμα δεν βρέθηκε.")
    out = await repo.patients_for(program, status=status, q=q, limit=limit, skip=skip)
    out["program"] = {"_id": program_id, "name": program.get("name"),
                      "repeat_years": program.get("repeat_years"),
                      "doses_required": program.get("doses_required")}
    return out


class NotifyIn(BaseModel):
    status: str = "incomplete"          # ποιους: incomplete | expired | due_soon
    channel: str = "sms"                # sms | viber | email | push
    subject: str | None = None
    message: str
    dry_run: bool = False


@router.post("/{program_id}/notify")
async def notify_program(program_id: str, body: NotifyIn,
                         ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ειδοποίηση των ασφαλισμένων μιας κατάστασης (π.χ. όσων δεν ολοκλήρωσαν τις δόσεις).

    Σέβεται συγκατάθεση + μητρώο ανακλήσεων. Οι θανόντες ΔΕΝ μπαίνουν ποτέ (η λίστα τους
    αποκλείει ήδη). `dry_run` επιστρέφει μόνο πλήθος παραληπτών — ο φαρμακοποιός βλέπει
    πόσους αφορά ΠΡΙΝ σταλεί οτιδήποτε."""
    if body.status not in ("incomplete", "expired", "due_soon"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Η ειδοποίηση αφορά μόνο όσους εκκρεμούν, όχι τους πλήρως εμβολιασμένους.")
    repo = VaccineProgramRepository(tenant_id=ctx.tenant_id)
    program = await repo.get(program_id)
    if not program:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Το πρόγραμμα δεν βρέθηκε.")

    data = await repo.patients_for(program, status=body.status, limit=5000)
    field = {"sms": "mobile", "viber": "mobile", "email": "email"}.get(body.channel)

    targets: list[dict] = []
    if field:
        withdrawn = {str(x) for x in await consent.withdrawn_patient_ids(ctx.tenant_id, body.channel)}
        for r in data["items"]:
            if r.get("consent") and r["patient_id"] not in withdrawn and r.get(field):
                targets.append(r)
    else:                                   # push → όσοι έχουν λογαριασμό στην πύλη
        targets = list(data["items"])

    if body.dry_run:
        return {"recipients": len(targets), "channel": body.channel, "dry_run": True}

    accounts = PatientAccountRepository()
    sent = failed = 0
    for r in targets[:2000]:
        name = r.get("name") or ""
        text = (body.message or "").replace("{name}", name).replace("{first}", name.split(" ")[0])
        try:
            if body.channel == "email":
                from app.api.v1.routers.vaccinations import _vacc_email_html
                await comms.send_email(ctx.tenant_id, r["email"],
                                       body.subject or "Υπενθύμιση εμβολιασμού",
                                       _vacc_email_html(text, None))
            elif body.channel == "sms":
                await comms.send_sms(ctx.tenant_id, r["mobile"], text)
            elif body.channel == "viber":
                await comms.send_viber(ctx.tenant_id, r["mobile"], text)
            else:
                acc = await accounts.get_by_amka(r.get("amka") or "")
                if not acc or not await push_service.send_to_account(
                        acc["_id"], title=body.subject or "💉 Υπενθύμιση εμβολιασμού",
                        body=text, url="/portal"):
                    failed += 1
                    continue
            sent += 1
        except Exception:  # noqa: BLE001 — ένας κακός παραλήπτης δεν ρίχνει όλη την παρτίδα
            failed += 1

    await shared_db()["comms_campaigns"].insert_one({
        "tenant_id": ctx.tenant_id, "channel": body.channel, "kind": "vaccine_program",
        "program": program.get("name"), "status_filter": body.status,
        "subject": body.subject, "recipients": len(targets), "sent": sent, "failed": failed,
        "by": getattr(ctx, "email", None), "created_at": datetime.now(tz=timezone.utc)})
    return {"recipients": len(targets), "sent": sent, "failed": failed}


def _msg(code: str) -> str:
    """Validation code → μήνυμα που καταλαβαίνει ο φαρμακοποιός."""
    if code.startswith("bad_atc:"):
        return f"Μη έγκυρη ομάδα ATC: {code.split(':', 1)[1]} (επιτρέπονται μόνο εμβόλια J07*)."
    return {
        "name_required": "Δώσε όνομα στο πρόγραμμα.",
        "no_vaccine_selected": "Επίλεξε τουλάχιστον μία ομάδα ή ένα σκεύασμα.",
        "bad_doses_required": "Οι δόσεις πρέπει να είναι 1-6.",
        "bad_dose_interval_days": "Το μεσοδιάστημα δόσεων πρέπει να είναι 1-3650 ημέρες.",
        "bad_repeat_years": "Η επανάληψη πρέπει να είναι 1-50 έτη (ή κενό αν δεν επαναλαμβάνεται).",
        "bad_min_age": "Μη έγκυρη ελάχιστη ηλικία.",
        "bad_max_age": "Μη έγκυρη μέγιστη ηλικία.",
        "bad_lookback_years": "Η αναδρομή πρέπει να είναι 1-10 έτη.",
        "bad_notify_before_days": "Η προειδοποίηση πρέπει να είναι 0-365 ημέρες.",
    }.get(code, "Μη έγκυρα στοιχεία.")
