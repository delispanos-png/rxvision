"""Προχορηγήσεις σκευασμάτων («δανεικά») — Α & Β φάση.

Α φάση: καταγραφή δανεικού, λίστες, χειροκίνητη ξεχρέωση.
Β φάση: προτάσεις ταύτισης με εκτελεσμένη συνταγή — ο φαρμακοποιός απαντά ναι/όχι.
ΔΕΝ αναρτούμε τίποτα σε ΗΔΥΚΑ ή HMVO — αυτό το κάνει το εμπορικό πρόγραμμα του φαρμακείου.
Το κύκλωμα είναι καθαρά ενημερωτικό για τον φαρμακοποιό.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.deps import TenantContext, require
from app.repositories.advance_dispensings import AdvanceDispensingRepository

logger = logging.getLogger(__name__)

router = APIRouter()
_MODULE = "advance_dispensing"
_PERM = "patients:read"


def _repo(ctx: TenantContext) -> AdvanceDispensingRepository:
    return AdvanceDispensingRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)


class ItemIn(BaseModel):
    name: str | None = None
    eof_code: str | None = None
    barcode: str | None = None       # κουπόνι ΕΟΦ (13ψήφιο «280…») ή κανονικό barcode προϊόντος
    gtin: str | None = None          # από το 2D barcode του κουτιού
    batch: str | None = None         # παρτίδα του 2D
    strip: str | None = None         # ταινία γνησιότητας / σειριακό
    lot: str | None = None           # για σκευάσματα χωρίς QR
    expiry: str | None = None
    qty: int = 1
    raw: str | None = None           # το ακατέργαστο σκανάρισμα (ξαναδιαβάζεται στον server)


class LoanIn(BaseModel):
    # Ο πελάτης ΕΠΙΛΕΓΕΤΑΙ από τη λίστα: με ελεύθερο κείμενο, «Κυρία Μαρία» και «ΜΑΡΙΑ Κ.»
    # γίνονται δύο διαφορετικοί οφειλέτες και το χρέος δεν βρίσκεται ποτέ ξανά.
    patient_name: str
    patient_ref: str
    amka: str | None = None
    items: list[ItemIn] = []
    note: str = ""
    expected_at: str | None = None      # YYYY-MM-DD — πότε θα φέρει τη συνταγή


@router.get("")
async def list_loans(status_f: str = Query("open", alias="status"),
                     q: str | None = Query(None),
                     limit: int = Query(100, ge=1, le=500),
                     ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Τα δανεικά του φαρμακείου. `status`: open | cleared | written_off | all."""
    query: dict = {} if status_f == "all" else {"status": status_f}
    if q and q.strip():
        import re as _re
        query["patient_name"] = {"$regex": _re.escape(q.strip()), "$options": "i"}
    items = await _repo(ctx).find(query, sort=[("created_at", -1)], limit=limit)
    for it in items:
        it["_id"] = str(it["_id"])
    return {"items": items}


@router.get("/history")
async def history(kind: str = Query("all", pattern="^(all|cleared|written_off)$"),
                  q: str | None = None, product: str | None = None, code: str | None = None,
                  date_from: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                  date_to: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                  by: str | None = None,
                  via: str | None = Query(None, pattern="^(prescription|manual|write_off)$"),
                  ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ιστορικό ξεχρεώσεων ανά σκεύασμα, με φίλτρα (πελάτης/ΑΜΚΑ, σκεύασμα, κωδικός QR/ταινίας,
    ξεχρέωση ή διαγραφή χρέους, περίοδος κλεισίματος, χρήστης)."""
    from app.repositories.base import jsonsafe
    res = await _repo(ctx).history(kind=kind, q=q, product=product, code=code,
                                   date_from=date_from, date_to=date_to, by=by, via=via)
    if ctx.demo:
        from app.utils.masking import mask_amka, mask_name
        for r in res["items"]:
            r["patient_name"], r["amka"] = mask_name(r.get("patient_name"), True), mask_amka(r.get("amka"), True)
    return jsonsafe(res)


@router.get("/patients")
async def search_patients(q: str = Query(..., min_length=2),
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Αναζήτηση πελάτη για χρέωση δανεικού.

    ΓΙΑΤΙ ΕΔΩ ΚΑΙ ΟΧΙ ΤΟ `/patients/search`: εκείνο απαιτεί το module «Ασφαλισμένοι». Όποιος
    αγόρασε ΜΟΝΟ τις Προχορηγήσεις θα έπαιρνε 403 και το πεδίο δεν θα έβρισκε ποτέ κανέναν.
    Ίδιο αποθετήριο, ίδια δεδομένα — απλώς περνάει από το δικό του πρόσθετο.
    """
    from app.repositories.patients import PatientExecutionsRepository
    repo = PatientExecutionsRepository(tenant_id=ctx.tenant_id, demo=ctx.demo)
    return {"items": await repo.search(q)}


@router.get("/for-patient")
async def for_patient(ref: str = Query(..., min_length=1),
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Τα ανοιχτά δανεικά ενός πελάτη — το καταναλώνει η καρτέλα πελάτη & το pop-up ταμείου."""
    items = await _repo(ctx).open_for_patient(ref)
    return {"items": items, "count": len(items)}


@router.get("/due-today")
async def due_today(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ποιοι είπαν ότι θα φέρουν συνταγή σήμερα (ή το είχαν πει για νωρίτερα)."""
    from datetime import date
    items = await _repo(ctx).due_today(date.today().isoformat())
    return {"items": items, "count": len(items)}


@router.get("/overdue")
async def overdue(ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Δανεικά που ανοίγουν πάνω από 30 ημέρες — υπενθύμιση, όχι προθεσμία."""
    res = await _repo(ctx).overdue()
    for it in res["items"]:
        it["_id"] = str(it["_id"])
    return res


@router.get("/matches")
async def matches(days: int = Query(45, ge=1, le=365),
                  ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """ΠΡΟΤΑΣΕΙΣ ξεχρέωσης — όχι αυτόματη πράξη.

    Το `strip` ΔΕΝ είναι μοναδικό (μετρημένο: 15% επαναλαμβάνονται), οπότε μια αυτόματη
    ξεχρέωση θα έσβηνε χρέος που υπάρχει. Ο φαρμακοποιός βλέπει ΓΙΑΤΙ ταιριάζει και αποφασίζει.
    """
    return {"items": await _repo(ctx).matches(days=days)}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_loan(body: LoanIn,
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    try:
        return await _repo(ctx).create(
            patient_name=body.patient_name, patient_ref=body.patient_ref, amka=body.amka,
            items=[i.model_dump() for i in body.items], note=body.note, by=ctx.user_id,
            expected_at=body.expected_at)
    except ValueError as e:
        msg = {"patient_ref_required": "Διάλεξε πελάτη από τη λίστα.",
               "items_required": "Σάρωσε ή γράψε τουλάχιστον ένα σκεύασμα.",
               "corrupt_scan": "Ένα σκανάρισμα ήρθε κομμένο — αφαίρεσέ το και σκάναρε ξανά το κουτί.",
               "lot_needs_eof_coupon": "Σκάναρες LOT ταινίας χωρίς το κουπόνι ΕΟΦ (13ψήφιο, 280…). "
                                       "Σκάναρε και το κουπόνι του ίδιου κουτιού."}.get(str(e), "")
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"error": str(e), "message": msg}) from e


class ScanIn(BaseModel):
    raw: str
    typed: str | None = None     # ό,τι έφτασε στο κουτάκι κειμένου (για διάγνωση: ο browser χάνει πλήκτρα;)
    check: bool = False          # από τον «Έλεγχο σαρωτή»


@router.post("/parse-scan")
async def parse_scan(body: ScanIn, ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """ΕΝΑΣ αναγνώστης QR φαρμάκου (services/gs1_scan): πεδία + όνομα από το GTIN + τι σαρωτή έχει το
    φαρμακείο (διαχωριστής/πληκτρολόγιο). Πλήρες σκανάρισμα → η εφαρμογή «μαθαίνει» τον σαρωτή."""
    from app.services import gs1_scan
    c = gs1_scan.classify(body.raw)
    p = c.get("qr") or ({"corrupt": True} if c["kind"] == "corrupt" else None)
    if body.check or (body.typed and body.typed.strip() != body.raw.strip()):
        # η σελίδα έπιασε στο keydown ΑΛΛΟ από ό,τι έφτασε στο πεδίο → εδώ φαίνεται αν «σώσαμε» το σκανάρισμα
        logger.warning("parse-scan capture tenant=%s check=%s kind=%s raw=%r typed=%r", ctx.tenant_id,
                       body.check, c["kind"], body.raw[:200], (body.typed or "")[:200])
    if c["kind"] in ("eof_code", "eof_lot", "intangible", "other"):
        # ΟΧΙ QR (κανόνας ιδιοκτήτη 22/10/2026): κουπόνι ΕΟΦ, LOT ταινίας, άυλο ΕΔΑΠΥ ή άλλος κωδικός.
        # Το ζευγάρωμα κουπονιού↔LOT (με οποιαδήποτε σειρά) το κάνει η οθόνη· εδώ: ΤΙ είναι + όνομα.
        code = c["code"]
        item: dict = {"raw": body.raw[:200], "name": ""}
        if c["kind"] in ("eof_code", "other"):
            item["barcode"] = code
            named = await _repo(ctx).name_for_barcode(code)
            if named:
                item["name"], item["eof_code"] = named["name"], named.get("eof_code")
        else:                                        # LOT ταινίας / άυλο: μοναδικό ανά κουτί
            item["strip"] = item["lot"] = code
        return {"ok": True, "kind": c["kind"], "item": item}
    if p.get("corrupt"):
        # το ακατέργαστο κείμενο στο log: «κομμένο» σκανάρισμα δεν αποθηκεύεται πουθενά αλλού
        logger.warning("parse-scan corrupt tenant=%s raw=%r", ctx.tenant_id, body.raw[:200])
        return {"ok": False, "kind": "corrupt"}     # κομμένο σκανάρισμα → «σκάναρε ξανά»
    repo = _repo(ctx)
    named = await repo.name_for_gtin(p["gtin"]) if p.get("gtin") else None
    if p.get("complete"):
        await repo.learn_scanner(p["scanner"])
    return {"ok": True, "kind": "gs1", "item": {
        "gtin": p["gtin"], "expiry": p.get("expiry"), "batch": p.get("batch"),
        "strip": p.get("serial"), "lot": p.get("serial"), "raw": body.raw[:200],
        "name": (named or {}).get("name") or "", "eof_code": (named or {}).get("eof_code")},
        "complete": p.get("complete"), "scanner": p["scanner"]}


class ItemStatusIn(BaseModel):
    status: str                      # cleared | open


@router.post("/{loan_id}/items/{idx}/status")
async def set_item_status(loan_id: str, idx: int, body: ItemStatusIn,
                          ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ξεχρέωση ΑΝΑ ΣΚΕΥΑΣΜΑ (όταν ξεχρεωθούν όλα, κλείνει και το δανεικό)."""
    if body.status not in ("cleared", "open"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"error": "bad_status"})
    r = await _repo(ctx).set_item_status(loan_id, idx, body.status, by=ctx.user_id)
    if not r.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"error": "not_found"})
    return r


@router.post("/{loan_id}/items/{idx}/rescan")
async def rescan_item(loan_id: str, idx: int, body: ScanIn,
                      ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ξανασκανάρισμα κουτιού με ελλιπή ανάγνωση — μόνο για το ΙΔΙΟ φάρμακο (ίδιο GTIN)."""
    return await _repo(ctx).rescan_item(loan_id, idx, body.raw)


class ClearFromRxIn(BaseModel):
    idxs: list[int]
    execution_id: str | None = None
    external_id: str | None = None


@router.post("/{loan_id}/items/clear-from-prescription")
async def clear_from_prescription(loan_id: str, body: ClearFromRxIn,
                                  ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Επιβεβαίωση πρότασης: ξεχρεώνει ΜΟΝΟ τα σκευάσματα που ταίριαξαν με τη συνταγή."""
    r = await _repo(ctx).clear_items_from_prescription(
        loan_id, body.idxs, by=ctx.user_id, execution_id=body.execution_id, external_id=body.external_id)
    if not r.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"error": "not_found"})
    return r


class ItemNameIn(BaseModel):
    name: str


@router.post("/{loan_id}/items/{idx}/name")
async def set_item_name(loan_id: str, idx: int, body: ItemNameIn,
                        ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    if not await _repo(ctx).set_item_name(loan_id, idx, body.name):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"error": "not_found"})
    return {"ok": True}


class ExpectedIn(BaseModel):
    expected_at: str | None = None


@router.post("/{loan_id}/expected")
async def set_expected(loan_id: str, body: ExpectedIn,
                       ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ορισμός ημερομηνίας που ο πελάτης θα φέρει τη συνταγή."""
    n = await _repo(ctx).set_expected(loan_id, body.expected_at)
    if not n:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"error": "not_found"})
    return {"ok": True, "expected_at": body.expected_at}


class StatusIn(BaseModel):
    status: str                      # cleared | written_off | open
    reason: str = ""
    execution_id: str | None = None   # ξεχρέωση ΑΠΟ ΣΥΝΤΑΓΗ (πρόταση) → καταγράφεται ποια
    external_id: str | None = None


@router.post("/{loan_id}/status")
async def set_status(loan_id: str, body: StatusIn,
                     ctx: TenantContext = Depends(require(_PERM, module=_MODULE))):
    """Ξεχρέωση, διαγραφή χρέους, ή επαναφορά αν πατήθηκε κατά λάθος."""
    if body.status not in ("cleared", "written_off", "open"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"error": "bad_status"})
    if body.status == "written_off" and not body.reason.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"error": "reason_required",
                                    "message": "Γράψε γιατί διαγράφεται το χρέος."})
    n = await _repo(ctx).set_status(loan_id, body.status, by=ctx.user_id, reason=body.reason,
                                    execution_id=body.execution_id or None, external_id=body.external_id or None)
    if not n:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"error": "not_found"})
    return {"ok": True, "status": body.status}
