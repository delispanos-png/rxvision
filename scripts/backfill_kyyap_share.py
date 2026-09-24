"""Backfill: μερίδιο ΚΥΥΑΠ ανά εκτέλεση (`details.kyyap_share`).

ΓΙΑΤΙ: η ΗΔΥΚΑ δίνει την κάλυψη ΚΥΥΑΠ ΑΝΑ ΣΥΝΤΑΓΗ και τη γράφει σε κάθε φάση. Μέχρι τώρα
αποδιδόταν ΟΛΟΚΛΗΡΗ στη φάση 1, οπότε η πρώτη ημέρα έβγαινε λιγότερη και η δεύτερη περισσότερη.
Βλ. `services/ingestion/kyyap_split.py` για τον σωστό (αναλογικό) επιμερισμό.

ΤΡΕΞΙΜΟ:  cat scripts/backfill_kyyap_share.py | docker exec -i <api> python           (δοκιμή)
           cat scripts/backfill_kyyap_share.py | docker exec -i -e APPLY=1 <api> python (εφαρμογή)
"""
import asyncio
import os
from collections import defaultdict

from app.core.db import shared_db
from app.services.ingestion.kyyap_split import allocate

APPLY = os.environ.get("APPLY") == "1"


async def main():
    db = shared_db()
    rows = [r async for r in db["prescription_executions"].find(
        {"details.kyyap_covered": {"$gt": 0}},
        {"tenant_id": 1, "external_id": 1, "amount_total": 1, "amount_claimed": 1,
         "executed_at": 1, "details.kyyap_covered": 1, "details.kyyap_share": 1})]
    visits = defaultdict(list)
    for r in rows:
        visits[(r["tenant_id"], str(r.get("external_id") or "").split(":")[0])].append(r)

    changed = writes = 0
    per_tenant = defaultdict(lambda: [0, 0])          # [εκτελέσεις, συνταγές]
    moved = defaultdict(int)                          # μετατόπιση ανά μήνα (λεπτά)
    for (tid, visit), rs in visits.items():
        shares = allocate(rs)
        multi = len(rs) > 1
        for r in rs:
            want = int(shares.get(r["external_id"], 0))
            have = (r.get("details") or {}).get("kyyap_share")
            if have == want:
                continue
            changed += 1
            per_tenant[tid][0] += 1
            if multi:
                old = ((r.get("details") or {}).get("kyyap_covered") or 0) \
                    if str(r["external_id"]).split(":")[-1] in ("1", r["external_id"]) else 0
                moved[r["executed_at"].strftime("%Y-%m")] += old - want
            if APPLY:
                res = await db["prescription_executions"].update_one(
                    {"_id": r["_id"], "tenant_id": tid},   # tenant-ok: φίλτρο με tenant_id
                    {"$set": {"details.kyyap_share": want}})
                writes += res.modified_count
        if multi:
            per_tenant[tid][1] += 1

    print(f"{'ΕΦΑΡΜΟΓΗ' if APPLY else 'ΔΟΚΙΜΗ (χωρίς εγγραφές)'}")
    print(f"συνταγές με ΚΥΥΑΠ: {len(visits)} · εκτελέσεις: {len(rows)}")
    print(f"εκτελέσεις που αλλάζουν: {changed}" + (f" · γράφτηκαν: {writes}" if APPLY else ""))
    for tid, (n, v) in sorted(per_tenant.items(), key=lambda x: -x[1][0]):
        t = await db["tenants"].find_one({"_id": tid}, {"name": 1}) or {}
        print(f"   {(t.get('name') or tid)[:34]:36} εκτελέσεις={n:5}  πολυ-φασικές συνταγές={v}")
    if moved:
        print("\nμετατόπιση ΕΟΠΥΥ ανά μήνα (μόνο πολυ-φασικές):")
        for mth in sorted(moved):
            if moved[mth]:
                print(f"   {mth}  {moved[mth]/100:+8.2f} €")

asyncio.run(main())
