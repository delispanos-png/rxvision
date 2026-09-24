"""Επιμερισμός της κάλυψης ΚΥΥΑΠ/ΕΤΥΑΠ στις εκτελέσεις μιας συνταγής.

ΤΟ ΠΡΟΒΛΗΜΑ: η ΗΔΥΚΑ δίνει την κάλυψη ΚΥΥΑΠ **ανά συνταγή** (visit) και τη γράφει
ΠΑΝΟΜΟΙΟΤΥΠΑ σε κάθε εκτέλεσή της. Αν αφαιρεθεί ολόκληρη από κάθε εκτέλεση, διπλομετριέται·
αν αφαιρεθεί ολόκληρη από την πρώτη, η πρώτη ημέρα βγαίνει λιγότερη και η δεύτερη περισσότερη.

ΤΟ ΣΩΣΤΟ (επαληθευμένο στο λεπτό vs ΗΔΥΚΑ/SoftOne, συνταγή 2609033481768 — 04/09/2026):
επιμερισμός **αναλογικά προς το `amount_total` κάθε εκτέλεσης**, με το υπόλοιπο των λεπτών
στην τελευταία φάση ώστε να μη χάνεται τίποτα.

    ΚΥΥΑΠ 4,78 · φάση 1: 14,46 · φάση 2: 4,66  (σύνολο 19,12)
    φάση 1 → 4,78 × 1446/1912 = 3,62  →  13,46 − 3,62 = 9,84  ✓ όσο λέει η ΗΔΥΚΑ
    φάση 2 → υπόλοιπο        = 1,16  →   4,66 − 1,16 = 3,50

ΓΙΑΤΙ ΑΠΟΘΗΚΕΥΕΤΑΙ ΚΑΙ ΔΕΝ ΥΠΟΛΟΓΙΖΕΤΑΙ ΣΤΗΝ ΑΝΑΓΝΩΣΗ: ο επιμερισμός χρειάζεται ΟΛΕΣ τις
εκτελέσεις της συνταγής — και αυτές μπορεί να πέφτουν έξω από το παράθυρο ημερομηνιών που
ρωτάει η οθόνη. Γραμμένο στην εκτέλεση, κάθε ανάγνωση (ημέρα, μήνας, ΕΤΥΑΠ, κλείσιμο) είναι
σωστή χωρίς να ξέρει τίποτα για τις αδελφές της.
"""

from __future__ import annotations

import re

_FIELD = "details.kyyap_share"


def _phase(external_id: str) -> int:
    parts = str(external_id or "").split(":")
    try:
        return int(parts[1])
    except (IndexError, ValueError):
        return 1


def allocate(rows: list[dict]) -> dict[str, int]:
    """→ {external_id: μερίδιο σε λεπτά}. Καθαρή συνάρτηση, δοκιμάζεται χωρίς βάση."""
    if not rows:
        return {}
    kyyap = max(int((r.get("details") or {}).get("kyyap_covered") or 0) for r in rows)
    order = sorted(rows, key=lambda r: _phase(r.get("external_id", "")))
    if kyyap <= 0:
        return {r["external_id"]: 0 for r in order}
    total = sum(max(0, int(r.get("amount_total") or 0)) for r in order)
    if total <= 0:                       # χωρίς ποσά δεν υπάρχει αναλογία → όλο στην πρώτη φάση
        return {r["external_id"]: (kyyap if i == 0 else 0) for i, r in enumerate(order)}

    shares, used = {}, 0
    for r in order[:-1]:
        s = round(kyyap * max(0, int(r.get("amount_total") or 0)) / total)
        shares[r["external_id"]] = s
        used += s
    shares[order[-1]["external_id"]] = kyyap - used     # τα λεπτά της στρογγυλοποίησης

    # ΦΡΟΥΡΟΣ: κανένα μερίδιο δεν επιτρέπεται να ξεπερνά το αιτούμενο της ίδιας της εκτέλεσης —
    # αλλιώς το ταμείο βγαίνει αρνητικό και η οθόνη το μηδενίζει σιωπηλά, χάνοντας το ποσό.
    # Ό,τι περισσεύει πάει σε αδελφή εκτέλεση που το χωράει.
    claims = {r["external_id"]: max(0, int(r.get("amount_claimed") or 0)) for r in order}
    spill = 0
    for k in list(shares):
        if shares[k] > claims[k]:
            spill += shares[k] - claims[k]
            shares[k] = claims[k]
    for k in sorted(shares, key=lambda x: claims[x] - shares[x], reverse=True):
        if spill <= 0:
            break
        room = claims[k] - shares[k]
        take = min(room, spill)
        shares[k] += take
        spill -= take
    return shares


async def resync_visit(db, tenant_id: str, external_id: str) -> int:
    """Ξαναμοιράζει το ΚΥΥΑΠ σε ΟΛΕΣ τις εκτελέσεις της συνταγής. → πόσες ενημερώθηκαν.

    Καλείται σε κάθε εγγραφή εκτέλεσης με ΚΥΥΑΠ: όταν έρθει η φάση 2, το μερίδιο της φάσης 1
    αλλάζει — άρα ο επιμερισμός πρέπει να ξαναγίνει για όλη τη συνταγή, όχι μόνο για τη νέα.
    """
    visit = str(external_id or "").split(":")[0]
    if not visit:
        return 0
    coll = db["prescription_executions"]
    rows = [r async for r in coll.find(   # tenant-ok: το φίλτρο κουβαλά tenant_id
        {"tenant_id": tenant_id, "external_id": {"$regex": f"^{re.escape(visit)}(:|$)"}},
        {"external_id": 1, "amount_total": 1, "amount_claimed": 1, "details.kyyap_covered": 1})]
    if not rows:
        return 0
    shares = allocate(rows)
    n = 0
    for r in rows:
        want = shares.get(r["external_id"], 0)
        res = await coll.update_one(      # tenant-ok: το φίλτρο κουβαλά tenant_id
            {"_id": r["_id"], "tenant_id": tenant_id}, {"$set": {_FIELD: int(want)}})
        n += res.modified_count
    return n
