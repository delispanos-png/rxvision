"""Seed RxVision with a demo tenant + RBAC + realistic demo data.

Run inside the api container:
    docker compose -f docker-compose.prod.yml run --rm api python scripts/seed.py

Idempotent-ish: it wipes the demo tenant's analytics docs and re-creates them, but
upserts the tenant/user/subscription so you can re-run safely.

Demo login is controlled by env (SEED_DEMO_EMAIL / SEED_DEMO_PASSWORD); the
seeder prints the effective credentials at the end.
"""

from __future__ import annotations

import asyncio
import os
import random
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.core.db import ensure_indexes, shared_db
from app.core.security import hash_password
from app.services.rbac_seed import seed_rbac

TID = "rxvision-demo"  # tenant_id is a string everywhere (matches JWT `tid`)
# Demo/admin credentials come from env so no real secret ever lands in the repo.
# Override these in your .env before seeding a real environment.
DEMO_EMAIL = os.getenv("SEED_DEMO_EMAIL", "owner@example.com")
DEMO_PASSWORD = os.getenv("SEED_DEMO_PASSWORD", "ChangeMe-Demo-2026!")

MODULE_KEYS = [
    "dashboard", "prescription_analytics", "doctor_analytics", "patient_analytics",
    "icd10_analytics", "profitability", "future_prescriptions", "order_suggestions",
    "monthly_closing", "ingestion", "pharmacyone",
]

# (code, Greek title) — seeded into icd10_codes so analytics show real diagnosis names
ICD10_CATALOGUE = [
    ("E11.9", "Σακχαρώδης διαβήτης τύπου 2"),
    ("I10", "Ιδιοπαθής υπέρταση"),
    ("J45.9", "Άσθμα"),
    ("E78.5", "Υπερλιπιδαιμία"),
    ("F32.9", "Καταθλιπτικό επεισόδιο"),
    ("K21.9", "Γαστροοισοφαγική παλινδρόμηση"),
    ("M54.5", "Οσφυαλγία"),
    ("N39.0", "Λοίμωξη ουροποιητικού"),
    ("J02.9", "Οξεία φαρυγγίτιδα"),
    ("E03.9", "Υποθυρεοειδισμός"),
    ("I48.91", "Κολπική μαρμαρυγή"),
    ("M81.0", "Οστεοπόρωση"),
    ("G43.9", "Ημικρανία"),
    ("L40.9", "Ψωρίαση"),
    ("B34.9", "Ιογενής λοίμωξη"),
]
ICD10 = [c for c, _ in ICD10_CATALOGUE]

# (code, name, patient_share options) — patient_share fraction of amount_total
FUNDS = [
    ("EOPYY", "ΕΟΠΥΥ", [0.0, 0.10, 0.25]),
    ("OPAD", "ΟΠΑΔ / Δημόσιο", [0.0, 0.10]),
    ("TYPET", "ΤΥΠΕΤ (Τράπεζα)", [0.10, 0.25]),
    ("EDOEAP", "ΕΔΟΕΑΠ (ΜΜΕ)", [0.0, 0.25]),
    ("OAEE", "ΟΑΕΕ / Ελ. Επαγγελματίες", [0.0, 0.10, 0.25]),
    ("PRIVATE", "Ιδιωτική Ασφάλιση", [0.10, 0.25, 0.40]),
]
SPECIALTIES = ["Παθολόγος", "Καρδιολόγος", "Πνευμονολόγος", "Ενδοκρινολόγος",
               "Γενικός Ιατρός", "Ορθοπεδικός", "Δερματολόγος", "Νευρολόγος",
               "Ψυχίατρος", "Ουρολόγος"]
AREAS = ["Αττική", "Θεσσαλονίκη", "Πάτρα", "Ηράκλειο", "Λάρισα", "Βόλος",
         "Ιωάννινα", "Καβάλα", "Χανιά", "Ρόδος"]
AGE_GROUPS = ["18-34", "35-49", "50-64", "65-74", "75+"]
PRODUCT_NAMES = [
    "Παρακεταμόλη", "Ιβουπροφαίνη", "Αμοξικιλλίνη", "Ομεπραζόλη", "Μετφορμίνη",
    "Ατορβαστατίνη", "Αμλοδιπίνη", "Σαλβουταμόλη", "Λεβοθυροξίνη", "Σερτραλίνη",
    "Παντοπραζόλη", "Βιταμίνη D3", "Ασπιρίνη", "Κλοπιδογρέλη", "Ραμιπρίλη",
    "Διαζεπάμη", "Τραμαδόλη", "Ινσουλίνη", "Εμβόλιο Γρίπης", "Εμβόλιο Πνευμονιόκοκκου",
]
SELLER_NAMES = ["Μαρία Π.", "Γιώργος Κ.", "Ελένη Δ.", "Νίκος Α.", "Σοφία Μ.", "Κώστας Λ."]
# extra back-office tenants so the admin panel shows a real customer base.
# last field = days until subscription expiry (varied → expiring/expired/trial signals)
EXTRA_TENANTS = [
    ("demo-co-athens", "Φαρμακείο Κέντρο Αθήνας", "pro", "active", 6900, 4, 210),
    ("demo-co-thess", "Φαρμακείο Θεσσαλονίκης", "standard", "active", 3900, 2, 11),   # λήγει σύντομα
    ("demo-co-patra", "Φαρμακείο Πάτρας", "standard", "trial", 0, 1, 5),               # trial τελειώνει
    ("demo-co-crete", "Φαρμακείο Κρήτης", "pro", "active", 6900, 3, 47),
    ("demo-co-volos", "Φαρμακείο Βόλου", "standard", "past_due", 3900, 1, -8),         # ληγμένη/past_due
]


def now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def main() -> None:
    db = shared_db()
    await ensure_indexes()

    # ── tenant + subscription ──────────────────────────────
    await db["tenants"].update_one(
        {"_id": TID},
        {"$set": {
            "name": "Φαρμακείο RxVision Demo",
            "slug": TID,
            "country": "GR",
            "status": "active",
            "isolation_tier": "shared",
            "settings": {"locale": "el-GR", "timezone": "Europe/Athens",
                         "currency": "EUR", "fiscal_month_close_day": 31},
            "modules": {"pharmacyone": "enabled"},
            "credentials_ref": {"hdika": None, "gesy": None},
            "updated_at": now()},
         "$setOnInsert": {"created_at": now()}},
        upsert=True,
    )
    await db["subscriptions"].update_one(
        {"tenant_id": TID},
        {"$set": {
            "tenant_id": TID, "plan": "pro", "status": "active",
            "trial_ends_at": None, "seats": 5, "price_per_pharmacy": 4900, "currency": "EUR",
            "addons": ["pharmacyone"], "modules_included": MODULE_KEYS,
            "limits": {"pharmacies": 3, "history_months": 24, "api_sync": True},
            "current_period_end": now() + timedelta(days=30), "updated_at": now()},
         "$setOnInsert": {"created_at": now()}},
        upsert=True,
    )

    # ── RBAC (global perms + tenant roles) ─────────────────
    await seed_rbac(tenant_id=TID)
    owner_role = await db["roles"].find_one({"tenant_id": TID, "key": "owner"})

    # ── owner user ─────────────────────────────────────────
    await db["users"].update_one(
        {"tenant_id": TID, "email": DEMO_EMAIL},
        {"$set": {
            "tenant_id": TID, "email": DEMO_EMAIL,
            "password_hash": hash_password(DEMO_PASSWORD),
            "full_name": "Δημήτρης Δελής", "role_ids": [owner_role["_id"]],
            "pharmacy_ids": [], "status": "active", "mfa_enabled": False,
            "refresh_token_version": 0, "updated_at": now()},
         "$setOnInsert": {"created_at": now()}},
        upsert=True,
    )

    # ── platform admins (back-office) — credentials from env, never hardcoded ──
    for email, pwd, name in [
        (os.getenv("SEED_PADMIN_EMAIL", "admin@example.com"),
         os.getenv("SEED_PADMIN_PASSWORD", "ChangeMe-Admin-2026!"),
         os.getenv("SEED_PADMIN_NAME", "Platform Admin")),
    ]:
        await db["platform_admins"].update_one(
            {"email": email},
            {"$set": {
                "email": email, "password_hash": hash_password(pwd),
                "full_name": name, "status": "active",
                "refresh_token_version": 0, "updated_at": now()},
             "$setOnInsert": {"created_at": now()}},
            upsert=True,
        )

    # ── subscription packages (provisioning catalog) ──────
    _core = ["dashboard", "prescription_analytics", "doctor_analytics", "patient_analytics",
             "icd10_analytics", "profitability", "future_prescriptions", "order_suggestions",
             "monthly_closing", "ingestion"]
    await db["packages"].delete_many({})
    await db["packages"].insert_many([
        {"_id": "trial", "name": "Δοκιμαστικό", "modules": MODULE_KEYS,
         "price_monthly": 0, "price_annual": 0, "trial_days": 14, "seats": 1,
         "features": ["Όλα τα modules για 14 ημέρες"]},
        {"_id": "standard", "name": "Standard", "modules": _core,
         "price_monthly": 3900, "price_annual": 39000, "trial_days": 0, "seats": 2,
         "features": ["Analytics & κερδοφορία", "ΗΔΙΚΑ sync", "2 χρήστες"]},
        {"_id": "pro", "name": "Pro", "modules": MODULE_KEYS,
         "price_monthly": 6900, "price_annual": 69000, "trial_days": 0, "seats": 4,
         "features": ["Όλα τα Standard", "PharmacyOne POS", "4 χρήστες"]},
    ])

    # ── content (Άρθρα/Νέα/Wiki) demo ──────────────────────
    await db["posts"].delete_many({})
    await db["posts"].insert_many([
        {"type": "news", "title": "Καλώς ήρθατε στο RxVision", "status": "published",
         "body": "<p>Η πλατφόρμα analytics εκτελέσεων συνταγών είναι εδώ.</p>",
         "author": "cloudon@rxvision.gr", "created_at": now(), "updated_at": now()},
        {"type": "news", "title": "Νέο: Ανάλυση ωρών αιχμής", "status": "published",
         "body": "<p>Δείτε τις ώρες αιχμής του φαρμακείου σας στο dashboard.</p>",
         "author": "cloudon@rxvision.gr", "created_at": now(), "updated_at": now()},
        {"type": "article", "title": "Πώς να αυξήσετε την κερδοφορία", "status": "published",
         "body": "<p>Οδηγός για τη χρήση του engine κερδοφορίας.</p>",
         "author": "cloudon@rxvision.gr", "created_at": now(), "updated_at": now()},
        {"type": "wiki", "title": "Σύνδεση ΗΔΙΚΑ — Οδηγός", "status": "draft",
         "body": "<p>Βήματα ρύθμισης διασύνδεσης ΗΔΙΚΑ.</p>",
         "author": "cloudon@rxvision.gr", "created_at": now(), "updated_at": now()},
    ])

    # ── wipe demo-tenant data (idempotent re-seed) ─────────
    for coll in ("insurance_funds", "doctors", "patients_anonymized", "products",
                 "prescription_executions", "prescription_items", "future_prescriptions",
                 "icd10_codes", "pharmacyone_sales", "sellers", "sync_jobs"):
        await db[coll].delete_many({"tenant_id": TID})
    await db["users"].delete_many({"tenant_id": TID, "email": {"$ne": DEMO_EMAIL}})

    # ── ICD-10 catalogue (titles) ──────────────────────────
    await db["icd10_codes"].insert_many([
        {"_id": code, "tenant_id": TID, "title_el": title, "chapter": code[0]}
        for code, title in ICD10_CATALOGUE
    ])

    # ── insurance funds (multiple) ─────────────────────────
    funds = [{"_id": ObjectId(), "tenant_id": TID, "code": code, "name": name,
              "shares": shares, "country": "GR", "created_at": now()}
             for code, name, shares in FUNDS]
    await db["insurance_funds"].insert_many(funds)

    # ── staff users (for PharmacyOne by-user + admin user counts) ──
    staff_role = await db["roles"].find_one({"tenant_id": TID, "key": "pharmacist"}) or owner_role
    staff_users = []
    for i, name in enumerate(["Άννα Παπαδοπούλου", "Δημήτρης Βασιλείου",
                              "Ελένη Γεωργίου", "Σπύρος Αντωνίου"]):
        staff_users.append({"_id": ObjectId(), "tenant_id": TID,
                            "email": f"staff{i+1}@rxvision.gr",
                            "password_hash": hash_password("Staff!2026"),
                            "full_name": name, "role_ids": [staff_role["_id"]],
                            "pharmacy_ids": [], "status": "active", "mfa_enabled": False,
                            "refresh_token_version": 0,
                            "created_at": now(), "updated_at": now()})
    await db["users"].insert_many(staff_users)
    owner_user = await db["users"].find_one({"tenant_id": TID, "email": DEMO_EMAIL})
    all_user_ids = [owner_user["_id"]] + [u["_id"] for u in staff_users]

    # ── doctors ────────────────────────────────────────────
    doctors = []
    for i in range(14):
        doctors.append({"_id": ObjectId(), "tenant_id": TID,
                        "full_name": f"Δρ. {chr(913 + (i % 24))}. {random.choice(['Ιατρού', 'Παπαδάκη', 'Νικολάου', 'Δημητρίου'])}",
                        "specialty": random.choice(SPECIALTIES),
                        "first_seen_at": now() - timedelta(days=random.randint(30, 500)),
                        "created_at": now()})
    await db["doctors"].insert_many(doctors)

    # ── patients (anonymized) ──────────────────────────────
    patients = []
    for i in range(140):
        patients.append({"_id": ObjectId(), "tenant_id": TID,
                         "pseudo_id": f"ΑΣΦ-{i+1:04d}",
                         "sex": random.choice(["M", "F"]),
                         "age_group": random.choice(AGE_GROUPS),
                         "residence_area": random.choice(AREAS),
                         "first_seen_at": now() - timedelta(days=random.randint(1, 500)),
                         "last_seen_at": now(), "rx_count": 0, "rx_value_total": 0,
                         "lifecycle": random.choice(["new", "active", "active", "active", "inactive"]),
                         "created_at": now()})
    await db["patients_anonymized"].insert_many(patients)

    # ── products ───────────────────────────────────────────
    products = []
    for i in range(40):
        wholesale = random.randint(150, 6000)
        margin_pct = round(random.uniform(3, 38), 2)
        retail = int(wholesale * (1 + margin_pct / 100))
        base = PRODUCT_NAMES[i % len(PRODUCT_NAMES)]
        cat = ("vaccine" if "Εμβόλιο" in base
               else random.choice(["normal", "normal", "normal", "FYK", "narcotic"]))
        products.append({"_id": ObjectId(), "tenant_id": TID,
                         "barcode": f"520{random.randint(1000000, 9999999)}",
                         "name": f"{base} {random.choice(['500mg', '20mg', '10mg', '1000mg', '40mg'])}",
                         "active_substance_id": None,
                         "icd10_links": random.sample(ICD10, k=random.randint(1, 2)),
                         "retail_price": retail, "wholesale_price": wholesale,
                         "margin": retail - wholesale, "margin_pct": margin_pct,
                         "category": cat, "flags": {}, "rx_frequency": 0, "updated_at": now()})
    await db["products"].insert_many(products)

    # ── prescription executions + items (last 160 days) ────
    execs, items, futures = [], [], []
    rx_freq: dict = {}
    for _ in range(1000):
        d = doctors[random.randrange(len(doctors))]
        p = patients[random.randrange(len(patients))]
        fund = random.choice(funds)
        when = now() - timedelta(days=random.randint(0, 160),
                                 hours=random.randint(8, 20), minutes=random.randint(0, 59))
        rx_items = random.sample(products, k=random.randint(1, 4))
        amount_total = sum(it["retail_price"] for it in rx_items)
        wholesale_cost = sum(it["wholesale_price"] for it in rx_items)
        patient_share = int(amount_total * random.choice(fund["shares"]))
        amount_claimed = amount_total - patient_share
        repeat_total = random.choice([1, 1, 1, 3, 6])
        repeat_current = 1 if repeat_total == 1 else random.randint(1, repeat_total)
        exec_id = ObjectId()
        next_open = (when + timedelta(days=30)) if repeat_current < repeat_total else None
        status = random.choices(["executed", "partial", "cancelled"], weights=[88, 8, 4])[0]
        # concept doc §9: ~15% of multi-item rx have one substance left undispensed
        unexec_idx = (random.randrange(len(rx_items))
                      if len(rx_items) > 1 and (status == "partial" or random.random() < 0.12)
                      else None)
        for it in rx_items:
            rx_freq[it["_id"]] = rx_freq.get(it["_id"], 0) + 1
        execs.append({"_id": exec_id, "tenant_id": TID, "pharmacy_id": None,
                      "source": "HDIKA", "external_id": f"GR-RX-{exec_id}",
                      "executed_at": when, "fund_id": fund["_id"], "doctor_id": d["_id"],
                      "patient_ref": p["_id"], "repeat_current": repeat_current,
                      "repeat_total": repeat_total,
                      "icd10": random.sample(ICD10, k=random.randint(1, 2)),
                      "amount_total": amount_total, "amount_claimed": amount_claimed,
                      "patient_share": patient_share, "wholesale_cost": wholesale_cost,
                      "status": status, "has_unexecuted_substances": unexec_idx is not None,
                      "next_open_date": next_open, "ingested_at": now()})
        for idx, it in enumerate(rx_items):
            items.append({"_id": ObjectId(), "tenant_id": TID, "execution_id": exec_id,
                          "product_id": it["_id"], "active_substance_id": None,
                          "quantity": 1, "retail_price": it["retail_price"],
                          "wholesale_price": it["wholesale_price"],
                          "margin": it["margin"], "amount_claimed": it["retail_price"],
                          "patient_share": 0, "is_executed": idx != unexec_idx,
                          "category": it["category"], "executed_at": when})
        if next_open:
            futures.append({"_id": ObjectId(), "tenant_id": TID, "patient_ref": p["_id"],
                            "source_execution_id": exec_id, "expected_open_date": next_open,
                            "products": [{"product_id": it["_id"], "expected_qty": 1} for it in rx_items],
                            "confidence": round(random.uniform(0.7, 0.98), 2),
                            "status": "pending", "created_at": now()})

    await db["prescription_executions"].insert_many(execs)
    await db["prescription_items"].insert_many(items)
    if futures:
        await db["future_prescriptions"].insert_many(futures)
    # backfill product rx_frequency (drives low-margin/order analytics)
    for pid, n in rx_freq.items():
        await db["products"].update_one({"_id": pid}, {"$set": {"rx_frequency": n}})

    # ── PharmacyOne POS sales (sellers + per-user attribution) ──
    sellers = [{"_id": ObjectId(), "tenant_id": TID, "name": n} for n in SELLER_NAMES]
    await db["sellers"].insert_many(sellers)
    sales = []
    for _ in range(700):
        prod = random.choice(products)
        qty = random.randint(1, 3)
        sales.append({"_id": ObjectId(), "tenant_id": TID,
                      "sold_at": now() - timedelta(days=random.randint(0, 160),
                                                   hours=random.randint(8, 21)),
                      "seller_id": random.choice(sellers)["_id"],
                      "user_id": random.choice(all_user_ids),
                      "product_id": prod["_id"], "quantity": qty,
                      "amount": prod["retail_price"] * qty,
                      "is_executed": random.random() > 0.08,  # ~8% unexecuted
                      "out_of_prescription": random.random() < 0.35})
    await db["pharmacyone_sales"].insert_many(sales)

    # ── sync jobs history (ingestion health) ───────────────
    sync_jobs = _build_sync_jobs(TID, count=28)
    await db["sync_jobs"].insert_many(sync_jobs)

    # ── extra back-office tenants (admin panel customer base) ──
    await db["tenants"].delete_many({"_id": {"$regex": "^demo-co-"}})
    for coll in ("subscriptions", "sync_jobs", "users", "roles"):
        await db[coll].delete_many({"tenant_id": {"$regex": "^demo-co-"}})
    for tid, name, plan, status, price, seats, expiry_days in EXTRA_TENANTS:
        await db["tenants"].insert_one({
            "_id": tid, "name": name, "slug": tid, "country": "GR", "status": status,
            "isolation_tier": "shared", "settings": {"locale": "el-GR"}, "modules": {},
            "created_at": now() - timedelta(days=random.randint(20, 300)), "updated_at": now()})
        await db["subscriptions"].insert_one({
            "tenant_id": tid, "plan": plan, "status": status, "seats": seats,
            "price_per_pharmacy": price, "currency": "EUR",
            "modules_included": MODULE_KEYS, "limits": {"pharmacies": seats},
            "trial_ends_at": (now() + timedelta(days=expiry_days)) if status == "trial" else None,
            "current_period_end": now() + timedelta(days=expiry_days), "created_at": now(),
            "updated_at": now()})
        # owner user per extra tenant (drives users counts + newsletter recipients)
        await seed_rbac(tenant_id=tid)
        orole = await db["roles"].find_one({"tenant_id": tid, "key": "owner"})
        await db["users"].insert_one({
            "tenant_id": tid, "email": f"owner@{tid}.gr",
            "password_hash": hash_password("Owner!2026"), "full_name": f"Owner {name}",
            "role_ids": [orole["_id"]], "pharmacy_ids": [], "status": "active",
            "mfa_enabled": False, "refresh_token_version": 0,
            "created_at": now(), "updated_at": now()})
        for sj in _build_sync_jobs(tid, count=random.randint(2, 5)):
            await db["sync_jobs"].insert_one(sj)

    print(f"✓ tenant={TID}  execs={len(execs)}  items={len(items)}  future={len(futures)}")
    print(f"  doctors={len(doctors)}  patients={len(patients)}  products={len(products)}  "
          f"funds={len(funds)}  icd10={len(ICD10_CATALOGUE)}")
    print(f"  pos_sales={len(sales)}  sellers={len(sellers)}  staff_users={len(staff_users)}  "
          f"sync_jobs={len(sync_jobs)}  extra_tenants={len(EXTRA_TENANTS)}")
    print(f"✓ login: {DEMO_EMAIL} / {DEMO_PASSWORD}  (staff: staff1..4@rxvision.gr / Staff!2026)")


def _build_sync_jobs(tenant_id: str, *, count: int) -> list[dict]:
    """A believable ingestion history: mostly successful HDIKA syncs, a few partial/failed."""
    jobs = []
    for i in range(count):
        started = now() - timedelta(hours=i * 8 + random.randint(0, 5))
        status = random.choices(["success", "success", "success", "partial", "failed"],
                                weights=[60, 15, 10, 10, 5])[0]
        fetched = random.randint(5, 60)
        inserted = fetched if status == "success" else random.randint(0, fetched)
        jobs.append({
            "_id": ObjectId(), "tenant_id": tenant_id,
            "source": random.choice(["HDIKA", "HDIKA", "HDIKA", "GESY"]),
            "type": "sync", "status": status, "cursor": {},
            "stats": {"fetched": fetched, "inserted": inserted,
                      "duplicates": fetched - inserted if status != "failed" else 0,
                      "invalid": random.randint(0, 2) if status == "partial" else 0},
            "attempts": 1 if status != "failed" else random.randint(2, 3),
            "error": None if status != "failed" else "ΗΔΙΚΑ endpoint timeout (504)",
            "started_at": started,
            "finished_at": started + timedelta(seconds=random.randint(20, 240)),
        })
    return jobs


if __name__ == "__main__":
    asyncio.run(main())
