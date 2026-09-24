"""Backfill: πόσα τεμάχια δόθηκαν όντως ανά γραμμή (`prescription_items.executed_qty`).

ΓΙΑΤΙ: η ΗΔΥΚΑ δίνει «Υπόλοιπο» (CDA 1.4.19) — μια γραμμή 2 τεμαχίων με υπόλοιπο 1 σημαίνει
ΔΟΘΗΚΕ ΤΟ ΕΝΑ. Το μοντέλο μας κρατούσε μόνο ναι/όχι (`is_executed`), οπότε κάθε μερική
εκτέλεση καταγραφόταν ως ολικά ανεκτέλεστη: ο φαρμακοποιός έβλεπε «ανεκτέλεστο» για φάρμακο
που είχε ήδη δώσει, και ο χαμένος τζίρος χρέωνε ολόκληρη τη συσκευασία αντί για το υπόλοιπο.

Το `details.outstanding` ΑΠΟΘΗΚΕΥΟΤΑΝ ΗΔΗ — άρα η διόρθωση γίνεται ΤΟΠΙΚΑ, χωρίς να
ξανακατεβάσουμε τίποτα από την ΗΔΥΚΑ.

ΤΡΕΞΙΜΟ:  cat scripts/backfill_executed_qty.py | docker exec -i <api> python            (δοκιμή)
           cat scripts/backfill_executed_qty.py | docker exec -i -e APPLY=1 <api> python (εφαρμογή)
"""
import asyncio
import os

from app.core.db import shared_db

APPLY = os.environ.get("APPLY") == "1"

# Ποσότητα, και το υπόλοιπο ως αριθμός (ό,τι δεν μετατρέπεται → άγνωστο).
_Q = {"$max": [0, {"$toInt": {"$ifNull": ["$quantity", 1]}}]}
_O = {"$convert": {"input": "$details.outstanding", "to": "double",
                   "onError": None, "onNull": None}}

# Άγνωστο υπόλοιπο → όλα ή τίποτα (η παλιά συμπεριφορά). Αλλιώς ποσότητα − υπόλοιπο,
# μανταλωμένο στο [0, ποσότητα] ώστε κακό δεδομένο να μη βγάλει ποτέ αρνητικό/υπερβολικό.
_EXEC_QTY = {"$toInt": {"$let": {"vars": {"q": _Q, "o": _O}, "in": {
    "$cond": [{"$eq": ["$$o", None]},
              {"$cond": [{"$ifNull": ["$is_executed", True]}, "$$q", 0]},
              {"$max": [0, {"$min": ["$$q", {"$subtract": ["$$q", {"$round": ["$$o", 0]}]}]}]}]}}}}


async def main():
    db = shared_db()
    coll = db["prescription_items"]
    total = await coll.estimated_document_count()

    # Πόσες γραμμές ΑΛΛΑΖΟΥΝ εικόνα: σήμερα «ανεκτέλεστες», ενώ κάτι είχε δοθεί.
    partial = await coll.aggregate([
        {"$match": {"is_executed": False, "details.outstanding": {"$exists": True}}},
        {"$set": {"_eq": _EXEC_QTY}},
        {"$match": {"$expr": {"$gt": ["$_eq", 0]}}},
        {"$group": {"_id": "$tenant_id", "n": {"$sum": 1},
                    "given": {"$sum": "$_eq"},
                    "over": {"$sum": {"$multiply": ["$retail_price", "$_eq"]}}}},
        {"$sort": {"n": -1}},
    ], allowDiskUse=True).to_list(length=None)

    print(f"γραμμές συνολικά: {total:,}")
    print(f"\nΜΕΡΙΚΩΣ ΕΚΤΕΛΕΣΜΕΝΕΣ που τις λέγαμε ανεκτέλεστες: "
          f"{sum(r['n'] for r in partial):,}")
    print(f"τεμάχια που είχαν δοθεί και δεν μετρούσαν: {sum(r['given'] for r in partial):,}")
    print(f"ΨΕΥΔΩΣ χαμένος τζίρος που αφαιρείται: "
          f"{sum(r['over'] for r in partial) / 100:,.2f} €\n")
    for r in partial:
        print(f"  {str(r['_id']):<42} {r['n']:>7,} γραμμές   "
              f"{r['given']:>6,} τεμ.   {r['over'] / 100:>10,.2f} €")

    if not APPLY:
        print("\n(δοκιμή — τίποτα δεν γράφτηκε· APPLY=1 για εφαρμογή)")
        return

    res = await coll.update_many({}, [{"$set": {"executed_qty": _EXEC_QTY}}])
    print(f"\n✓ ενημερώθηκαν {res.modified_count:,} γραμμές")


asyncio.run(main())
