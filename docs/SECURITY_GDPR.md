# RxVision — Security & GDPR

Διαχειριζόμαστε δεδομένα υγείας (special category, GDPR Art. 9). Αρχή σχεδίασης:
**τα analytics δεν χρειάζονται ταυτότητα ασθενούς** — άρα δεν την αποθηκεύουμε ποτέ στο
analytics store. Privacy-by-design & by-default.

## 1. Διαχωρισμός προσωπικών vs στατιστικών δεδομένων (η βασική αρχή)
- Το ingestion δέχεται PII (AMKA, όνομα ασθενούς) **μόνο εφήμερα** στη μνήμη του worker.
- Στο σημείο εισόδου (`normalizer`) ο ασθενής μετατρέπεται σε **`pseudo_id`** και αδρά
  χαρακτηριστικά (φύλο, ηλικιακό group, περιοχή). Τίποτα από το raw PII δεν persist-άρεται.
- Άρα τα analytics collections **δεν περιέχουν** AMKA/όνομα/διεύθυνση/ημ.γέννησης.

## 2. Ανωνυμοποίηση / Ψευδωνυμοποίηση AMKA
- `pseudo_id = HMAC-SHA256(amka, tenant_pepper)`.
- **`tenant_pepper`** = μυστικό ανά tenant, στο Vault (όχι στη DB). Δίνει:
  - σταθερό id ανά tenant (ίδιος ασθενής → ίδιο pseudo_id) ώστε να μετράμε
    συχνότητα/retention,
  - **μη αντιστρεψιμότητα** (HMAC, όχι plain hash → ανθεκτικό σε rainbow/brute AMKA),
  - **μη συσχέτιση μεταξύ tenants** (διαφορετικό pepper → ίδιος ασθενής διαφορετικό id).
- Ηλικία → bucket (`0-17,18-34,...,75+`), διεύθυνση → region. Έτσι αποφεύγεται
  re-identification μέσω quasi-identifiers (k-anonymity friendly).

## 3. Encryption
- **In transit:** TLS 1.2+ παντού (client↔gateway, εσωτερικά service-to-service με mTLS
  στο K8s). HSTS, secure cookies (refresh σε `HttpOnly; Secure; SameSite=Strict`).
- **At rest:** MongoDB encrypted storage engine (WiredTiger encryption) ή
  encrypted volumes (LUKS/cloud KMS). Backups encrypted. Vault sealed με auto-unseal (KMS).
- **Field-level (optional):** για τυχόν ευαίσθητα πεδία tenant settings — MongoDB CSFLE.

## 4. Secrets management
- **Vault** (ή cloud KMS/Secrets Manager) για: tenant ΗΔΙΚΑ/ΓΕΣΥ credentials,
  `tenant_pepper`, JWT signing keys, DB creds.
- App χρησιμοποιεί short-lived dynamic secrets / leases. **Καμία** secret σε env files
  παραγωγής, repo, logs, ή API responses. Rotation πολιτική (JWT keys, peppers με versioning).

## 5. Credential storage για ΗΔΙΚΑ / ΓΕΣΥ
- Endpoint `PUT /ingestion/credentials/*` είναι **write-only**: γράφει στο Vault, δεν
  διαβάζεται ποτέ πίσω από το API. Workers τα διαβάζουν runtime με lease.
- Στο `tenants.credentials_ref` κρατάμε **μόνο** το Vault path + status (set/unset/expired).

## 6. RBAC & tenant isolation (security side)
- Κάθε query tenant-scoped by construction (repository layer) — βλ. ARCHITECTURE §2.3.
- Least privilege roles· module gating· `support` role μόνο read + impersonation **audited**.
- MFA (TOTP) για owner/manager. Password hashing **Argon2id**. Brute-force lockout + rate limit.

## 7. Audit logs
- Καταγράφονται όλα τα: logins, exports, deletions, credential changes, role/permission
  changes, impersonation, settings changes — σε `audit_logs` με `actor, action, ip,
  request_id, outcome, meta`.
- Append-only πρακτικά (write από middleware, καμία update API). Retention κατά πολιτική
  (π.χ. 24 μήνες) με TTL ή cold-archive.

## 8. Data retention
- Configurable ανά tenant/plan (`subscription.limits.history_months`, π.χ. 24–60).
- Nightly job διαγράφει/αρχειοθετεί εγγραφές πέραν του ορίου.
- Audit & σύννομες υποχρεώσεις μπορεί να έχουν διαφορετικό (μεγαλύτερο) retention.

## 9. Δικαιώματα υποκειμένων / Right to be forgotten
- Επειδή ο ασθενής είναι ήδη ψευδωνυμοποιημένος, «διαγραφή ασθενούς» = purge όλων των
  εγγραφών με συγκεκριμένο `pseudo_id` (ο tenant δίνει AMKA → υπολογίζουμε pseudo_id με το
  pepper → διαγραφή). Endpoint/εργαλείο για DPO του φαρμακείου.
- **Tenant deletion (right to erasure σε επίπεδο πελάτη):** soft-delete → grace period →
  hard purge όλων των documents με το `tenant_id` + revoke Vault secrets + delete pepper
  (καθιστά τυχόν backups μη-αναγνώσιμα ως προς ταυτότητες). Καταγραφή στο audit.
- **Data portability:** `POST /tenant/export` → δομημένο JSON/CSV.

## 10. Consent κατά την εγγραφή φαρμακείου
- Στο onboarding ο φαρμακοποιός αποδέχεται **DPA (Data Processing Agreement)**: το
  RxVision είναι **Processor**, το φαρμακείο **Controller**. Καταγράφεται έκδοση DPA,
  timestamp, IP, υπεύθυνος.
- Επιβεβαίωση ότι έχει νόμιμη βάση επεξεργασίας των δεδομένων εκτέλεσης συνταγών και ότι
  τα δεδομένα ψευδωνυμοποιούνται από εμάς.

## 11. Compliance & hardening checklist
- DPIA (Data Protection Impact Assessment) πριν παραγωγή — special category data.
- ROPA (Record of Processing Activities) ως processor.
- Breach notification διαδικασία (72h).
- Pen-test πριν launch· dependency scanning (SCA) στο CI· SAST.
- Security headers, CSP, CORS allowlist ανά tenant domain.
- Rate limiting (Redis token-bucket ανά `tenant+user+route`), WAF στο gateway.
- Backups encrypted, restore drills, RPO/RTO ορισμένα.
