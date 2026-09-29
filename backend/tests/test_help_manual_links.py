"""Κάθε «Διάβασέ το αναλυτικά στο Εγχειρίδιο» του βοηθού «?» πρέπει να δείχνει σε ΥΠΑΡΚΤΗ ενότητα.

ΓΙΑΤΙ: 28/09/2026 βρέθηκαν 22 από 69 σελίδες βοηθού να στέλνουν στην ΚΟΡΥΦΗ του εγχειριδίου
αντί για την ενότητά τους (όλο το Patient Intelligence, Σύμβουλος, Connect…). Κανείς δεν το
πρόσεξε, γιατί ο σύνδεσμος «δουλεύει» — απλώς πάει σε λάθος σημείο. Ένας σπασμένος σύνδεσμος εδώ
δεν βγάζει σφάλμα· βγάζει έναν χρήστη που ψάχνει με το χέρι και σταματά να πατάει το «?».

Οι συναρτήσεις παρακάτω είναι ΑΝΤΙΓΡΑΦΟ του `frontend/src/lib/markdown.tsx` (`slug`, `cleanTitle`)
και του `manualSlug` στο `help.ts`. Αν αλλάξουν εκεί, πρέπει να αλλάξουν κι εδώ — ο έλεγχος
`test_slug_functions_match_frontend` το φυλάει.
"""

from __future__ import annotations

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
MANUAL = ROOT / "docs" / "USER_MANUAL.md"
HELP = ROOT / "frontend" / "src" / "lib" / "help.ts"
MARKDOWN = ROOT / "frontend" / "src" / "lib" / "markdown.tsx"


def _slug(s: str) -> str:
    # JS: s.toLowerCase().replace(/[*`_]/g,"").replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-|-$/g,"")
    s = re.sub(r"[*`_]", "", s.lower())
    s = re.sub(r"[\W_]+", "-", s)
    return s.strip("-")


def _clean_title(s: str) -> str:
    # ΣΕΙΡΑ: πρώτα η ουρά «*(…)*», μετά οι αστερίσκοι — ανάποδα έσπαγε 22 συνδέσμους.
    s = re.sub(r"\s*\*\(.*?\)\*\s*$", "", s)
    return re.sub(r"[*`]", "", s).strip()


def _manual_ids() -> set[str]:
    ids = set()
    for line in MANUAL.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            ids.add(_slug(_clean_title(m.group(2))))
    return ids


def _help_links() -> list[tuple[str, str]]:
    src = HELP.read_text(encoding="utf-8")
    out = []
    for m in re.finditer(r'^  "([^"]+)": \{(.*?)^  \},', src, re.S | re.M):
        link = re.search(r'manual: "([^"]+)"', m.group(2))
        if link:
            out.append((m.group(1), link.group(1)))
    return out


def test_every_help_link_points_to_a_real_manual_section():
    ids = _manual_ids()
    links = _help_links()
    assert len(links) > 50, "Δεν βρέθηκαν σύνδεσμοι στο help.ts — άλλαξε η μορφή του αρχείου;"
    broken = [f"{route} → «{title}»" for route, title in links if _slug(title) not in ids]
    assert not broken, (
        "Ο βοηθός «?» δείχνει σε ενότητα που ΔΕΝ υπάρχει στο εγχειρίδιο (ο χρήστης θα βρεθεί "
        "στην κορυφή): " + "; ".join(broken))


def test_slug_functions_match_frontend():
    """Αν αλλάξει ο αλγόριθμος στο frontend, αυτός ο έλεγχος πρέπει να ενημερωθεί μαζί."""
    md = MARKDOWN.read_text(encoding="utf-8")
    assert '.replace(/\\s*\\*\\(.*?\\)\\*\\s*$/, "").replace(/[*`]/g, "")' in md, (
        "Άλλαξε το cleanTitle στο markdown.tsx — ενημέρωσε το _clean_title εδώ (και κράτα τη "
        "σειρά: πρώτα η ουρά, μετά οι αστερίσκοι).")
    assert '.replace(/[^\\p{L}\\p{N}]+/gu, "-")' in md, "Άλλαξε το slug στο markdown.tsx."
