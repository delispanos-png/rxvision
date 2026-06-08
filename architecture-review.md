# RxVision — Architecture Review

> Ανάλυση μόνο για ανάγνωση (read-only). Καμία αλλαγή κώδικα. Ημερομηνία: 2026-06-07 · branch `main` @ `f0f494e`.

## 1. Συνολική εικόνα

RxVision είναι **multi-tenant SaaS PWA** για στατιστική ανάλυση εκτελέσεων συνταγών φαρμακείων (αγορές 🇬🇷 ΗΔΙΚΑ & 🇨🇾 ΓΕΣΥ). Δύο εφαρμογές, ένα backend:

```
┌──────────────┐      ┌──────────────────────────┐      ┌────────────────┐
│ Next.js PWA  │      │ FastAPI (Python 3.12)     │      │ MongoDB 7      │
│ tenant (app) │─────▶│ api / services / repos    │─────▶│ (Motor async)  │
│ admin (back) │ /api │ workers (Celery)          │      │ rs0 (1 node)   │
└──────────────┘      └────────────┬──────────────┘      └────────────────┘
                                   │                      ┌────────────────┐
                                   └─────────────────────▶│ Redis 7        │
                                       broker/cache       │ (Celery+cache) │
                                                          └────────────────┘
```

Μέγεθος: ~83 αρχεία Python (~6.7k LOC `app/`), 62 `.tsx` (~5.5k LOC), σύνολο ~14.7k LOC.

## 2. Backend (FastAPI)

### Layering — καθαρό 4-επίπεδο
- **`api/v1/routers/*`** — λεπτοί HTTP handlers, όλοι συνδεδεμένοι στο `app/api/v1/__init__.py`.
- **`services/*`** — επιχειρησιακή λογική (auth, provisioning, onboarding, ingestion engine/adapters, vault, mailer, noeton).
- **`repositories/*`** — πρόσβαση DB· όλα τα analytic repos κληρονομούν από `BaseRepository`.
- **`workers/*`** — Celery tasks (ingestion, noeton, snapshots).

App factory: `app/main.py:26` (`create_app`), lifespan τρέχει `ensure_indexes()` στο startup.

### Multi-tenancy — η ισχυρότερη απόφαση του σχεδιασμού
`BaseRepository` (`repositories/base.py:34-78`) επιβάλλει `tenant_id` **εκ κατασκευής**:
- `_scope()` εισάγει `tenant_id` σε κάθε filter,
- κάθε `insert_one` σφραγίζει `tenant_id`,
- `aggregate()` προσθέτει υποχρεωτικά `{"$match": {"tenant_id": ...}}` ως **πρώτο** στάδιο.

Αυτό είναι unit-tested (`tests/test_invariants.py`). Το `TenantDatabaseResolver` (`core/db.py:23`) είναι seam για μελλοντικό DB-per-tenant.

**Διαρροή του seam (αδυναμία):** Αρκετά σημεία παρακάμπτουν το `BaseRepository` και χτυπούν `shared_db()` με χειρόγραφα `tenant_id` filters — η εγγύηση «κανένα query χωρίς tenant_id» **δεν είναι καθολική**:
- `services/ingestion/engine.py` (raw collections, χειρόγραφα filters),
- `api/v1/routers/ingestion.py` (raw `shared_db()`),
- ολόκληρο το `admin.py` (νόμιμα cross-tenant, αλλά χωρίς abstraction).

### Dependency injection / request flow
`core/deps.py`: `HTTPBearer` → `decode_token` → `TenantContext` (από JWT claims `tid/sub/roles/modules/perms`). Factory `require(permission, module)` ελέγχει και module-lock και RBAC permission — χρησιμοποιείται με συνέπεια σε όλα τα analytics routers. Οι platform admins είναι ξεχωριστή ταυτότητα (`PlatformContext`, claim `padmin`).

**Anti-pattern:** τα δικαιώματα/modules/roles είναι ενσωματωμένα στο JWT κατά το login και **δεν επαναελέγχονται** ανά request. Αλλαγή ρόλου ή module-lock ισχύει μόνο μετά τη λήξη (15') ή το refresh.

### DB / Redis / Celery
- Ένας global Motor client (`core/db.py`), `tz_aware=True`.
- Celery beat: HDIKA sync κάθε 15', nightly snapshots, retention, Noeton heartbeat/usage. `task_acks_late`, `prefetch_multiplier=1` (σωστά).
- Οι workers δημιουργούν **νέο Motor client + loop ανά task** (`asyncio.run`) — σωστό για loop-binding, αλλά βαρύ.

## 3. Frontend (Next.js 14 App Router)

### Route groups
- `(app)` — authenticated tenant analytics (dashboard, prescriptions, doctors, patients, icd10, profitability, future, orders, closing, settings/*).
- `(marketing)` — login/register/forgot/reset.
- `admin/` — back-office (ξεχωριστή ταυτότητα `padmin`, δικό του layout & gate).

### Auth / session
- **Όλα τα tokens σε `localStorage`** (tenant: `access_token`/`refresh_token`· admin: `padmin_*`). Όχι httpOnly cookies, **όχι** server-side middleware/route protection.
- Όλο το gating είναι UI-only· το backend είναι η μόνη πραγματική άμυνα (ρητά τεκμηριωμένο σε `(app)/layout.tsx`, `ModuleGuard.tsx`).
- Transparent refresh σε 401 με collapse των concurrent refresh (`apiClient.ts`).
- Impersonation: tokens περνούν μέσω URL fragment `#imp=access~refresh`.

### State / data
- **TanStack Query v5** (server state, `staleTime 60s`), **Zustand** ×3 stores (uiStore φίλτρα, navStore drawer, dialogStore modal που αντικαθιστά native alert/confirm).
- ECharts μέσω `echarts-for-react` με `next/dynamic({ssr:false})`, κοινό `theme.ts`.
- **PWA:** `next-pwa` (disabled σε dev) + χειροκίνητο `ServiceWorkerRegister.tsx` (το next-pwa δεν κάνει auto-register σε App Router).

## 4. Ingestion pipeline (πυρήνας του προϊόντος)

Source-agnostic σχεδίαση: **adapters → `CanonicalExecution` → `IngestionEngine`**.
- Χρήμα σε cents· raw AMKA ψευδωνυμοποιείται (HMAC-SHA256) πριν από κάθε εγγραφή — καλή GDPR στάση.
- Idempotency μέσω natural key + content hash (re-runs κάνουν dedup). **Όχι transactional** (delete+insert items χωρίς Mongo session, παρότι το `rs0` το επιτρέπει).
- HDIKA dual-mode: synthetic demo data αν δεν υπάρχουν πραγματικά credentials· πραγματικό path delegate σε `HdikaClient` (**blocking httpx μέσα σε async** — βλ. technical-debt).
- HDIKA XML mapping είναι **provisional / "ASSUMED contract"** εν αναμονή επίσημης προδιαγραφής ΗΔΙΚΑ.

## 5. Συνολική αξιολόγηση

| Άξονας | Εκτίμηση |
|---|---|
| Διαχωρισμός επιπέδων | **Καλός** (api/service/repo/worker) |
| Tenant isolation | **Πολύ καλός** by-construction, με τοπικές διαρροές στο ingestion/admin |
| Συνέπεια προτύπων | **Μέτρια** — διπλασιασμοί helpers, 2 API clients, ad-hoc queryKeys |
| Πληρότητα | **MVP-stage** — πολλά stubs (snapshots, retention, GESY automation, myDATA, MFA, billing) |
| Testability | **Χαμηλή** — 3 test files, μηδέν integration tests, καμία CI |

**Συμπέρασμα:** Ώριμη αρχιτεκτονική βάση με σωστές θεμελιώδεις αποφάσεις (multi-tenancy, canonical ingestion, RBAC, ψευδωνυμοποίηση). Τα κενά είναι κυρίως **ολοκλήρωση λειτουργιών, σκλήρυνση ασφάλειας, και έλλειψη αυτοματισμού/τεστ** — όχι θεμελιώδη σφάλματα σχεδιασμού.
