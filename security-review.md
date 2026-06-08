# RxVision — Security Review

> Read-only ανάλυση. Πολυ-tenant SaaS με δεδομένα υγείας (GDPR / ειδική κατηγορία). Severity: Critical / High / Medium / Low. Ημερομηνία: 2026-06-07.
>
> **Καμία αλλαγή κώδικα δεν έγινε — μόνο ευρήματα.**

## CRITICAL

### C1 — Default JWT secret & anonymization pepper γίνονται σιωπηλά αποδεκτά σε κάθε environment
`core/config.py:20` `JWT_SECRET="change-me-dev-only"`, `:26` `ANONYMIZATION_GLOBAL_PEPPER="change-me-dev-only"`. Κανένας έλεγχος στο startup ότι διαφέρουν σε prod· το `.env.example` φέρνει τα ίδια literals.
- Με γνωστό `JWT_SECRET` (HS256) → **πλαστογράφηση `padmin`/tenant tokens** → πλήρης cross-tenant + platform-admin παραβίαση.
- Με γνωστό pepper → τα ψευδωνυμοποιημένα AMKA γίνονται **brute-forceable** (11ψήφιος γνωστός format → offline dictionary). Το per-tenant pepper πέφτει σε `f"{GLOBAL_PEPPER}:{tenant_id}"` (`vault_service.py:92`), άρα και αυτό προβλέψιμο.

### C2 — Vault disabled → secrets πέφτουν σιωπηλά σε in-memory dev store με τα weak defaults
`vault_service.py:34-50`: αν `VAULT_ADDR`/`VAULT_TOKEN` κενά **ή** auth αποτύχει **ή** λείπει το hvac → log warning + in-process dict seeded με τα default secrets. `.env.example` φέρνει και τα δύο κενά. Ένα misconfigured prod **εκκινεί κανονικά** με όλα τα ΗΔΙΚΑ/ΓΕΣΥ credentials και peppers σε plaintext μνήμη, χωρίς KMS, χωρίς fatal error.

## HIGH

### H1 — Κοινό signing key & ασθενής διαχωρισμός tenant vs platform tokens
Όλα τα tokens με το ίδιο `JWT_SECRET`. `get_current_context` (`deps.py:46-65`) ελέγχει μόνο `scope=="access"`, **δεν απορρίπτει** `padmin`. `AuthService.refresh` (`auth_service.py:69-81`) δέχεται κάθε `scope=="refresh"` χωρίς έλεγχο `padmin`. Καμία κρυπτογραφική διαχωρισμού domain (χωριστά keys/audiences) μεταξύ των δύο κλάσεων ταυτότητας.

### H2 — Password-reset tokens σε plaintext, όχι atomically single-use
`account_service.py:81-104`: το docstring λέει "hashed" αλλά αποθηκεύεται/αναζητείται **cleartext**. Διαρροή DB (βλ. H4/backup) → ζωντανά reset tokens. `reset_password` δεν ξαναελέγχει `status=="active"` (suspended user reset). Lookup-then-update **μη atomic** → race χρήσης token δύο φορές.

### H3 — ReDoS / regex injection στην αναζήτηση ιατρών
`doctors.py:17-21`: το raw `search` περνά κατευθείαν σε `{"$regex": search, "$options":"i"}`. Authenticated tenant user στέλνει catastrophic-backtracking pattern → **CPU DoS** στο shared Mongo.

### H4 — MongoDB & Redis χωρίς authentication· Mongo bind σε όλα τα interfaces
`docker-compose.yml`: mongo `--bind_ip_all` χωρίς `--auth`, port `27017:27017` εκτεθειμένο· redis `6379:6379` χωρίς password. (Το prod αφαιρεί τα published ports, αλλά Mongo/Redis παραμένουν **χωρίς credentials** στο Docker network.) Οποιοδήποτε compromised container διαβάζει/γράφει όλα τα tenant PHI **παρακάμπτοντας κάθε `tenant_id` filter**. Κανένα encryption-at-rest.

### H5 — Portainer εκθέτει το Docker socket & δημοσιεύει `:9000` πάνω από plain HTTP σε prod
`docker-compose.prod.yml:102-110`: mount `/var/run/docker.sock` (root-equivalent στον host) + publish `9000:9000` χωρίς TLS, με first-visit admin password. **Remote root foothold** αν προσεγγιστεί πριν το setup ή με αδύναμο password. (Το ίδιο το σχόλιο προειδοποιεί να γίνει firewall.)

### H6 — Vault listener με TLS disabled
`infra/docker/vault/vault.hcl:9-12` `tls_disable=1` σε `0.0.0.0:8200`. Το Vault token & κάθε secret ταξιδεύουν cleartext στο Docker network — sniff/replay από network-adjacent container.

## MEDIUM

### M1 — XXE στο GESY XML upload
`gesy.py:52` `etree.fromstring(data)` (lxml, default parser) σε **attacker-uploaded** αρχεία (authenticated CY tenant). Default lxml επιτρέπει external entities/DTD → local file read / SSRF / billion-laughs (το 25MB cap δεν σταματά entity expansion). Το σχόλιο "trusted" είναι λάθος. Λύση: parser με `resolve_entities=False, no_network=True`.

### M2 — SSRF μέσω tenant-controlled ΗΔΙΚΑ `base_url`
`schemas/ingestion.py:37` επιτρέπει αυθαίρετο `base_url`· αν το platform `idika.base_url` είναι κενό, ο `HdikaClient` κάνει authenticated GET (με το platform Api-Key) προς το tenant URL → δείχνεις σε `http://vault:8200`, `169.254.169.254`, Mongo κ.λπ. και **exfiltrate το Api-Key**. Καμία allow-list / private-IP φραγή.

### M3 — CORS `allow_credentials=True` με `allow_methods/headers=["*"]`
`main.py:34-40`. Λειτουργικά ΟΚ (origins από env, όχι wildcard), αλλά λάθος ρύθμιση `CORS_ORIGINS=*` από operator θα ήταν εκμεταλλεύσιμη. (Σημείωση: tokens σε `localStorage`, όχι cookies → CORS δεν είναι το κύριο vector· **κάθε XSS = πλήρης παραβίαση session**.)

### M4 — Next.js 14.2.5 με γνωστά CVEs + build αγνοεί type/lint errors
`package.json:13`. 14.2.5 < 14.2.25 (CVE-2025-29927 middleware auth-bypass). Δεν υπάρχει `middleware.ts` (το backend RBAC προστατεύει), αλλά `next.config.js:30-31` `ignoreBuildErrors` ανεβάζει ρίσκο logic/XSS bugs. Newsletter preview `<iframe srcDoc={previewHtml}>` (`admin/newsletter/page.tsx:361`) **χωρίς `sandbox`** → admin-origin stored/self-XSS.

### M5 — Κενά audit logging & αδύναμη ακεραιότητα
`middleware/audit.py`: logάρει μόνο mutating methods, παραλείπει `/auth/login` (**κανένα ίχνος failed-login/bruteforce**), δεν logάρει GET σε PHI ούτε platform credential reads. Τα audit rows γράφονται στο ίδιο **unauthenticated Mongo** χωρίς WORM → attacker σβήνει τα ίχνη. Καμία data-retention/erasure πέρα από hard delete.

### M6 — Αδύναμη πολιτική κωδικών· κανένα rate limiting· MFA stub
`auth.py`/`account_service.py`: μόνο 8-char minimum, χωρίς complexity/breached-check. **Κανένα rate limit** σε `/auth/login`, `/platform/auth/login`, `/forgot-password`, `/reset-password` → credential stuffing. MFA stub (`auth_service.py:53`) — οι `mfa_enabled` χρήστες **δεν προστατεύονται**.

## LOW

- **L1** Προσωρινοί κωδικοί επιστρέφονται σε API responses **και** αποστέλλονται μέσω SMTP (`admin.py:493-513,621`, `users.py:85-134`) — credential-in-transit· βεβαιώσου ότι δεν logάρονται.
- **L2** `BaseRepository._scope` (`base.py:45-47`) κάνει merge του caller query **πάνω** στο tenant filter — αν μελλοντικός caller περάσει `tenant_id`, παρακάμπτει isolation. Βάλε το `tenant_id` τελευταίο / assert απουσία.
- **L3** Admin RBAC fails-open για legacy/unmapped routes (`admin.py:65,70-71`).
- **L4** ΗΔΙΚΑ error text επιστρέφεται verbatim σε tenant users (`ingestion.py:152`, `hdika_client.py:140`) — info leak.
- **L5** `forgot_password` timing oracle (`account_service.py:74-92`) → email enumeration.
- Impersonation tokens μέσω URL fragment `#imp=access~refresh` — μένουν σε browser history/μνήμη opener.

## Επαληθευμένα ΣΩΣΤΑ (θετικά)

- Tenant isolation **εκ κατασκευής** (`BaseRepository._scope`/`aggregate`)· δεν βρέθηκε IDOR στα tenant routers.
- Password hashing = **Argon2** (`security.py:14`).
- Noeton inbound auth = `hmac.compare_digest` + 5-min window (σωστά).
- Anonymization = γνήσιο **non-reversible HMAC-SHA256**, raw AMKA δεν αποθηκεύεται ποτέ — μόνη αδυναμία το default pepper (C1).
- Secret GETs κάνουν σωστό masking (smtp/idika/noeton).

## Προτεινόμενη σειρά αποκατάστασης

1. **C1, C2** — fail-fast σε prod αν secrets = default· κάνε Vault υποχρεωτικό σε prod.
2. **H4, H5, H6** — auth σε Mongo/Redis, TLS στο Vault, firewall/αφαίρεση Portainer public port.
3. **H1, H2** — χωριστά JWT keys/audiences· hash + atomic single-use reset tokens.
4. **H3, M1, M2** — escape regex input, hardened XML parser, SSRF allow-list.
5. **M4, M6** — αναβάθμιση Next, rate limiting, υλοποίηση MFA.
