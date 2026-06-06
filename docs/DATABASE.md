# RxVision — MongoDB Schema

Σύμβαση: **κάθε** collection (πλην `tenants`, `subscriptions`, global reference) έχει
`tenant_id` ως πρώτο πεδίο compound index. Χρόνοι σε UTC ISODate. Χρηματικά σε **minor
units** (λεπτά, integer) για ακρίβεια — όχι float.

Νaming: snake_case fields, `_id` ObjectId εκτός αν δηλώνεται natural key.

---

## Πίνακας collections

| Collection | Σκοπός |
|---|---|
| `tenants` | φαρμακεία (root του multi-tenancy) |
| `users` | χρήστες ανά tenant |
| `roles` | σύνολα permissions ανά tenant |
| `permissions` | global κατάλογος permission keys |
| `pharmacies` | φυσικά σημεία/καταστήματα ενός tenant (chain support) |
| `prescription_executions` | εκτελεσμένες συνταγές (head) |
| `prescription_items` | γραμμές συνταγής (σκευάσματα) |
| `doctors` | ιατροί |
| `patients_anonymized` | ανωνυμοποιημένοι ασφαλισμένοι |
| `insurance_funds` | ασφαλιστικά ταμεία |
| `icd10_codes` | διαγνώσεις (global reference + tenant overlay) |
| `products` | σκευάσματα |
| `active_substances` | δραστικές ουσίες |
| `future_prescriptions` | μελλοντικές/επαναλαμβανόμενες |
| `profitability_snapshots` | precomputed κερδοφορία |
| `sync_jobs` | εργασίες ingestion |
| `audit_logs` | audit trail |
| `module_settings` | ρυθμίσεις module ανά tenant |
| `subscriptions` | συνδρομές/plans |

---

## 1. `tenants`
**Σκοπός:** ρίζα του multi-tenancy· κρατά settings, plan ref, modules, isolation tier.

```json
{
  "_id": "ObjectId",
  "name": "Φαρμακείο Παπαδόπουλος",
  "slug": "papadopoulos-athina",
  "country": "GR",                         // GR | CY
  "status": "active",                      // trial|active|suspended|pending_deletion
  "isolation_tier": "shared",              // shared|dedicated_db|dedicated_cluster
  "settings": {
    "locale": "el-GR", "timezone": "Europe/Athens",
    "currency": "EUR", "fiscal_month_close_day": 31
  },
  "subscription_id": "ObjectId(subscriptions)",
  "modules": {                             // override πάνω από το plan
    "profitability": "enabled",            // enabled|trial|locked
    "pharmacyone": "trial"
  },
  "credentials_ref": {                     // ΔΕΝ αποθηκεύονται raw creds
    "hdika": "vault://tenants/<id>/hdika",
    "gesy": null
  },
  "created_at": "ISODate", "updated_at": "ISODate", "deleted_at": null
}
```
**Indexes:** `{slug:1}` unique· `{status:1}`· `{country:1}`.
**Σχέσεις:** 1‑N → users, pharmacies, prescription_*. 1‑1 → subscriptions.

## 2. `users`
**Σκοπός:** λογαριασμοί ανά tenant.
```json
{
  "_id":"ObjectId","tenant_id":"ObjectId","email":"owner@pharm.gr",
  "password_hash":"argon2id$...","full_name":"Γ. Παπαδόπουλος",
  "role_ids":["ObjectId(roles)"],"pharmacy_ids":["ObjectId(pharmacies)"],
  "status":"active","mfa_enabled":true,
  "last_login_at":"ISODate","refresh_token_version":3,
  "created_at":"ISODate","updated_at":"ISODate"
}
```
**Indexes:** `{tenant_id:1, email:1}` unique· `{tenant_id:1, status:1}`.
**Σχέσεις:** N‑1 tenant· N‑N roles.

## 3. `roles`
```json
{"_id":"ObjectId","tenant_id":"ObjectId","key":"manager","name":"Διαχειριστής",
 "permissions":["prescriptions:read","doctors:read","profitability:read","settings:write"],
 "is_system":false,"created_at":"ISODate"}
```
**Indexes:** `{tenant_id:1, key:1}` unique.

## 4. `permissions` (global reference)
```json
{"_id":"prescriptions:read","resource":"prescriptions","action":"read",
 "description":"Ανάγνωση συνταγών","module":"prescription_analytics"}
```
**Indexes:** `{resource:1, action:1}`. **Σημ.:** seed-only, read-mostly.

## 5. `pharmacies`
**Σκοπός:** φυσικά καταστήματα (υποστήριξη αλυσίδας κάτω από έναν tenant).
```json
{"_id":"ObjectId","tenant_id":"ObjectId","name":"Κατάστημα Κέντρο",
 "external_codes":{"hdika_pharmacy_id":"GR12345","afm":"099..."},
 "address":{"city":"Αθήνα","postal":"10434","region":"Αττική"},
 "is_primary":true,"created_at":"ISODate"}
```
**Indexes:** `{tenant_id:1}`· `{tenant_id:1,"external_codes.hdika_pharmacy_id":1}`.

## 6. `prescription_executions` (head)
**Σκοπός:** μία εκτελεσμένη συνταγή. Καρδιά των analytics.
```json
{
  "_id":"ObjectId","tenant_id":"ObjectId","pharmacy_id":"ObjectId",
  "source":"HDIKA",                        // HDIKA|GESY
  "external_id":"GR-RX-2026-00098765",     // natural key από πηγή
  "executed_at":"ISODate",                 // ημερομηνία+ώρα εκτέλεσης
  "fund_id":"ObjectId(insurance_funds)",
  "doctor_id":"ObjectId(doctors)",
  "patient_ref":"ObjectId(patients_anonymized)",
  "repeat_current":1,"repeat_total":3,     // τρέχουσα/συνολικές επαναλήψεις
  "icd10":["E11.9"],                        // διαγνώσεις
  "amount_total":4250,                      // αξία συνταγής (cents)
  "amount_claimed":3800,                    // αιτούμενο προς ταμείο (cents)
  "patient_share":450,                      // συμμετοχή ασφαλισμένου (cents)
  "wholesale_cost":3100,                    // χονδρική αξία ειδών (cents, για κερδοφορία)
  "status":"executed",                      // executed|partial|cancelled
  "has_unexecuted_substances":false,
  "next_open_date":"ISODate|null",          // πότε ανοίγει η επόμενη επανάληψη
  "ingested_at":"ISODate","sync_job_id":"ObjectId(sync_jobs)",
  "hash":"sha256(...)"                      // για dedup/idempotency
}
```
**Indexes:**
- `{tenant_id:1, source:1, external_id:1}` **unique** (dedup)
- `{tenant_id:1, executed_at:-1}` (timeline/dashboard)
- `{tenant_id:1, doctor_id:1, executed_at:-1}` (doctor analytics)
- `{tenant_id:1, fund_id:1, executed_at:-1}` (ανά ταμείο)
- `{tenant_id:1, icd10:1}` (multikey, ICD analytics)
- `{tenant_id:1, next_open_date:1}` (future prescriptions)

**Σχέσεις:** 1‑N → prescription_items· N‑1 → doctor, fund, patient.

## 7. `prescription_items` (γραμμές)
```json
{"_id":"ObjectId","tenant_id":"ObjectId","execution_id":"ObjectId",
 "product_id":"ObjectId(products)","active_substance_id":"ObjectId",
 "quantity":2,"retail_price":1200,"wholesale_price":900,
 "margin":300,                              // retail - wholesale (cents)
 "amount_claimed":1080,"patient_share":120,
 "is_executed":true,"category":"FYK",       // FYK|vaccine|narcotic|special|normal
 "executed_at":"ISODate"}                    // denormalized για aggregation χωρίς join
```
**Indexes:** `{tenant_id:1, execution_id:1}`· `{tenant_id:1, product_id:1, executed_at:-1}`·
`{tenant_id:1, active_substance_id:1}`· `{tenant_id:1, category:1, executed_at:-1}`.
**Σημ.:** denormalize `executed_at`, `doctor_id` (optional) για να αποφεύγουμε `$lookup`.

## 8. `doctors`
```json
{"_id":"ObjectId","tenant_id":"ObjectId","full_name":"Δρ. Α. Ιωάννου",
 "specialty":"Παθολόγος","external_codes":{"etaa_id":"..."},
 "first_seen_at":"ISODate","created_at":"ISODate"}
```
**Indexes:** `{tenant_id:1, full_name:1}`· `{tenant_id:1,"external_codes.etaa_id":1}`.
**Σημ.:** αξία/πλήθος/κερδοφορία/νέοι-πελάτες υπολογίζονται με aggregation (όχι αποθηκευμένα),
ή precomputed σε snapshot.

## 9. `patients_anonymized`
**Σκοπός:** ασφαλισμένος χωρίς PII — μόνο pseudonymous id + αδρά χαρακτηριστικά.
```json
{
  "_id":"ObjectId","tenant_id":"ObjectId",
  "pseudo_id":"hmac_sha256(amka, tenant_pepper)",  // σταθερό ανά tenant, μη αντιστρέψιμο
  "sex":"F",                                        // M|F|U
  "age_group":"65-74",                              // bucket, ΟΧΙ ημ. γέννησης
  "residence_area":"Αττική",                        // region-level, ΟΧΙ διεύθυνση
  "first_seen_at":"ISODate","last_seen_at":"ISODate",
  "rx_count":42,"rx_value_total":182000,            // denormalized counters
  "lifecycle":"active",                             // new|active|inactive
  "created_at":"ISODate"
}
```
**Indexes:** `{tenant_id:1, pseudo_id:1}` unique· `{tenant_id:1, lifecycle:1}`·
`{tenant_id:1, age_group:1, sex:1}`.
**GDPR:** δεν περιέχει AMKA/όνομα/ΑΦΜ/ημ.γέννησης. Βλ. [SECURITY_GDPR.md](SECURITY_GDPR.md).

## 10. `insurance_funds`
```json
{"_id":"ObjectId","tenant_id":"ObjectId","code":"EOPYY","name":"ΕΟΠΥΥ",
 "country":"GR","created_at":"ISODate"}
```
**Indexes:** `{tenant_id:1, code:1}` unique.

## 11. `icd10_codes` (global reference + tenant counters)
```json
{"_id":"E11.9","chapter":"E","title_el":"Σακχ. διαβήτης τύπου 2, χωρίς επιπλοκές",
 "title_en":"Type 2 diabetes mellitus without complications"}
```
**Indexes:** `{chapter:1}`· text index σε `title_el`. Global read-only seed.

## 12. `products` (σκευάσματα)
```json
{
  "_id":"ObjectId","tenant_id":"ObjectId",
  "barcode":"5201234567890","name":"Glucophage 850mg",
  "active_substance_id":"ObjectId","icd10_links":["E11.9"],
  "retail_price":420,"wholesale_price":310,
  "margin":110,"margin_pct":26.19,
  "category":"normal",                      // FYK|vaccine|narcotic|special|normal
  "flags":{"is_fyk":false,"is_vaccine":false,"is_narcotic":false},
  "rx_frequency":318,                       // συχνότητα εμφάνισης (denormalized)
  "updated_at":"ISODate"
}
```
**Indexes:** `{tenant_id:1, barcode:1}` unique· `{tenant_id:1, active_substance_id:1}`·
`{tenant_id:1, category:1}`· `{tenant_id:1, margin_pct:1}` (low-profitability queries).

## 13. `active_substances`
```json
{"_id":"ObjectId","tenant_id":"ObjectId","name":"Metformin","atc":"A10BA02",
 "created_at":"ISODate"}
```
**Indexes:** `{tenant_id:1, atc:1}`· `{tenant_id:1, name:1}`.

## 14. `future_prescriptions`
**Σκοπός:** συνταγές που ανοίγουν, για demand forecast & order suggestions.
```json
{"_id":"ObjectId","tenant_id":"ObjectId","patient_ref":"ObjectId",
 "source_execution_id":"ObjectId","expected_open_date":"ISODate",
 "products":[{"product_id":"ObjectId","expected_qty":1}],
 "confidence":0.92,"status":"pending",     // pending|opened|missed
 "created_at":"ISODate"}
```
**Indexes:** `{tenant_id:1, expected_open_date:1, status:1}`· `{tenant_id:1, patient_ref:1}`.

## 15. `profitability_snapshots`
**Σκοπός:** precomputed κερδοφορία ανά περίοδο/διάσταση (dashboard speed).
```json
{"_id":"ObjectId","tenant_id":"ObjectId","period":"2026-05","grain":"month",
 "dimension":"fund","dimension_id":"ObjectId(insurance_funds)",
 "rx_count":1240,"amount_claimed":4250000,"wholesale_cost":3100000,
 "gross_profit":1150000,"margin_pct":27.06,"computed_at":"ISODate"}
```
**Indexes:** `{tenant_id:1, period:1, dimension:1}`· `{tenant_id:1, grain:1, period:-1}`.

## 16. `sync_jobs`
```json
{"_id":"ObjectId","tenant_id":"ObjectId","source":"HDIKA","type":"incremental",
 "status":"success",                       // queued|running|success|failed|partial
 "cursor":{"from":"ISODate","to":"ISODate"},
 "stats":{"fetched":320,"inserted":300,"duplicates":18,"invalid":2},
 "attempts":1,"error":null,
 "started_at":"ISODate","finished_at":"ISODate"}
```
**Indexes:** `{tenant_id:1, source:1, started_at:-1}`· `{status:1}`.

## 17. `audit_logs`
```json
{"_id":"ObjectId","tenant_id":"ObjectId","actor_user_id":"ObjectId",
 "action":"prescriptions:export","resource":"prescription_executions",
 "request_id":"uuid","ip":"…","outcome":"success",
 "meta":{"filters":{...},"count":1240},"at":"ISODate"}
```
**Indexes:** `{tenant_id:1, at:-1}`· `{tenant_id:1, actor_user_id:1, at:-1}`·
TTL προαιρετικό (π.χ. retention 24 μήνες) ανάλογα με πολιτική.

## 18. `module_settings`
```json
{"_id":"ObjectId","tenant_id":"ObjectId","module":"order_suggestions",
 "config":{"lead_time_days":3,"safety_stock_pct":15,"include_area_oncall":true},
 "updated_at":"ISODate"}
```
**Indexes:** `{tenant_id:1, module:1}` unique.

## 19. `subscriptions`
```json
{"_id":"ObjectId","tenant_id":"ObjectId","plan":"pro",       // free_trial|basic|pro|enterprise
 "status":"active","trial_ends_at":"ISODate|null",
 "seats":5,"price_per_pharmacy":4900,"currency":"EUR",
 "addons":["pharmacyone"],
 "modules_included":["dashboard","prescription_analytics","doctor_analytics",
                     "patient_analytics","icd10_analytics","profitability"],
 "limits":{"pharmacies":3,"history_months":24,"api_sync":true},
 "current_period_end":"ISODate","created_at":"ISODate"}
```
**Indexes:** `{tenant_id:1}` unique· `{status:1, current_period_end:1}`.

---

## Index bootstrap
Όλα τα indexes δημιουργούνται idempotent στο app startup (`core/db.py:ensure_indexes()`),
ώστε deployment = αυτόματο index sync. Sharding key (Phase 2): `tenant_id` (hashed) στα
μεγάλα collections (`prescription_executions`, `prescription_items`).
