"""Prescription closing checks (έλεγχος κλεισίματος συνταγών) — surfaces to the pharmacist which
lines need a manual/visual check before closing, since ΗΔΥΚΑ gives no single authoritative answer.

Overdose: ΗΔΥΚΑ checks overdose at PRESCRIBING for tablets/capsules/syrup/respiratory-ampoules OR
when overdoseMessageType == 'E'. Everything else → the pharmacist must check visually (compute the
doses the posology implies vs the pack content piecesPerPackage/dosePerPackage).
Special meds: desensitization vaccines, Ultra-Levure (parametric per pharmacy), special-opinion
restrictions (groupInfo), and high-value ΦΥΚ (> €3.000).
"""

from __future__ import annotations

import math
import re

from app.services import med_schedule as ms

# Ultra-Levure — unofficially no longer restricted (no ΦΕΚ) → pharmacist toggles the check per item.
ULTRA_LEVURE_BARCODES = {"2800697702014", "2800697701017", "2800697703011"}
FYK_HIGH_VALUE_CENTS = 300000   # €3.000


def _num(s):
    m = re.search(r"[\d.]+", str(s or "").replace(",", "."))
    try:
        return float(m.group()) if m else None
    except ValueError:
        return None


def _form_auto_checked(form_code: str | None, package_form: str | None, name: str | None) -> bool:
    """ΗΔΥΚΑ ελέγχει υπερδοσολογία στη συνταγογράφηση για: δισκία/ταμπλέτες/κάψουλες/σιρόπι/
    αναπνευστικές αμπούλες. Όλα τα υπόλοιπα → οπτικός έλεγχος από τον φαρμακοποιό."""
    f = (form_code or "").upper()
    n = (name or "").upper()
    if "TAB" in f or "CAP" in f or "ΔΙΣΚΙ" in n or "ΚΑΨΟΥΛ" in n or "ΤΑΜΠΛΕΤ" in n or "ΔΙΣΠ" in f:
        return True
    if "SYR" in f or "ΣΙΡΟΠ" in n or "SYRUP" in n or "POS" in f:           # σιρόπι / πόσιμο διάλυμα
        return True
    if "NEB" in f or ("ΑΜΠ" in n and ("ΑΝΑΠΝΕΥΣ" in n or "ΕΙΣΠΝ" in n or "NEB" in n)):
        return True
    return False


def _overdose_detail(item: dict, cat: dict) -> str:
    d = item.get("dose")
    freq = item.get("frequency")
    dur = item.get("duration")
    qty = item.get("quantity") or 1
    dose_amt = _num(d)
    plan = ms.frequency_plan(freq)
    per_day = plan.get("per_day") or 0
    days = _num(dur)
    pack = cat.get("dose_per_package") or cat.get("pieces_per_package")
    if dose_amt and per_day and days and pack and pack > 1:
        needed = dose_amt * per_day * days
        pkgs = math.ceil(needed / pack)
        return (f"Απαιτούνται ~{needed:.0f} δόσεις ({dose_amt:.0f}×{per_day}/ημέρα×{days:.0f} ημέρες). "
                f"Το σκεύασμα έχει {pack:.0f}/συσκευασία → ~{pkgs} τεμ. (χορηγήθηκαν {qty}).")
    return ("Δεν υπάρχει αυτόματος έλεγχος για αυτή τη μορφή — έλεγξε οπτικά αν η ποσότητα "
            "επαρκεί/συμφωνεί με τη δοσολογία του ιατρού.")


def check_item(item: dict, cat: dict, *, ultra_levure_enabled: bool = True) -> list[dict]:
    """item: {barcode, name, quantity, dose, frequency, duration}; cat: medicine_catalog doc."""
    checks: list[dict] = []
    omt = (cat.get("overdose_message_type") or "").upper()
    qty = item.get("quantity") or 1
    auto = _form_auto_checked(cat.get("form_code"), cat.get("package_form"), item.get("name"))

    # ── 1. Υπερδοσολογία ── (μόνο αν ποσότητα > 1· με 1 τεμάχιο δίνουμε το ελάχιστο → χωρίς έλεγχο)
    if omt != "E" and not auto and qty > 1:
        checks.append({"type": "overdose", "level": "warning",
                       "title": "Οπτικός έλεγχος υπερδοσολογίας",
                       "detail": _overdose_detail(item, cat)})

    # ── 2. Ειδικά φάρμακα ──
    if cat.get("desensitization_vaccine"):
        checks.append({"type": "desensitization", "level": "warning",
                       "title": "Εμβόλιο απευαισθητοποίησης",
                       "detail": "Απαιτείται ειδικός χειρισμός/έλεγχος εκτέλεσης."})
    if ultra_levure_enabled and str(item.get("barcode") or "") in ULTRA_LEVURE_BARCODES:
        checks.append({"type": "ultra_levure", "level": "warning",
                       "title": "Ultra-Levure — έλεγχος ένδειξης",
                       "detail": "Χορηγείται συνήθως ΜΑΖΙ με αντιβιοτικό (προστασία εντέρου/διάρροια). "
                                 "Επιβεβαίωσε ότι η συνταγή του γιατρού περιέχει τη σχετική ένδειξη/οδηγία "
                                 "πριν την εκτέλεση. (Παραμετρικός έλεγχος — μπορείς να τον απενεργοποιήσεις.)"})
    gi = cat.get("group_info")
    if gi:
        checks.append({"type": "special_opinion", "level": "info",
                       "title": "Ειδική γνωμάτευση / περιορισμός αποζημίωσης",
                       "detail": gi[:400]})
    if cat.get("high_cost") and (cat.get("retail_cents") or 0) > FYK_HIGH_VALUE_CENTS:
        checks.append({"type": "fyk_high_value", "level": "info",
                       "title": "ΦΥΚ υψηλής αξίας",
                       "detail": f"Λιανική €{(cat['retail_cents'] / 100):,.2f} (> €3.000) — δώσε προσοχή."})

    # ── 3. Επίσημα μηνύματα ΗΔΥΚΑ + κατάσταση κυκλοφορίας / περιορισμοί εκτέλεσης ──
    if cat.get("info_popup"):
        checks.append({"type": "hdika_info", "level": "warning",
                       "title": "Προειδοποίηση ΗΔΥΚΑ", "detail": cat["info_popup"][:400]})
    if cat.get("pharmacist_popup"):
        checks.append({"type": "hdika_pharmacist", "level": "info",
                       "title": "Οδηγία ΗΔΥΚΑ προς φαρμακοποιό", "detail": cat["pharmacist_popup"][:400]})
    if cat.get("withdrawn"):
        checks.append({"type": "withdrawn", "level": "warning",
                       "title": "Αποσυρμένο φάρμακο",
                       "detail": "Καταχωρημένο ως αποσυρμένο από την κυκλοφορία — επιβεβαίωσε πριν την εκτέλεση."})
    if cat.get("limited_execution"):
        unit = cat.get("execution_unit")
        checks.append({"type": "limited_execution", "level": "warning",
                       "title": "Περιορισμένη εκτέλεση",
                       "detail": f"Φάρμακο περιορισμένης εκτέλεσης{' — ' + unit if unit else ''}."})
    if cat.get("hospital_medicine"):
        checks.append({"type": "hospital", "level": "warning",
                       "title": "Νοσοκομειακό φάρμακο",
                       "detail": "Χορηγείται μόνο σε νοσοκομειακό περιβάλλον."})
    if cat.get("ifet"):
        checks.append({"type": "ifet", "level": "info",
                       "title": "Ειδική εισαγωγή (ΙΦΕΤ)",
                       "detail": "Διατίθεται μέσω ΙΦΕΤ."})
    if cat.get("is_heparin"):
        checks.append({"type": "heparin", "level": "info",
                       "title": "Ηπαρίνη",
                       "detail": "Απαιτείται ειδικός χειρισμός/φύλαξη."})
    return checks
