"""Ανάγνωση QR (GS1 DataMatrix / HMVS) κουτιού φαρμάκου — ΕΝΑΣ αναγνώστης για όλη την εφαρμογή.

Μορφή: 01<GTIN 14> και, με οποιαδήποτε σειρά, 17<λήξη YYMMDD> 10<παρτίδα ≤20> 21<σειριακός ≤20>.
Οι παρτίδα/σειριακός είναι μεταβλητού μήκους και ΧΩΡΙΖΟΝΤΑΙ με τον αόρατο χαρακτήρα GS (0x1D).

ΓΙΑΤΙ ΧΡΕΙΑΖΕΤΑΙ «ΕΞΥΠΝΟΣ» (15/10/2026, πραγματικά σκαναρίσματα δανεικών):
  • ο σαρωτής-πληκτρολόγιο του Μπινίκου στέλνει τον GS ως ΚΕΝΟ («69028 21HHE0GY8K30»)·
  • άλλου φαρμακείου στέλνει το ΚΕΙΜΕΝΟ «<GS>» — και με τον υπολογιστή σε ΕΛΛΗΝΙΚΑ γίνεται «<ΓΣ>», ενώ
    ο σειριακός APFG9GADH7 γίνεται «ΑΠΦΓ9ΓΑΔΗ7» (ίδια πλήκτρα, ελληνική διάταξη)·
  • άλλοι σαρωτές δεν στέλνουν ΚΑΘΟΛΟΥ διαχωριστή → το «17» μπορεί να βρεθεί μέσα στον σειριακό.
Κανένας τεχνικός δεν ενημερώνει τον φαρμακοποιό τι ρύθμισε. Άρα: δοκιμάζουμε τις ερμηνείες και
κρατάμε αυτή με τα ΠΕΡΙΣΣΟΤΕΡΑ πεδία και ΕΓΚΥΡΗ λήξη· το QR φαρμάκου δεν έχει ποτέ ελληνικά, άρα η
μετάφραση πληκτρολογίου είναι πάντα ασφαλής.
"""

from __future__ import annotations

import re

GS = "\x1d"
# Ελληνική διάταξη πληκτρολογίου → λατινικό γράμμα του ΙΔΙΟΥ πλήκτρου (κεφαλαία & πεζά, με/χωρίς τόνο)
_GR = "ΑΒΨΔΕΦΓΗΙΞΚΛΜΝΟΠΡΣΤΘΩΧΥΖ"     # W = «ς» (χωριστά πιο κάτω)· Q = «;»
_LA = "ABCDEFGHIJKLMNOPRSTUVXYZ"
_GREEK_KEYS = {**{g: l for g, l in zip(_GR, _LA)}, **{g.lower(): l.lower() for g, l in zip(_GR, _LA)},
               "ς": "W", ";": "Q", "Ά": "A", "Έ": "E", "Ή": "H", "Ί": "I", "Ό": "O", "Ύ": "Y", "Ώ": "V",
               "ά": "a", "έ": "e", "ή": "h", "ί": "i", "ό": "o", "ύ": "y", "ώ": "v"}
_FIXED = {"01": 14, "17": 6, "11": 6, "15": 6}
_VAR = {"10", "21"}
_SEP_TOKENS = re.compile(r"<\s*GS\s*>|\[GS\]|\{GS\}|␝|\^\]|\s+|[|~]")


def _ok_date(d: str) -> bool:
    return bool(re.fullmatch(r"\d{6}", d)) and 1 <= int(d[2:4]) <= 12 and int(d[4:6]) <= 31


def gtin_ok(g: str) -> bool:
    """Ψηφίο ελέγχου GS1 (mod 10): το 14ο ψηφίο του GTIN βγαίνει από τα 13 πρώτα. Ένας χαμένος
    χαρακτήρας μέσα στο GTIN το χαλάει σχεδόν πάντα — έτσι πιάνουμε το «κομμένο» σκανάρισμα."""
    if not re.fullmatch(r"\d{14}", g or ""):
        return False
    tot = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(g[:13]))
    return (10 - tot % 10) % 10 == int(g[13])


def classify(raw: str) -> dict:
    """ΤΙ σκανάρισε ο φαρμακοποιός — ΕΝΑΣ κανόνας για όλη την εφαρμογή (κανόνας ιδιοκτήτη 22/10/2026,
    επιβεβαιωμένος σε πραγματικά δεδομένα: 4.996/5.000 barcodes φαρμάκων «280» είναι 13ψήφια· ΟΛΕΣ οι
    ταινίες της ΗΔΥΚΑ 12ψήφιες):
      • eof_code   — κουπόνι ΕΟΦ (barcode φαρμάκου): 13 ψηφία, ξεκινά «280»· προαιρετικά + LOT
      • eof_lot    — LOT αυτοκόλλητης ταινίας: 12 ψηφία, μοναδικό ανά κουτί· ΥΠΟΧΡΕΩΤΙΚΑ + κουπόνι ΕΟΦ
      • intangible — άυλο κουπόνι (ΕΔΑΠΥ: αναλώσιμα διαβήτη, ορθοπεδικά, διατροφή): 20 ψηφία, ≥2 μηδενικά
                     μπροστά· μοναδικό ανά κουτί· προαιρετικά + κανονικό barcode
      • qr         — QR φαρμάκου (HMVS): πεδία 01/17/10/21 με οποιαδήποτε σειρά (βλ. parse)
      • corrupt    — QR που ήρθε κομμένο
      • other      — οτιδήποτε άλλο: παραφάρμακο, ΜΗ.ΣΥ.ΦΑ. ή λάθος σκανάρισμα
    Το LOT και το κουπόνι ΕΟΦ μπορεί να σκαναριστούν με οποιαδήποτε σειρά — το ζευγάρωμα γίνεται στην οθόνη."""
    s, scanner = normalize(raw)
    plain = s.replace(GS, "")
    if plain.isdigit():
        if len(plain) == 13 and plain.startswith("280"):
            return {"kind": "eof_code", "code": plain}
        if len(plain) == 12:
            return {"kind": "eof_lot", "code": plain}
        if len(plain) == 20 and plain.startswith("00"):
            return {"kind": "intangible", "code": plain}
    p = parse(raw)
    if p and p.get("corrupt"):
        return {"kind": "corrupt", "scanner": scanner}
    if p and p.get("gtin"):
        return {"kind": "qr", "qr": p}
    return {"kind": "other", "code": plain or (raw or "").strip()}


def normalize(raw: str) -> tuple[str, dict]:
    """Ακατέργαστο σκανάρισμα → συμβολοσειρά με GS ως διαχωριστή + τι ανιχνεύθηκε για τον σαρωτή."""
    s = re.sub(r"^\](d2|C1|Q3|e0)", "", (raw or "").strip())
    # ελληνική διάταξη = υπάρχει ΕΣΤΩ ΕΝΑ ελληνικό γράμμα (το «;» μόνο του δεν αρκεί — μπορεί να είναι γνήσιο)
    greek = any(not ch.isascii() and ch in _GREEK_KEYS for ch in s)
    if greek:
        s = "".join(_GREEK_KEYS.get(ch, ch) for ch in s)
    toks = [m.group(0) for m in _SEP_TOKENS.finditer(s)]
    if GS in s:
        sep = "gs"
    elif any("GS" in t.upper() for t in toks):
        sep = "text_gs"                      # ο σαρωτής «γράφει» <GS>
    elif any(t.isspace() for t in toks):
        sep = "space"
    else:
        sep = toks[0] if toks else None
    s = _SEP_TOKENS.sub(GS, s).strip(GS)
    return s, {"separator": sep or "none", "greek_layout": greek}


def parse(raw: str) -> dict | None:
    """→ {gtin, expiry, batch, serial, scanner:{separator, greek_layout}} ή None αν δεν είναι GS1 φαρμάκου.

    {"corrupt": True, ...}: μοιάζει με QR κουτιού (01… μακρύ) αλλά το GTIN είναι χαλασμένο — χάθηκαν
    χαρακτήρες στη διαδρομή σαρωτής→υπολογιστής. Ποτέ δεν αποθηκεύεται· ζητάμε ξανά σκανάρισμα."""
    s, scanner = normalize(raw)
    corrupt = {"gtin": None, "expiry": None, "batch": None, "serial": None, "scanner": scanner,
               "complete": False, "corrupt": True}
    # Τα πεδία του QR έρχονται με ΟΠΟΙΑΔΗΠΟΤΕ σειρά (κανόνας ιδιοκτήτη 22/10/2026): μπορεί να ξεκινά από
    # 01 (κωδικός προϊόντος), 10 (παρτίδα), 17 (λήξη) ή 21 (σειριακός). QR ≥ 24 χαρακτήρες.
    if s[:2] not in ("01", "10", "17", "21") or len(s) < 24:
        return None
    starts01 = s.startswith("01")
    if starts01 and (not re.match(r"^01\d{14}", s) or not gtin_ok(s[2:16])):
        return corrupt                      # QR με χαλασμένο κωδικό προϊόντος → χάθηκαν χαρακτήρες
    results: list[dict] = []

    def go(pos: int, acc: dict) -> None:
        if len(results) > 300:
            return
        if pos >= len(s):
            results.append(acc)
            return
        if s[pos] == GS:
            go(pos + 1, acc)
            return
        ai = s[pos:pos + 2]
        if ai in acc:
            return
        if ai in _FIXED:
            v = s[pos + 2:pos + 2 + _FIXED[ai]]
            if len(v) == _FIXED[ai] and (ai == "01" or _ok_date(v)):
                go(pos + 2 + _FIXED[ai], {**acc, ai: v})
        elif ai in _VAR:
            start = pos + 2
            gs = s.find(GS, start)
            if gs >= 0:
                if 0 < gs - start <= 20:
                    go(gs + 1, {**acc, ai: s[start:gs]})
                return
            for end in range(min(len(s), start + 20), start, -1):
                go(end, {**acc, ai: s[start:end]})

    go(0, {})
    # ΜΟΝΟ ερμηνείες με έγκυρο κωδικό προϊόντος (01 + ψηφίο ελέγχου) — αλλιώς δεν είναι QR φαρμάκου
    results = [r for r in results if gtin_ok(r.get("01") or "")]
    if not results and not starts01:
        return None
    if not results:
        # Σωστό GTIN αλλά ό,τι ακολουθεί δεν διαβάζεται με ΚΑΝΕΝΑ τρόπο (π.χ. «…4976Y01 17…»: χάθηκε
        # το «10195» της παρτίδας) → πάλι κομμένο· καλύτερα ξανά σκανάρισμα τώρα παρά ελλιπές χρέος.
        return {"gtin": s[2:16], "expiry": None, "batch": None, "serial": None, "scanner": scanner,
                "complete": False, "corrupt": True}
    best = max(results, key=lambda r: len(r))
    return {"gtin": best.get("01"), "expiry": best.get("17"), "batch": best.get("10"),
            "serial": best.get("21"), "scanner": scanner,
            "complete": all(best.get(k) for k in ("01", "17", "10", "21"))}
