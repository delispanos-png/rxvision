"""Κείμενα Κύπρου: το κυπριακό φαρμακείο δεν βλέπει ΠΟΤΕ ελληνικές αναφορές (ΗΔΥΚΑ, ΕΟΠΥΥ, ΑΜΚΑ…).

ΓΙΑΤΙ: ίδια πλατφόρμα, δύο χώρες. Ένα «συνδέσου στην ΗΔΥΚΑ» σε κυπριακή οθόνη μπερδεύει τον
πελάτη και δείχνει ότι το προϊόν δεν είναι φτιαγμένο για αυτόν (οδηγία ιδιοκτήτη 17/11/2026).
Φυλάει: το εγχειρίδιο Κύπρου, τη βοήθεια «?» Κύπρου, τις ελληνικές εξηγήσεις που δανείζεται η
Κύπρος (CY_SHARED_HELP) και ότι κάθε σύνδεσμος βοήθειας → υπαρκτή ενότητα του κυπριακού εγχειριδίου.
"""

from __future__ import annotations

import pathlib
import re

from tests.test_help_manual_links import _clean_title, _slug

ROOT = pathlib.Path(__file__).resolve().parents[2]
MANUAL_CY = ROOT / "docs" / "USER_MANUAL_CY.md"
HELP = ROOT / "frontend" / "src" / "lib" / "help.ts"
HELP_CY = ROOT / "frontend" / "src" / "lib" / "helpCy.ts"

FORBIDDEN = re.compile(r"ΗΔΥΚΑ|ΗΔΙΚΑ|ΕΟΠΥΥ|ΑΜΚΑ|ΑΑΔΕ|myDATA|ΚΥΥΑΠ|ΕΦΚΑ|Δελτίο Τιμών|Profarm|\b(?:24|13|6)%")


def _entries(src: str) -> dict[str, str]:
    return {m.group(1): m.group(2) for m in re.finditer(r'^  "([^"]+)": \{(.*?)^  \},', src, re.S | re.M)}


def _cy_ids() -> set[str]:
    ids = set()
    for line in MANUAL_CY.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            ids.add(_slug(_clean_title(m.group(2))))
    return ids


def test_cyprus_manual_has_no_greek_references():
    text = MANUAL_CY.read_text(encoding="utf-8")
    hits = sorted(set(FORBIDDEN.findall(text)))
    assert not hits, f"Ελληνικές αναφορές στο εγχειρίδιο Κύπρου: {hits}"


def test_cyprus_help_has_no_greek_references_and_links_resolve():
    src = HELP_CY.read_text(encoding="utf-8")
    entries = _entries(src)
    assert len(entries) >= 8
    ids = _cy_ids()
    for route, body in entries.items():
        assert not FORBIDDEN.findall(body), f"{route}: ελληνική αναφορά στη βοήθεια Κύπρου"
        link = re.search(r'manual: "([^"]+)"', body)
        if link:
            assert _slug(link.group(1)) in ids, f"{route} → «{link.group(1)}» λείπει από το εγχειρίδιο Κύπρου"


def test_shared_greek_help_borrowed_by_cyprus_is_clean():
    shared = re.search(r"CY_SHARED_HELP = new Set\(\[(.*?)\]\)", HELP_CY.read_text(encoding="utf-8"), re.S)
    keys = re.findall(r'"([^"]+)"', shared.group(1))
    greek = _entries(HELP.read_text(encoding="utf-8"))
    ids = _cy_ids()
    for k in keys:
        assert k in greek, f"{k}: δεν υπάρχει στο help.ts"
        assert not FORBIDDEN.findall(greek[k]), f"{k}: η ελληνική εξήγηση αναφέρει ελληνικά συστήματα"
        link = re.search(r'manual: "([^"]+)"', greek[k])
        if link:
            assert _slug(link.group(1)) in ids, f"{k} → «{link.group(1)}» λείπει από το εγχειρίδιο Κύπρου"
