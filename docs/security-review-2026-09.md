# Έλεγχος Ασφαλείας RxVision — Σεπτέμβριος 2026

> Read-only έλεγχος (καμία αλλαγή κώδικα). 5 παράλληλοι ελεγκτές: Scraping · Απομόνωση tenant ·
> Μυστικά & Απώλεια δεδομένων · AuthZ/API · Διαχωρισμός 3 επιφανειών (adminpanel/app/my).
> Έμφαση (κατ' εντολή ιδιοκτήτη): **δυνατότητα scraping** και **διαρροή/απώλεια δεδομένων** — «αστακός».

## Συνολική εικόνα

Το σύστημα είναι **ασυνήθιστα ώριμο σε ασφάλεια**. Οι θεμελιώδεις άμυνες κρατούν:

- **3 κρυπτογραφικά ξεχωριστές ταυτότητες** (tenant `tid` / platform `padmin` / patient) — ξεχωριστό
  κλειδί υπογραφής **ΚΑΙ** ξεχωριστό audience, με αμοιβαία απόρριψη. Αδύνατη η σύγχυση token.
- **Απομόνωση tenant «by construction»** μέσω `BaseRepository` (unit-tested). **Κανένα** Critical/High
  cross-tenant vector ανάγνωσης/εγγραφής.
- JWT σκληρυμένο (pinned algorithm, no `none`, Argon2, refresh revocation, 15′ access TTL).
- Prod fail-fast guards, Vault υποχρεωτικό, GPG offsite backups με pinned host key, audit χωρίς PII.
- Ισχυρά headers (HSTS/CSP/nosniff), origin-auth guard, rate-limit + account lockout, defused XML, PIL re-encode εικόνων.

Τα ευρήματα **δεν** είναι σπασμένη απομόνωση — είναι κυρίως: (α) **webhooks πληρωμών που εμπιστεύονται
πλαστογραφήσιμη είσοδο (fail-open)**, (β) **γραφές πίσω από read-only permissions**, (γ) **PII (ΑΜΚΑ)
plaintext at rest**, (δ) **monitoring in-band** στην ίδια Celery που κόλλησε 13ώρες.

---

## 🔴 Κρίσιμα / Υψηλά (προτεραιότητα)

### H1 — Viva payment webhooks επιβεβαιώνουν πληρωμή σε πλαστογραφήσιμη είσοδο (payment bypass) · fail-open
**Αρχεία:** `backend/app/repositories/orders_delivery.py:725,737-744` (e-shop `confirm_viva_payment`) ·
`backend/app/services/billing_service.py:582,591-593` (συνδρομές `handle_viva_webhook`) ·
endpoints `patient.py:832`, `billing.py:31`.

Και τα δύο Viva webhooks είναι **χωρίς auth/υπογραφή** (η Viva δεν δίνει HMAC) και βασίζονται σε
«re-fetch της συναλλαγής» — που **παρακάμπτεται**:
- **e-shop**: η επαλήθευση είναι μέσα σε `if transaction_id:`. Αν ο επιτιθέμενος **παραλείψει** το
  `TransactionId`, δεν τρέχει καμία επαλήθευση → η παραγγελία γίνεται `paid`. Ακόμη κι αν υπάρχει, το
  `get_transaction` επιστρέφει `None` σε σφάλμα και το guard «πέφτει» σε `paid` (fail-open).
- **συνδρομές**: `status_id = ... or ""` και `if status_id and status_id != "F": return` → κενό/άγνωστο
  status θεωρείται **επιτυχία** → `complete_renewal`, `mark_pending_paid` (εγγραφή χωρίς πληρωμή), top-up wallet.

**Σενάριο:** Ο πελάτης κάνει μια online παραγγελία, παίρνει το δικό του `viva_order_code`, και αντί να
πληρώσει κάνει POST `{"EventData":{"OrderCode":"<code>","MerchantTrns":"renew:<tid>"}}` (χωρίς
TransactionId) στο δημόσιο webhook → παραγγελία/συνδρομή/εγγραφή = πληρωμένη, ή πίστωση wallet, **χωρίς
να κινηθεί χρήμα**.

**Διόρθωση:** Fail **closed** — `if status_id != "F": return` (ποτέ κενό/αποτυχία ως επιτυχία)· στο e-shop
απαίτησε επιτυχές re-fetch (απόρριψη αν λείπει `transaction_id` ή `get_transaction` επιστρέφει falsy).
Επιπλέον Viva source-IP allowlist.

### H2 — RBAC ενοτήτων adminpanel «ανοίγει» για μη-χαρτογραφημένα URL segments (privilege escalation στο staff)
**Αρχείο:** `backend/app/api/v1/routers/admin.py:71-74` (`enforce_section`), grandfather `:67`, regex-from-URL `:70`.

Και τα 142 admin endpoints είναι σωστά πίσω από `get_platform_admin` (το όριο platform/tenant είναι
άθικτο). Όμως **μέσα** στο CloudOn staff, ο περιορισμός ανά ενότητα βασίζεται στο 1ο URL segment μέσω
`_SEG_TO_SECTION`· ένα **μη-χαρτογραφημένο** segment επιστρέφει `ctx` (**allow**) για κάθε admin. Πολλά
state-changing endpoints ζουν σε μη-χαρτογραφημένα segments: `PUT /integrations` (`:1182`, γράφει
Revolut/ΑΑΔΕ μυστικά), `POST /data-retention/purge` (`:2777`, μη-αναστρέψιμη διαγραφή cross-tenant),
`POST /eshop-fees/tenant/{tid}/charge` (`:2940`, χρεώνει κάρτα φαρμακείου), `PUT /network/users/{id}` (`:3354`).

**Σενάριο:** staff με μόνο `["newsletter"]` καλεί `PUT /admin/integrations` με δικά του κλειδιά πληρωμών, ή
τρέχει data purge.

**Διόρθωση:** `enforce_section` fail **closed** — deny (ή `super_admin`) όταν `section is None` για
μη-super/legacy admins· πρόσθεσε **κάθε** state-changing segment στο `_SEG_TO_SECTION`.

### H3 — Raw ΑΜΚΑ + ονόματα ασθενών αποθηκεύονται **plaintext at rest** (GDPR Art. 9 έκθεση)
**Αρχεία:** `backend/app/services/ingestion/engine.py:316,331-332` (collection `patients_anonymized`) ·
`patient_accounts.amka` (raw) · reads: `death_sweep.py:23`, `workers/reminders.py:22`,
`patient_intelligence.py:424`, `vaccination_campaigns.py:216`.

Το CLAUDE.md + `utils/anonymization.py` δηλώνουν ότι το raw ΑΜΚΑ δεν αποθηκεύεται ποτέ (μόνο HMAC pseudonym).
Στην πράξη το `patients_anonymized` κρατά **raw `amka` + full_name + περιοχή + έτος γέννησης**. Καμία
κρυπτογράφηση at-rest (ούτε field-level, ούτε στον όγκο `mongo_data`). Το όνομα της collection είναι
παραπλανητικό. Είναι **σκόπιμη** απόφαση (ο φαρμακοποιός πρέπει να βλέπει ποιος είναι ο ασθενής) — αλλά
ένα κλεμμένο disk/backup εκτός-κουτιού = cleartext ΑΜΚΑ + ονόματα όλων → αναφερόμενη παραβίαση.

**Διόρθωση:** (α) field-encryption των αναγνωριστικών at-rest (Fernet-ανά-πεδίο με κλειδί από Vault, όπως
τα creds), ή (β) storage-level encryption στον `mongo_data` (WiredTiger encryption-at-rest / encrypted
volume)· (γ) εναρμόνισε το CLAUDE.md (τεκμηρίωσε τη ρητή εξαίρεση) και μετονόμασε την collection.

### H4 — Το monitoring τρέχει «in-band» στην ίδια Celery που μπορεί να κολλήσει (το τυφλό σημείο του 13ωρου)
**Αρχεία:** `backend/app/workers/ops_health.py:42` (το `check` είναι Celery beat task) ·
`celery_app.py:28` (`visibility_timeout=43200` = 12h).

Ο watchdog καλύπτει πολλά (backups, node liveness, Vault, φρεσκάδα ingestion, χωρητικότητα DB) — αλλά
τρέχει **ως Celery task**. Αν κολλήσει ο beat/worker (ακριβώς το incident 2026-09-05), το `ops_health.check`
**δεν τρέχει** και δεν στέλνεται alert. Δεν υπάρχει out-of-band dead-man's-switch ούτε άμεσος έλεγχος
βάθους ουράς. Το `visibility_timeout=43200` σημαίνει ότι μήνυμα κολλημένου worker δεν επαναπαραδίδεται
για **12 ώρες** — δομικός συντελεστής του σιωπηλού κενού.

**Κατάσταση:** ✅ Μερικώς αντιμετωπίστηκε στη συνεδρία 2026-09-05 — προστέθηκαν Celery **time-limits**
(soft 600/hard 900) + **ανεξάρτητος watchdog στο MGMT01** (SMS + auto-restart), εκτός της ουράς.
**Απομένει:** (i) εγκατάσταση του `install-worker-watchdog.sh` από τον ιδιοκτήτη· (ii) εξωτερικός
dead-man's-switch (π.χ. Healthchecks.io ping) που να ειδοποιεί στην **απουσία** heartbeat· (iii) μείωση
`visibility_timeout` προς τη μέγιστη πραγματική διάρκεια task.

---

## 🟠 Μεσαία

### M1 — Apifon DLR webhook χωρίς auth/υπογραφή, κινεί επιστροφές wallet
**Αρχείο:** `backend/app/api/v1/routers/communications.py:295` (`apifon_dlr`), lookup χωρίς tenant filter `~:322`, refund `~:332`.

Χωρίς auth/υπογραφή (γνωστό TODO). Ψάχνει `sent_messages` με `provider_message_id` χωρίς tenant filter και σε
`failed` καλεί `message_wallet.refund`. Οποιοσδήποτε μαντέψει/δώσει `provider_message_id` μπορεί να πλαστογραφήσει
`UNDELIVERED` → **επιστροφή credit** (δωρεάν μηνύματα), ή `DELIVERED` → ψευδής αναφορά παράδοσης.

**Διόρθωση:** επαλήθευση Apifon shared-secret/υπογραφής πάνω στο raw body (μοντέλο ο σωστός Revolut handler
`billing.py:111` — HMAC + replay-dedup). Scope το lookup ανά tenant.

### M2 — Rate-limit ΛΕΙΠΕΙ στα χειροκίνητα Profarm scrape endpoints (κατάχρηση / self-lockout / AI κόστος)
**Αρχείο:** `backend/app/api/v1/routers/pharmacy_catalog.py:505-560` (`/test`, `/sync`, `/import`, `/classify`).

Ο μηχανισμός `rate_limit(...)` υπάρχει αλλά εφαρμόζεται **μόνο** σε auth routes. Κάθε `/test`/`/sync` κάνει
**φρέσκο login** στο `b2b.profarmsa.gr` + έως 50 barcode searches. Χρήστης με `portal:manage` (ή κλεμμένο
session) σε loop → δεκάδες γρήγορα credential POSTs → πιθανό **κλείδωμα του πραγματικού B2B λογαριασμού** ή
DoS στην Profarm. Το `/classify` καλεί paid Anthropic (cap 500) χωρίς throttle → AI κόστος.

**Διόρθωση:** `Depends(rate_limit("profarm_sync", ...))` στα 4 endpoints· επαναχρησιμοποίηση session αντί
login-ανά-request· per-tenant cooldown.

### M3 — Πληρωμένη μαζική αποστολή & κουπόνια πίσω από read permission
**Αρχεία:** `communications.py:191` (`POST /communications/send`, guard `patients:read`) ·
`marketing.py:45,76,86,106` (coupons redeem/create/toggle/settings, guard `patients:read`).

Το `/send` στέλνει πραγματικά SMS/email/Viber και **χρεώνει το wallet** (+ κουπόνια), αλλά ζητά μόνο
`patients:read`. Τα αντίστοιχα οικονομικά endpoints ζητούν `billing:manage`. Ένας view-only χρήστης
αδειάζει το prepaid wallet / δημιουργεί εκπτώσεις.

**Διόρθωση:** gate με write/comms/billing permission (π.χ. νέο `marketing:manage` / `portal:manage`).

### M4 — Απομόνωση tenant στο analytics/worker path επιβάλλεται «με πειθαρχία», όχι δομικά
**Αρχεία (ενδεικτικά):** `reimbursement.py` (~20 raw aggregates), `patient_intelligence.py:231-936`,
`contacts.py:215`, `loyalty.py:313,372`, `comms.py:448-596`, `marketing.py:50`, **και** ο scraper
`profarm_service.py:151,208,530,561`.

Δεκάδες hot-path queries πάνε κατευθείαν σε `self._db["..."]` / `shared_db()["..."]` και ξαναγράφουν το
`{"tenant_id": ...}` **στο χέρι**. Όλα **σωστά τώρα**, αλλά το invariant που διαφημίζει το CLAUDE.md δεν τα
προστατεύει — μια μελλοντική προσθήκη που ξεχνά το φίλτρο θα διαρρεύσει cross-tenant **σιωπηλά** και θα
περάσει το CI.

**Διόρθωση:** CI-lint που αποτυγχάνει σε `self._db[` / `shared_db()[` πάνω σε tenant collection χωρίς
κοντινό `tenant_id`· ή scoped helper `aggregate_on(coll, pipeline)` που prepend-άρει το tenant match.

### M5 — Το adminpanel (bundle+login+`/platform` APIs) σερβίρεται και στα hosts app/my (path-based μόνο)
**Αρχεία:** `infra/docker/Caddyfile:126-145`, `frontend/src/middleware.ts:31-42`.

Και τα 3 hosts κάνουν `import api_and_app`, οπότε `/admin` & `/portal` & `/api/*` σερβίρονται σε κάθε host.
Το `https://my.rxvision.gr/admin` δείχνει το login διαχειριστή. **Δεν** διαρρέει δεδομένα (τα APIs θέλουν
`padmin`), αλλά το back-office είναι ανακαλύψιμο/επιτεύξιμο από λάθος host, και ένα XSS στο host ασθενή έχει
το admin login in-origin.

**Διόρθωση:** στο `middleware.ts` 404/redirect για `/admin` όταν `host != ADMIN_HOST` (και συμμετρικά για
`/portal`)· ιδανικά χώρισε τα Caddy sites ώστε κάθε host να προξενεί μόνο το δικό του δέντρο.

### M6 — Το κλειδί κρυπτογράφησης μυστικών (KEK) παράγεται από το `JWT_SECRET`
**Αρχείο:** `backend/app/services/platform_secrets.py:48-51`.

Το Fernet κλειδί που προστατεύει τα «κοσμήματα» (Anthropic/Revolut/Viva/Apifon/ΑΑΔΕ/SMTP/Hetzner/Cloudflare)
= `sha256("rxvision-platform-secrets:" + JWT_SECRET)`. Διαρροή του `JWT_SECRET` δίνει **και** πλαστογράφηση
token **και** αποκρυπτογράφηση όλων των μυστικών. Κάνει και τη rotation επώδυνη.

**Διόρθωση:** ανεξάρτητο `SECRETS_ENCRYPTION_KEY` στο Vault, με versioning για rotation χωρίς μαζικό re-encrypt.

### M7 — Tokens και στις 3 επιφάνειες σε `localStorage` υπό CSP με `unsafe-inline`
**Αρχεία:** `apiClient.ts`, `adminClient.ts`, `patientClient.ts`, `middleware.ts:15`.

Access **και** refresh JWT σε `localStorage`, με CSP `script-src 'self' 'unsafe-inline'`. Οποιοδήποτε XSS σε
ένα origin κλέβει πλήρως-ανανεώσιμο session. **Μετριασμός (πραγματικός):** τα 3 subdomains = διαφορετικά
origins → per-origin απομόνωση (padmin token δεν διαβάζεται από app/my).

**Διόρθωση:** refresh token σε `HttpOnly; Secure; SameSite` cookie· αφαίρεση `unsafe-inline` (hash/nonce).

---

## 🟡 Χαμηλά / Ενημερωτικά

- **L1 — Impersonation** εκδίδει **πλήρους διάρκειας** access+refresh, μεταφερόμενα σε **URL fragment**
  (`admin.py:1902-1913`, `login/page.tsx:64-76`). Θετικά: audit-logged, `nion` flag, εκτός seat-cap,
  `noopener`, καθαρισμός hash. **Διόρθωση:** βραχύβιο, μη-ανανεώσιμο token με `imp` claim / one-time code.
- **L2 — Cross-tenant AI-advice cache** (`patient_intelligence.py:129-133`) με global-pepper pseudonym, χωρίς
  tenant filter. Καλά φραγμένο (θέλει τον ασθενή στον καλούντα tenant + ίδιο clinical signature), αλλά
  υλοποιεί globally-correlatable pseudonym κάθε ΑΜΚΑ. **Διόρθωση:** κλειδί per-tenant αν δεν είναι απαίτηση.
- **L3 — AMKA→όνομα oracle** στη μεταφορά πελάτη (`patient_transfer.py:60-96`) επιστρέφει `patient_name`.
  **Διόρθωση:** μην επιστρέφεις το όνομα· rate-limit + audit.
- **L4 — Δημόσια σερβιρίσματα by opaque id:** patient avatar (`patient.py:450`, PII πρόσωπο), product image
  (`pharmacy_catalog.py:672`, non-PII ok). **Διόρθωση:** signed URL / gate για το avatar.
- **L5 — `file.read()` χωρίς όριο πριν τον έλεγχο μεγέθους** (`ingestion.py:456`, `patients.py:263`,
  `patient.py:440`) — βασίζεται μόνο στο 30MB cap του Caddy. **Διόρθωση:** μοτίβο `read(_MAX+1)`.
- **L6 — Unscoped reads by `_id`** (`loyalty.py:697`, `reminders.py:22`) — ασφαλή τώρα (trusted input).
  **Διόρθωση:** πρόσθεσε `tenant_id` για defense-in-depth.
- **L7 — Ένα μη-escaped regex** (`scans.py:283` `^{bc}`) — tenant-scoped, barcode-shaped, χαμηλό ρίσκο.
  **Διόρθωση:** `re.escape(bc)`.
- **L8 — legacy plaintext passthrough** στο `pdec()` — τρέξε migration ώστε κανένα `supplier_settings.password`
  να μην είναι χωρίς `enc:v1:`.
- **L9 — `pdec` per-tenant pepper fallback** χαμηλής εντροπίας (`vault_service.py:133`) — provision τυχαίο
  pepper στη δημιουργία tenant.
- **L10 — dead `probe()`** (`profarm_service.py:111-131`) με path param — διάγραψέ το (SSRF αν εκτεθεί).
- **L11 — Billing state χωρίς `billing:manage`** (`billing.py:45,81`), **optical upload σε `closing:read`**
  (`reimbursement.py:263`), **CORS credentials** (βεβαιώσου `CORS_ORIGINS != *` σε prod).

---

## Θέματα ΑΝΘΕΚΤΙΚΟΤΗΤΑΣ / ΑΠΩΛΕΙΑΣ δεδομένων (έμφαση ιδιοκτήτη)

- **`delete_tenant_fully`** (`billing_service.py:373-416`) διατρέχει **όλες** τις collections και κάνει
  `delete_many({"tenant_id": tid})` **χωρίς guard** για κενό/άκυρο `tid`. Κλήση με `None`/`""` = μαζική
  διαγραφή shared docs. **Διόρθωση:** `if not tid: raise`, απαίτηση ύπαρξης tenant doc, soft-delete/undo window, audit counts.
- **`data_retention.purge_old`** (`data_retention.py:128`) hard-delete σε schedule χωρίς dry-run gate στον
  worker (`reminders.py:312`). **Διόρθωση:** pre-delete count/audit + safety cap (άρνηση >X% σε ένα run).
- **Untested restore + 7ημ retention** (`mongo-backup.sh`). **Διόρθωση:** scheduled test-restore σε
  throwaway DB (assert counts) + GFS retention (εβδομαδιαία/μηνιαία).
- **Redis AOF** ενεργό (καλό, μετά το προηγούμενο incident)· **Vault token** auto-renew (καλό).

---

## Δυνατά σημεία (να διατηρηθούν)

Ταυτότητες (3 κλειδιά + 3 audiences + αμοιβαία απόρριψη) · `BaseRepository` hot-path · cross-tenant barcode
guard (ενεργή αποκατάσταση) · μεταφορά πελάτη με έγκριση ασθενή · Revolut webhook HMAC + replay-dedup ·
Argon2 + refresh revocation + anti-enumeration reset · defusedxml/PIL re-encode/GridFS (no path traversal) ·
prod fail-fast guards · Vault υποχρεωτικό · GPG offsite backups (pinned host key) · audit χωρίς PII/bodies ·
origin-auth guard + non-spoofable client IP + no-store σε `/api/*`.

---

## Προτεινόμενο πλάνο δράσης (σειρά)

| # | Εύρημα | Σοβαρότητα | Κατάσταση |
|---|--------|-----------|-----------|
| 1 | H1 Viva webhook fail-closed | 🔴 | ✅ **Διορθώθηκε** (44a98f5) |
| 2 | H2 admin section RBAC fail-closed | 🔴 | ✅ **Διορθώθηκε** (44a98f5) |
| 3 | M1 Apifon DLR shared-secret guard | 🟠 | ✅ Κώδικας έτοιμος — ⚠️ **θέλει ρύθμιση** `comms.apifon_dlr_secret` + callback URL |
| 4 | M2 rate-limit Profarm endpoints | 🟠 | ✅ **Διορθώθηκε** (44a98f5) |
| 5 | M3 permissions σε send/coupons | 🟠 | ✅ **Διορθώθηκε** (44a98f5) |
| 6 | delete_tenant_fully guard + retention safety-cap | 🟠 | ✅ **Διορθώθηκε** (44a98f5) |
| 7 | M5 host-pin `/admin` (404 εκτός adminpanel) | 🟠 | ✅ **Διορθώθηκε** — επαληθεύτηκε 404/200 |
| 8 | L3 AMKA→όνομα oracle (μεταφορά πελάτη) | 🟡 | ✅ **Διορθώθηκε** |
| 9 | L6 unscoped read · L7 regex escape · L10 dead probe() | 🟡 | ✅ **Διορθώθηκαν** |
| 10 | H4 dead-man's-switch + εγκατάσταση watchdog | 🔴 | 🟡 Μερικώς (time-limits+watchdog έτοιμα· **θέλει owner**: install + external ping) |
| 11 | H3 κρυπτογράφηση ΑΜΚΑ at-rest | 🔴 | ⏳ **Εκκρεμεί — θέλει απόφαση προσέγγισης** (volume vs field encryption) |
| 12 | M6 KEK ανεξάρτητο από JWT_SECRET | 🟠 | ⏳ Εκκρεμεί — θέλει migration + Vault provisioning |
| 13 | M7/L1 cookies+CSP+impersonation token | 🟡 | ⏳ Εκκρεμεί — auth refactor (μεσαίο ρίσκο) |
| 14 | M4 CI-lint απομόνωσης tenant | 🟠 | ⏳ Εκκρεμεί — χρειάζεται σταδιακό tuning για μηδέν false positives |
| 15 | L11 write-permissions (scans→closing:run, billing→billing:manage) | 🟡 | ✅ **Διορθώθηκε** (ed8bae9) |
| 16 | L5 bounded file reads (×3) | 🟡 | ✅ **Διορθώθηκε** (ed8bae9) |
| 17 | L8 legacy plaintext passwords | 🟡 | ✅ **Επαληθεύτηκε καθαρό** (0 legacy — όλα `enc:v1:`) |
| 18 | CORS wildcard | 🟡 | ✅ **Επαληθεύτηκε καθαρό** (ρητά origins) |
| 19 | L2 AI-cache per-tenant · L4 avatar signed URL · L9 per-tenant pepper | 🟡 | ⏳ Εκκρεμούν (μικρά) |

**Top-3 άμεσα:** (1) fail-closed στο Viva webhook (πραγματικό payment bypass), (2) fail-closed στο admin
section RBAC, (3) υπογραφή στο Apifon DLR.
