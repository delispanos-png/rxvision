"""Εισαγωγή στοιχείων επικοινωνίας από το εμπορικό πρόγραμμα του φαρμακείου (.xlsx/.csv).

Ο φαρμακοποιός εξάγει τη λίστα πελατών του, την ανεβάζει και λέει ποια στήλη είναι τι
(«στήλη 1 = όνομα, 2 = κινητό, 3 = email …»). Κάθε πρόγραμμα βγάζει άλλη διάταξη, οπότε ΔΕΝ
υποθέτουμε επικεφαλίδες: τις χρησιμοποιούμε μόνο για να ΠΡΟΤΕΙΝΟΥΜΕ αντιστοίχιση.

Εδώ ζει το καθαρό κομμάτι (χωρίς βάση): πρόταση αντιστοίχισης, κανονικοποίηση τηλεφώνων/email,
μετατροπή γραμμών σε εγγραφές. Το ταίριασμα με ασθενείς & η συγχώνευση με ό,τι υπάρχει ζουν στο
PatientContactRepository.import_contacts.
"""

from __future__ import annotations

import io
import re
import unicodedata

from openpyxl import Workbook

# Τι μπορεί να είναι μια στήλη. last_name/first_name ενώνονται σε ονοματεπώνυμο (πολλά προγράμματα
# τα βγάζουν χωριστά).
IMPORT_FIELDS = ("amka", "full_name", "last_name", "first_name", "mobile", "phone", "email",
                 "address", "city", "postal_code")

# κανονικοποιημένη επικεφαλίδα → πεδίο (μόνο για ΠΡΟΤΑΣΗ αντιστοίχισης)
_ALIASES: dict[str, str] = {
    "amka": "amka", "αμκα": "amka",
    "ονοματεπωνυμο": "full_name", "name": "full_name", "fullname": "full_name",
    "επωνυμοονομα": "full_name", "ονομαεπωνυμο": "full_name", "πελατης": "full_name",
    "επωνυμια": "full_name", "περιγραφη": "full_name",
    "επωνυμο": "last_name", "surname": "last_name", "lastname": "last_name",
    "ονομα": "first_name", "firstname": "first_name",
    "κινητο": "mobile", "mobile": "mobile", "cell": "mobile", "κινητοτηλεφωνο": "mobile",
    "τηλεφωνο": "phone", "phone": "phone", "σταθερο": "phone", "landline": "phone", "τηλ": "phone",
    "τηλεφωνο1": "phone", "σταθεροτηλεφωνο": "phone",
    "email": "email", "emailaddress": "email", "ηλεκτρονικοταχυδρομειο": "email", "mail": "email",
    "διευθυνση": "address", "address": "address", "διευθ": "address", "οδος": "address",
    "πολη": "city", "city": "city", "περιοχη": "city",
    "τκ": "postal_code", "ταχυδρομικοςκωδικας": "postal_code", "ταχυδρομικοςκωδικος": "postal_code",
    "postalcode": "postal_code", "zip": "postal_code", "postal": "postal_code",
}

TEMPLATE_HEADERS = ["ΑΜΚΑ", "Ονοματεπώνυμο", "Κινητό", "Σταθερό", "Email", "Διεύθυνση", "Πόλη", "ΤΚ"]

_EMAIL_RX = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$")


def _norm(s) -> str:
    """Πεζά, χωρίς τόνους, μόνο γράμματα/ψηφία — για σύγκριση επικεφαλίδων."""
    if s is None:
        return ""
    s = str(s).strip().lower()
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    return "".join(ch for ch in s if ch.isalnum())


def name_key(s: str | None) -> str:
    """Κλειδί ονόματος ανεξάρτητο από σειρά/τόνους/κεφαλαία: «Γεώργιος Παπαδόπουλος» ==
    «ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΕΩΡΓΙΟΣ». Κενό όταν έχει λιγότερες από δύο λέξεις (μόνο επώνυμο = ασαφές)."""
    if not s:
        return ""
    s = "".join(c for c in unicodedata.normalize("NFD", str(s).upper())
                if unicodedata.category(c) != "Mn")
    words = [w for w in re.split(r"[^0-9A-ZΑ-Ω]+", s) if w]
    return " ".join(sorted(words)) if len(words) >= 2 else ""


def suggest_mapping(header: list[str]) -> dict[str, int]:
    """{πεδίο: δείκτης στήλης} από τις επικεφαλίδες — το πρώτο ταίριασμα κερδίζει."""
    out: dict[str, int] = {}
    for i, h in enumerate(header):
        field = _ALIASES.get(_norm(h))
        if field and field not in out:
            out[field] = i
    return out


def looks_like_header(row: list[str]) -> bool:
    """Η γραμμή είναι επικεφαλίδες αν έστω ένα κελί είναι γνωστό όνομα στήλης και κανένα δεν
    μοιάζει με ΑΜΚΑ/τηλέφωνο (11/10 ψηφία)."""
    if not any(_ALIASES.get(_norm(c)) for c in row):
        return False
    return not any(len(re.sub(r"\D", "", c or "")) >= 10 for c in row)


def norm_amka(v: str | None) -> str:
    """ΑΜΚΑ μόνο ψηφία. Το Excel τον κάνει συχνά αριθμό («12345678901.0», «1.2345678901E10»)."""
    s = (v or "").strip()
    if not s:
        return ""
    if re.fullmatch(r"\d+(\.0+)?", s):
        s = s.split(".")[0]
    elif re.fullmatch(r"\d(\.\d+)?[eE]\+?\d+", s):
        try:
            s = str(int(float(s)))
        except ValueError:
            return ""
    digits = re.sub(r"\D", "", s)
    if len(digits) == 10:                  # το Excel έκοψε το αρχικό μηδενικό
        digits = "0" + digits
    # κάποιοι ασφαλισμένοι έχουν μη-11ψήφιο αναγνωριστικό στη βάση → ταιριάζει ως έχει
    return digits if len(digits) >= 8 else ""


def split_phones(v: str | None) -> tuple[list[str], list[str], int]:
    """Ένα κελί τηλεφώνου → (κινητά, σταθερά, άκυρα). Ένα κελί μπορεί να έχει δύο αριθμούς
    («210… / 697…»)· το είδος το κρίνει το πρόθεμα (69 = κινητό, 2 = σταθερό), όχι η στήλη —
    στα εμπορικά προγράμματα το κινητό συχνά κάθεται στη στήλη «Τηλέφωνο»."""
    mobiles: list[str] = []
    lands: list[str] = []
    bad = 0
    s = (v or "").strip()
    if re.fullmatch(r"\d+\.0+", s):        # αριθμός από Excel
        s = s.split(".")[0]
    for part in re.split(r"[/,;|\n]+|\s{2,}", s):
        d = re.sub(r"\D", "", part)
        if not d:
            continue
        if d.startswith("0030"):
            d = d[4:]
        elif d.startswith("30") and len(d) == 12:
            d = d[2:]
        if len(d) == 10 and d.startswith("69"):
            mobiles.append(d)
        elif len(d) == 10 and d.startswith("2"):
            lands.append(d)
        else:
            bad += 1
    return mobiles, lands, bad


def norm_email(v: str | None) -> tuple[str, bool]:
    """(email, άκυρο;). Κενό κελί → ("", False)."""
    s = (v or "").strip().lower().replace(" ", "")
    if not s:
        return "", False
    return (s, False) if _EMAIL_RX.match(s) else ("", True)


def row_to_record(row: list[str], mapping: dict[str, int]) -> dict:
    """Μια γραμμή → {amka, name, fields:{…}, invalid:{πεδίο: πλήθος}}. Κενά κελιά αγνοούνται."""
    def cell(field: str) -> str:
        i = mapping.get(field)
        return (row[i] if i is not None and 0 <= i < len(row) else "") or ""

    name = cell("full_name").strip() or " ".join(
        x for x in (cell("last_name").strip(), cell("first_name").strip()) if x)
    rec: dict = {"amka": norm_amka(cell("amka")), "name": name, "fields": {}, "invalid": {}}
    raw_amka = cell("amka").strip()
    if raw_amka and not rec["amka"]:
        rec["invalid"]["amka"] = 1

    mobiles: list[str] = []
    lands: list[str] = []
    for f in ("mobile", "phone"):
        m, ln, bad = split_phones(cell(f))
        mobiles += m
        lands += ln
        if bad:
            rec["invalid"][f] = rec["invalid"].get(f, 0) + bad
    if mobiles:
        rec["fields"]["mobile"] = mobiles[0]
    if lands:
        rec["fields"]["phone"] = lands[0]

    email, bad_email = norm_email(cell("email"))
    if email:
        rec["fields"]["email"] = email
    if bad_email:
        rec["invalid"]["email"] = 1

    for f in ("address", "city"):
        v = re.sub(r"\s+", " ", cell(f)).strip()
        if v:
            rec["fields"][f] = v[:200]
    pc = re.sub(r"\s", "", cell("postal_code"))
    if pc.endswith(".0"):
        pc = pc[:-2]
    if pc:
        if re.fullmatch(r"\d{5}", pc):
            rec["fields"]["postal_code"] = pc
        else:
            rec["invalid"]["postal_code"] = 1
    return rec


def build_template_xlsx() -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Πελάτες"
    ws.append(TEMPLATE_HEADERS)
    ws.append(["12345678901", "ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΕΩΡΓΙΟΣ", "6971234567", "2101234567",
               "g.papadopoulos@example.gr", "Ερμού 10", "Αθήνα", "10563"])
    for col, _ in enumerate(TEMPLATE_HEADERS, start=1):
        ws.column_dimensions[chr(64 + col)].width = 22
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
