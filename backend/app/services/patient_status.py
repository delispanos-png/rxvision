"""Κατάσταση πελάτη (`patients_anonymized.lifecycle`) — ΕΝΑΣ ορισμός, ίδιος με την Εικόνα Ασθενών.

Έως 01/10/2026 το πεδίο γραφόταν ΜΟΝΟ ως «new» (πρώτη εμφάνιση) ή «active» (κάθε εκτέλεση) και δεν
άλλαζε ποτέ: 80.799 «active» σε όλη την πλατφόρμα. Άρα το κοινό καμπάνιας «σε κίνδυνο»/«χαμένοι»
ήταν πάντα άδειο και κάθε «ενεργοί» σήμαινε «όσοι πέρασαν ποτέ».

Ορισμός (ημέρες από την τελευταία εκτέλεση, `last_seen_at`) — ίδια όρια με την Εικόνα Ασθενών
(`active_60d`, win-back κουβάδες 60/90/180/365, «Χαμένοι» = 90–365):
  new       πρώτη εμφάνιση ≤ 60 ημέρες
  active    ≤ 60 ημέρες
  at_risk   60–90
  lost      90–365
  inactive  > 365
Ξαναϋπολογίζεται κάθε βράδυ (`refresh`). Οι θανόντες κρατούν τη σημαία `deceased` — εξαιρούνται
χωριστά παντού· οι διαγραμμένοι GDPR («erased») δεν αγγίζονται.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

ACTIVE_DAYS = 60
AT_RISK_DAYS = 90
LOST_DAYS = 365
STATES = ("new", "active", "at_risk", "lost", "inactive")


async def refresh(db, tenant_id: str, now: datetime | None = None) -> dict:
    now = now or datetime.now(tz=timezone.utc)
    a, r, lo = (now - timedelta(days=d) for d in (ACTIVE_DAYS, AT_RISK_DAYS, LOST_DAYS))
    base = {"tenant_id": tenant_id, "lifecycle": {"$ne": "erased"}}
    rules = [
        ("new", {"first_seen_at": {"$gte": a}}),
        ("active", {"last_seen_at": {"$gte": a}, "first_seen_at": {"$not": {"$gte": a}}}),
        ("at_risk", {"last_seen_at": {"$gte": r, "$lt": a}}),
        ("lost", {"last_seen_at": {"$gte": lo, "$lt": r}}),
        ("inactive", {"$or": [{"last_seen_at": {"$lt": lo}}, {"last_seen_at": None}]}),
    ]
    out = {}
    for state, q in rules:
        res = await db["patients_anonymized"].update_many(  # tenant-ok: base έχει tenant_id
            {**base, **q, "lifecycle": {"$nin": ["erased", state]}}, {"$set": {"lifecycle": state}})
        out[state] = res.modified_count
    return out
