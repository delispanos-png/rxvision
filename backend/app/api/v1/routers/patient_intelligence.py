"""Patient Intelligence router — unified patient-level BI (dashboard, analytics, compliance,
recall, win-back, VIP, risk, segmentation, AI insights). Consolidates capabilities that were
scattered across the advisor/patients modules."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.config import settings
from app.core.deps import TenantContext, require
from app.repositories.advisor import AdvisorRepository
from app.repositories.patient_intelligence import PatientIntelligenceRepository
from app.services import patient_advice
from app.utils.anonymization import pseudonymize

router = APIRouter()
_MODULE = "patient_analytics"


def _repo(ctx: TenantContext) -> PatientIntelligenceRepository:
    return PatientIntelligenceRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


@router.get("/overview")
async def overview(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).overview()


@router.get("/today")
async def today(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).today()


@router.get("/patients")
async def patients(sort: str = Query("value"),
                   ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).patients_table(sort=sort)


@router.get("/compliance")
async def compliance(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).compliance()


@router.get("/recall")
async def recall(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await AdvisorRepository(tenant_id=ctx.tenant_id, demo=ctx.demo).recall()


@router.get("/winback")
async def winback(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).winback()


@router.get("/returns")
async def returns(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).returns()


@router.get("/vip")
async def vip(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).vip()


@router.get("/risk")
async def risk(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).risk()


@router.get("/segments")
async def segments(ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).segments()


# ── 360° single-patient profile («Εικόνα Πελάτη», by ΑΜΚΑ) ──────────────────
@router.get("/profile")
async def profile(amka: str | None = Query(None),
                  patient_id: str | None = Query(None),
                  barcode: str | None = Query(None),
                  date_from: datetime | None = Query(None),
                  date_to: datetime | None = Query(None),
                  ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """360° profile by ΑΜΚΑ, με patient_id (από αναζήτηση ονόματος — δουλεύει και σε demo με
    masked ΑΜΚΑ), ή με barcode συνταγής (σάρωση στο φαρμακείο — χωρίς να ζητηθεί ΑΜΚΑ).
    date_from/date_to περιορίζουν ΜΟΝΟ διαγνώσεις/φάρμακα/segments (εστίαση AI)."""
    return await _repo(ctx).patient_profile(amka=amka, patient_id=patient_id, barcode=barcode,
                                            date_from=date_from, date_to=date_to)


class AdviceIn(BaseModel):
    amka: str
    date_from: datetime | None = None
    date_to: datetime | None = None
    force: bool = False     # αναγκαστική αναδημιουργία (αγνοεί την αποθηκευμένη)


@router.post("/profile/advice")
async def profile_advice(body: AdviceIn,
                         ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    """AI care/retention/lifestyle advice for ONE patient, from their 360° profile (ίδιο date scope).
    Αποθηκεύεται στη βάση· καλεί ξανά το AI ΜΟΝΟ όταν οι κλινικές συνθήκες (παθήσεις/φάρμακα/
    κατηγορίες/G6PD) έχουν αλλάξει — αλλιώς επιστρέφει τις αποθηκευμένες (ταχύτητα + μικρότερο κόστος)."""
    # AI entitlement: η συμβουλή είναι AI-feature → απαιτεί και το module ai_assistant (Pro), πέρα
    # από το patient_analytics gate του router.
    if ctx.modules.get("ai_assistant", "locked") == "locked":
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"error": "module_locked", "module": "ai_assistant"})
    repo = _repo(ctx)

    def _iso(d):
        return d.isoformat() if d else None

    # 1) ΦΘΗΝΗ υπογραφή κλινικών συνθηκών (χωρίς το βαρύ προφίλ 360°). Cache-hit → ΑΜΕΣΗ απάντηση.
    pid, amka, sig_src = await repo.advice_signature(body.amka, date_from=body.date_from, date_to=body.date_to)
    if not pid:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    sig = hashlib.sha256(json.dumps(sig_src, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    # ΚΑΘΟΛΙΚΗ βάση γνώσεων: κλειδί = καθολικό ψευδώνυμο του ΑΜΚΑ (hash, όχι raw) → κοινή χρήση μεταξύ
    # φαρμακείων. Χωρίς ΑΜΚΑ (demo/masked) → fallback ανά tenant ώστε να μη σπάει.
    kb_key = (pseudonymize(amka, tenant_pepper=settings.ANONYMIZATION_GLOBAL_PEPPER)
              if amka else f"t:{ctx.tenant_id}:{pid}")
    coll = repo._db["ai_advice_kb"]
    cached = await coll.find_one({"_id": kb_key})
    if cached and cached.get("sig") == sig and not body.force and cached.get("advice", {}).get("ok"):
        return {**cached["advice"], "cached": True, "shared": bool(amka), "generated_at": _iso(cached.get("generated_at"))}

    # 2) MISS (ή force) → χτίσε το προφίλ ΜΟΝΟ για κλινικά (παθήσεις/φάρμακα/δημογραφικά), κάλεσε AI,
    # αποθήκευσε καθολικά. ΔΕΝ περνάμε στοιχεία-σχέσης φαρμακείου (επισκέψεις/αξία/VIP/συμμόρφωση) ώστε
    # η κοινή συμβουλή να μη διαρρέει δεδομένα ενός φαρμακείου σε άλλο.
    prof = await repo.patient_profile(body.amka, date_from=body.date_from, date_to=body.date_to)
    if not prof.get("found"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    p = prof["patient"]
    facts = {
        "ηλικιακή_ομάδα": p.get("age_group"), "φύλο": p.get("sex"),
        "θεραπευτικές_κατηγορίες": [s["label"] for s in prof["segments"]],
        "παθήσεις": [f"{c['code']} {c.get('title') or ''}".strip() for c in prof["conditions"]],
        "βασικά_φάρμακα": [m["name"] for m in prof["medicines"][:8]],
        "έλλειψη_ενζύμου_G6PD": "ΝΑΙ — προσοχή σε οξειδωτικά φάρμακα" if prof.get("clinical", {}).get("g6pd_deficiency") else "όχι",
    }
    res = await patient_advice.advise(facts)
    if not res.get("ok"):
        if cached and cached.get("advice", {}).get("ok"):    # AI κάτω → fallback στα αποθηκευμένα
            return {**cached["advice"], "cached": True, "stale": True, "generated_at": _iso(cached.get("generated_at"))}
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, res.get("error", "unavailable"))
    now = datetime.now(tz=timezone.utc)
    await coll.update_one({"_id": kb_key},
                          {"$set": {"sig": sig, "advice": res, "generated_at": now,
                                    "conditions": sig_src["conditions"]}}, upsert=True)
    return {**res, "cached": False, "shared": bool(amka), "generated_at": _iso(now)}


# ── pharmacist notes / comments on a patient ────────────────────────────────
class NoteIn(BaseModel):
    amka: str
    text: str


@router.get("/profile/notes")
async def profile_notes(amka: str = Query(..., min_length=3),
                        ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return {"items": await _repo(ctx).list_notes(amka)}


@router.post("/profile/notes")
async def add_profile_note(body: NoteIn,
                           ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).add_note(body.amka, body.text, ctx.user_id)


@router.delete("/profile/notes/{note_id}")
async def delete_profile_note(note_id: str,
                              ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    return await _repo(ctx).delete_note(note_id)


# ── clinical flag: G6PD enzyme deficiency ───────────────────────────────────
class G6pdIn(BaseModel):
    amka: str
    g6pd_deficiency: bool


@router.post("/profile/g6pd")
async def set_g6pd(body: G6pdIn,
                   ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    res = await _repo(ctx).set_g6pd(body.amka, body.g6pd_deficiency)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, res.get("error", "patient_not_found"))
    return res


# ── create a my.rxvision.gr portal account for the patient (pharmacist-initiated) ──
class PortalAccountIn(BaseModel):
    amka: str
    email: str
    phone: str | None = None


@router.post("/profile/portal-account")
async def create_portal_account(body: PortalAccountIn,
                                ctx: TenantContext = Depends(require("patients:read", module=_MODULE))):
    pa = await _repo(ctx)._patient_by_amka(body.amka)
    if not pa:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient_not_found")
    parts = (pa.get("full_name") or "").split()
    last = parts[0] if parts else ""
    first = " ".join(parts[1:]) if len(parts) > 1 else ""
    from app.services.patient_auth_service import PatientAuthService
    res = await PatientAuthService().admin_create(
        first_name=first, last_name=last, email=body.email, phone=body.phone, amka=body.amka)
    if not res.get("ok"):
        raise HTTPException(status.HTTP_409_CONFLICT, res.get("error", "failed"))
    return res
