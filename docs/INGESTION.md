# RxVision — Data Ingestion

Δύο πηγές, ένα κοινό normalize→validate→dedup→persist pipeline. Όλα τα βήματα γράφουν
`sync_jobs` (per-tenant) και per-tenant logs.

> **Country rule (επιβάλλεται):** το φαρμακείο (tenant) δένεται σε **μία** πηγή από τη χώρα του —
> **GR → ΗΔΙΚΑ**, **CY → ΓΕΣΥ**. Ένας GR tenant ΔΕΝ μπορεί να κάνει ingest ΓΕΣΥ και αντίστροφα
> (`app/services/ingestion/sources.py`, 409 στο API boundary).
>
> **Status:** η **ΗΔΙΚΑ/Ελλάδα** είναι σε προτεραιότητα και υλοποιημένη end-to-end (engine +
> adapter interface· ο adapter δίνει synthetic demo data μέχρι να υπάρξει πρόσβαση στο πραγματικό
> API). **ΓΕΣΥ/Κύπρος** (XML upload) είναι έτοιμο αλλά gated για δεύτερο step.
> Σήμερα το processing γίνεται **inline** στο request (≤25MB)· για μεγάλα/αυτόματα → Celery worker.

Implementation: `app/services/ingestion/` — `canonical.py` (source-agnostic model),
`gesy.py` & `hdika.py` (adapters → canonical), `validate.py`, `engine.py` (persist core),
`sources.py` (country rule).

```
 source adapter ─▶ normalizer ─▶ validator ─▶ deduplicator ─▶ persister ─▶ post-process
 (HDIKA/GESY)      (→canonical)   (schema/biz)  (natural key+hash) (upsert)   (future rx, counters)
        │                                                                         │
        └──────────────────── sync_jobs (status, stats, errors) ◀────────────────┘
```

## 1. Canonical model
Κάθε adapter μετατρέπει την πηγή σε **ένα** canonical dict που ταιριάζει στο
`prescription_executions` + `prescription_items` (βλ. DATABASE.md). Έτσι το downstream
είναι αγνωστικιστικό ως προς πηγή.

## 2. 🇬🇷 ΗΔΙΚΑ (e-prescription) — automated, αέναο sync
- **Credentials:** ο tenant καταχωρεί ΗΔΙΚΑ creds μέσω `PUT /ingestion/credentials/hdika`
  → αποθηκεύονται **μόνο** στο Vault (`vault://tenants/<id>/hdika`). Το app κρατά reference.
- **Initial full sync:** worker `ingestion_hdika_full` τραβά όλο το διαθέσιμο ιστορικό
  (paged ανά ημερομηνία/σελίδα). Μεγάλο job → chunked, resumable μέσω `sync_jobs.cursor`.
- **Incremental (αέναο):** Celery beat προγραμματίζει `ingestion_hdika_incremental` ανά
  N λεπτά (tenant-configurable). Cursor = `last_executed_at` του προηγούμενου επιτυχημένου
  job· τραβά μόνο νέες εκτελέσεις (`executed_at > cursor` με overlap buffer για late arrivals).
- **Auth lifecycle:** session/token της ΗΔΙΚΑ ανανεώνεται από τον adapter· αποτυχία auth →
  job `failed` με reason `auth_expired` και notification στον tenant να ανανεώσει creds.

## 3. 🇨🇾 ΓΕΣΥ — manual XML upload (→ API αργότερα)
- **MVP:** `POST /ingestion/gesy/upload` (multipart XML). Streaming parser (lxml/iterparse
  για μεγάλα αρχεία) → canonical → ίδιο pipeline.
- **Validation πριν persist:** XSD/schema check· report γραμμών που απορρίφθηκαν.
- **Future:** όταν δοθεί ΓΕΣΥ API, ένας `GesyApiAdapter` αντικαθιστά το upload με ίδιο
  contract — καμία αλλαγή downstream.

## 4. Deduplication & idempotency
- **Natural key:** `{tenant_id, source, external_id}` με **unique index** → `upsert`
  ποτέ δεν δημιουργεί διπλό.
- **Content hash:** `hash = sha256(canonical_payload)`· αν ίδιο external_id αλλά
  διαφορετικό hash → update (η πηγή διόρθωσε εγγραφή), αλλιώς skip (no-op).
- Στατιστικά στο `sync_jobs.stats`: `fetched/inserted/updated/duplicates/invalid`.

## 5. Validation
- **Schema-level (Pydantic):** τύποι, required, enums (status, category).
- **Business-level:** `amount_claimed ≤ amount_total`, `repeat_current ≤ repeat_total`,
  έγκυρο `fund code`, υπαρκτό ICD-10 (αλλιώς flag `unknown_icd`), θετικές τιμές.
- Άκυρες εγγραφές → δεν μπλοκάρουν το batch· καταγράφονται σε `sync_jobs.errors[]` με
  λόγο & raw ref, και ο tenant τα βλέπει σε «Ingestion → Errors».

## 6. Retry mechanism
- Celery autoretry με **exponential backoff + jitter** (π.χ. 1m,5m,15m,1h), max attempts.
- Transient (network/5xx/timeout) → retry. Permanent (auth/validation) → fail fast +
  notify. `sync_jobs.attempts` μετρά. Dead-letter: job μένει `failed`, ορατό στο UI με κουμπί retry.

## 7. Incremental sync details
- Overlap window (π.χ. `cursor - 24h`) ώστε late-posted συνταγές να μην χάνονται· dedup
  αναλαμβάνει τα διπλά.
- Watermark αποθηκεύεται ατομικά μόνο μετά από επιτυχές persist του chunk.

## 8. Post-processing (μετά το persist)
1. **Counters:** ενημέρωση `patients_anonymized.rx_count/value`, `products.rx_frequency`,
   `doctors.first_seen_at`.
2. **Future prescriptions:** για κάθε execution με `repeat_current < repeat_total`,
   υπολόγισε `next_open_date` → upsert σε `future_prescriptions`.
3. **Snapshot invalidation:** marker ώστε το nightly snapshot να ξαναϋπολογίσει τις
   επηρεασμένες περιόδους (ή incremental update).

## 9. Error reporting & logs ανά tenant
- Κάθε log line φέρει `tenant_id`, `sync_job_id`, `request_id`.
- Endpoint `GET /ingestion/jobs` & `/jobs/{id}` δίνουν stats + errors στον tenant.
- Alerts: αν N συνεχόμενα incremental jobs αποτύχουν → email/in-app στον owner.

## 10. Ασφάλεια ingestion
- Creds **ποτέ** σε DB/logs/responses (μόνο Vault). Worker τα διαβάζει runtime με
  short-lived lease. PII (AMKA) **ανωνυμοποιείται στο σημείο εισόδου** (normalizer), πριν
  γραφτεί οτιδήποτε — βλ. [SECURITY_GDPR.md](SECURITY_GDPR.md).
