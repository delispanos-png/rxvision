"""Εισαγωγή αρχείων εκτέλεσης ΓεΣΥ (XML ή ZIP με XML) στο κυπριακό φαρμακείο.

Σειρά για ΚΑΘΕ αρχείο: parse → έλεγχος ότι ανήκει σε ΑΥΤΟ το φαρμακείο → ψευδώνυμο ταυτότητας →
αποθήκευση (χωρίς διπλά). Ένα κακό αρχείο ΔΕΝ σταματά τα υπόλοιπα· επιστρέφεται στη λίστα σφαλμάτων.

ΦΥΛΑΚΑΣ ΦΑΡΜΑΚΕΙΟΥ: το πρώτο έγκυρο αρχείο «δένει» το φαρμακείο με τον κωδικό παρόχου ΓεΣΥ
(`DispensingProviderId`, π.χ. C2559) στο `tenants.settings.cy_provider_id`. Από εκεί και πέρα, αρχείο
άλλου παρόχου απορρίπτεται — δεδομένα ενός φαρμακείου δεν μπαίνουν ποτέ σε άλλο.
"""

from __future__ import annotations

import hashlib
import io
import json
import posixpath
import zipfile
from typing import Any

from app.core.db import shared_db
from app.repositories.cy import CyDispensingRepository, CyPatientRepository
from app.services.cy.parser import MAX_XML_BYTES, CyParseError, parse_dispensing
from app.utils.anonymization import pseudonymize

MAX_FILES = 5000
MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_ERRORS_REPORTED = 50


class CyImportError(ValueError):
    pass


def expand(files: list[tuple[str, bytes]]) -> list[tuple[str, bytes]]:
    """XML περνούν ως έχουν· τα ZIP ανοίγουν (με όρια μεγέθους/πλήθους — zip bomb)."""
    out: list[tuple[str, bytes]] = []
    total = 0
    for name, data in files:
        if name.lower().endswith(".zip") or data[:2] == b"PK":
            try:
                zf = zipfile.ZipFile(io.BytesIO(data))
            except zipfile.BadZipFile as exc:
                raise CyImportError(f"{name}: δεν είναι έγκυρο ZIP") from exc
            for info in zf.infolist():
                if info.is_dir() or not info.filename.lower().endswith(".xml"):
                    continue
                if info.file_size > MAX_XML_BYTES:
                    out.append((posixpath.basename(info.filename), b""))  # θα απορριφθεί με μήνυμα
                    continue
                total += info.file_size
                if total > MAX_TOTAL_BYTES or len(out) >= MAX_FILES:
                    raise CyImportError("πάρα πολλά αρχεία σε ένα ανέβασμα — χώρισέ τα σε μικρότερα")
                out.append((posixpath.basename(info.filename), zf.read(info)))
        else:
            total += len(data)
            if total > MAX_TOTAL_BYTES or len(out) >= MAX_FILES:
                raise CyImportError("πάρα πολλά αρχεία σε ένα ανέβασμα — χώρισέ τα σε μικρότερα")
            out.append((name, data))
    return out


async def _provider_of(tenant_id: str) -> str | None:
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"settings.cy_provider_id": 1})
    return ((t or {}).get("settings") or {}).get("cy_provider_id")


async def _bind_provider(tenant_id: str, provider_id: str) -> None:
    await shared_db()["tenants"].update_one(
        {"_id": tenant_id, "settings.cy_provider_id": {"$in": [None, ""]}},
        {"$set": {"settings.cy_provider_id": provider_id}})


def content_hash(parsed: dict) -> str:
    """Αποτύπωμα του περιεχομένου που ΜΕΤΡΑΕΙ (γραμμές, ποσότητες, ποσά) — για να ξεχωρίζει μια
    διόρθωση της ίδιας εκτέλεσης από ένα απλό ξανά-ανέβασμα."""
    core = {"t": parsed["totals"], "k": parsed["kind"], "l": [
        [ln["line_id"], ln.get("code"), ln.get("barcode"), ln["instance"], ln["instances"],
         ln["qty_presc"], ln["qty_disp"], ln["amounts"]] for ln in parsed["lines"]]}
    return hashlib.sha256(json.dumps(core, sort_keys=True, default=str).encode()).hexdigest()


def to_document(parsed: dict, patient_ref: str) -> dict[str, Any]:
    """Η μορφή αποθήκευσης: ΧΩΡΙΣ ταυτότητα, χωρίς ονόματα ασθενή (ζουν μόνο στο cy_patients)."""
    d = parsed["doctor"]
    return {
        "dispensing_id": parsed["dispensing_id"],
        "prescription_id": parsed["prescription_id"],
        "visit_id": parsed["visit_id"],
        "kind": parsed["kind"],
        "provider_id": parsed["provider_id"],
        "dispensed_at": parsed["dispensed_at"],
        "effective_date": parsed["effective_date"],
        "patient_ref": patient_ref,
        "doctor": {"id": d["id"], "name": f"{d['first_name']} {d['last_name']}".strip() or None,
                   "phones": d["phones"]},
        "user": parsed["user"],
        "instance": parsed["instance"],
        "instances": parsed["instances"],
        "closes_prescription": parsed["closes_prescription"],
        "lines": parsed["lines"],
        "totals": parsed["totals"],
        "parse_version": parsed["parse_version"],
        "content_hash": content_hash(parsed),
    }


async def import_files(tenant_id: str, files: list[tuple[str, bytes]], *,
                       pepper: str | None = None) -> dict[str, Any]:
    if pepper is None:
        from app.services.vault_service import vault
        pepper = vault.tenant_pepper(tenant_id)
    items = expand(files)
    disp = CyDispensingRepository(tenant_id=tenant_id)
    pats = CyPatientRepository(tenant_id=tenant_id)
    provider = await _provider_of(tenant_id)

    counts = {"new": 0, "updated": 0, "duplicate": 0, "stale": 0}
    errors: list[dict[str, str]] = []
    for name, data in items:
        try:
            p = parse_dispensing(data)
        except CyParseError as exc:
            errors.append({"file": name, "error": str(exc)})
            continue
        if provider is None and p["provider_id"]:
            await _bind_provider(tenant_id, p["provider_id"])
            provider = await _provider_of(tenant_id)
        if provider and p["provider_id"] != provider:
            errors.append({"file": name,
                           "error": f"ανήκει σε άλλο φαρμακείο ({p['provider_id']}), όχι στο {provider}"})
            continue
        p.pop("national_id", None)
        ref = pseudonymize(p.pop("patient_key"), tenant_pepper=pepper)
        id_ref = pseudonymize(p.pop("id_key"), tenant_pepper=pepper)
        outcome = await disp.save(to_document(p, ref))
        counts[outcome] += 1
        if outcome in ("new", "updated"):
            await pats.upsert(ref, p["patient"], p["dispensed_at"], id_ref=id_ref)
    return {"files": len(items), "imported": counts["new"], "updated": counts["updated"],
            "duplicates": counts["duplicate"] + counts["stale"],
            "failed": len(errors), "errors": errors[:MAX_ERRORS_REPORTED], "provider_id": provider}
