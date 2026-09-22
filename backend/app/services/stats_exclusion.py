"""Εκτελέσεις που ο φαρμακοποιός δηλώνει ότι ΔΕΝ μετρούν στα στατιστικά του.

ΓΙΑΤΙ ΧΡΕΙΑΖΕΤΑΙ: η ΗΔΥΚΑ καταχωρεί λάθη και ΔΕΝ μπαίνει πάντα στη διαδικασία να τα ακυρώσει.
Πραγματικό περιστατικό (22/09/2026): μία εκτέλεση 16.162.808 € σε φαρμακείο με συνολικό τζίρο
17.232.104 € — δηλαδή **94% του τζίρου του ήταν μία λάθος εγγραφή**. Κάθε στατιστικό άχρηστο.

⚠️ ΓΙΑΤΙ ΞΕΧΩΡΙΣΤΟ ΠΕΔΙΟ ΚΑΙ ΟΧΙ ΤΟ `cancelled`: το `cancelled` το γράφει η ΑΝΤΛΗΣΗ σε κάθε
συγχρονισμό (`engine.py`) και το `cancellations.py` το επαναφέρει σε False όταν η ΗΔΥΚΑ
εξακολουθεί να δηλώνει τη συνταγή ενεργή. Μια εξαίρεση εκεί θα σβηνόταν ΣΙΩΠΗΛΑ την επόμενη
μέρα, και ο φαρμακοποιός θα ξανάβλεπε το λάθος χωρίς να καταλαβαίνει γιατί.

⚠️ ΔΕΝ ΠΕΙΡΑΖΟΥΜΕ ΤΑ ΠΟΣΑ. Παλιότερη προσπάθεια «εξαίρεσης» που άλλαζε τιμές χάλασε 74
συνταγές και αφαιρέθηκε. Τα ποσά μένουν ΑΚΡΙΒΩΣ όπως τα έδωσε η ΗΔΥΚΑ — αλλάζει μόνο το ΑΝ
μετρώνται. Έτσι η εξαίρεση είναι πάντα αναστρέψιμη και ελέγξιμη.

ΤΙ ΔΕΝ ΑΓΓΙΖΕΙ: την αποζημίωση/κλείσιμο. Εκεί συμφωνούμε με τα ΔΙΚΑ ΤΟΥΣ νούμερα· αν κρύψουμε
μια εκτέλεση που ο ΕΟΠΥΥ βλέπει, η συμφωνία σπάει και ο φαρμακοποιός κυνηγά φάντασμα.
"""

from __future__ import annotations

from datetime import datetime, timezone

FIELD = "excluded_from_stats"

#: Μπαίνει σε ΚΑΘΕ ερώτημα που μετράει τζίρο/όγκο. Ένας ορισμός, ένα σημείο αλλαγής.
NOT_EXCLUDED: dict = {FIELD: {"$ne": True}}


def countable(match: dict | None = None) -> dict:
    """`{...φίλτρα σου}` → το ίδιο, χωρίς τις εξαιρεμένες εκτελέσεις."""
    return {**(match or {}), **NOT_EXCLUDED}


async def set_excluded(db, tenant_id: str, external_id: str, *, excluded: bool,
                       reason: str = "", by: str | None = None) -> int:
    """Σημειώνει/ξε-σημειώνει μία εκτέλεση. Επιστρέφει πόσες εγγραφές άλλαξαν."""
    now = datetime.now(tz=timezone.utc)
    upd = ({"$set": {FIELD: True, "excluded_reason": (reason or "")[:300],
                     "excluded_by": by, "excluded_at": now}}
           if excluded else
           {"$unset": {FIELD: "", "excluded_reason": "", "excluded_by": "", "excluded_at": ""}})
    res = await db["prescription_executions"].update_one(
        {"tenant_id": tenant_id, "external_id": external_id}, upd)          # tenant-scoped ΠΑΝΤΑ
    if res.matched_count:
        # Τα είδη της συνταγής ακολουθούν, αλλιώς η κερδοφορία ανά είδος θα συνέχιζε να τη μετρά.
        ex = await db["prescription_executions"].find_one(
            {"tenant_id": tenant_id, "external_id": external_id}, {"_id": 1})
        if ex:
            await db["prescription_items"].update_many(
                {"tenant_id": tenant_id, "execution_id": ex["_id"]}, upd)
    return res.matched_count
