"""Τεμάχια που δόθηκαν σε ΜΙΑ εγγραφή εκτέλεσης — ΕΝΑΣ ορισμός.

Η ΗΔΥΚΑ δίνει μια τμηματικά εκτελεσμένη συνταγή ως `barcode:1`, `:2`… και ΚΑΘΕ εγγραφή κουβαλά ΟΛΑ
τα είδη με την ΤΕΛΙΚΗ κατάσταση της συνταγής (`executed_qty` = σύνολο όλων των φάσεων). Άθροισμα
`executed_qty` ανά εγγραφή ⇒ ×N ([[hdika-multi-record-prescription]]).

Κανόνας (μετρημένο 01/10/2026 σε 30.000 εγγραφές: Σ λιανική × qty_here = σύνολο εγγραφής στο 99,96%,
έναντι 82% με `executed_qty`):
• το είδος έχει κουπόνια ΚΑΙ ΑΛΛΗΣ φάσης → τα κουπόνια ΑΥΤΗΣ της φάσης (`execution_no` == N)·
• αλλιώς → `executed_qty` (μονή εγγραφή, ή όλα τα κουπόνια σε αυτή τη φάση).

Το `qty_here` αποθηκεύεται σε κάθε `prescription_items` στο ingestion· κάθε άθροισμα τεμαχίων/αξίας
πάνω σε εγγραφές το χρησιμοποιεί. Για «τι ΔΕΝ δόθηκε» (υπόλοιπο) η μονάδα είναι η ΣΥΝΤΑΓΗ, όχι η
εγγραφή — βλ. `rx_root`.
"""

from __future__ import annotations


def record_no(external_id: str | None) -> int:
    """`2608276126652:3` → 3· χωρίς «:N» → 1."""
    tail = str(external_id or "").partition(":")[2]
    return int(tail) if tail.isdigit() else 1


def rx_root(external_id: str | None) -> str:
    """Η ΣΥΝΤΑΓΗ (13ψήφιο barcode) στην οποία ανήκει μια εγγραφή."""
    return str(external_id or "").split(":")[0]


def qty_here(coupons: list | None, executed_qty: int | None, quantity: int | None,
             is_executed: bool | None, n: int) -> int:
    eq = executed_qty
    if eq is None:
        eq = (quantity or 0) if is_executed is not False else 0
    numbered = [c for c in (coupons or []) if int(float(c.get("execution_no") or 0)) > 0]
    mine = sum(1 for c in numbered if int(float(c.get("execution_no") or 0)) == n)
    if len(numbered) > mine:          # υπάρχουν κουπόνια άλλης φάσης
        return mine
    return max(0, int(eq or 0))


# ── εκφράσεις για aggregation ───────────────────────────────────────────────
def qty_expr(prefix: str = "") -> dict:
    """Τεμάχια ΑΥΤΗΣ της εγγραφής σε pipeline (`prefix` π.χ. "it." μετά από $unwind). Πέφτει σε
    executed_qty/quantity για γραμμές πριν από το backfill του `qty_here`."""
    return {"$ifNull": [f"${prefix}qty_here", f"${prefix}executed_qty", f"${prefix}quantity"]}


def rx_root_expr(path: str) -> dict:
    """`$ex.external_id` → η συνταγή (μέρος πριν από το «:»)."""
    return {"$arrayElemAt": [{"$split": [{"$ifNull": [path, ""]}, ":"]}, 0]}


def one_record_per_rx() -> list[dict]:
    """Stages: κράτα τη ΝΕΟΤΕΡΗ εγγραφή κάθε συνταγής (για ό,τι αφορά ΟΛΗ τη συνταγή: υπόλοιπο,
    επόμενη επανάληψη, τι χρειάζεται) — αλλιώς κάθε `:N` εμφανίζεται ως ξεχωριστή συνταγή."""
    return [{"$sort": {"executed_at": -1}},
            {"$group": {"_id": rx_root_expr("$external_id"), "doc": {"$first": "$$ROOT"}}},
            {"$replaceRoot": {"newRoot": "$doc"}}]
