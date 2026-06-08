# RxVision — Technical Debt

> Read-only ανάλυση. Όλες οι αναφορές με `file:line`. Ημερομηνία: 2026-06-07.

## A. Ημιτελή / Stubbed / Placeholder (το μεγαλύτερο debt)

Λειτουργίες που **φαίνονται έτοιμες αλλά δεν λειτουργούν**:

| Περιοχή | Τοποθεσία | Κατάσταση |
|---|---|---|
| Profitability snapshots | `workers/snapshots.py:8-12` | `compute_nightly` επιστρέφει `{"status":"stub"}` → τα snapshots **δεν παράγονται ποτέ**· το profitability πέφτει πάντα σε live scan ή επιστρέφει κενό |
| Data retention | `workers/snapshots.py:18-19` | `apply_retention` stub → **καμία διαγραφή παλιών δεδομένων** (GDPR) |
| GESY automation | `workers/ingestion.py:84-87` | `gesy_xml_ingest` stub· μόνο το manual `gesy/upload` δουλεύει |
| Order-suggestions recompute | `orders.py:43-49` | Καλεί task που **δεν υπάρχει**· `ImportError` καταπίνεται, επιστρέφει `"accepted"` |
| Tenant data export (GDPR) | `tenants.py:46-54` | Ίδιο pattern — task ανύπαρκτο, ψεύτικο `"accepted"` |
| myDATA / ΑΑΔΕ | `admin.py:823-838` | Placeholder MARK `4000{timestamp}` |
| MFA | `auth_service.py:53` | `# TODO: verify mfa_code` — δέχεται **οποιοδήποτε** κωδικό· `mfa_enabled` δεν επιβάλλεται |
| Billing checkout | `subscriptions.py:36` | Hardcoded ψεύτικο URL· κανένας payment provider |
| Region mapping | `utils/anonymization.py:35-37` | Placeholder string-split, χωρίς postal→περιφέρεια |
| Frontend export polling | `components/export/ExportButton.tsx:13` | "Polling is stubbed" — ένα follow-up fetch (χρησιμοποιείται σε 5 σελίδες) |
| Cyprus onboarding | `onboarding/page.tsx:82-94` | "έρχεται σύντομα" — disabled input |
| Language switcher / bell | `Topbar.tsx:73-79` | Non-functional placeholders |

**Επιπτώσεις δεδομένων:** `hdika_client.py:274` κωδικοποιεί `wholesale_price=0` για live HDIKA items → `gross_profit == amount_claimed` → **όλα τα profitability/margin analytics λάθος** για πραγματικούς ΗΔΙΚΑ tenants (κρύβεται στα demos). Επιπλέον το `repeat_total`/`repeat_current` mapping (`hdika_client.py:255-256`) είναι ύποπτο και τροφοδοτεί τη λογική future-prescriptions.

## B. Testing (κρίσιμο κενό)

- **3 test files μόνο** (`test_invariants.py`, `test_ingestion.py`, `test_hdika_client.py`).
- **Μηδέν integration tests** (κανένα FastAPI `TestClient`)· το `require()` gating στο HTTP layer είναι αδοκίμαστο.
- `IngestionEngine` (το πιο κρίσιμο & σύνθετο path) **χωρίς end-to-end tests**.
- `admin.py` (1.164 γραμμές) **εντελώς αδοκίμαστο**.
- Καμία CI (`.github/workflows` ανύπαρκτο), κανένα coverage config, `mongomock-motor` αχρησιμοποίητο.

## C. Code quality / Maintainability

### Backend
- **`admin.py` = 1.164 γραμμές** με ~12 άσχετα concerns (tenants, staff, billing, invoices+ΑΑΔΕ, SMTP, newsletter, CMS, maintenance, ΗΔΙΚΑ, Noeton, health), όλα inline στο router χωρίς service/repo layer. **Η #1 maintainability ευθύνη.**
- **Sync-in-async:** `HdikaClient` χρησιμοποιεί blocking `httpx.Client` (`hdika_client.py:110`) μέσα σε async handlers (`ingestion.py:148,176-200`)· ένα backfill (έως 400 ημέρες) **μπλοκάρει το event loop** για όλα τα requests.
- **29 broad `except Exception`**· κάποια καταπίνουν πραγματικά σφάλματα: `engine.py:68-70` (persist error μετριέται ως "invalid"), `hdika_client.py:190-192` (κάθε αποτυχημένη μέρα → silent `skipped_days`, sync "επιτυχημένο" κενό), `noeton_inbound.py:113-120` (επιστρέφει `{"ok":True}` ενώ απέτυχε).
- **Καμία άνω-φραγή σε `limit`/`page_size`** (π.χ. `prescriptions.py:23`, `patients.py:38`, `users.py:60`) → client ζητά αυθαίρετα μεγάλη σελίδα.
- **Χωρίς pagination** σε admin endpoints που σαρώνουν όλα τα docs (`admin.py` tenants/subscriptions/billing/invoices/health).
- **Duplication helpers:** `_now()`/`_oid()`/`_slugify()`/`_month_range` ξαναγραμμένα σε πολλά modules· καμία κοινή utils. `OnboardingService.register` vs `TenantProvisioningService.open_tenant` διπλασιάζουν tenant+sub+RBAC+owner με διαφορετικές λίστες modules.
- **Όχι transactional ingestion** (delete+insert items χωρίς Mongo session παρότι `rs0` το επιτρέπει).
- Invoice numbering (`admin.py:764-765`): `find_one(sort desc)+1` **χωρίς atomicity** → race/collision.

### Frontend
- **Build quality gates κλειστά:** `next.config.js:30-33` `typescript.ignoreBuildErrors:true` + `eslint.ignoreDuringBuilds:true` — TS/lint errors **δεν μπλοκάρουν το build** (το `tsconfig` είναι `strict` αλλά δεν επιβάλλεται).
- **2 σχεδόν ίδιοι API clients** (`apiClient.ts`, `adminClient.ts`) με διπλό `ApiError`/refresh/redirect.
- `API_BASE` fallback hardcoded σε **4 σημεία**.
- `queryKeys` registry **σχεδόν αχρησιμοποίητο** (52 inline `queryKey` arrays → ρίσκο cache-key drift).
- Πολλές σελίδες **χωρίς error state** (dashboard, prescriptions, doctors, closing...) — σιωπηλά `?? []`.
- 9 `any` types· `<img>` αντί `next/image`· charts χωρίς text alternative (a11y).
- Dead link `/pricing` (`login/page.tsx:137`)· διπλά formatters/badge components.

## D. Infra / build debt

- **Floating image tags + κανένα lockfile** → μη αναπαραγώγιμα builds (backend `pip install -e`, frontend `npm install` αντί `npm ci`).
- **Healthchecks μόνο σε mongo/redis** — api/web/worker/beat/vault/caddy χωρίς, παρότι υπάρχει `/health`.
- **Καμία CI/CD** (μόνο τεκμηρίωση στο `DEPLOYMENT.md`).
- **Καμία resource limit** σε κανένα container.
- `.env.example` **ελλιπές** για prod: λείπουν `CADDY_TLS`, `CF_API_TOKEN`, Noeton secrets, SMTP, Stripe keys.
- Backup: logical dump μόνο, χωρίς PITR/encryption/offsite, restore χειροκίνητο, hardcoded container name.

## E. Συγκεντρωτικός πίνακας TODO/stub (verbatim grep)

```
auth_service.py:53            # TODO: verify mfa_code
anonymization.py:36           # TODO: map postal code -> περιφέρεια
hdika_client.py:274           wholesale_price=0  # TODO masterdata
subscriptions.py:36           # TODO: real payment-provider checkout
snapshots.py:11-12,18-19      stub (compute_nightly, apply_retention)
workers/ingestion.py:86-87    GESY automation = step 2 (stub)
admin.py:826,834              placeholder MARK (myDATA)
ExportButton.tsx:13           Polling is stubbed
```
(Δεν βρέθηκαν `eval`/`exec`/`pickle`/bare `except:`.)
