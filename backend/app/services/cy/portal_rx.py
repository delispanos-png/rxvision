"""RxVision Κύπρος: οι συνταγές του πελάτη στην ΠΥΛΗ (my.rxvision.gr), στα ΙΔΙΑ σχήματα με την Ελλάδα.

Η ελληνική πύλη (Αρχική, Συνταγές με λεπτομέρεια, Επαναλήψεις, Ανεκτέλεστα) διαβάζει από το
`PatientRxRepository` / `AdvisorRepository.recall_detail`. Για λογαριασμό ΓεΣΥ τα ίδια endpoints περνούν
από εδώ και επιστρέφουν τα ΙΔΙΑ πεδία — έτσι η πύλη δουλεύει αυτούσια, χωρίς δεύτερη οθόνη.

Αντιστοίχιση:
  εκτέλεση (barcode)        = cy_dispensings.dispensing_id
  συνταγή / αλυσίδα          = prescription_id   (επανάληψη k/N = instance/instances)
  επόμενη επίσκεψη           = `chains.chains` (ΙΔΙΟΣ ορισμός με την πλευρά του φαρμακείου)
  πλήρωσε / κάλυψε ο ΟΑΥ     = totals.beneficiary / totals.hio
  «Ανεκτέλεστα»              = αλυσίδες που είναι διαθέσιμες ΤΩΡΑ (κατάσταση soon/late)
Όσα δεν υπάρχουν στο ΓεΣΥ (ICD-10, ειδικότητα ιατρού) επιστρέφονται κενά — ποτέ εκτίμηση.
"""

from __future__ import annotations

from typing import Any

from app.repositories.base import jsonsafe
from app.repositories.cy import CyDispensingRepository, find_all
from app.services.cy import chains as cy_chains
from app.services.cy.meds import _dosage_text
from app.utils.masking import mask_name, set_given_name_first

OPEN_NOW = ("soon", "late")      # «διαθέσιμη τώρα» για τα Ανεκτέλεστα


def _doc(name: str | None, demo: bool) -> str | None:
    if demo and name:
        set_given_name_first(True)        # Κύπρος: «ΟΝΟΜΑ ΕΠΙΘΕΤΟ» → κρύβεται το επίθετο
        return mask_name(name, True)
    return name


def _given(ln: dict) -> int:
    return int(ln.get("qty_disp") or 0)


def _open_chains(cs: list[dict]) -> dict[str, dict]:
    """Ανοιχτές αλυσίδες (όχι κλειστές/χαμένες) ανά συνταγή."""
    return {c["prescription_id"]: c for c in cs if c["status"] not in ("closed", "lost")}


def _row(d: dict, nxt: dict[str, dict], last_of: dict[str, str], demo: bool) -> dict[str, Any]:
    lines = d.get("lines") or []
    c = nxt.get(d.get("prescription_id"))
    latest = last_of.get(d.get("prescription_id")) == d.get("dispensing_id")
    return {
        "barcode": str(d.get("dispensing_id")), "executed_at": d.get("dispensed_at"), "status": "executed",
        "patient_share": int((d.get("totals") or {}).get("beneficiary") or 0),
        "repeat_current": int(d.get("instance") or 1), "repeat_total": int(d.get("instances") or 1),
        "repeat_root": d.get("prescription_id"),
        "next_open_date": c["next_due"] if (c and latest) else None,
        "icd10": [], "doctor": _doc((d.get("doctor") or {}).get("name"), demo), "specialty": None,
        "partial": any(_given(ln) < int(ln.get("qty_presc") or 0) for ln in lines),
        "medicines": [ln.get("description") or "Φάρμακο" for ln in lines],
        "pending": [ln.get("description") or "Φάρμακο" for ln in lines if _given(ln) == 0],
    }


async def _context(tenant_id: str, pseudo: str) -> tuple[list[dict], dict[str, dict], dict[str, str]]:
    rows = await find_all(CyDispensingRepository(tenant_id=tenant_id), {"patient_ref": pseudo},
                          sort=[("dispensed_at", -1)])
    last_of: dict[str, str] = {}
    for d in rows:                                    # ταξινομημένα νεότερα πρώτα → η 1η ανά συνταγή
        last_of.setdefault(d.get("prescription_id"), d.get("dispensing_id"))
    nxt = _open_chains(await cy_chains.chains(tenant_id, match={"patient_ref": pseudo}))
    return rows, nxt, last_of


async def prescriptions(tenant_id: str, pseudo: str | None, *, demo: bool = False,
                        limit: int = 200) -> list[dict]:
    """Σχήμα `PatientRxRepository.my_prescriptions` — μία γραμμή ανά εκτέλεση ΓεΣΥ."""
    if not pseudo:
        return []
    rows, nxt, last_of = await _context(tenant_id, pseudo)
    return jsonsafe([_row(d, nxt, last_of, demo) for d in rows[:limit]])


async def detail(tenant_id: str, pseudo: str | None, barcode: str, *, demo: bool = False) -> dict | None:
    """Σχήμα `my_prescription_detail`. Το `barcode` είναι εκτέλεση (dispensing_id) — ή, από τις
    Επαναλήψεις, συνταγή (prescription_id) → η πιο πρόσφατη εκτέλεσή της."""
    if not pseudo:
        return None
    rows, nxt, last_of = await _context(tenant_id, pseudo)
    bc = str(barcode).split(":")[0]
    d = next((r for r in rows if str(r.get("dispensing_id")) == bc), None) \
        or next((r for r in rows if str(r.get("prescription_id")) == bc), None)
    if not d:
        return None
    out = _row(d, nxt, last_of, demo)
    items = []
    for ln in d.get("lines") or []:
        given = _given(ln)
        items.append({
            "name": ln.get("description"), "barcode": ln.get("barcode"),
            "quantity": int(ln.get("qty_presc") or given or 1),
            "retail_price": int((ln.get("amounts") or {}).get("total") or 0),
            "is_executed": given > 0, "executed_qty": given,
            "dosage": _dosage_text(ln.get("dosage") or {}), "details": {},
        })
    # Βίντεο οδηγιών χρήσης του είδους (όπως στην Ελλάδα) — ίδια πηγή: `product_video_map`
    from app.core.db import shared_db
    from app.repositories.patient_portal import product_video_map
    vmap = await product_video_map(shared_db(), tenant_id, [i.get("barcode") for i in items])
    for i in items:
        i["usage_video_url"] = vmap.get(str(i.get("barcode") or "").strip()) if i.get("barcode") else None
    out.update({"amount_total": int((d.get("totals") or {}).get("total") or 0), "details": {}, "items": items})
    return jsonsafe(out)


async def summary(tenant_id: str, pseudo: str | None) -> dict:
    """Σχήμα `PatientRxRepository.summary` (Αρχική πύλης)."""
    out: dict[str, Any] = {"rx_count": 0, "paid_cents": 0, "covered_cents": 0, "total_cents": 0, "doctors": 0,
                           "medicines": 0, "repeats_active": 0, "next_open_date": None,
                           "first_at": None, "last_at": None}
    if not pseudo:
        return out
    rows, nxt, _ = await _context(tenant_id, pseudo)
    if rows:
        tot = [d.get("totals") or {} for d in rows]
        out.update({
            "rx_count": len(rows),
            "paid_cents": sum(int(t.get("beneficiary") or 0) for t in tot),
            "total_cents": sum(int(t.get("total") or 0) for t in tot),
            "covered_cents": sum(int(t.get("hio") or 0) for t in tot),
            "doctors": len({(d.get("doctor") or {}).get("id") or (d.get("doctor") or {}).get("name")
                            for d in rows} - {None, ""}),
            "medicines": len({ln.get("code") or ln.get("description") for d in rows for ln in d.get("lines") or []
                              if _given(ln) > 0} - {None, ""}),
            "first_at": rows[-1].get("dispensed_at"), "last_at": rows[0].get("dispensed_at"),
        })
    fut = _future(nxt)
    out["repeats_active"] = len(fut)
    out["next_open_date"] = min((c["next_due"] for c in fut), default=None)
    return jsonsafe(out)


def _future(nxt: dict[str, dict]) -> list[dict]:
    """Επόμενες επισκέψεις από σήμερα και μετά (ίδια λογική με την Ελλάδα: ποτέ «ανοίγει» στο παρελθόν)."""
    return [c for c in nxt.values() if c["days_to_due"] >= 0]


async def repeats(tenant_id: str, pseudo: str | None) -> list[dict]:
    """Σχήμα `PatientRxRepository.my_repeats` — ανοιχτές συνταγές με επόμενη επίσκεψη."""
    if not pseudo:
        return []
    rows, nxt, last_of = await _context(tenant_id, pseudo)
    by_disp = {d.get("dispensing_id"): d for d in rows}
    out = []
    for c in sorted(_future(nxt), key=lambda c: c["next_due"]):
        last = by_disp.get(last_of.get(c["prescription_id"])) or {}
        out.append({
            "barcode": str(c["prescription_id"]), "next_open_date": c["next_due"],
            "repeat_current": c["instance"], "repeat_total": c["instances"],
            "medicines": [{"name": ln.get("description") or "Φάρμακο", "dosage": _dosage_text(ln.get("dosage") or {})}
                          for ln in last.get("lines") or []],
        })
    return jsonsafe(out)


async def renewals(tenant_id: str, pseudo: str | None, intents: dict[str, dict], *,
                   demo: bool = False) -> list[dict]:
    """Σχήμα του `/patient/renewals`: συνταγές που μπορούν να εκτελεστούν ΤΩΡΑ (soon/late). Το «θα το
    πάρω / δεν θα το πάρω» γράφεται από το κοινό `/renewals/respond` (κλειδί = αριθμός συνταγής)."""
    if not pseudo:
        return []
    cs = [c for c in await cy_chains.chains(tenant_id, match={"patient_ref": pseudo}) if c["status"] in OPEN_NOW]
    out = []
    for c in sorted(cs, key=lambda c: c["next_due"]):
        it = intents.get(str(c["prescription_id"]))
        out.append({
            "key": str(c["prescription_id"]), "medicine": " · ".join(c["items"]) or None,
            "doctor": {"name": _doc(c.get("doctor"), demo)} if c.get("doctor") else None,
            "available": 1, "since": c["next_due"],
            "intent": {"decision": it.get("decision"), "visit_date": it.get("visit_date"),
                       "reason": it.get("reason")} if it else None,
        })
    return out
