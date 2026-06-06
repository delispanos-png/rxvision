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
        │  🇬🇷 ΗΔΙΚΑ (e-prescription) — credentials/automated │
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
| `vault` | secrets — tenant ΗΔΙΚΑ/ΓΕΣΥ credentials, encryption keys |

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
 ├─ api_credentials     (ΗΔΙΚΑ/ΓΕΣΥ — encrypted refs σε Vault, ΟΧΙ raw)
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
| 6 | `profitability` | αιτούμενο ταμείου vs χονδρική, μεικτό κέρδος, περιθώριο, χαμηλή κερδοφορία, ασύμφορες κατηγορίες |
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
2. **Precomputed snapshots** για βαριά/ιστορικά (`profitability_snapshots`, daily KPIs):
   nightly Celery job γράφει συγκεντρωτικά → dashboard διαβάζει σχεδόν instant.

Έτοιμα pipelines: [ANALYTICS.md](ANALYTICS.md).

## 7. Data ingestion (περίληψη)

- **ΗΔΙΚΑ (GR):** tenant καταχωρεί credentials (→ Vault). Worker κάνει **αρχικό
  full sync** και μετά **incremental** σε σταθερό interval (αέναο). Retry με backoff,
  duplicate detection με natural key, validation, per-tenant error reporting.
- **ΓΕΣΥ (CY):** αρχικά **χειροκίνητο XML upload** (parse → normalize → ingest), με ίδιο
  validation/dedup pipeline· έτοιμο για automation αν δοθεί API.

Πλήρες flow, retries, incremental cursors: [INGESTION.md](INGESTION.md).

## 8. Βασικές τεχνικές αποφάσεις & αιτιολόγηση

| Απόφαση | Επιλογή | Γιατί | Trade-off |
|---|---|---|---|
| Tenancy | Shared DB + `tenant_id` | απλό, φθηνό, cross-tenant benchmarking, εύκολο onboarding | πρέπει αυστηρό enforcement (το λύνουμε στο repo layer) |
| DB | MongoDB | ετερογενές ingestion (ΗΔΙΚΑ/ΓΕΣΥ διαφορετικά schemas), δυνατό aggregation για stats | όχι ACID πολλαπλών docs — δεν μας χρειάζεται για analytics |
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

Συνέχισε στο [DATABASE.md](DATABASE.md).
