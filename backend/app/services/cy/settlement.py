"""RxVision Κύπρος: «Εκκαθάριση ΟΑΥ» — τα αρχεία που λαμβάνει ο φαρμακοποιός κάθε μήνα από τον ΟΑΥ.

ΓΙΑΤΙ (20/11/2026): ο ΟΑΥ πληρώνει τα φάρμακα ΣΤΗ ΧΟΝΔΡΙΚΗ (98% των γραμμών: ποσό XML = χονδρική + ΦΠΑ),
άρα το κέρδος του φαρμακείου στο ΓεΣΥ είναι η ΑΜΟΙΒΗ ΑΝΑ ΣΥΣΚΕΥΑΣΙΑ (σύστημα μονάδων, τιμή μονάδας που
αλλάζει κάθε μήνα) + εφημερίες — ΤΙΠΟΤΑ από αυτά δεν υπάρχει στο XML. Τα παίρνουμε από τα αρχεία του ΟΑΥ:

  - «Αμοιβή Φαρμακοποιού» (PDF «ΜΟΝΑΔΑ ΓΕΣΥ»): μήνας, τιμή μονάδας, συσκευασίες, αμοιβή.
  - «Κατάσταση πληρωμής / Remittance advice» (PDF): ημερήσιες απαιτήσεις, αμοιβή, εφημερίες, διορθώσεις.
  - «Πληρωμένες απαιτήσεις» (Excel): ανά εκτέλεση — συσκευασίες, ΟΑΥ, συμμετοχή, PC II, σύνολο, ΦΠΑ.
  - «Εγκεκριμένο» / «Μερικώς εκτελεσμένη» (Excel): απαιτήσεις που ΔΕΝ πληρώθηκαν ακόμα.

Το είδος του αρχείου αναγνωρίζεται από το ΠΕΡΙΕΧΟΜΕΝΟ (όχι από το όνομα). ΔΕΝ αποθηκεύονται ονόματα πελατών,
γιατρών ή ταυτότητες — μόνο αριθμοί εκτέλεσης και ποσά (ό,τι χρειάζεται η συμφωνία).
Επαλήθευση με τα πραγματικά αρχεία 10/2026: 1.126/1.127 εκτελέσεις ταιριάζουν στο λεπτό σε όλα τα πεδία.
"""

from __future__ import annotations

import io
import re
from datetime import date, datetime, timezone
from typing import Any

from app.repositories.cy import CyDispensingRepository, CySettlementRepository, find_all

MAX_FILE_BYTES = 10 * 1024 * 1024


class CySettlementError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _cents(s: Any) -> int | None:
    """«3,921.60 €» · «-.70» · 1.6 → λεπτά."""
    if s is None or s == "":
        return None
    if isinstance(s, (int, float)):
        return round(float(s) * 100)
    t = str(s).replace("€", "").replace(",", "").replace(" ", "").strip()
    try:
        return round(float(t) * 100)
    except ValueError:
        return None


def _dmy(s: Any) -> str | None:
    """«30/10/2026» ή datetime → «2026-10-30»."""
    if isinstance(s, datetime):
        return s.date().isoformat()
    if isinstance(s, date):
        return s.isoformat()
    iso = re.match(r"\s*(\d{4})-(\d{2})-(\d{2})", str(s or ""))
    if iso:
        return f"{iso.group(1)}-{iso.group(2)}-{iso.group(3)}"
    m = re.match(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})", str(s or ""))
    return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}" if m else None


def _ids(v: Any) -> str | None:
    if isinstance(v, float):
        v = int(v)
    s = str(v or "").strip()
    return s if s.isdigit() else None


# ── ανάγνωση αρχείων ─────────────────────────────────────────────────────────

def _pdf_text(data: bytes) -> str:
    import pdfplumber
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        return "\n".join((p.extract_text() or "") for p in pdf.pages)


def parse_unit_pdf(text: str) -> dict[str, Any]:
    """«Αμοιβή Φαρμακοποιού»: Μήνας/Έτος + γραμμή «… 1.60 € 2451 3,921.60 €»."""
    mo = re.search(r"Μήνας:\s*(\d{1,2})", text)
    yr = re.search(r"Έτος:\s*(\d{4})", text)
    row = re.search(r"(\d{5,})\s+\S+\s+\S+\s+(\d{2}/\d{2}/\d{4}).*?([\d.,]+)\s*€\s+(\d+)\s+([\d.,]+)\s*€", text)
    if not (mo and yr and row):
        raise CySettlementError("unit_pdf_unreadable")
    price, packs, fee = _cents(row.group(3)), int(row.group(4)), _cents(row.group(5))
    return {"month": f"{yr.group(1)}-{int(mo.group(1)):02d}",
            "unit": {"invoice_id": row.group(1), "invoice_date": _dmy(row.group(2)), "price_cents": price,
                     "packages": packs, "fee_cents": fee,
                     # ο ΟΑΥ υπολογίζει αμοιβή = μονάδα × συσκευασίες· αν όχι, το λέμε (ποτέ σιωπηλή «διόρθωση»)
                     "consistent": price is not None and fee is not None and abs(price * packs - fee) <= 1}}


_REM_LINE = re.compile(r"^(\d{2}/\d{2}/\d{4})\s+(\S+)\s+(.+?)\s+(-?[\d,]*\.\d{2})\s+EUR\s+(-?[\d,]*\.\d{2})\s*$")


def parse_remittance_pdf(text: str) -> dict[str, Any]:
    """«Κατάσταση πληρωμής»: κάθε γραμμή τιμολογίου → απαίτηση / εφημερίες / διόρθωση."""
    pay = re.search(r"Payment Date:\s*(\d{2}/\d{2}/\d{4})", text)
    tot = re.search(r"Total paid in this batch:\s*(-?[\d,]*\.\d{2})", text)
    lines = []
    for ln in text.splitlines():
        m = _REM_LINE.match(ln.strip())
        if not m:
            continue
        desc = m.group(3).strip()
        key = re.sub(r"\s", "", desc).upper()
        kind = ("services" if "HCPSERVICES" in key else "duty" if "EFIMER" in key else "correction")
        lines.append({"date": _dmy(m.group(1)), "invoice": m.group(2), "description": desc, "kind": kind,
                      "cents": _cents(m.group(5)) or 0})
    if not lines or not tot:
        raise CySettlementError("remittance_unreadable")
    months = sorted({ln["date"][:7] for ln in lines if ln["kind"] == "services"} or {ln["date"][:7] for ln in lines})
    return {"month": months[-1],
            "remittance": {"payment_date": _dmy(pay.group(1)) if pay else None, "total_cents": _cents(tot.group(1)),
                           "lines": lines}}


def _rows(data: bytes) -> list[tuple]:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    return [r for ws in wb.worksheets[:1] for r in ws.iter_rows(values_only=True)]


def parse_paid_xlsx(rows: list[tuple]) -> dict[str, Any]:
    """«Πληρωμένες απαιτήσεις»: ανά εκτέλεση. Ονόματα/ταυτότητες ΔΕΝ διαβάζονται καν."""
    h = [str(c or "").strip().upper() for c in rows[0]]
    col = {k: h.index(k) for k in ("DISPENS. ID", "TYPE", "CLAIM DATE", "CO-PAYMENT", "PC II", "HIO REIMB.",
                                   "TOTAL AMT", "VAT *", "NO. OF PACKAGES") if k in h}
    if len(col) < 9:
        raise CySettlementError("paid_xlsx_columns")
    out = []
    for r in rows[1:]:
        did = _ids(r[col["DISPENS. ID"]])
        if not did:
            continue                                  # σύνολα / σημειώσεις στο τέλος του φύλλου
        out.append({"id": did, "kind": "consumable" if "CONSUM" in str(r[col["TYPE"]] or "").upper() else "drug",
                    "claim_date": _dmy(r[col["CLAIM DATE"]]), "copay": _cents(r[col["CO-PAYMENT"]]) or 0,
                    "pc2": _cents(r[col["PC II"]]) or 0, "hio": _cents(r[col["HIO REIMB."]]) or 0,
                    "total": _cents(r[col["TOTAL AMT"]]) or 0, "vat": _cents(r[col["VAT *"]]) or 0,
                    "packages": int(float(r[col["NO. OF PACKAGES"]] or 0))})
    if not out:
        raise CySettlementError("paid_xlsx_empty")
    return {"month": max(p["claim_date"] or "" for p in out)[:7], "paid": out}


def parse_status_xlsx(rows: list[tuple]) -> dict[str, Any]:
    """«Εγκεκριμένο» / «Μερικώς εκτελεσμένη»: απαιτήσεις που ΔΕΝ πληρώθηκαν ακόμα."""
    h = [str(c or "").strip() for c in rows[0]]
    try:
        ci, ck, cs, cd, cb, ch = (h.index("Αρ. Εκτελ. Συνταγής"), h.index("Κατάσταση"), h.index("Τύπος"),
                                  h.index("Ημερομηνία Εκτέλεσης"), h.index("Συμπλ. & Συνεισφ. ΙΙ"),
                                  h.index("Ενδ. Αμοιβη ΟΑΥ"))
    except ValueError:
        raise CySettlementError("status_xlsx_columns") from None
    out = []
    for r in rows[1:]:
        did = _ids(r[ci])
        if not did:
            continue
        st = str(r[ck] or "")
        out.append({"id": did, "status": "partial" if "Μερικ" in st else "approved",
                    "kind": "consumable" if "Αναλώσ" in str(r[cs] or "") else "drug", "date": _dmy(r[cd]),
                    "beneficiary": _cents(r[cb]) or 0, "hio": _cents(r[ch]) or 0})
    if not out:
        raise CySettlementError("status_xlsx_empty")
    return {"month": max(p["date"] or "" for p in out)[:7], "pending": out}


def parse_file(name: str, data: bytes) -> dict[str, Any]:
    """Αναγνώριση από το περιεχόμενο → {kind, month, …}."""
    if data[:4] == b"%PDF":
        text = _pdf_text(data)
        if "Αμοιβή Φαρμακοποιού" in text or "Τιμή Μονάδας" in text:
            return {"kind": "unit", **parse_unit_pdf(text)}
        if "REMITTANCE" in text.upper() or "ΚΑΤΑΣΤΑΣΗ ΠΛΗΡΩΜΗΣ" in text:
            return {"kind": "remittance", **parse_remittance_pdf(text)}
        raise CySettlementError("unknown_pdf")
    if data[:2] == b"PK":
        rows = _rows(data)
        if not rows:
            raise CySettlementError("empty_xlsx")
        head = " ".join(str(c or "") for c in rows[0]).upper()
        if "DISPENS. ID" in head and "NO. OF PACKAGES" in head:
            return {"kind": "paid", **parse_paid_xlsx(rows)}
        if "ΑΡ. ΕΚΤΕΛ. ΣΥΝΤΑΓΉΣ" in head or "ΑΡ. ΕΚΤΕΛ. ΣΥΝΤΑΓΗΣ" in head:
            return {"kind": "pending", **parse_status_xlsx(rows)}
        raise CySettlementError("unknown_xlsx")
    raise CySettlementError("unsupported_file")


# ── αποθήκευση ───────────────────────────────────────────────────────────────

async def import_files(tenant_id: str, files: list[tuple[str, bytes]], *, by: str | None = None) -> dict[str, Any]:
    """Κάθε αρχείο ενημερώνει ΤΟ ΔΙΚΟ ΤΟΥ κομμάτι του μήνα (ξανά-ανέβασμα = αντικατάσταση, όχι διπλό).
    Τα αρχεία ενός μήνα μπορούν να ανέβουν μαζί ή χωριστά. Ο «μήνας» = μήνας πληρωμής του ΟΑΥ."""
    repo = CySettlementRepository(tenant_id=tenant_id)
    parsed, errors = [], []
    for name, data in files:
        try:
            parsed.append((name, parse_file(name, data)))
        except CySettlementError as exc:
            errors.append({"file": name, "error": str(exc)})
        except Exception:                                    # χαλασμένο αρχείο — ποτέ 500
            errors.append({"file": name, "error": "unreadable"})
    # Ο μήνας της αμοιβής (PDF μονάδας) υπερισχύει: τα Excel της ίδιας αποστολής ανήκουν σε αυτόν.
    anchor = next((p["month"] for _, p in parsed if p["kind"] == "unit"), None) \
        or next((p["month"] for _, p in parsed if p["kind"] == "remittance"), None)
    done = []
    for name, p in parsed:
        month = anchor or p["month"]
        if not re.fullmatch(r"\d{4}-\d{2}", month or ""):
            errors.append({"file": name, "error": "no_month"})      # ποτέ εγγραφή σε «άγνωστο» μήνα
            continue
        upd: dict[str, Any] = {"updated_at": _now()}
        if p["kind"] == "unit":
            upd["unit"] = p["unit"]
        elif p["kind"] == "remittance":
            upd["remittance"] = p["remittance"]
        elif p["kind"] == "paid":
            upd["paid"] = p["paid"]
        else:                                               # pending: ένα αρχείο ανά κατάσταση
            st = p["pending"][0]["status"]
            upd[f"pending_{st}"] = p["pending"]
        await repo.update_one({"month": month}, {
            "$set": upd, "$setOnInsert": {"created_at": _now()},
            "$push": {"files": {"$each": [{"name": name[:120], "kind": p["kind"], "at": _now(), "by": by}],
                                "$slice": -30}}}, upsert=True)
        done.append({"file": name, "kind": p["kind"], "month": month})
    return {"imported": done, "errors": errors}


# ── αμοιβή ανά εκτέλεση (για την Κερδοφορία) ─────────────────────────────────

async def fee_book(tenant_id: str) -> dict[str, Any]:
    """{paid: {dispensing_id → τιμή μονάδας του μήνα που πληρώθηκε}, latest: {month, price}, months: {…}}."""
    rows = await CySettlementRepository(tenant_id=tenant_id).find({}, sort=[("month", 1)], limit=240)
    paid: dict[str, int] = {}
    months: dict[str, dict] = {}
    latest = None
    for s in rows:
        price = (s.get("unit") or {}).get("price_cents")
        rem = s.get("remittance") or {}
        months[s["month"]] = {
            "price_cents": price, "fee_cents": (s.get("unit") or {}).get("fee_cents"),
            "duty_cents": sum(ln["cents"] for ln in rem.get("lines") or [] if ln["kind"] == "duty"),
            "corrections_cents": sum(ln["cents"] for ln in rem.get("lines") or [] if ln["kind"] == "correction"),
            "has_remittance": bool(rem)}
        if price:
            latest = {"month": s["month"], "price_cents": price}
            for p in s.get("paid") or []:
                paid[p["id"]] = price
    return {"paid": paid, "latest": latest, "months": months}


def packages_of(d: dict) -> int:
    """Συσκευασίες μιας εκτέλεσης όπως τις μετρά ο ΟΑΥ = Σ QtyDisp (επαληθευμένο 1.126/1.126)."""
    return sum(int(ln.get("qty_disp") or 0) for ln in d.get("lines") or [] if (ln.get("qty_disp") or 0) > 0)


# ── συμφωνία (οθόνη «Εκκαθάριση ΟΑΥ») ────────────────────────────────────────

def _m(cents: int | None) -> int:
    return int(cents or 0)


async def months(tenant_id: str) -> list[dict[str, Any]]:
    rows = await CySettlementRepository(tenant_id=tenant_id).find({}, sort=[("month", -1)], limit=60)
    out = []
    for s in rows:
        u, rem = s.get("unit") or {}, s.get("remittance") or {}
        lines = rem.get("lines") or []
        out.append({"month": s["month"], "price_cents": u.get("price_cents"), "packages": u.get("packages"),
                    "fee_cents": u.get("fee_cents"),
                    "duty_cents": sum(ln["cents"] for ln in lines if ln["kind"] == "duty") if rem else None,
                    "corrections_cents": sum(ln["cents"] for ln in lines if ln["kind"] == "correction") if rem else None,
                    "paid_total_cents": rem.get("total_cents"), "payment_date": rem.get("payment_date"),
                    "has": {"unit": bool(u), "remittance": bool(rem), "paid": bool(s.get("paid")),
                            "pending": bool(s.get("pending_approved") or s.get("pending_partial"))}})
    return out


async def detail(tenant_id: str, month: str) -> dict[str, Any] | None:
    s = await CySettlementRepository(tenant_id=tenant_id).find_one({"month": month})
    if not s:
        return None
    u, rem = s.get("unit") or {}, s.get("remittance") or {}
    paid = s.get("paid") or []
    pending = (s.get("pending_approved") or []) + (s.get("pending_partial") or [])
    ids = [p["id"] for p in paid] + [p["id"] for p in pending]
    ours = {d["dispensing_id"]: d for d in await find_all(CyDispensingRepository(tenant_id=tenant_id),
                                                          {"dispensing_id": {"$in": ids}})} if ids else {}

    ok, diffs, missing = 0, [], []
    for p in paid:
        d = ours.get(p["id"])
        if not d:
            missing.append({"id": p["id"], "kind": p["kind"], "claim_date": p["claim_date"], "total": p["total"],
                            "hio": p["hio"], "packages": p["packages"]})
            continue
        t = d.get("totals") or {}
        mine = {"total": _m(t.get("total")), "hio": _m(t.get("hio")), "copay": _m(t.get("copay")),
                "pc2": _m(t.get("pc2")), "packages": packages_of(d)}
        bad = {k: {"ours": mine[k], "hio_file": p[k]} for k in mine if abs(mine[k] - p[k]) > 1}
        if bad:
            diffs.append({"id": p["id"], "kind": p["kind"], "claim_date": p["claim_date"], "fields": bad})
        else:
            ok += 1
    pend = [{**p, "found": p["id"] in ours} for p in pending]

    # Εκτελέσεις του μήνα (στο RxVision) που δεν εμφανίζονται ΠΟΥΘΕΝΑ στα αρχεία του ΟΑΥ (καμία κατάσταση).
    known = set(ids)
    for other in await CySettlementRepository(tenant_id=tenant_id).find({"month": {"$ne": month}}, limit=60):
        known |= {p["id"] for p in (other.get("paid") or [])}
        known |= {p["id"] for p in (other.get("pending_approved") or []) + (other.get("pending_partial") or [])}
    from app.services.cy.chains import TZ
    y, mo = int(month[:4]), int(month[5:7])
    lo = datetime(y, mo, 1, tzinfo=TZ)
    hi = datetime(y + (mo == 12), (mo % 12) + 1, 1, tzinfo=TZ)
    def _local(dt: datetime) -> str:
        return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(TZ).date().isoformat()

    unseen = [{"id": d["dispensing_id"], "date": _local(d["dispensed_at"]),
               "hio": _m((d.get("totals") or {}).get("hio")), "total": _m((d.get("totals") or {}).get("total")),
               "packages": packages_of(d)}
              for d in await find_all(CyDispensingRepository(tenant_id=tenant_id),
                                      {"dispensed_at": {"$gte": lo, "$lt": hi}, "totals.hio": {"$gt": 0}},
                                      sort=[("dispensed_at", 1)])
              if d["dispensing_id"] not in known]

    lines = rem.get("lines") or []
    services = [ln for ln in lines if ln["kind"] == "services"]
    fee_line = next((ln for ln in services if u.get("invoice_id") and ln["invoice"] == u.get("invoice_id")), None)
    paid_pk = sum(p["packages"] for p in paid)
    return {
        "month": month,
        "unit": u or None,
        "remittance": {"payment_date": rem.get("payment_date"), "total_cents": rem.get("total_cents"),
                       "claims_cents": sum(ln["cents"] for ln in services if ln is not fee_line),
                       "fee_cents": fee_line["cents"] if fee_line else None,
                       "duty_cents": sum(ln["cents"] for ln in lines if ln["kind"] == "duty"),
                       "corrections": [ln for ln in lines if ln["kind"] == "correction"],
                       "duty": [ln for ln in lines if ln["kind"] == "duty"]} if rem else None,
        "paid": {"count": len(paid), "packages": paid_pk, "hio_cents": sum(p["hio"] for p in paid),
                 "total_cents": sum(p["total"] for p in paid), "vat_cents": sum(p["vat"] for p in paid),
                 "copay_cents": sum(p["copay"] for p in paid), "pc2_cents": sum(p["pc2"] for p in paid),
                 # έλεγχος: οι συσκευασίες της λίστας = αυτές που πολλαπλασίασε ο ΟΑΥ;
                 "packages_match_unit": (paid_pk == u.get("packages")) if (paid and u) else None} if paid else None,
        "reconcile": {"ok": ok, "diffs": diffs[:200], "missing": missing[:200],
                      "pending": pend[:300], "unseen": unseen[:500], "unseen_count": len(unseen)},
        "files": [{"name": f.get("name"), "kind": f.get("kind"), "at": f.get("at")} for f in (s.get("files") or [])][-15:],
    }


async def delete_month(tenant_id: str, month: str) -> bool:
    r = await CySettlementRepository(tenant_id=tenant_id).delete_many({"month": month})
    return bool(r.deleted_count)
