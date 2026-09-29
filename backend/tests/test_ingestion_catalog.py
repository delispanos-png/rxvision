"""ΚΑΘΕ άντληση ΗΔΥΚΑ πρέπει να περνά τον κατάλογο φαρμάκων στο `HdikaAdapter`.

ΓΙΑΤΙ ΕΙΝΑΙ ΜΟΝΙΜΟΣ ΕΛΕΓΧΟΣ: από την πρώτη μέρα (06/06/2026) έως 28/09/2026 ο καθημερινός
συγχρονισμός καλούσε `HdikaAdapter(creds)` χωρίς κατάλογο, ενώ το backfill τον περνούσε. Κάθε νέα
εκτέλεση έπαιρνε barcode = σκέτο ΕΟΦ αντί για EAN `280…` → ΔΕΥΤΕΡΟ προϊόν για κάθε φάρμακο (60% των
φαρμάκων σε δύο γραμμές στην κερδοφορία, υπενθυμίσεις πύλης που χάθηκαν σιωπηλά), χονδρική 100%
εκτίμηση, 0/875 ναρκωτικά σημειωμένα. Φαινόταν σαν «η ΗΔΥΚΑ άλλαξε κωδικοποίηση» — δεν άλλαξε.
"""

from __future__ import annotations

import ast
import pathlib

APP = pathlib.Path(__file__).resolve().parents[1] / "app"


def test_every_hdika_adapter_call_passes_the_catalog():
    offenders = []
    for f in APP.rglob("*.py"):
        tree = ast.parse(f.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and getattr(node.func, "id", None) == "HdikaAdapter"
                    and not any(k.arg == "catalog" for k in node.keywords)):
                offenders.append(f"{f.relative_to(APP)}:{node.lineno}")
    assert not offenders, ("HdikaAdapter χωρίς catalog= — οι εκτελέσεις θα πάρουν barcode ΕΟΦ, "
                           "εκτιμώμενη χονδρική και χωρίς σήμανση ναρκωτικού: " + ", ".join(offenders))
