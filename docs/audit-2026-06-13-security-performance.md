# RxVision — Security & Performance Audit (2026-06-13)

5-agent parallel audit (tenant-isolation/authz · secrets/PII/injection/SSRF · web-infra · backend perf · frontend perf). No code changed. Severity + file:line + fix below. Tenant under review: T-C838D2E4.

## Overall health
Architecture is fundamentally sound: tenant isolation by construction holds (all 32 analytics repos extend BaseRepository), JWT design is correct (separate secrets+audiences, HS256, revocable refresh), SSRF on the ΗΔΥΚΑ fetch is properly mitigated (assert_safe_outbound_url), webhooks are HMAC+constant-time, CORS is explicit, Mongo/Redis auth is on. The findings below are fixable hardening + scaling items — one is a genuine cross-tenant escalation that must be fixed before production.

---

## SECURITY

### HIGH
1. **Cross-tenant role escalation** — `api/v1/routers/users.py:78,109` (role_ids unvalidated) → `services/auth_service.py:109` (login dereferences `db.roles.find({_id:{$in:role_ids}})` with NO tenant filter). A tenant admin can attach another tenant's role ID to a user; on login those foreign permissions (e.g. `gdpr:export`) union into the token. **Fix:** validate role_ids via `RoleRepository(tenant_id)` on write + scope the login query with `tenant_id`.
2. **ReDoS / Mongo `$regex` from raw user input** — `api/v1/routers/communications.py:103` (`value` into `^`+regex) and `repositories/doctors.py:68` (`search`). Crafted pattern pins CPU on the shared Mongo → cross-tenant DoS. **Fix:** `re.escape(...)` (sibling code already does it).
3. **No security response headers** — `infra/docker/Caddyfile` + `frontend/next.config.js` set none (HSTS/CSP/X-Frame-Options/X-Content-Type-Options/Referrer-Policy). **Fix:** add a `header` block in the Caddy snippet.
4. **OpenAPI docs exposed in prod** — `backend/app/main.py:37-38` (`/api/docs`, `/api/openapi.json` public). Full endpoint/schema enumeration. **Fix:** set docs/openapi/redoc URLs to None when `is_production`.
5. **Vault token over plaintext HTTP on the private net** — `infra/scaling/PHASE1-app-node.md:24-28` (`VAULT_ADDR=http://10.0.0.2:8200` via socat to a TLS listener). Token sniffable on the LAN = full secret store. **Fix:** TLS end-to-end (socat openssl-connect + VAULT_CACERT) or move Vault to the state node; short-TTL scoped tokens.

### MEDIUM
6. **Raw AMKA + full name stored plaintext & returned in list APIs** — `services/ingestion/engine.py:171-174` writes raw `amka`/`full_name`; `repositories/prescriptions.py:191-197` returns `amka` on `GET /prescriptions` (any `prescriptions:read`). Contradicts the "AMKA pseudonymized at rest" invariant; `patients_anonymized` is misnamed. **Fix (product/GDPR decision):** encrypt amka/name at rest (Vault transit/field-level), gate `amka` behind a stricter permission + single-record audit, or drop the raw write and keep only `pseudo_id`.
7. **Scan upload: no size/type limit + decompression-bomb + served content-type** — `api/v1/routers/reimbursement.py:130-138` (`await file.read()` no cap, trusts client content-type, echoed back on serve `:152`). PIL `MAX_IMAGE_PIXELS` unset. **Fix:** size cap + image MIME allowlist before store; set MAX_IMAGE_PIXELS; serve with server-forced safe media_type + `X-Content-Type-Options: nosniff`.
8. **Rate-limit client IP spoofable + no account lockout** — `core/ratelimit.py:29-34` trusts left-most `X-Forwarded-For` (Caddy doesn't strip inbound XFF) → brute-force bypass; no per-account lockout. **Fix:** Caddy `header_up X-Forwarded-For {remote_host}` or use `CF-Connecting-IP` from allowlisted CF IPs; add per-email lockout/backoff.
9. **Public ΑΑΔΕ lookup + register unthrottled** — `api/v1/routers/onboarding.py:55-59` (`/onboarding/aade/{afm}` public, calls GSIS with privileged TAXISnet creds each time) + `/onboarding/register`. Abuse/enumeration/upstream-ban. **Fix:** rate limit both, cache AADE, add a challenge on the wizard.
10. **Portainer mounts the Docker socket (root) on the prod node** — `docker-compose.prod.yml:150-161` (bound to 127.0.0.1, but socket = host root; same node as Vault). **Fix:** verify strong password + 2FA, or remove from prod.

### LOW
- Containers run as root (no `USER`/`user:`) — widen blast radius. Add non-root user.
- `.env` + stale `.env.bak.precutover-*` copied to each node — secret sprawl; delete stale, verify 600 + .gitignore.
- `aade_service.py:68` `ET.fromstring` (no XXE guard) — use `defusedxml`.
- `core/security.py:17,57` misleading comments claim shared JWT key (code is actually safe — fix comments).
- `repositories/advisor.py:187` unscoped `find_one({_id})` (chained ref, safe; add tenant_id defense-in-depth).
- `repositories/users.py:88-102` RoleRepository get/update/delete pass raw string `_id` (functional bug, not security).
- Admin `enforce_section` allows unmapped segments by default (least-privilege gap within admin plane).
- Audit middleware skips platform-admin + failed-auth actions — forensic gap.

### Verified SAFE (checked, not issues)
Tenant isolation across repos; JWT tid/padmin separation; SSRF on /idika (validated base_url, barcode only fills path); secrets never logged/returned (masked to *_set booleans); typed query params prevent operator injection; sort allow-lists; forgot-password non-enumerable; webhooks HMAC+timestamp.

---

## PERFORMANCE

### HIGH
1. **Whole-collection scans loading full history into memory** — `repositories/advisor.py:503-507` (`recall` reads ALL executions, no date floor) and `repositories/patient_intelligence.py:~74-112` (`_chain_analysis`/`_patients` unbounded, no projection, `_patients` called ~5× per `overview()`). O(all-time) per request; won't scale. **Fix:** date floor + projections + memoize per request + Redis cache (read-heavy, changes only on ingestion).
2. **N+1 in `execution_detail`** — `repositories/prescriptions.py:44-54` (per item: products.find_one + up to 2× medicine_catalog.find_one = ~3N queries). Same shape in reimbursement `_rx_lines`/`_coupons_from_cda`. **Fix:** batch with `$in`.
3. **Cloudflare caches HTML for 1 year** (`s-maxage=31536000`) — client-rendered HTML references hashed chunks → after deploy, stale HTML points at missing chunks → white screen. This is the ROOT cause behind the disabled PWA + the round-robin crash class. **Fix:** Cloudflare rule — `no-cache` on `text/html`, immutable only on `/_next/static/*`.
4. **Dashboard fires ~11 parallel queries** (`app/(app)/dashboard/page.tsx:75-100`; 3 separate timeseries calls + separate prev-year). **Fix:** one `/dashboard/overview` endpoint (or `metric=value,claimed,executions`).
5. **PI patient list fetches ALL patients, paginates client-side** — `app/(app)/intelligence/patients/page.tsx:22` + `patients/page.tsx:123,133`. **Fix:** server pagination+sort (mirror the prescriptions list); prev-year as aggregate only.
6. **SW kill-switch is dead/contradictory** — `components/pwa/ServiceWorkerRegister.tsx` unregisters everything so `public/sw.js` never runs. **Fix:** register-once OR delete sw.js (pick one).

### MEDIUM
- `$sort` before `$match` (full-collection sort) — `repositories/doctors.py:117,132`, `patient_intelligence.py:~468`. Add an `executed_at` `$match` first.
- `base.py:85` `aggregate().to_list(None)` unbounded; several pipelines slice in Python after loading all (segments/compliance/risk/vip; reimbursement closing/risk/daily). Add `$limit`; use `$group→$count` over `$addToSet+$size` for distinct-patient counts.
- Missing indexes (only implicit `_id`): `claim_events (tenant_id,batch_id,at)`, `submission_batches (tenant_id,period)`, `barcode_check (tenant_id,period)`, confirm `medicine_catalog.barcode`. Add to `core/db.py::INDEXES`.
- `fund_groups.find().to_list(None)` on every analytics call (`prescriptions.py:222`, `reimbursement.py:~73`, `profitability.py:171`) — cache in Redis.
- Unconditional 3s polling — `reimbursement/optical/page.tsx:56`, `settings/ingestion/page.tsx:66`. Gate `refetchInterval` on activity + `refetchIntervalInBackground:false`.
- No debounce on patient search (`patients/page.tsx:139`) — request per keystroke. Debounce 300ms.
- Brand PNGs full-res via raw `<img>` (145KB mark at 36px, 339KB logo). Downscale or `next/image` + width/height (CLS).

### LOW
- Prev-year fetched as a 2nd full query on dashboard/prescriptions/patients — add `?compare=prev_year` to endpoints.
- Client-side merge/sort without `useMemo` (patients/prescriptions).
- All pages `"use client"` (no RSC/streaming) — longer-term, render a server shell.

### Async correctness — clean
LLM via AsyncAnthropic; OCR/ingestion blocking work runs in Celery (off the event loop); `run_in_threadpool` used for the one blocking fetch. Main `gather` opportunity: PI `overview` (multiple sequential aggregations) + reimbursement `forecast` (3 calls).

---

## Suggested fix order
**Security now:** #1 role escalation → #2 ReDoS (re.escape) → #4 disable prod docs → #3 Caddy headers → #8 XFF/lockout → #5 Vault TLS. Then #6 AMKA (needs decision), #7 upload, #9 AADE throttle.
**Perf now:** Cloudflare HTML cache rule (#3, also kills the deploy-whitescreen class) → execution_detail batch (#2) → recall/PI scans date-floor+cache (#1) → dashboard combined endpoint + patient-list server pagination (#4/#5). Then indexes + polling gates + image sizes.
