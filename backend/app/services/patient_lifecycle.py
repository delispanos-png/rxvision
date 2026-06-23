"""Patient lifecycle — διαχείριση θανόντος ασθενή.

Όταν η ΗΔΥΚΑ αναγγείλει θάνατο για έναν ΑΜΚΑ (μήνυμα: «Για τον ΑΜΚΑ που δώσατε έχει
αναγγελθεί Θάνατος στο Εθνικό Μητρώο ΑΜΚΑ-ΕΜΑΕΣ.»), σημαίνουμε τον ασθενή ως θανόντα ώστε:
  • να ΕΞΑΙΡΕΘΕΙ από recall / win-back / cross-sell / μελλοντικές προβλέψεις
  • οι εκκρεμείς (ανεκτέλεστες) μελλοντικές συνταγές του να ακυρωθούν («δεν θα εκτελεστεί λόγω θανάτου»)
  • τυχόν ιστορικές μερικώς-ανεκτέλεστες εκτελέσεις να μαρκαριστούν ομοίως

Το authoritative flag ζει στο `patient_contacts` (pharmacist-controlled, ΞΕΧΩΡΙΣΤΟ collection),
ώστε ένα ΗΔΥΚΑ re-ingest να ΜΗΝ «αναστήσει» τον ασθενή. Παράλληλα κρατάμε `deceased` flag στο
`patients_anonymized` για ένδειξη/badge & εξαίρεση στις αναλυτικές λίστες (το ingestion δεν το πειράζει).

ΕΝΕΡΓΟΠΟΙΕΙΤΑΙ όταν ξεμπλοκάρει η live ΗΔΥΚΑ (getpatient): ο caller κάνει
`HdikaClient.get_patient(amka)` και, αν σηκωθεί `PatientDeceased`, καλεί `mark_deceased(...)`.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import db_resolver
from app.repositories.contacts import PatientContactRepository


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def mark_deceased(tenant_id: str, amka: str, *, isolation_tier: str = "shared") -> dict:
    """Σημαίνει τον ασθενή με αυτό το ΑΜΚΑ ως θανόντα στον συγκεκριμένο tenant και
    ακυρώνει τις εκκρεμείς συνταγές του. Idempotent. Επιστρέφει σύνοψη ενεργειών."""
    amka = (amka or "").strip()
    if not amka:
        return {"matched": False, "reason": "no_amka"}
    db = db_resolver.resolve(tenant_id=tenant_id, isolation_tier=isolation_tier)
    # Το ΗΔΥΚΑ επιστρέφει το raw ΑΜΚΑ· το κρατάμε (όταν isdigit) και είναι indexed → άμεσο lookup.
    pa = await db["patients_anonymized"].find_one({"tenant_id": tenant_id, "amka": amka})
    if not pa:
        return {"matched": False, "reason": "patient_not_found", "amka": amka}
    pid = pa["_id"]
    now = _now()

    # 1) authoritative deceased flag (επιβιώνει ΗΔΥΚΑ re-ingest)
    await PatientContactRepository(tenant_id=tenant_id).upsert(
        str(pid), {"active": False, "inactive_reason": "deceased"})

    # 2) ένδειξη/badge + εξαίρεση αναλυτικών λιστών (το ingestion δεν αγγίζει αυτό το πεδίο)
    await db["patients_anonymized"].update_one(
        {"tenant_id": tenant_id, "_id": pid},
        {"$set": {"deceased": True, "deceased_at": now}})

    # 3) εκκρεμείς μελλοντικές (ανεκτέλεστες) → ακύρωση «λόγω θανάτου»
    fp = await db["future_prescriptions"].update_many(
        {"tenant_id": tenant_id, "patient_ref": pid, "status": "pending"},
        {"$set": {"status": "cancelled", "cancel_reason": "deceased", "cancelled_at": now}})

    # 4) ιστορικές μερικώς-ανεκτέλεστες εκτελέσεις → μαρκάρισμα «δεν θα εκτελεστεί λόγω θανάτου»
    ex = await db["prescription_executions"].update_many(
        {"tenant_id": tenant_id, "patient_ref": pid, "has_unexecuted_substances": True},
        {"$set": {"unexecuted_void": "deceased", "unexecuted_void_at": now}})

    return {
        "matched": True, "patient_ref": str(pid), "amka": amka,
        "future_cancelled": fp.modified_count,
        "executions_flagged": ex.modified_count,
    }
