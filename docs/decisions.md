# Decisions Log — RxVision

> Append-only ADR-style log of non-obvious decisions and their rationale.
> Newest at top. Date format: YYYY-MM-DD.

---

## 2026-06-08 — T-06: wholesale price resolution (profitability correctness)

**D-023 · Resolve item wholesale cost by priority (source → masterdata → estimate), never 0.**
`IngestionEngine._effective_wholesale`: use the source feed's wholesale if present; else a
*real* (non-estimated) price from product masterdata; else estimate from retail via
`WHOLESALE_FALLBACK_MARGIN_PCT` (default 25%), flagged `wholesale_source="estimated"`.
`_resolve_items` no longer overwrites a known masterdata wholesale with 0.
*Why:* live ΗΔΥΚΑ doesn't return wholesale, so the old hardcoded `wholesale_price=0` made
`gross_profit == amount_claimed` (100% margin) — every profitability/margin number wrong for
real GR tenants. A real price source (masterdata import / PharmacyOne) is ideal but absent;
estimating from retail with a flagged, configurable margin makes analytics *approximately
right and transparent* instead of *definitely wrong*, and the masterdata path means prices
converge to real values as they become known. Estimation can be disabled (pct=0). ΓΕΣΥ and
synthetic data already carry real wholesale, so they're unaffected. Validated by py_compile +
isolated logic test + a new unit test (`test_effective_wholesale_resolution_priority`); full
pytest runs in CI (no backend deps locally). Follow-up: a real price-list/PharmacyOne feed.

---

## 2026-06-08 — Responsive section applied + TypeScript gate enabled

**D-022 · Responsive Phase A/B/C implemented; `tsc` made clean; type gate turned on.**
Applied the responsive/UX plan on `quick-wins` (QueryState on all 9 analytics pages,
charts/touch/grids, dead-UI removal, friendly errors, not-found/error pages). Then fixed
the 3 long-standing type errors and set `next.config.js typescript.ignoreBuildErrors:false`.
*Why:* the config comment itself said to remove the ignore "once typecheck is clean" — it now
is (`tsc --noEmit` = 0, `next build` exit 0 with the gate on), so future type regressions now
fail the build (real safety). ESLint stays skipped (`ignoreDuringBuilds:true`) until a separate
lint pass (T-16). Modal migration (T-14) and Phase D (T-15) were deliberately deferred — they
want a visual/browser review, which this environment can't do. *Caveat:* all validation was
static (tsc + build); a device/emulator + axe/Lighthouse pass is still the final gate.
Autonomous overnight loop did not run — work was done supervised in the morning instead.

---

## 2026-06-07 — Full audit + responsive/UX reports

**D-020 · Comprehensive audit delivered as documentation only; responsive/UX done statically.**
Produced the full report set (architecture/tech-stack/tech-debt/security/responsive/ui-ux/
fixes-plan/quick-wins) + `docs/audit-summary.md` (scores, top-20) + `docs/execution-roadmap.md`
+ memory files (`changelog-ai.md`, `handoff.md`). Two parallel read-only subagents did the
frontend responsive and UI/UX passes.
*Why / caveat:* no browser or Docker in the authoring env, so the responsive audit is a
**static code-level analysis** (Tailwind/layout/breakpoints), not visual rendering at the 13
target widths — explicitly flagged in every report; a live emulator/device + axe/Lighthouse
pass is the required final gate. Scores are point-in-time and the Security score is provisional
until the implemented fixes run live (`pytest` + `docker compose up`). Chose to keep the
existing earlier reports and *annotate via* `audit-summary.md`/`changelog-ai.md` rather than
rewrite them, so history is preserved. Headline scores: overall 64, architecture 78, security
68*, code-quality 60, maintainability 62, scalability 55, responsive 62, UX 64 (a11y 45).

---

## 2026-06-07 — T-01: Vault mandatory in production

**D-019 · No in-memory secret fallback in production; fail-fast at boot.**
`VaultService._degrade` seeds the in-memory dev store ONLY when `not is_production`; in
prod it just logs. New `assert_ready()` (called in `main.lifespan`, alongside
`assert_production_secrets`) raises if prod has no authenticated Vault client.
*Why:* closes C2 — previously a misconfigured prod booted "successfully" on an in-memory
store seeded from env defaults, silently defeating secrets management and losing tenant
ΗΔΥΚΑ/ΓΕΣΥ credentials. Fail-fast at boot is the correct posture for a secrets backend.
Dev keeps the graceful fallback so local work needs no Vault. Chose a boot-time
`assert_ready()` over raising in the module-singleton constructor so importing the module
never crashes (tests, tooling) — only actually *starting* prod does.
*Scope note:* per-tenant peppers already read from Vault when present; provisioning a
*random* per-tenant pepper at tenant creation (instead of deriving from the global one) is
deferred to **T-09** because it touches anonymization/data-continuity and wants a test.

---

## 2026-06-07 — T-05: rate limiting + MFA verification

**D-018 · Redis fixed-window rate limiting (self-built) + real TOTP MFA.**
Rate limiting: a small `app/core/ratelimit.py` using the existing Redis (`redis.asyncio`),
applied as a FastAPI dependency to tenant login, platform login, forgot-password,
reset-password (per-IP, X-Forwarded-For aware). MFA: `pyotp` TOTP verified in
`auth_service.login` when `mfa_enabled`; a correct password but missing/invalid code
returns `{"mfa_required": True}` → router raises 401 `mfa_required`.
*Why (rate limiting):* built our own over adding `slowapi` — zero new infra, uses the
Redis we already run so limits hold across the prod `--workers 2` (in-memory wouldn't).
**Fail-open** on Redis errors: a Redis outage must not lock everyone out of login
(availability > perfect throttling for an auth gate). Per-IP fixed-window is the MVP
baseline; per-account limiting is a possible later refinement.
*Why (MFA):* closes the M6 hole where `mfa_code` was accepted and ignored. Used `pyotp`
(standard TOTP) rather than hand-rolling HOTP/TOTP. Returning a distinct `mfa_required`
after a correct password is standard 2FA UX (the small enumeration signal is acceptable
once the password is already proven). Enrollment (secret generation/QR/recovery codes) is
deliberately **out of scope** → tracked as T-08; no user is `mfa_enabled` yet, so nothing
breaks today, but the verification path is now correct and enforced.

---

## 2026-06-07 — T-04: tenant/platform JWT domain separation

**D-017 · Separate signing key + audience per identity class.**
Platform-admin tokens are now signed with a dedicated `JWT_PLATFORM_SECRET` and carry
`aud=rxvision/platform`; tenant tokens keep `JWT_SECRET` and carry `aud=rxvision/tenant`.
Added `decode_platform_token` (verifies the platform key + audience); `get_platform_admin`
and `PlatformAuthService.refresh` use it. `decode_token` now verifies the tenant audience.
*Why:* closes H1 — with one shared key a platform token could be replayed as a tenant
context (and vice versa). Two independent factors (key AND audience) give defense in depth:
a cross-class token now fails at the signature layer. Chose HS256 + separate secrets over
asymmetric RS256 to stay minimal/consistent with the existing setup (revisit if keys ever
need to be distributed to verifiers that shouldn't sign). The prod-secrets gate (D-014)
now also rejects a default/blank `JWT_PLATFORM_SECRET`, and the sentinel check became a
substring match (the platform default contains `change-me-dev-only`).
*Deploy impact:* tokens issued before this change lack `aud` and will be rejected →
all users and platform admins must log in again once after deploy. Acceptable one-time cost.

---

## 2026-06-07 — AI Tech Lead persistent working environment

**D-016 · Repo-native AI operating system in `docs/ai/` + `scripts/ai/`.**
Built a persistent environment so future sessions resume losslessly and work survives
SSH disconnects: three-layer model — living state (`project-state`/`todo`/`decisions`/
`journal`), operating manual (`RESUME`/`HANDOFF`/`TMUX`/`LONG-RUNNING-TASKS`/
`CONVENTIONS`), and tools (`rxvision-tmux.sh`/`session-start.sh`/`run-task.sh`).
*Why:* the repo must be the single source of truth — no context may live only in a chat
window. Chose plain Markdown + small shell scripts over any tooling/daemon so it is
greppable, diff-able, and dependency-free. tmux (everything, incl. the Claude CLI, runs
inside it) gives disconnect survival with zero infrastructure. Alternatives rejected:
external task tracker (state leaves the repo); the harness's in-session Task tools
(ephemeral, don't persist across sessions); a DB-backed system (overkill, fragile).
Run logs go to a self-ignoring `docs/ai/runs/` so no existing file needed modifying.

---

## 2026-06-07 — Mongo/Redis auth + Vault TLS (completes #7/#8; supersedes D-005/D-006)

**D-011 · Mongo auth via auto-generated keyfile in a named volume.**
`mongod --auth --keyFile`; the keyfile is generated with `openssl rand` inside the
container entrypoint (as root) into the `mongo_keyfile` volume, then chmod 400 +
chowned to mongodb. Root user from `MONGO_INITDB_ROOT_*`; `mongo-init` authenticates
to run `rs.initiate`. Creds embedded in `MONGODB_URI` (`authSource=admin`).
*Why:* a host-mounted keyfile hits ownership/permission errors (mongod refuses a
keyfile not owned by its user); generating in-container side-steps that and keeps no
secret in the repo. Alternatives rejected: committing a static keyfile (secret in
git); host file mount (perm pain). Supersedes **D-006** (localhost-bind-only stopgap).

**D-012 · Redis auth via `requirepass`; healthcheck uses `-a`.**
Password in `REDIS_PASSWORD`, embedded in `REDIS_URL`/`CELERY_*`.
*Why:* simplest real auth for Redis; healthcheck must authenticate or it reports
unhealthy.

**D-013 · Vault TLS with a self-signed cert generated on the host.**
`gen-vault-tls.sh` writes `infra/docker/vault/tls/{vault.crt,vault.key}` (gitignored,
SANs: vault/localhost/127.0.0.1); mounted into Vault; only `vault.crt` mounted into
api/worker/beat; hvac verifies via `VAULT_CACERT`; unseal scripts use https + CACERT;
systemd `ExecStartPre` + Makefile `up` generate it.
*Why:* host generation reuses the repo's existing "secrets-on-host, scripts-manage"
pattern (cf. `secrets/vault-init.json`) and avoids depending on openssl/bash being
present in the Vault alpine image. We verify with the CA (not `-tls-skip-verify`) so
MITM on the Docker network is actually prevented. Supersedes **D-005** (TLS deferred).
*Note:* this is the INTERNAL Vault cert only — unrelated to public site TLS (see D-015).

**D-015 · Public TLS: Let's Encrypt via Cloudflare DNS-01.**
DNS for `rxvision.gr` is managed by Cloudflare; the user wants a Let's Encrypt cert,
**not** a Cloudflare-issued cert. Chosen method: DNS-01 through the Cloudflare API
(the existing `infra/compose.tls.yml` custom Caddy build + `enable-public-tls.sh`).
*Why:* DNS-01 issues a real Let's Encrypt cert and uses the Cloudflare API only to
write a temporary TXT record — so the cert is NOT "from Cloudflare," satisfying the
requirement. Works behind the Cloudflare proxy (orange cloud) and needs no open 80/443.
*(Corrects an earlier misread that flagged this path as wrong.)*
*Secret handling:* the `CF_API_TOKEN` (scope Zone→DNS→Edit) lives ONLY in the
server's `.env`. It must never be pasted in chat or committed. The current
`enable-public-tls.sh` takes the token as a CLI arg (leaks to shell history /
process list) — flagged for hardening (todo T-07).

**D-014 · Prod-secrets gate extended to DB connection URIs.**
`assert_production_secrets` now also fails if `MONGODB_URI`/`REDIS_URL` contain the
`change-me-dev-only` sentinel while `ENV` is prod/staging.
*Why:* the dev DB passwords embed the sentinel, so this catches "shipped the dev
.env to prod" for databases too, not just JWT/pepper.

---

## 2026-06-07 — Quick-wins implementation scoping

**D-008 · Reset tokens hashed + atomic single-use.**
Store only `sha256(token)` (`reset_token_hash`), never the raw token; consume via
a single `find_one_and_update` gated on `status=="active"` and unexpired.
*Why:* plaintext tokens leaked via DB/backup were usable; lookup-then-update was a
double-use race. SHA-256 (not Argon2) is sufficient because the token is 256-bit random.

**D-007 · Reject `padmin` tokens in tenant context.**
`get_current_context` now refuses platform tokens and missing `tid`.
*Why:* both identities share one signing key; without this, a platform token could
be replayed as a tenant context. Symmetric to the existing `get_platform_admin`
check that rejects tenant tokens.

**D-006 · Mongo/Redis/Portainer bound to `127.0.0.1`, NOT full auth.**
For quick-wins #7/#8 we bound ports to localhost instead of enabling credential auth.
*Why:* Mongo replica-set auth needs a keyfile + credentials threaded through
`MONGODB_URI`/`REDIS_URL` (a coordinated `.env` change that breaks existing local
setups). Localhost binding closes LAN/public exposure with zero risk. Full auth is
tracked in `docs/todo.md` (T-02).

**D-005 · Vault TLS deferred, not half-applied.**
Left `tls_disable=1` in `vault.hcl`; only firewalled Portainer.
*Why:* setting `tls_disable=0` without provisioned certs **fails Vault boot** and
requires updating the unseal scripts (https + skip-verify) and `api_addr`. Not a
config-only quick win — bundle with prod-TLS work (T-03).

**D-004 · Page-size capped in two layers.**
Hard `MAX_PAGE_SIZE=500` clamp inside `BaseRepository.find` (defense-in-depth) plus
`Query(ge=, le=)` validation on endpoints.
*Why:* endpoint validation gives clean 422s; the repo clamp protects any future
caller that bypasses the endpoint constraint.

**D-003 · CI gates: ruff+pytest blocking, the rest advisory.**
mypy, frontend `tsc`, and `next lint` run with `continue-on-error`.
*Why:* the codebase has never had a clean type pass and ships with
`ignoreBuildErrors`. A hard type gate on day one would block every PR. Make it
visible first, drive to zero, then flip to blocking + remove the ignores.

---

## Pre-existing architectural decisions (reconstructed from code/docs)

**D-002 · Tenant isolation by construction.**
All tenant DB access goes through `BaseRepository`, which injects `tenant_id` into
every filter/insert and prepends it to every aggregation.
*Why:* isolation enforced by the type, not by developer discipline. Caveat:
`IngestionEngine`, `ingestion.py`, and `admin.py` bypass this with raw
`shared_db()` + manual filters — correct today but a latent leak (see todo T-06).

**D-001 · Money as integer cents; PII pseudonymized pre-write.**
Currency is integer cents end-to-end; raw national IDs (AMKA) are HMAC-SHA256
pseudonymized before any persistence and never stored raw.
*Why:* avoids float rounding in financial analytics; GDPR data-minimization for
special-category health data. Weakness: default global pepper makes pseudonyms
reversible — addressed by quick-win #1 fail-fast (T-01 for full Vault rollout).

> Template for new entries:
> **D-NNN · <decision>.** <what changed>. *Why:* <rationale / alternatives rejected>.
