"""Νυχτερινός αυτοέλεγχος συνέπειας δεδομένων — να βρίσκουμε ΕΜΕΙΣ το λάθος πριν από τον πελάτη.

Κάθε έλεγχος είναι μια σχέση που ΠΡΕΠΕΙ να ισχύει. Όλα τα σφάλματα 28/09–01/10/2026 θα είχαν πιαστεί
από έναν από αυτούς: γραμμές ≠ σύνολο συνταγής (352/369), φαντάσματα προβλέψεων (26.453), διπλές
προβλέψεις ανά συνταγή (3.041), τεμάχια ×N (+5,6%), κατάλογος ΗΔΥΚΑ παγωμένος από 26/06.

Κάθε συνάρτηση επιστρέφει `Finding` ή None. ΜΟΝΟ ανάγνωση — ποτέ διόρθωση εδώ: ο έλεγχος λέει τι
βρήκε, η διόρθωση είναι απόφαση ανθρώπου. Τα όρια (`rate`) είναι πάνω από τη μετρημένη βάση
01/10/2026, ώστε να ηχεί μόνο όταν κάτι ΧΑΛΑΣΕΙ — όχι κάθε βράδυ για τα ίδια γνωστά.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone

from app.services import dispensed
from app.services.repeat_windows import next_repeat_open, period_days
from app.services.stats_exclusion import COUNTABLE_EXEC

WINDOW_DAYS = 35          # πόσο πίσω κοιτάμε τις εκτελέσεις κάθε νύχτα
CATALOG_MAX_AGE_DAYS = 14


@dataclass
class Finding:
    check: str
    title: str                 # τι σπάει, σε ανθρώπινη γλώσσα
    bad: int
    total: int
    tenant_id: str | None = None
    sample: list = field(default_factory=list)   # έως 5 αναγνωριστικά για να το βρεις

    def as_dict(self) -> dict:
        d = asdict(self)
        d["rate"] = round(self.bad / self.total, 4) if self.total else None
        return d


def _f(check, title, bad, total, tenant_id=None, sample=None, *, rate: float = 0.0):
    """Finding μόνο αν ξεπεραστεί το όριο (ποσοστό επί του συνόλου· 0 = κάθε περίπτωση)."""
    if bad <= 0 or (total and bad / total <= rate):
        return None
    return Finding(check, title, bad, total, tenant_id, (sample or [])[:5])


async def _recent_execs(db, tid: str, since: datetime) -> list[dict]:
    return [e async for e in db["prescription_executions"].find(
        {"tenant_id": tid, **COUNTABLE_EXEC, "executed_at": {"$gte": since}},
        {"external_id": 1, "amount_total": 1, "amount_claimed": 1, "patient_share": 1,
         "details.fund_surcharge": 1})]


async def check_tenant(db, tid: str, now: datetime | None = None) -> list[Finding]:
    now = now or datetime.now(tz=timezone.utc)
    since = now - timedelta(days=WINDOW_DAYS)
    out: list[Finding | None] = []
    exs = await _recent_execs(db, tid, since)
    if not exs:
        return []
    ids = [e["_id"] for e in exs]
    items: dict = {}
    for i in range(0, len(ids), 2000):
        async for it in db["prescription_items"].find(
                {"tenant_id": tid, "execution_id": {"$in": ids[i:i + 2000]}},
                {"execution_id": 1, "retail_price": 1, "qty_here": 1, "quantity": 1, "executed_qty": 1,
                 "details.retail_price": 1, "details.patient_share": 1, "details.difference": 1}):
            items.setdefault(it["execution_id"], []).append(it)
    # συνταγές με >1 εγγραφή — ΚΑΙ όταν η άλλη εγγραφή είναι εκτός παραθύρου
    multi = {dispensed.rx_root(e["external_id"]) for e in exs if dispensed.record_no(e["external_id"]) > 1}
    firsts = [dispensed.rx_root(e["external_id"]) + ":2" for e in exs
              if dispensed.record_no(e["external_id"]) == 1]
    for i in range(0, len(firsts), 2000):
        async for e in db["prescription_executions"].find(
                {"tenant_id": tid, "external_id": {"$in": firsts[i:i + 2000]}}, {"external_id": 1}):
            multi.add(dispensed.rx_root(e["external_id"]))

    # 1) το σύνολο της ΗΔΥΚΑ μοιράζεται ακριβώς σε ταμείο + ασθενή
    bad = [e["external_id"] for e in exs if (e.get("amount_total") or 0)
           != (e.get("amount_claimed") or 0) + (e.get("patient_share") or 0)]
    out.append(_f("exec_split", "Σύνολο συνταγής ≠ ταμείο + ασθενής", len(bad), len(exs), tid, bad))

    # 2) οι γραμμές (λιανική × τεμάχια ΑΥΤΗΣ της εγγραφής) αθροίζουν στο σύνολο — βάση 0,04%
    bad, no_items, no_qty = [], [], 0
    for e in exs:
        its = items.get(e["_id"]) or []
        if not its:
            no_items.append(e["external_id"])
            continue
        s = 0
        for it in its:
            if it.get("qty_here") is None:
                no_qty += 1
            r = (it.get("details") or {}).get("retail_price")
            r = it.get("retail_price") or 0 if r is None else r
            s += int(r) * int(it.get("qty_here") if it.get("qty_here") is not None
                              else (it.get("executed_qty") or 0))
        if abs(s - (e.get("amount_total") or 0)) > 100:
            bad.append(e["external_id"])
    out.append(_f("lines_vs_total", "Γραμμές συνταγής δεν αθροίζουν στο σύνολο (>1 €)",
                  len(bad), len(exs), tid, bad, rate=0.01))
    out.append(_f("exec_without_items", "Εκτέλεση χωρίς κανένα είδος", len(no_items), len(exs), tid,
                  no_items, rate=0.005))
    out.append(_f("qty_here_missing", "Είδη χωρίς `qty_here` (το ingestion δεν το γράφει)", no_qty,
                  sum(len(v) for v in items.values()), tid))

    # 3) συμμετοχή ασθενή: Σ(συμμετοχή+διαφορά) γραμμών + (1 € ανά συνταγή | στρογγυλοποίηση)
    bad, single = [], 0
    for e in exs:
        if dispensed.rx_root(e["external_id"]) in multi:
            continue                                # τμηματικές: τα ποσά γραμμής αφορούν όλη τη συνταγή
        single += 1
        lines = sum(int((it.get("details") or {}).get("patient_share") or 0)
                    + int((it.get("details") or {}).get("difference") or 0)
                    for it in items.get(e["_id"]) or [])
        res = (e.get("patient_share") or 0) - lines
        fee = bool((e.get("details") or {}).get("fund_surcharge"))
        if not (abs(res) <= 2 or (fee and 95 <= res <= 102)):
            bad.append(e["external_id"])
    out.append(_f("patient_lines", "Συμμετοχή ασθενή γραμμών ≠ συνταγής (πέρα από 1 €/στρογγυλοποίηση)",
                  len(bad), single, tid, bad, rate=0.03))

    # 4) προβλέψεις: χωρίς πηγή (φαντάσματα), διπλές ανά συνταγή, ημερομηνία ≠ κανόνα ΗΔΥΚΑ
    preds = [p async for p in db["future_prescriptions"].find(
        {"tenant_id": tid, "status": "pending"}, {"source_execution_id": 1, "expected_open_date": 1})]
    src_ids = list({p.get("source_execution_id") for p in preds if p.get("source_execution_id")})
    src: dict = {}
    for i in range(0, len(src_ids), 2000):
        async for e in db["prescription_executions"].find(
                {"tenant_id": tid, "_id": {"$in": src_ids[i:i + 2000]}},
                {"external_id": 1, "valid_from": 1, "executed_at": 1, "repeat_current": 1,
                 "details.repeat_period_days": 1, "details.interval_months": 1}):
            src[e["_id"]] = e
    phantom = [str(p["_id"]) for p in preds if p.get("source_execution_id") not in src]
    out.append(_f("prediction_phantom", "Μελλοντικές χωρίς συνταγή-πηγή (φαντάσματα)",
                  len(phantom), len(preds), tid, phantom))
    per_rx: dict = {}
    wrong_date = []
    for p in preds:
        e = src.get(p.get("source_execution_id"))
        if not e:
            continue
        per_rx.setdefault(dispensed.rx_root(e.get("external_id")), []).append(p)
        exp = next_repeat_open(e.get("valid_from"), e["executed_at"], e.get("repeat_current") or 1,
                               period_days(e.get("details")))
        if p.get("expected_open_date") and exp.date() != p["expected_open_date"].date():
            wrong_date.append(e.get("external_id"))
    dup = [rx for rx, ps in per_rx.items() if len(ps) > 1]
    out.append(_f("prediction_duplicate", "Πάνω από μία ανοιχτή πρόβλεψη για την ίδια συνταγή",
                  len(dup), len(per_rx), tid, dup))
    out.append(_f("prediction_date", "Ημερομηνία Μελλοντικής ≠ «ΑΠΟ + k × βήμα»",
                  len(wrong_date), len(preds), tid, wrong_date))
    return [f for f in out if f]


async def check_platform(db, now: datetime | None = None) -> list[Finding]:
    now = now or datetime.now(tz=timezone.utc)
    out: list[Finding | None] = []
    # κατάλογος φαρμάκων ΗΔΥΚΑ — βρέθηκε παγωμένος από 26/06/2026 (κανείς δεν τον ανανέωνε)
    last = await db["medicine_catalog"].find_one({}, {"updated_at": 1}, sort=[("updated_at", -1)])
    lu = (last or {}).get("updated_at")
    if lu and lu.tzinfo is None:
        lu = lu.replace(tzinfo=timezone.utc)
    age = (now - lu).days if lu else 9999
    if age > CATALOG_MAX_AGE_DAYS:
        out.append(Finding("catalog_stale", f"Ο κατάλογος φαρμάκων ΗΔΥΚΑ έχει να ανανεωθεί {age} ημέρες "
                                            "(τιμές, αποσύρσεις, μηνύματα ΗΔΥΚΑ παλιά)", age, CATALOG_MAX_AGE_DAYS))
    # η ίδια εκτέλεση σε δύο φαρμακεία (πινγκ-πονγκ / λάθος μεταφορά)
    since = now - timedelta(days=WINDOW_DAYS)
    rows = await db["prescription_executions"].aggregate([   # tenant-ok: πλατφόρμα, ανά external_id
        {"$match": {"executed_at": {"$gte": since}}},
        {"$group": {"_id": "$external_id", "t": {"$addToSet": "$tenant_id"}}},
        {"$match": {"t.1": {"$exists": True}}},
        {"$limit": 50}], allowDiskUse=True).to_list(length=None)
    out.append(_f("cross_tenant_duplicate", "Η ίδια εκτέλεση υπάρχει σε δύο φαρμακεία",
                  len(rows), len(rows), None, [r["_id"] for r in rows]))
    return [f for f in out if f]
