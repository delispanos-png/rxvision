"""Data retention — κυλιόμενο παράθυρο ΑΝΑ ΦΑΡΜΑΚΕΙΟ.

Default 36 μήνες (χωρίς extra χρέωση). Ο πελάτης μπορεί να αγοράσει μεγαλύτερο παράθυρο (π.χ. 60μ)
ως πρόσθετη υπηρεσία → `tenants.retention_months`. Εκτελέσεις/είδη παλαιότερα από το ΔΙΚΟ ΤΟΥ cutoff
διαγράφονται ΟΡΙΣΤΙΚΑ (GDPR data minimization).

Το κατώφλι του ingestion σέβεται ΤΟ ΙΔΙΟ per-tenant cutoff (ingestion._watermark) ώστε η ΗΔΥΚΑ να
ΜΗΝ ξανακατεβάζει ό,τι μόλις καθαρίσαμε. Και τα δύο collections (prescription_executions,
prescription_items) έχουν δικό τους `executed_at` → διαγραφή απευθείας με ημερομηνία, χωρίς joins.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db

DEFAULT_RETENTION_MONTHS = 36    # τρέχον + 2 προηγούμενα χρόνια — το βασικό (χωρίς χρέωση)
MIN_RETENTION_MONTHS = 36        # ποτέ κάτω από αυτό (νομικό/λειτουργικό ελάχιστο)
MAX_RETENTION_MONTHS = 120       # ασφαλές ταβάνι
DEFAULT_PRICE_PER_EXTRA_YEAR = 1000   # cents/μήνα ανά ΕΠΙΠΛΕΟΝ έτος πάνω από 36μ (default 10€/μ)


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def cutoff_for(months: int, now: datetime | None = None) -> datetime:
    """Παλαιότερη ημερομηνία που ΚΡΑΤΑΜΕ (executed_at < αυτής → διαγραφή)."""
    now = now or _utcnow()
    total = now.year * 12 + (now.month - 1) - int(months)
    y, m = divmod(total, 12)
    m += 1
    # κράτα την ημέρα, με clamp για σύντομους μήνες (π.χ. 31→28)
    day = min(now.day, [31, 29 if y % 4 == 0 and (y % 100 or not y % 400) else 28,
                        31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1])
    return now.replace(year=y, month=m, day=day)


def clamp_months(months) -> int:
    try:
        v = int(months)
    except (TypeError, ValueError):
        return DEFAULT_RETENTION_MONTHS
    return max(MIN_RETENTION_MONTHS, min(MAX_RETENTION_MONTHS, v))


async def tenant_retention_months(db, tenant_id: str) -> int:
    """Το συμφωνημένο παράθυρο του φαρμακείου (default 36). Ρυθμίζεται από το adminpanel/add-on."""
    t = await db["tenants"].find_one({"_id": tenant_id}, {"retention_months": 1})
    return clamp_months((t or {}).get("retention_months") or DEFAULT_RETENTION_MONTHS)


async def tenant_cutoff(db, tenant_id: str, now: datetime | None = None) -> datetime:
    return cutoff_for(await tenant_retention_months(db, tenant_id), now)


# ── Τιμολόγηση extended retention (κλιμακωτά, ανά επιπλέον έτος πάνω από 36μ) ──────────────
def extra_years(months) -> int:
    """Πόσα ΕΠΙΠΛΕΟΝ έτη πάνω από το βασικό (36μ). 36→0, 48→1, 60→2, 72→3…"""
    m = clamp_months(months)
    return max(0, -(-(m - DEFAULT_RETENTION_MONTHS) // 12))   # ceil((m-36)/12)


async def retention_price_per_year(db=None) -> int:
    """Μηνιαία χρέωση (cents) ανά επιπλέον έτος retention — platform setting, ρυθμιζόμενη."""
    db = db if db is not None else shared_db()
    doc = await db["platform_settings"].find_one({"_id": "retention"})
    v = (doc or {}).get("price_per_year_cents")
    return int(v) if v is not None else DEFAULT_PRICE_PER_EXTRA_YEAR


async def retention_surcharge_monthly(db, tenant_id: str) -> int:
    """Μηνιαία επιβάρυνση (cents) του φαρμακείου για extended retention (0 αν 36μ)."""
    months = await tenant_retention_months(db, tenant_id)
    return extra_years(months) * await retention_price_per_year(db)


async def _batched_delete(coll, query: dict, batch: int = 5000) -> int:
    """Διαγραφή σε παρτίδες ώστε ένα μεγάλο πρώτο run να μη «κλειδώνει» τη βάση."""
    total = 0
    while True:
        ids = [d["_id"] async for d in coll.find(query, {"_id": 1}).limit(batch)]
        if not ids:
            break
        res = await coll.delete_many({"_id": {"$in": ids}})
        total += res.deleted_count
        if len(ids) < batch:
            break
    return total


async def storage_by_tenant(db=None) -> list[dict]:
    """Εκτίμηση αποθηκευτικού χώρου ΑΝΑ φαρμακείο (για διαφάνεια κόστους — όχι billing-grade).

    Οι collections είναι κοινές (tenant_id-scoped), οπότε το ακριβές μέγεθος/tenant δεν υπάρχει
    στη Mongo. Εκτίμηση: πλήθος εγγραφών × μέσο μέγεθος (avgObjSize) + αναλογικό μερίδιο indexes.
    Αρκετά ακριβές για να δεις ποιος καταναλώνει πολύ.
    """
    db = db if db is not None else shared_db()
    stats = {}
    for coll in ("prescription_executions", "prescription_items"):
        try:
            stats[coll] = await db.command("collStats", coll)
        except Exception:  # noqa: BLE001
            stats[coll] = {}
    avg_ex = stats["prescription_executions"].get("avgObjSize", 0) or 0
    avg_it = stats["prescription_items"].get("avgObjSize", 0) or 0
    idx_ex = stats["prescription_executions"].get("totalIndexSize", 0) or 0
    idx_it = stats["prescription_items"].get("totalIndexSize", 0) or 0
    tot_ex = max(1, stats["prescription_executions"].get("count", 0) or 0)
    tot_it = max(1, stats["prescription_items"].get("count", 0) or 0)
    ex_n = {r["_id"]: r["n"] async for r in db["prescription_executions"].aggregate(
        [{"$group": {"_id": "$tenant_id", "n": {"$sum": 1}}}])}
    it_n = {r["_id"]: r["n"] async for r in db["prescription_items"].aggregate(
        [{"$group": {"_id": "$tenant_id", "n": {"$sum": 1}}}])}
    rows = []
    async for t in db["tenants"].find({}, {"_id": 1, "name": 1}):
        tid = t["_id"]
        ne, ni = ex_n.get(tid, 0), it_n.get(tid, 0)
        b = ne * avg_ex + ni * avg_it + idx_ex * (ne / tot_ex) + idx_it * (ni / tot_it)
        rows.append({"tenant_id": str(tid), "name": t.get("name"),
                     "executions": ne, "items": ni, "mb": round(b / 1048576, 1)})
    rows.sort(key=lambda r: -r["mb"])
    return rows


async def purge_old(db=None, *, dry_run: bool = False) -> dict:
    """Καθαρισμός εκτός παραθύρου, ΑΝΑ ΦΑΡΜΑΚΕΙΟ (κάθε ένα με το δικό του retention).
    dry_run=True → μόνο μέτρηση. Επιστρέφει σύνολα + ανάλυση ανά φαρμακείο.
    db: πέρασέ το από worker context (_fresh_db)· default = shared_db() για FastAPI."""
    db = db if db is not None else shared_db()
    now = _utcnow()
    per: list[dict] = []
    tot_exec = tot_item = 0
    async for t in db["tenants"].find({}, {"_id": 1, "name": 1, "retention_months": 1}):
        tid = t["_id"]
        months = clamp_months(t.get("retention_months") or DEFAULT_RETENTION_MONTHS)
        cutoff = cutoff_for(months, now)
        q = {"tenant_id": tid, "executed_at": {"$lt": cutoff}}
        n_exec = await db["prescription_executions"].count_documents(q)   # tenant-ok: scoped by tenant_id
        n_item = await db["prescription_items"].count_documents(q)
        if not dry_run and (n_exec or n_item):
            # items ΠΡΩΤΑ (τα «παιδιά»), μετά οι εκτελέσεις — αν διακοπεί, δεν μένουν ορφανά items
            await _batched_delete(db["prescription_items"], q)
            await _batched_delete(db["prescription_executions"], q)
        if n_exec or n_item:
            per.append({"tenant_id": str(tid), "name": t.get("name"), "months": months,
                        "cutoff": cutoff.date().isoformat(), "executions": n_exec, "items": n_item})
        tot_exec += n_exec
        tot_item += n_item
    return {"deleted": not dry_run, "executions": tot_exec, "items": tot_item, "per_tenant": per}
