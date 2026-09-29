# RxVision — System Architecture

> Έγγραφο αρχιτεκτονικής για άμεση υλοποίηση από development team.

## 1. Επισκόπηση συστήματος

Το RxVision είναι **multi-tenant SaaS**. Κάθε φαρμακείο = ένα **tenant**. Όλα τα
δεδομένα και η πρόσβαση είναι αυστηρά scoped ανά `tenant_id`.

```
                         ┌──────────────────────────────────────────────┐
                         │                  Clients                      │
                         │   PWA (Next.js)  ·  installable  ·  offline    │
                         └───────────────┬──────────────────────────────┘
                                         │ HTTPS (JWT)
                                ┌────────▼─────────┐
                                │   API Gateway     │  (Traefik/NGINX Ingress)
                                │  TLS · WAF · rate │
                                └────────┬─────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        │                                │                                 │
┌───────▼────────┐            ┌──────────▼──────────┐          ┌───────────▼─────────┐
│  Next.js (web) │            │   FastAPI (api)      │          │  Celery workers      │
│  SSR/RSC + PWA │◀──REST────▶│  auth·tenant·RBAC    │          │  ingestion · GDPR    │
└────────────────┘            │  services·repos      │          │  snapshots · beat    │
                              └───┬─────────────┬────┘          └──────┬──────────────┘
                                  │             │                      │
                          ┌───────▼───┐   ┌─────▼──────┐        ┌──────▼───────┐
                          │ MongoDB 7 │   │  Redis 7    │        │ Vault / KMS  │
                          │ (replica  │   │ cache·broker│        │ secrets/keys │
                          │  set)     │   │ ·rate-limit │        └──────────────┘
                          └───────────┘   └─────────────┘
                                  ▲
                  ingestion │     │
        ┌─────────────────────────┴────────────────────────┐
        │  External sources                                  │
        │  🇬🇷 ΗΔΥΚΑ (e-prescription) — credentials/automated │
        │  🇨🇾 ΓΕΣΥ — XML upload (→ API αργότερα)             │
        └────────────────────────────────────────────────────┘
```

### 1.1 Συστατικά (containers)

| Service | Ρόλος |
|---|---|
| `web` | Next.js PWA, SSR + RSC, role/module-based UI |
| `api` | FastAPI — auth, tenant resolution, RBAC, business services, analytics endpoints |
| `worker` | Celery workers — ingestion sync, GDPR anonymization, snapshot precompute |
| `beat` | Celery beat — scheduling περιοδικών sync & nightly jobs |
| `mongo` | MongoDB replica set (primary data store) |
| `redis` | cache, rate-limit counters, Celery broker/result backend |
| `vault` | secrets — tenant ΗΔΥΚΑ/ΓΕΣΥ credentials, encryption keys |

## 2. Multi-tenancy

### 2.1 Προτεινόμενη προσέγγιση: **Shared database, shared collections, tenant discriminator** (`tenant_id` σε κάθε document)

**Γιατί αυτή αρχικά (MVP → early growth):**

- **Λειτουργική απλότητα & κόστος:** ένα cluster, ένα schema, ένα set από indexes. Δεν
  χρειάζεται provisioning ανά φαρμακείο — onboarding = 1 insert στο `tenants`.
- **Cross-tenant analytics (ανώνυμα/aggregated):** π.χ. benchmarking «το φαρμακείο σου vs
  μέσος όρος περιοχής» γίνεται φθηνά. Με database-per-tenant θα ήταν πανάκριβο.
- **Migrations & deploys:** μία φορά, όχι ×N.
- Το MongoDB κλιμακώνει οριζόντια με **sharding key = `tenant_id`** όταν χρειαστεί.

**Trade-off & mitigation:** ο μεγαλύτερος κίνδυνος είναι data-leak μεταξύ tenants. Τον
αντιμετωπίζουμε με **καθολικό enforcement** (βλ. 2.3): κανένα query δεν φεύγει για τη
MongoDB χωρίς `tenant_id` filter — επιβάλλεται στο repository layer, όχι «με προσοχή».

### 2.2 Migration path → **database-per-tenant** (όταν δικαιολογείται)

Το design είναι έτοιμο για μετάβαση χωρίς αλλαγή business logic:

- Το data access περνά **πάντα** από `TenantRepository`, που δέχεται `tenant_context`.
- Η επιλογή DB/collection γίνεται από έναν **`TenantDatabaseResolver`**. Σήμερα επιστρέφει
  `(shared_db, collection)` με injected `tenant_id` filter· αύριο μπορεί να επιστρέψει
  `(db_tenant_<id>, collection)` χωρίς filter.
- Στο `tenants.isolation_tier` ορίζουμε `shared | dedicated_db | dedicated_cluster`.

**Πότε προάγουμε tenant σε dedicated DB:** Enterprise plan, νομική απαίτηση isolation,
ή πολύ μεγάλος όγκος (π.χ. αλυσίδα φαρμακείων). Hybrid: 95% shared, λίγοι Enterprise dedicated.

### 2.3 Επιβολή tenant isolation (το πιο κρίσιμο σημείο)

1. **JWT → tenant context.** Κάθε access token περιέχει `tid` (tenant), `sub` (user),
   `roles`, `modules`. Το `TenantMiddleware` το διαβάζει και γεμίζει ένα
   `request.state.tenant`.
2. **Repository base class.** Όλα τα reads/writes περνούν από `BaseRepository` που
   κάνει **auto-inject `{"tenant_id": ctx.tenant_id}`** σε κάθε `find/update/delete` και
   σε κάθε `$match` πρώτου σταδίου των aggregation pipelines. Δεν υπάρχει «raw» πρόσβαση
   στο collection από τα services.
3. **Compound indexes με πρόθεμα `tenant_id`** σε όλα τα collections (βλ. DATABASE.md).
4. **Defense in depth:** unit tests που αποτυγχάνουν αν ένα pipeline δεν ξεκινά με
   `$match: {tenant_id}`· optional MongoDB **per-tenant DB users** στο dedicated tier.

### 2.4 Tenant model (τι «κρατάει» ένας tenant)

```
tenant
 ├─ settings            (locale GR/CY, timezone, currency, fiscal config)
 ├─ subscription        (plan, status, trial_ends_at, seats, add-ons)
 ├─ modules[]           (enabled/locked/trial ανά module key)
 ├─ users[]             (μέσω users.tenant_id)  → roles → permissions
 ├─ api_credentials     (ΗΔΥΚΑ/ΓΕΣΥ — encrypted refs σε Vault, ΟΧΙ raw)
 ├─ data isolation tier (shared | dedicated_db)
 └─ lifecycle ops       (backup, export, deletion / right-to-be-forgotten)
```

- **Backup/export:** per-tenant export job → ZIP (JSON/CSV) σε signed URL· χρησιμεύει και
  ως GDPR data-portability.
- **Deletion:** soft-delete (status `pending_deletion`, grace period) → hard purge job που
  σβήνει όλα τα documents με το `tenant_id` + revoke credentials στο Vault.

## 3. RBAC (Roles / Permissions)

- **Permissions** = fine-grained `resource:action` (π.χ. `prescriptions:read`,
  `doctors:read`, `profitability:read`, `settings:write`, `users:manage`, `billing:manage`).
- **Roles** = named σύνολα permissions, **ανά tenant** (+ system roles defaults).
- **Module gating:** πρόσβαση = `has_permission AND module_enabled`. Ένας χρήστης με
  `profitability:read` αλλά tenant χωρίς ενεργό module Profitability → 403 `module_locked`.

Default roles:

| Role | Σκοπός |
|---|---|
| `owner` | ιδιοκτήτης φαρμακείου — όλα + billing + users |
| `manager` | πλήρη analytics + settings, όχι billing |
| `pharmacist` | analytics read, ingestion trigger |
| `staff` | περιορισμένα dashboards |
| `support` (system) | impersonation read-only για support (audited) |

Enforcement στο API: dependency `require(permission, module)` σε κάθε route.

## 4. Modules (λειτουργικά)

Κάθε module είναι (α) ένα σύνολο API endpoints, (β) ένα frontend route group, (γ) ένα
`module_key` που ελέγχεται από subscription. Πλήρη endpoints: [API.md](API.md).

| # | Module key | Περιεχόμενο |
|---|---|---|
| 1 | `dashboard` | ημερήσιες/μηνιαίες εκτελέσεις, αξία, αιτούμενα, #ασφαλισμένων, top ιατροί/ICD-10/σκευάσματα, κερδοφορία |
| 2 | `prescription_analytics` | φίλτρα (ημέρα/μήνα/ταμείο/ιατρό/ICD-10/σκεύασμα), συγκρίσεις περιόδων, trends |
| 3 | `doctor_analytics` | συνταγές/αξία/νέοι πελάτες/κερδοφορία ανά ιατρό |
| 4 | `patient_analytics` | ανώνυμα ασφαλισμένων, συχνότητα, αξία, loyalty/retention |
| 5 | `icd10_analytics` | πλήθος/αξία/κερδοφορία ανά διάγνωση |
| 6 | `profitability` | λιανική − χονδρική (μεικτό κέρδος), περιθώριο, περικοπές ταμείων & καθαρό, ανοιχτά υπόλοιπα, χαμηλή κερδοφορία — βλ. §6α |
| 7 | `future_prescriptions` | συνταγές που ανοίγουν προσεχώς, πρόβλεψη ζήτησης, επαναλαμβανόμενοι |
| 8 | `order_suggestions` | πρόταση παραγγελίας (μελλοντικές + ιστορικότητα + εφημερίες περιοχής) |
| 9 | `monthly_closing` | έλεγχος προ κλεισίματος, ασυμφωνίες, ελλείψεις, συγκεντρωτικά ταμείων |
| 10 | `pharmacyone` (add-on) | κινήσεις πελάτη, εκτός-συνταγής πωλήσεις, ανά πωλητή/χρήστη, ανεκτέλεστα |

## 5. Backend layering (Python / FastAPI)

Καθαρός διαχωρισμός ευθυνών — εύκολο testing & μελλοντικό swap (π.χ. DB-per-tenant):

```
router  →  service  →  repository  →  MongoDB
  (HTTP)    (business)   (data access,        ▲
            (RBAC,        tenant-scoped)       │ indexes / aggregation
             module gate)                      │
analytics pipelines ──────────────────────────┘
workers (Celery) → services/repositories (ίδιο layer, εκτός HTTP)
```

- **router**: validation (Pydantic schemas), auth/permission deps, HTTP mapping. Καθόλου logic.
- **service**: business rules, module gating, ορχήστρωση repositories, GDPR checks.
- **repository**: μόνο data access, **tenant-scoped by construction**, indexes, pipelines.
- **workers**: ingestion/GDPR/snapshots· καλούν services, όχι routers.

Folder structure: [backend/](../backend/) — βλ. και σχόλια στο `backend/app/`.

```
backend/app/
├── main.py                 # app factory, router mount, middleware, lifespan
├── core/
│   ├── config.py           # Pydantic Settings (env)
│   ├── db.py               # Motor client, db resolver, index bootstrap
│   ├── security.py         # JWT encode/decode, password hashing
│   ├── redis.py            # redis pool
│   └── deps.py             # get_current_user, require(permission, module), tenant ctx
├── middleware/
│   ├── tenant.py           # resolve tenant από JWT → request.state
│   ├── audit.py            # write audit_logs ανά mutating request
│   └── ratelimit.py        # redis token-bucket ανά tenant+user
├── api/v1/routers/         # auth, tenants, users, prescriptions, doctors,
│   │                       # patients, icd10, products, profitability,
│   │                       # future, orders, monthly_closing, ingestion,
│   │                       # subscriptions, pharmacyone
│   └── __init__.py         # api_router (version v1)
├── models/                 # domain models / Mongo document shapes
├── schemas/                # Pydantic request/response DTOs
├── repositories/           # BaseRepository + ένα ανά collection
├── services/               # business logic ανά module + auth/gdpr/billing
├── analytics/              # aggregation pipeline builders (reusable)
├── workers/                # celery_app, tasks: ingestion_*, gdpr_*, snapshots_*
└── utils/                  # anonymization, validators, time/fiscal helpers
```

**API versioning:** prefix `/api/v1`. Νέες ασύμβατες αλλαγές → `/api/v2` με συνύπαρξη.

**Cross-cutting:** JWT auth, refresh rotation, tenant middleware, RBAC deps, rate limiting
(Redis), structured error handling (RFC-7807 `problem+json`), audit logging,
GDPR anonymization service. Λεπτομέρειες: [SECURITY_GDPR.md](SECURITY_GDPR.md).

## 6. Analytics architecture

Δύο ταχύτητες:

1. **On-the-fly aggregations** για interactive φίλτρα (Prescription/Doctor/ICD-10
   analytics) — MongoDB aggregation pipelines με `$match {tenant_id, date-range}` πρώτα,
   στηριγμένα σε compound indexes. Cache αποτελεσμάτων σε Redis (TTL + key από φίλτρα).
2. **Precomputed snapshots** — ⚠ **ΔΕΝ ΥΠΑΡΧΟΥΝ.** Το `snapshots.compute_nightly` είναι stub που
   επιστρέφει `{"status": "stub"}`· η `profitability_snapshots` έχει **0 έγγραφα**. Ό,τι έλεγε ότι
   «διαβάζει από snapshot» έπεφτε πάντα στον ζωντανό υπολογισμό. Ο κώδικας που τα διάβαζε αφαιρέθηκε
   (28/09/2026)· το stub και το ευρετήριο μένουν ως εκκρεμότητα στο `todo.md`.

Έτοιμα pipelines: [ANALYTICS.md](ANALYTICS.md).

### 6α. Κερδοφορία — ΕΝΑΣ ορισμός για κάθε οθόνη (28/09/2026)

`repositories/profitability.py::ProfitabilityRepository` — μοναδικό repository (router + Copilot).

**Μεικτό κέρδος = `amount_total − wholesale_cost` της εκτέλεσης.** Το σύνολο της εκτέλεσης είναι
αυτό που έδωσε η ΗΔΥΚΑ. Οι αναλύσεις **δεν** έχουν δικά τους ποσά:

| Ανάλυση | Πώς μοιράζει το σύνολο |
|---|---|
| ταμείο / ιατρός | ολόκληρη η εκτέλεση στο ταμείο/ιατρό της |
| ICD-10 | **ισόποσα** στις διαγνώσεις της (πριν: 2 διαγνώσεις = διπλή μέτρηση)· χωρίς διάγνωση → «Χωρίς διάγνωση» |
| σκεύασμα / τύπος / θεραπ. κατηγορία | έσοδο ∝ λιανική×**δοσμένα**, κόστος ∝ χονδρική×**δοσμένα** — κάθε είδος κρατά το δικό του περιθώριο |

Εκτέλεση χωρίς γραμμές με αξία → **ολόκληρη** σε «Χωρίς ανάλυση ανά σκεύασμα» (όχι μία φορά ανά
είδος). Λίστες > όριο → μία γραμμή «Όλα τα υπόλοιπα». **Άρα κάθε ανάλυση αθροίζει ΑΚΡΙΒΩΣ στην
κεφαλίδα** — επαληθευμένο σε 3 φαρμακεία × 6 αναλύσεις.

**Φίλτρο:** `stats_exclusion.COUNTABLE_EXEC` = όχι `excluded_from_stats`, όχι `status: cancelled`.
Ο ίδιος ορισμός μπήκε και σε `advisor`, `doctors`, `icd10`, `patients` (18 σημεία) — πριν δεν
φιλτράριζαν καθόλου.

**Προσθήκες:** `estimated_cost_pct` (τι ποσοστό του κόστους είναι εκτίμηση από την κλίμακα)·
`fund_cuts` / `net_profit` από το κύκλωμα αποζημίωσης (μόνο εξοφλημένοι μήνες)·
`open_receivables` = ανοιχτά υπόλοιπα από `ReimbursementRepository.receivables()`, μετρημένα
**από τον πρώτο μήνα με καταγεγραμμένη είσπραξη** (`tracking_from`) — οι προηγούμενοι είναι
άγνωστοι, όχι οφειλόμενοι.

**Παγίδα:** το `BaseRepository.aggregate()` επιστρέφει τα ObjectId **ως κείμενο** (jsonsafe).
Ερώτημα `{"_id": {"$in": <κείμενα>}}` δεν βρίσκει τίποτα — μετάτρεψε πίσω σε `ObjectId`.

**Αφαιρέθηκε:** ο μετρητής `products.rx_frequency` (αυξανόταν σε κάθε επανα-άντληση → 71% των
προϊόντων φουσκωμένα, έως ×932). Η «χαμηλή κερδοφορία» μετρά πλέον δοσμένα τεμάχια της περιόδου.
Κέρδος και στο φορτίο: μία εγγραφή `products` λιγότερη ανά είδος σε κάθε άντληση.

## 7. Data ingestion (περίληψη)

- **ΗΔΥΚΑ (GR):** tenant καταχωρεί credentials (→ Vault). Worker κάνει **αρχικό
  full sync** και μετά **incremental** σε σταθερό interval (αέναο). Retry με backoff,
  duplicate detection με natural key, validation, per-tenant error reporting.
- **ΓΕΣΥ (CY):** αρχικά **χειροκίνητο XML upload** (parse → normalize → ingest), με ίδιο
  validation/dedup pipeline· έτοιμο για automation αν δοθεί API.

Πλήρες flow, retries, incremental cursors: [INGESTION.md](INGESTION.md).

## 8. Βασικές τεχνικές αποφάσεις & αιτιολόγηση

| Απόφαση | Επιλογή | Γιατί | Trade-off |
|---|---|---|---|
| Tenancy | Shared DB + `tenant_id` | απλό, φθηνό, cross-tenant benchmarking, εύκολο onboarding | πρέπει αυστηρό enforcement (το λύνουμε στο repo layer) |
| DB | MongoDB | ετερογενές ingestion (ΗΔΥΚΑ/ΓΕΣΥ διαφορετικά schemas), δυνατό aggregation για stats | όχι ACID πολλαπλών docs — δεν μας χρειάζεται για analytics |
| API framework | FastAPI | async, Pydantic, auto-OpenAPI, ταχύτητα ανάπτυξης | — |
| REST vs GraphQL | **REST** core, GraphQL μόνο αν χρειαστεί | analytics endpoints είναι λίγα & σταθερά· REST + query params αρκεί· caching ευκολότερο | GraphQL θα έδινε flexible drill-down — Phase 2 αν ζητηθεί |
| Jobs | Celery + Redis | ώριμο, beat scheduling, ανεξάρτητο scaling των workers | extra infra (αποδεκτό) |
| Frontend | Next.js App Router | SSR/RSC, PWA, role routing, SEO marketing site στο ίδιο | — |
| Charts | ECharts | μεγάλα datasets, πλούσια στατιστικά γραφήματα | bundle μέγεθος (lazy-load) |
| Snapshots | precompute nightly | dashboards instant, κόστος query χαμηλό | μικρό staleness (αποδεκτό για στατιστικά) |
| Anonymization | hash+pepper AMKA στο ingestion | τα PII δεν μπαίνουν ποτέ στο analytics store | δεν γίνεται re-identify (επιθυμητό) |

## 9. Non-functional

- **Performance:** p95 < 400ms σε cached dashboard, < 1.5s σε ad-hoc aggregation 12μήνου.
- **Availability:** Mongo replica set (3 nodes), stateless api (≥2 replicas).
- **Observability:** structured JSON logs, OpenTelemetry traces, Prometheus metrics,
  Sentry για errors. Κάθε log φέρει `tenant_id` & `request_id`.
- **Backups:** nightly Mongo snapshot + per-tenant logical export on demand.

## 10. Reimbursement & Optical Audit — τεχνικές σημειώσεις

Πλήρης προδιαγραφή κανόνων/πηγών: [reimbursement-compliance-spec.md](reimbursement-compliance-spec.md).

- **Coupon/QR semantics (κρίσιμο):** στα ΗΔΥΚΑ CDA coupons το πεδίο `qr` = `True` (QR/DataMatrix) /
  `False` (**ταινία γνησιότητας**, paper strip 2.10.12) / `None` (άγνωστο). **Κάθε κουπόνι που υπάρχει =
  εκτελεσμένο τεμάχιο** (παράγεται μόνο από blocks εκτελεσμένης ποσότητας, `hdika_cda.py`). Η μη-εκτέλεση
  αποτυπώνεται ΜΟΝΟ σε επίπεδο γραμμής (`is_executed`). ΠΟΤΕ μη χρησιμοποιείς το `qr` ως proxy εκτέλεσης
  (`_rx_lines`, `scans._coupons_summary`). Regression test: `tests/test_reimbursement_coupons.py`.
- **Closing checks** (`repositories/prescriptions.py::closing_checks` + `services/prescription_checks.py`):
  ανά-γραμμή (overdose/ΦΥΚ/γνωμάτευση/ναρκωτικά…) + prescription-level `exec_window` (30+10 ημ.,
  `valid_from`/`valid_until` vs `executed_at`) & `missing_strip` (tokens vs ποσότητα). Κατηγορία `closing`
  = κίνδυνος περικοπής· `advisory` = ενημερωτικό.
- **Έντυπη vs άυλη gating** (`scans._cross_check`): φυσικοί έλεγχοι (υπογραφή/σφραγίδα/παραλήπτης/ταινία +
  AI anomalies) ΜΟΝΟ όταν `is_intangible` false. Άυλη = 0 φυσικά ευρήματα (ο διοικητικός έλεγχος ΕΟΠΥΥ
  «δεν εφαρμόζεται σε άυλη»).
- **Optical Audit single-source:** το `scans._coupons_summary` αντλεί από `Reimbursement.prescription_detail`
  (ίδια authoritative εικόνα με το cockpit). **Φάκελος συνταγής:** `prescription_scans.case_id` — auto =
  matched barcode (2ο φύλλο ίδιου barcode), χειροκίνητο μέσω `POST /scans/group` & `/scans/{id}/ungroup`.
- **Folder-scan (frontend):** `optical/page.tsx` — File System Access API (`showDirectoryPicker` + watch
  8''· fallback `webkitdirectory`). Cloud server ΔΕΝ βλέπει το LAN → browser-side directory-watch.
- **Submission reconciliation:** `submission/page.tsx` — invoice amount vs άθροισμα αιτούμενων ΗΔΥΚΑ
  (ανά ξεχωριστό τιμολόγιο), για την προκαταβολή 95%.

## 10β. Κυκλώματα & υποδομή — εβδομάδα 20–27/09/2026

### Νέα κυκλώματα προϊόντος
| Κύκλωμα | Module | Πυρήνας |
|---|---|---|
| Προχορηγήσεις («δανεικά») | `advance_dispensings` 25 €/μ | `repositories/advance_dispensings.py` |
| Θεραπείες με Επανάληψη | `therapy_programs` 10 €/μ | **ίδιος κινητήρας** με τα εμβόλια — `vaccine_programs` με άλλο πρόσωπο |
| Οικογένειες / Δομές Φροντίδας | `patient_groups` 15 € / `care_structures` 20 € | μία συλλογή, `kind=family\|care` |
| Πρόσβαση πύλης | (μέρος των ομάδων) | `services/portal_access.py` |
| RxVision Connect | `connect` 30 €/μ | `services/connect_availability.py` |
| Συνομιλία φαρμακείων | `pharmacy_chat` (δωρεάν) | πρόσκληση με ΑΦΜ, μόνο σε ενεργή συνδρομή |
| Έτοιμος κατάλογος ειδών | `catalog_seed` 15 €/μ | `workers/catalog_categories.py` |
| «Τι νέο υπάρχει» | — (όλοι) | `services/release_notes.py` |

**Αρχή που επαναλήφθηκε:** ένας κινητήρας, πολλά πρόσωπα. Οι «Θεραπείες με Επανάληψη» δεν
είναι νέο σύστημα — είναι ο μηχανισμός των περιοδικών εμβολίων με διαφορετική ορολογία στην
οθόνη. Κάθε νέο χρεώσιμο module απαιτεί **ΔΥΟ** εγγραφές (κατάλογος + διακόπτης adminpanel),
αλλιώς ο πελάτης πληρώνει κάτι που δεν βλέπει.

### Λωρίδες εργασιών (Celery)
Πέντε ουρές αντί για μία: **`fast` · `sync` · `maintenance` · `backfill` · `optical`**,
με δρομολόγηση από **συνάρτηση** `_route_task` (ΟΧΙ λεξικό — μην προσπαθήσεις να διαβάσεις
`task_routes` ως dict). 3 κόμβοι × 5 λωρίδες. Οι **φύλακες του sync πάνε στο `fast`**, ώστε
μια αργή ιστορική ανάκτηση να μη σέρνει μαζί της τον έλεγχο υγείας.

> ⚠ **Πώς ΝΑ ΜΗΝ ελέγξεις:** το `api` container δεν φορτώνει τα worker modules — ρωτώντας το
> βλέπεις 9 από 56 εργασίες και βγάζεις άκυρο συμπέρασμα. Ρώτα τον **broker**:
> `celery -A app.workers.celery_app inspect active_queues`. Ίδια παγίδα με το
> `create_app().routes`, που σε one-off process επιστρέφει 2 διαδρομές αντί για εκατοντάδες.

### Φύλακας διαθεσιμότητας κόμβων
`workers/capacity.py` — ρωτά το Hetzner για διαθεσιμότητα του τύπου κόμβου και **αγοράζει
αυτόματα** μόλις εμφανιστεί (ο τύπος όλου του στόλου είναι εξαντλημένος· η επόμενη x86
κατηγορία κοστίζει 4×). Κάθε νέος κόμβος γεννιέται με **δημόσια IP + firewall από τη γέννηση**
(δεν υπάρχει NAT — χωρίς δημόσια IP δεν κατεβαίνει καν το Docker). **Η αποτυχία αγοράς
ειδοποιεί** — αλλιώς ο φύλακας αποτυγχάνει σιωπηλά.

### Ασφάλεια
Το `pull_token` της γέφυρας SoftOne και τα κλειδιά Noeton **κρυπτογραφούνται** με το «Κλειδί
Μυστικών» (`SECRETS_ENCRYPTION_KEY`, ενεργό από 23/09). Η γέφυρα συγκρίνει token με
**`hmac.compare_digest`**, ποτέ με `==`.

### Δοκιμές δυνατοτήτων — η λήξη έγινε **οριστική**
Πριν, η λήξη δοκιμής ίσχυε μόνο από την **επόμενη έκδοση token**, δηλαδή η δυνατότητα δούλευε
ως 15΄ μετά το τέλος της. Τώρα η ημερομηνία λήξης μπαίνει **μέσα στο JWT** (claim `mtrl`) και
ο έλεγχος γίνεται **σε κάθε αίτημα** με το ρολόι (`core/deps.py::_module_locked`).

> ⚠ **Μάθημα 27/09 (ολική διακοπή 81΄):** η προσθήκη του `mtrl` άλλαξε την υπογραφή του
> `auth_service._resolve` σε **5** τιμές· ενημερώθηκαν και οι 4 καλούντες αλλά **ξεχάστηκε το
> ίδιο το `return`** (4 τιμές) → `ValueError` σε login / refresh / αλλαγή φαρμακείου /
> impersonation. **Ο ruff ΔΕΝ το πιάνει· ο mypy το πιάνει** (`[return-value]`) — και ο mypy
> είναι `continue-on-error: true` στη CI. Πριν από κάθε deploy χρειάζονται **δύο** έλεγχοι:
> ruff `F821,F811` **και** mypy.

## 10γ. Ο Σύμβουλος προτείνει — `CoachSchool` (27/09/2026)

Ο `DailyCoachRepository` απαντά «**τι** να κάνεις σήμερα». Ο `CoachSchool` (ίδιο αρχείο)
απαντά «**τι άλλο μπορείς**» — μια πρόταση ανά δυνατότητα του RxVision που δεν αξιοποιείται.

**ΣΤΟΧΟΣ ΤΟΥ ΚΥΚΛΩΜΑΤΟΣ** (απόφαση ιδιοκτήτη): όσο περισσότερα κυκλώματα δουλεύει ο
φαρμακοποιός, τόσο περισσότερα πετυχαίνει εμπορικά — και τόσο πιο πολύ το RxVision γίνεται
**ο τρόπος που δουλεύει**, όχι ένα ακόμη πρόγραμμα. Η πρόταση δεν είναι διαφήμιση: είναι
**προσφορά βοήθειας** με μετρημένο όφελος και βήματα στησίματος.

**Δομή κάθε πρότασης:** `headline` («Ξέρεις ότι…» με το δικό του νούμερο) → `serve_pct` +
`money_cents` (πόσο ποσοστό πελατών και πόσος τζίρος) → `situation` → `promise` → `offer`
(«Θες να σε βοηθήσω;») → `setup[]` (4 βήματα).

**Ο σχεδιαστικός κανόνας:** κάθε `_prop_*` επιστρέφει `None` όταν τα δεδομένα δεν στηρίζουν την
πρόταση. Τα κατώφλια (≥5 εκκρεμείς θεραπείες, ≥15 ανενεργοί τακτικοί, ≥40 συνεπείς) είναι μέρος
της λειτουργίας, όχι φίλτρο εμφάνισης — μια πρόταση που εμφανίζεται «γενικά» γίνεται διαφήμιση.

**Πηγές:** `prescription_executions` + `prescription_items` (αξία, συχνότητα), `products.atc`
(λίστα `REPEAT_THERAPY_ATC` ανά δραστική), `patient_contacts`, `vaccinations`,
`loyalty_members`, `patient_links`, `comms_campaigns`, `icd10_codes`.

> ⚠ **`products.rx_frequency` ΔΕΝ είναι διάστημα δόσης** — είναι πλήθος συνταγών. Το «SALOSPIR
> κάθε 2947 ημέρες» το αποκάλυψε. Τα διαστήματα ορίζονται ρητά στο `REPEAT_THERAPY_ATC`.

> ⚠ **Ο έλεγχος δυνατότητας με `resolve_tenant_modules()`.** Με λάθος ανάγνωση
> (`tenants.modules` σκέτο), κάθε δυνατότητα του πακέτου εμφανίζεται ως «δεν την έχεις».

## 10δ. Partner API — δημόσιο API τρίτων (27/09/2026, σε εξέλιξη)

**ΞΕΧΩΡΙΣΤΗ FastAPI ΕΦΑΡΜΟΓΗ**, mounted στο `/api/partner` (`app/api/partner/app.py`).

> **Γιατί mount και όχι ακόμη ένας router:** το εσωτερικό OpenAPI είναι **κλειστό στην
> παραγωγή** επίτηδες — εκθέτει admin/GDPR/ingestion. Του συνεργάτη πρέπει να είναι **ανοιχτό**.
> Με δύο εφαρμογές και δύο schemas, ό,τι δεν δηλώνεται ρητά στο partner app **δεν μπορεί** να
> εμφανιστεί στα δημόσια docs — ούτε κατά λάθος.

### Δύο hostnames, σκόπιμα
| Hostname | Τι σερβίρει |
|---|---|
| `api.rxvision.gr` | **μόνο** `/v1/*` → `api:8000/api/partner/v1/*`. Καμία τεκμηρίωση. |
| `developers.rxvision.gr` | **μόνο** `/docs`, `/redoc`, `/openapi.json`. Κανένα endpoint δεδομένων. |

Και στα τρία υπάρχοντα hostnames (`app`/`adminpanel`/`my`) το `/api/partner*` απαντά **404** —
αλλιώς ο διαχωρισμός θα ήταν μόνο στα χαρτιά.

### Έξι επίπεδα ελέγχου πρόσβασης
1. **Κλειδί** `rxv_live_…`, 256-bit. Αποθηκεύεται **μόνο SHA-256 hash** + ορατό πρόθεμα.
   Χαμένο κλειδί δεν ανακτάται — ανακαλείται και εκδίδεται νέο.
2. **Ένα κλειδί = ένα φαρμακείο.** Το `tenant_id` έρχεται ΠΑΝΤΑ από το κλειδί· καμία διαδρομή
   δεν δέχεται «για ποιον», ούτε προαιρετικά.
3. **Scopes ανά κλειδί** (`products:read`, `stock:write`, …). Το 403 λέει **ποιο** λείπει.
4. **Λήξη** — προεπιλογή 180 ημέρες, μέγιστο 365. Κλειδί που δεν λήγει είναι κλειδί που κανείς
   δεν θυμάται ότι υπάρχει.
5. **Λίστα IP** ανά κλειδί (μεμονωμένες ή CIDR). Κενή = χωρίς περιορισμό.
6. **Ρητή αποδοχή GDPR** για ευαίσθητα scopes (`patients:read`): χωρίς `gdpr_ack=True` το
   `create()` ρίχνει `ValueError`. Ο φαρμακοποιός είναι ο υπεύθυνος επεξεργασίας.

Το `verify()` επιστρέφει **(doc, λόγος)** — `malformed`/`unknown`/`revoked`/`expired`/
`ip_blocked` — ώστε το 401 να λέει ΤΙ φταίει αντί για σκέτο «άκυρο κλειδί».

### Συμβάσεις που ΔΕΝ αλλάζουν
- **Σελιδοποίηση με opaque cursor** πάνω στο `_id` (σταθερή με ταυτόχρονες εγγραφές).
  Σχήμα απάντησης πάντα `{items, next_cursor, has_more}`.
- **Σφάλματα πάντα επίπεδα**: `{error, message, hint}`. Υπάρχει `StarletteHTTPException` handler
  που ξετυλίγει το `{"detail": …}` του FastAPI — **αλλιώς το Swagger θα έλεγε ψέματα**.
- **Χρήματα σε ακέραια λεπτά**, ημερομηνίες ISO 8601 UTC.
- **`patient_ref` = σταθερό ψευδώνυμο** ανά φαρμακείο. Καμία ταυτότητα ασθενή δεν φεύγει από
  το `/v1/prescriptions`.

### Απομόνωση φαρμακείων — ο ΕΝΑΣ κανόνας στο API

Τεχνική ομάδα που ολοκληρώνει για το φαρμακείο Α **δεν πρέπει να δει τίποτα** του Β. Δεν είναι
σφάλμα οθόνης: είναι παραβίαση GDPR με δεδομένα υγείας, ανάμεσα σε δύο άσχετα φαρμακεία.

**Πώς επιβάλλεται (τέσσερα σημεία):**
1. **Καμία παράμετρος `tenant_id` πουθενά.** Ο συνεργάτης δεν έχει τρόπο να δηλώσει «ποιανού».
   Το `PartnerContext.tenant_id` γεμίζει **μόνο** από την επαληθευμένη εγγραφή του κλειδιού.
2. **`_page()`: `{**q, "tenant_id": tenant_id}` — το tenant_id ΤΕΛΕΥΤΑΙΟ.** Με την αντίστροφη
   σειρά, ένα μελλοντικό `q` με κλειδί `tenant_id` θα αντικαθιστούσε το φίλτρο. Υπάρχει και
   `assert` πριν το ερώτημα.
3. **Κάθε εγγραφή φιλτράρει ρητά**, ακόμη κι όταν το έγγραφο ήρθε ήδη φιλτραρισμένο — το φίλτρο
   πρέπει να φαίνεται **στην ίδια γραμμή** που γράφει.
4. **Ο cursor δεν σπάει την απομόνωση**: κωδικοποιεί μόνο `_id` και συνδυάζεται πάντα με
   `tenant_id`. Πλαστός cursor με ξένο `_id` επιστρέφει κενό.

**Μόνιμος έλεγχος:** `backend/tests/test_partner_api_isolation.py` — **23 στατικοί έλεγχοι**
(χωρίς Mongo, άρα ποτέ flaky): καμία παράμετρος tenant σε χειριστή HTTP, κάθε πρόσβαση
φιλτραρισμένη, η σειρά του φίλτρου, η πηγή του tenant, ο φρουρός συνδρομής, μηδενική έκθεση
ταυτότητας ασθενή (και στα κλινικά endpoints), ότι **κάθε** endpoint δεδομένων φρουρείται από
scope, ότι **κάθε πληρωμένη δυνατότητα φρουρείται και από module**, ότι **κάθε κίνηση αξίας
φέρει κλειδί ιδεμποτεντίας**, και ότι **ταυτοποιητικά στοιχεία μπαίνουν μόνο από τη σύνδεση
πελάτη**.

> Το εύρος του ελέγχου καλύπτει και το `services/partner_customers.py` — υπηρεσία που υπάρχει
> αποκλειστικά για το Partner API, άρα υπόκειται στους ίδιους κανόνες κι αν ζει αλλού.
>
> Δύο ευρήματα βγήκαν από τη διεύρυνση των ελέγχων (27/09): η εγγραφή `pos_sales.insert_one(doc)`
> δεν έδειχνε το `tenant_id` **στη γραμμή της** (το έγγραφο το είχε, ο επόμενος αναγνώστης δεν
> το ήξερε) — διορθώθηκε στον κώδικα, όχι στον έλεγχο· και ο έλεγχος «καμία παράμετρος tenant»
> **εξαιρούσε ολόκληρο το `v1.py`**, δηλαδή δεν φύλαγε κανένα endpoint. Τώρα στοχεύει ακριβώς
> τους χειριστές HTTP (διακοσμημένους με `@router.*`) και αφήνει ελεύθερους τους εσωτερικούς
> βοηθούς, που *οφείλουν* να παίρνουν `tenant_id` από το επαληθευμένο κλειδί.

**Επαληθεύτηκε και εμπειρικά** στην παραγωγή (27/09), με κλειδί του Α εναντίον δεδομένων του Β:
barcode αποκλειστικό του Β → κενό · πλαστός cursor → κενό · `?tenant_id=B` → αγνοήθηκε ·
εγγραφή σε απόθεμα του Β → απορρίφθηκε, τιμή αμετάβλητη · παραγγελίες → μόνο του Α.

### Έκδοση του API — το Swagger ΕΙΝΑΙ η ανακοίνωση (κανόνας 27/09/2026)

`API_VERSION` στο `app/api/partner/app.py` είναι **μία πηγή αλήθειας**: τη διαβάζει το FastAPI
(`version=`) **και** το `GET /v1/ping` (πεδίο `api_version`). Με δύο σκληροκωδικοποιημένους
αριθμούς ο ένας θα ξεχαστεί, και ο συνεργάτης θα κατέγραφε στα logs του έκδοση που δεν ισχύει.

**Κάθε** αλλαγή στο API ανεβάζει τον αριθμό **και** γράφει `### <έκδοση> — DD/MM/YYYY` στο
«## 10. Changelog» του `DESCRIPTION`. Ο λόγος είναι πρακτικός: ο συνεργάτης-προγραμματιστής δεν
έχει κανέναν άλλο κανάλι — δεν του στέλνουμε email, δεν μπαίνει στο adminpanel. Αλλαγή χωρίς
changelog είναι αλλαγή που δεν ανακοινώθηκε ποτέ.

| Είδος | Έκδοση | Τι σημαίνει για τον καλούντα |
|---|---|---|
| PATCH | 1.1.0 → 1.1.1 | διόρθωση· η συμπεριφορά ήρθε σε συμφωνία με ό,τι ήδη υποσχόταν η σελίδα |
| MINOR | 1.1.0 → 1.2.0 | νέα endpoints ή **προαιρετικά** πεδία· τίποτα δεν σπάει |
| MAJOR | 1.x → 2.0.0 | breaking· ενημερώνεται **πριν** συμβεί, και το `/v1/` συνεχίζει να σερβίρει |

⚠ **Ξεχωριστό** από το `frontend/src/lib/version.ts` (έκδοση **προϊόντος**, κοινό = φαρμακοποιός).
Άλλο κοινό, άλλος ρυθμός. Τρέχουσες: API **1.1.0** · προϊόν **1.66.0**.

**Επιβάλλεται** από `test_api_version_is_documented_in_the_changelog` και
`test_swagger_version_and_ping_cannot_disagree`.

### Τι καλύπτει το API (27/09/2026) — 16 endpoints

| Κύκλωμα | Endpoints | Scope | Module |
|---|---|---|---|
| Έλεγχος | `GET /v1/ping` | — | — |
| Κατάλογος | `GET /v1/products` | `products:read` | — |
| Απόθεμα | `GET /v1/stock` · `POST /v1/stock/movements` | `stock:read/write` | — |
| Εκτελέσεις | `GET /v1/prescriptions` | `prescriptions:read` | — |
| Πωλήσεις ταμείου | `POST /v1/sales` | `sales:write` | — |
| Παραγγελίες | `GET /v1/orders` | `orders:read` | — |
| **Πελάτες** | `POST /v1/customers/link` · `DELETE /v1/customers/{ref}/link` | `patients:read` | — |
| **Πιστότητα** | `GET /v1/loyalty/config` · `GET /v1/loyalty/customers/{ref}` · `POST /v1/loyalty/enroll` · `GET /v1/loyalty/rewards` · `POST /v1/loyalty/redeem` | `loyalty:read/write` | `loyalty` |
| **Κλινικά** | `POST /v1/clinical/interactions` · `POST /v1/clinical/advise` | `clinical:read` | `pharmacat`/`ai_assistant`/`drug_interactions` |

### 10δ.1 Η στρατηγική: γιατί πιστότητα και PharmaCat στο API

Τα εμπορικά προγράμματα φαρμακείου **δεν έχουν** πρόγραμμα επιβράβευσης, και **δεν έχουν** την
πλήρη εικόνα της αγωγής του ασθενή. Το RxVision έχει και τα δύο. Άρα:

- **Δεν ανταγωνιζόμαστε** — δεν κάνουμε τιμολόγηση, αποθήκη, παραστατικά. Δεν πατάμε στα πόδια
  τους σε τίποτα από αυτά που πουλάνε.
- **Τους δίνουμε δυνατότητες που δεν έχουν**: κάρτα πιστότητας στο ταμείο τους, και έλεγχο
  αλληλεπιδράσεων πάνω στην **πλήρη αγωγή από ΗΔΥΚΑ** — συνταγές που εκτελέστηκαν σε **άλλα**
  φαρμακεία, τις οποίες η βάση τους δεν μπορεί να γνωρίζει.
- **Παίρνουμε τα καλάθια** — τις ελεύθερες πωλήσεις που δεν βλέπουμε από την ΗΔΥΚΑ. Έτσι η
  εικόνα του φαρμακείου γίνεται πλήρης, και όλα τα αναλυτικά που πληρώνει καλυτερεύουν μαζί.

**Ο κύκλος (flywheel):** στέλνουν καλάθι → πιστώνονται πόντοι → ο πελάτης ξαναέρχεται για να τους
ξοδέψει → περισσότερα καλάθια → πληρέστερη εικόνα → καλύτερος κλινικός έλεγχος και καλύτερες
προτάσεις. Κάθε γύρος κάνει την αντικατάσταση του RxVision πιο δύσκολη **χωρίς κλείδωμα** — με
συσσωρευμένη αξία.

### 10δ.2 Η γέφυρα πελάτη (`services/partner_customers.py`)

Το εμπορικό ξέρει τον πελάτη με **δικό του** κωδικό· εμείς με εγγραφή `patients_anonymized`.
Συλλογή `partner_customers` (μοναδικό `tenant_id+customer_ref`).

- **Ταυτοποιητικό στοιχείο ταξιδεύει ΜΙΑ ΦΟΡΑ**, στο `POST /v1/customers/link`, πίσω από το
  ευαίσθητο `patients:read`. Κάθε επόμενη κλήση χρησιμοποιεί τον **δικό του** κωδικό.
- **Κανένα δικό μας id δεν φεύγει ποτέ** — ούτε `_id`, ούτε ψευδώνυμο.
- Αντιστοίχιση με **ΑΜΚΑ** (μοναδικό) ή **κινητό** (τελευταία 10 ψηφία). Αν το τηλέφωνο ταιριάξει
  σε **πολλούς** (οικογένεια) → **409, καμία σύνδεση**. Λάθος σύνδεση εδώ δεν βάζει μόνο πόντους
  σε άλλο πρόσωπο — βάζει **αγωγή** άλλου προσώπου.
- `DELETE` σβήνει τον δείκτη και **τίποτα άλλο** (GDPR: δικαίωμα διαγραφής χωρίς παρενέργειες).

### 10δ.3 Πιστότητα στο ταμείο — δύο σχεδιαστικές αποφάσεις με σημασία

**(α) Το υπόλοιπο σπάει στα δύο.** Το `member()` περνά από `_chain_analysis()`, που σαρώνει
**όλες** τις εκτελέσεις του φαρμακείου — αδύνατο σε κλήση ταμείου ανά πελάτη. Το νέο
`till_card()`:

| Μέρος | Πηγή | Cache |
|---|---|---|
| πόντοι από **εκτελέσεις** | `_refills_since` (μόνο εγγεγραμμένοι) | **5΄** (Redis) |
| **εξαργυρώσεις & bonus** | aggregate σε **ΕΝΑΝ** ασθενή | **ποτέ** |

Η δεύτερη γραμμή δεν είναι βελτιστοποίηση, είναι **ασφάλεια**: με cache στις εξαργυρώσεις ο
πελάτης θα ξόδευε το ίδιο υπόλοιπο δύο φορές μέσα στο παράθυρο, και θα πλήρωνε το φαρμακείο.
Redis κάτω → υπολογίζει, δεν σπάει.

**(β) Ιδεμποτεντία σε κάθε κίνηση αξίας.** `redeem`/`redeem_reward` δέχονται πλέον προαιρετικό
`dedup_key`, και η πίστωση από πώληση περνά από το υπάρχον `_credit_once`:

| Κίνηση | `dedup_key` |
|---|---|
| πίστωση από πώληση | `pos:earn:{external_id}` |
| εξαργύρωση στο ταμείο | `pos:redeem:{external_id}` |

Χωρίς αυτό, **ένα timeout** στο ταμείο και μια επανάληψη θα ξόδευαν δύο φορές το πορτοφόλι του
πελάτη — ή θα χάριζαν δύο φορές πόντους που πληρώνει το φαρμακείο. Ευρετήριο
`loyalty_ledger(tenant_id, dedup_key)` sparse.

**Πόντοι από το ταμείο:** νέες ρυθμίσεις `pos_earn_enabled` (**OFF** εξ ορισμού — οι πόντοι
κοστίζουν πραγματικά €) και `pos_earn_pct` (clamp 0–100). Η πίστωση γίνεται **μέσα** στο
`POST /v1/sales` — αν απαιτούσε δεύτερη κλήση, κάποιοι δεν θα την έκαναν ποτέ και ο πελάτης θα
ρωτούσε «γιατί δεν πήρα πόντους». Υπολογίζεται **μόνο** στην αξία **μη-συνταγογραφούμενων**:
τα rx έχουν κρατική διατίμηση (ίδιος κανόνας με την έκπτωση καλαθιού στην πύλη).

> **Αν η πίστωση αποτύχει, η πώληση ΔΕΝ χαλάει.** Είναι ήδη αποθηκευμένη· το σφάλμα καταγράφεται
> και η απάντηση λέει `credited_cents: 0`. Ένα 500 εδώ θα έκανε τον συνεργάτη να ξαναστείλει
> καλάθι που μπήκε κανονικά.

### 10δ.4 PharmaCat στο API — τρεις φραγμοί κόστους

Το `/v1/clinical/*` καλεί τα υπάρχοντα `PharmaCatRepository.interactions_for_patient` /
`chat`, άρα κληρονομεί **αυτόματα**:

1. **Ημερήσιο όριο AI ανά φαρμακείο** (`ai_quota.check_and_consume`) → 429 με ρητό μήνυμα ότι
   δεν φταίει το κλειδί.
2. **Κοινό cache απαντήσεων** (`pharmacat_knowledge`, ανά υπογραφή ερωτήματος) → ίδιος
   συνδυασμός φαρμάκων = **δωρεάν και ακαριαίο**, και το `source: cache` το λέει.
3. **Φρουρός module** — χωρίς `pharmacat`/`ai_assistant`/`drug_interactions` → 403.

Ο συνεργάτης **δεν μπορεί** να ξοδέψει χρήματα του φαρμακείου με polling.

**Ο καθαρός διαχωρισμός ρόλων:** επιστρέφουμε **κατηγορίες** ΜΗ.ΣΥ.ΦΑ., ποτέ συγκεκριμένο
προϊόν. Η κλινική κρίση μένει σε μας, η **εμπορική απόφαση** (ποιο προϊόν, σε ποια τιμή, από το
δικό του απόθεμα) μένει στο εμπορικό πρόγραμμα. Γι' αυτό δεν αισθάνεται ανταγωνισμό.

> `patients:read` **απαιτείται** για να μπει η αγωγή του ασθενή στον έλεγχο. Χωρίς αυτό, το
> endpoint ελέγχει **μόνο** το καλάθι — και το λέει ρητά με 403 αν στάλθηκε `customer_ref`,
> αντί να σιωπήσει και να αφήσει τον προγραμματιστή να νομίζει ότι έλεγξε την αγωγή.

### ⚠ ΕΚΚΡΕΜΕΙ ΠΡΙΝ ΒΓΕΙ ΣΤΟΝ ΑΕΡΑ
1. **DNS**: A/CNAME `api` και `developers` → ίδιος στόχος με το `app`, **proxied (orange)**.
2. **Πιστοποιητικό origin**: το τρέχον καλύπτει ΜΟΝΟ `app`/`adminpanel`/`my`
   (`/root/rxvision-origin-ca/`). Με Cloudflare SSL «Full (strict)» τα νέα hostnames θα
   δίνουν **526** μέχρι να επανεκδοθεί με τα νέα SAN.
3. **Transform Rule** `X-Origin-Auth`: να επεκταθεί στα νέα hostnames, αλλιώς **403**.
4. **Οθόνη έκδοσης κλειδιών** για τον φαρμακοποιό (Ρυθμίσεις → Κλειδιά API).
5. **Rate limit** 600/λεπτό ανά κλειδί — τεκμηριωμένο, **δεν έχει συνδεθεί ακόμη**.

## 11. Frontend gotchas

- **Inline components με text input → focus loss:** helper component (π.χ. `Field`) ορισμένος inline μέσα
  σε render → κάθε keystroke re-mount το `<input>` → χάνεται το focus (1 χαρακτήρας/κλικ). **Πάντα module
  scope** + state ως props. (Fix: `ContactCard.tsx`.) Grep: inline `const [A-Z]… = (` με `<input`.
- **JSX text:** χωρίς raw `'` (σπάει `next build` — ESLint react/no-unescaped-entities).

Συνέχισε στο [DATABASE.md](DATABASE.md).
