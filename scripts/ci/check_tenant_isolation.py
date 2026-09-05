#!/usr/bin/env python3
"""CI-lint απομόνωσης tenant — δίχτυ ασφαλείας για τον ΕΝΑ κανόνα που δεν σπάμε.

ΓΙΑΤΙ: το `BaseRepository` εγγυάται «by construction» ότι κάθε query/insert/aggregation φέρει
`tenant_id`. ΟΜΩΣ δεκάδες hot-path σημεία (analytics/workers/services) πάνε ΚΑΤΕΥΘΕΙΑΝ σε raw
collection handles (`self._db["..."]`, `shared_db()["..."]`, `db["..."]`) και ξαναγράφουν το φίλτρο
tenant ΣΤΟ ΧΕΡΙ. Είναι σωστά σήμερα — αλλά μια μελλοντική προσθήκη που ξεχνά το φίλτρο θα διαρρεύσει
cross-tenant ΣΙΩΠΗΛΑ και θα περάσει το CI (το test_invariants ελέγχει μόνο το BaseRepository).

ΤΙ ΚΑΝΕΙ: για κάθε πρόσβαση σε ΓΝΩΣΤΗ tenant-scoped collection μέσω raw handle, απαιτεί να υπάρχει
`tenant_id` (ή ρητή σήμανση `# tenant-ok`) κάπου μέσα στην ΠΕΡΙΒΑΛΛΟΥΣΑ ΣΥΝΑΡΤΗΣΗ (ανάλυση AST — τα
φίλτρα συχνά χτίζονται σε μεταβλητή πιο πάνω, οπότε ο έλεγχος ανά γραμμή θα έβγαζε ψευδώς θετικά).
Πιάνει την πραγματικά επικίνδυνη περίπτωση: συνάρτηση που αγγίζει tenant collection ΧΩΡΙΣ καθόλου
αναφορά σε tenant_id.

ΧΡΗΣΗ:  python3 scripts/ci/check_tenant_isolation.py [--verbose]
Exit 0 = καθαρό · Exit 1 = βρέθηκαν πιθανές διαρροές.
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "backend" / "app"

# Collections που ΠΑΝΤΑ φέρουν tenant_id (μια γραμμή ανά tenant). Κάθε νέα tenant collection μπαίνει εδώ.
TENANT_COLLECTIONS = {
    "prescription_executions", "prescription_items", "patients_anonymized", "doctors",
    "products", "pharmacy_products", "future_prescriptions", "patient_contacts",
    "orders_delivery", "loyalty_members", "loyalty_ledger", "loyalty_rewards", "loyalty_config",
    "vaccinations", "med_reminders", "sent_messages", "scans", "amount_audit_log",
    "shop_orders", "shop_coupons", "shop_campaigns", "order_subscriptions",
    "supplier_settings", "pharmacy_categories", "stock_movements", "ai_advice",
}

# Raw handles που ΠΑΡΑΚΑΜΠΤΟΥΝ το BaseRepository scoping
HANDLE = re.compile(
    r'(?:self\._db|self\.db|shared_db\(\)|\bdb)\[\s*[\'"](?P<coll>[a-z0-9_.]+)[\'"]\s*\]'
)
def _function_ranges(tree: ast.AST) -> list[tuple[int, int]]:
    """(start_line, end_line) κάθε (async) συνάρτησης — για να βρούμε την περιβάλλουσα."""
    out: list[tuple[int, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            end = getattr(node, "end_lineno", None) or node.lineno
            out.append((node.lineno, end))
    return out


def check_file(path: Path) -> list[tuple[int, str, str]]:
    """Επιστρέφει [(lineno, collection, γραμμή)] για ύποπτες προσβάσεις."""
    try:
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        tree = ast.parse(text)
    except Exception:  # noqa: BLE001 — μη-parsable αρχείο: το αφήνουμε στο ruff/mypy
        return []
    funcs = _function_ranges(tree)
    out: list[tuple[int, str, str]] = []
    for i, line in enumerate(lines):
        lineno = i + 1
        for m in HANDLE.finditer(line):
            coll = m.group("coll")
            if coll not in TENANT_COLLECTIONS:
                continue
            # Ελέγχουμε ΟΛΕΣ τις περιβάλλουσες συναρτήσεις (nested helpers συχνά χρησιμοποιούν φίλτρο
            # που χτίστηκε στην ΕΞΩΤΕΡΙΚΗ συνάρτηση — αλλιώς θα βγάζαμε ψευδώς θετικά).
            enclosing = [(s, e) for (s, e) in funcs if s <= lineno <= e]
            scopes = ["\n".join(lines[s - 1:e]) for (s, e) in enclosing] or [text]
            # ασφαλείς δείκτες: ρητή σήμανση platform-global, φίλτρο tenant, ή self._scope() που ΕΙΣΑΓΕΙ tenant_id
            if any(("tenant-ok" in sc or "tenant_id" in sc or "_scope(" in sc) for sc in scopes):
                continue
            out.append((lineno, coll, line.strip()))
    return out


def main() -> int:
    verbose = "--verbose" in sys.argv
    violations: list[tuple[Path, int, str, str]] = []
    files = sorted(SRC.rglob("*.py"))
    for f in files:
        for lineno, coll, text in check_file(f):
            violations.append((f, lineno, coll, text))

    if verbose:
        print(f"σαρώθηκαν {len(files)} αρχεία · {len(TENANT_COLLECTIONS)} tenant collections")

    if not violations:
        print("✅ tenant-isolation lint: καθαρό — καμία raw πρόσβαση σε tenant collection χωρίς tenant_id")
        return 0

    print(f"❌ tenant-isolation lint: {len(violations)} ύποπτες προσβάσεις "
          f"(raw handle σε tenant collection ΧΩΡΙΣ tenant_id στο ίδιο statement)\n")
    for f, lineno, coll, text in violations:
        print(f"  {f.relative_to(ROOT)}:{lineno}  [{coll}]")
        print(f"      {text[:120]}")
    print("\nΔΙΟΡΘΩΣΗ: πρόσθεσε {\"tenant_id\": ...} στο φίλτρο, ή πέρασε από repository που επεκτείνει")
    print("BaseRepository, ή —αν είναι σκόπιμα platform-global— σημείωσε τη γραμμή με  # tenant-ok")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
