"""Migration: παλιά `permissions[]` ανά χρήστη → ομάδες (`group_ids`).

Idempotent — τρέχει όσες φορές θέλεις. Τρέξ' το ΜΙΑ φορά μετά το deploy:

    docker compose exec api python scripts/migrate_platform_groups.py

Τι κάνει:
  1. Δημιουργεί/ενημερώνει τις default ομάδες (`seed_platform_groups`).
  2. Αντιστοιχίζει κάθε υπάρχοντα admin σε ομάδες με βάση τις παλιές του ενότητες.
  3. ΔΕΝ σβήνει το παλιό `permissions[]` — μένει για rollback. Ο νέος κώδικας το αγνοεί.

Οι super admins δεν θίγονται: κρατούν wildcard, χωρίς ομάδες.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone

from app.core.db import shared_db
from app.services.platform_rbac import DEFAULT_GROUPS, seed_platform_groups

# Παλιά ενότητα → ομάδες που καλύπτουν την ίδια δουλειά. Σκόπιμα γενναιόδωρο: ο στόχος
# της migration είναι να ΜΗΝ χάσει κανείς πρόσβαση που είχε· το σφίξιμο γίνεται μετά,
# χειροκίνητα, ανά άτομο.
SECTION_TO_GROUPS: dict[str, list[str]] = {
    "dashboard": ["support"],
    "subscribers": ["support"],
    "subscriptions": ["support"],
    "leads": ["sales"],
    "billing": ["finance"],
    "newsletter": ["marketing"],
    "content": ["marketing"],
    "health": ["support"],
    "smtp": ["tech"],
    "idika": ["tech"],
    "maintenance": ["tech"],
    "staff": [],  # διαχείριση χρηστών ΔΕΝ μεταφέρεται αυτόματα — δίνεται ρητά
}


async def main() -> int:
    db = shared_db()
    await seed_platform_groups()
    keys = {g["key"] for g in DEFAULT_GROUPS}
    by_key = {g["key"]: g["_id"] async for g in db["platform_groups"].find(
        {"key": {"$in": list(keys)}}, {"key": 1})}
    readonly_id = by_key.get("readonly")

    changed = 0
    async for a in db["platform_admins"].find({}):
        email = a.get("email", "")
        if a.get("super_admin"):
            print(f"  = {email:34s} super admin — αμετάβλητος")
            continue
        if a.get("group_ids"):
            print(f"  = {email:34s} έχει ήδη ομάδες — παραλείπεται")
            continue

        old = a.get("permissions") or []
        wanted: set[str] = set()
        for section in old:
            wanted.update(SECTION_TO_GROUPS.get(section, []))

        # Ο λογαριασμός του Lovable integration είναι read-only by design.
        if (a.get("full_name") or "").strip().lower() == "lovable":
            gids = [readonly_id] if readonly_id else []
            label = "readonly (Lovable integration)"
        elif wanted:
            gids = [by_key[k] for k in sorted(wanted) if k in by_key]
            label = ", ".join(sorted(wanted))
        else:
            # Χωρίς αντιστοίχιση → «Μόνο ανάγνωση», ποτέ «τίποτα»: κανείς δεν πρέπει να
            # ανακαλύψει τη migration επειδή κλειδώθηκε έξω.
            gids = [readonly_id] if readonly_id else []
            label = "readonly (fallback)"

        await db["platform_admins"].update_one(
            {"_id": a["_id"]},
            {"$set": {"group_ids": gids, "updated_at": datetime.now(tz=timezone.utc)}})
        print(f"  → {email:34s} {old} ⇒ {label}")
        changed += 1

    print(f"\nΕνημερώθηκαν {changed} λογαριασμοί.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
