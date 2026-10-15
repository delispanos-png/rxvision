"""Σύμβουλος: δανεικό ΘΑΝΟΝΤΟΣ (14/10/2026 — ΤΣΟΥΛΟΥΒΗΣ, φαρμακείο Παπαγιαννόπουλου).

Όχι «πάρ' τον τηλέφωνο» σε άνθρωπο που απεβίωσε· όνομα από την ΚΑΡΤΕΛΑ (όχι το κρυμμένο του δανεικού)·
οικογένεια/δομή για να τακτοποιηθεί· και τα χωρίς ημερομηνία δανεικά θανόντων εμφανίζονται.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.repositories.daily_coach import DailyCoachRepository
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

T = "tenant-coach"
NOW = datetime(2026, 10, 14, 9, tzinfo=timezone.utc)


async def _repo(dead: bool, groups: list[tuple[str, str]]):
    db = AsyncMongoMockClient()["coach_dead"]
    pid = ObjectId()
    await db["patients_anonymized"].insert_one({
        "_id": pid, "tenant_id": T, "pseudo_id": "ps1", "full_name": "ΤΣΟΥΛΟΥΒΗΣ ΠΑΝΑΓΙΩΤΗΣ",
        "sex": "M", "amka": "13073800057", "deceased": dead})
    for kind, name in groups:
        await db["patient_groups"].insert_one({"tenant_id": T, "kind": kind, "name": name, "active": True,
                                               "members": [{"pseudo_id": "ps1"}]})
    await db["advance_dispensings"].insert_many([
        {"tenant_id": T, "patient_ref": str(pid), "patient_name": "Τ**** ΠΑΝΑΓΙΩΤΗΣ", "status": "open",
         "expected_at": "2026-09-28", "items": [{"name": "SALOSPIR"}], "created_at": NOW},
        {"tenant_id": T, "patient_ref": str(pid), "patient_name": "Τ**** ΠΑΝΑΓΙΩΤΗΣ", "status": "open",
         "expected_at": None, "items": [{"name": "LASIX"}], "created_at": NOW}])
    repo = DailyCoachRepository(tenant_id=T)
    repo._db = db
    return repo


async def test_deceased_loan_names_family_and_care_and_uses_card_name():
    repo = await _repo(True, [("family", "Οικογένεια Τσουλούβη"), ("care", "Εστία Θαλπωρής")])
    found = await repo._sig_advance_due(NOW)
    assert len(found) == 2                                     # και το χωρίς ημερομηνία
    assert all(f["name"] == "ΤΣΟΥΛΟΥΒΗΣ ΠΑΝΑΓΙΩΤΗΣ" for f in found)   # όχι «Τ****»
    card = repo._speak(found[0], {})
    assert card["title"].startswith("Σύμφωνα με την ΗΔΥΚΑ, ο ΤΣΟΥΛΟΥΒΗΣ ΠΑΝΑΓΙΩΤΗΣ απεβίωσε")
    assert "«Οικογένεια Τσουλούβη»" in card["body"] and "«Εστία Θαλπωρής»" in card["body"]
    assert "τηλέφωνο" not in card["action"]


async def test_alive_patient_keeps_normal_reminder_and_ignores_undated():
    repo = await _repo(False, [])
    found = await repo._sig_advance_due(NOW)
    assert len(found) == 1                                     # μόνο το δανεικό με ημερομηνία
    card = repo._speak(found[0], {})
    assert "δεν έφερε ακόμη τη συνταγή" in card["title"] and "ΤΣΟΥΛΟΥΒΗΣ" in card["title"]
