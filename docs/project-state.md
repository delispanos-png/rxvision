# Project State — RxVision

> Living snapshot for session continuity. Update at the end of each work session.
> Last updated: **2026-06-07**.

## Audit snapshot (2026-06-07)
Full audit complete (docs only). Scores: **overall 64** · arch 78 · security 68* · code 60
· maintainability 62 · scalability 55 · responsive 62 · UX 64 (a11y 45). *(\*security
provisional until live-validated.)* See `docs/audit-summary.md` (top-20) +
`docs/execution-roadmap.md`. **#1 next move: live validation** (push→CI pytest +
`docker compose up`) — all code changes this session are static-checked only.

## Git

- Default branch: `main` @ `f0f494e` ("Branding: use the official RxVision logo PNG everywhere").
- **Active working branch: `quick-wins`** — committed (9 commits) and **PUSHED** to
  `origin/quick-wins` (2026-06-08). `origin/main` unchanged at `f0f494e`; NOT merged.
- **CI is GREEN** on `origin/quick-wins`: ✅ Frontend (tsc·lint·build) ✅ Backend (ruff·pytest).
  mypy runs advisory (continue-on-error). So pytest + the production build pass in a real
  environment — the work is now validated, not just static-checked.
- Open a PR with: `gh pr create --base main --head quick-wins` (not yet created).
- **Still pending** before merge: a live `docker compose up` smoke + a browser/device
  responsive pass (CI doesn't spin up the full stack or a browser).

## How to work here (AI Tech Lead)

Persistent environment lives in **`docs/ai/`** (operating manual) + **`scripts/ai/`** (tools).
New session: follow `docs/ai/RESUME.md` (or run `bash scripts/ai/session-start.sh`).
End session: follow `docs/ai/HANDOFF.md`. Run everything inside the `rxvision` tmux session
(`bash scripts/ai/rxvision-tmux.sh`) so work survives SSH disconnects.

**Resuming the live chat (not just the work):** Claude Code stores this conversation at
`~/.claude/projects/-home-agent/<id>.jsonl`. To continue the exact chat inside tmux:
`tmux attach -t rxvision` → in window `0:claude`: `cd ~ && claude --continue`
(or `claude --resume` to pick). The project memory in this repo makes a *fresh* session
able to resume the work even without the chat. See journal 2026-06-07 §Session 9.

## Maturity: MVP stage

Solid architectural foundation (multi-tenancy by construction, canonical
ingestion, RBAC, real pseudonymization). Gaps are mostly **feature completeness,
security hardening, and missing automation/tests** — not design flaws.

## What works

- Tenant-scoped CRUD + analytics (prescriptions, doctors, patients, icd10,
  profitability, future, orders, monthly closing) via tenant-isolated repos.
- Auth (Argon2, JWT access+refresh), RBAC, module gating.
- Platform back-office (`admin/`) with separate `padmin` identity + impersonation.
- ΗΔΙΚΑ ingestion: synthetic demo mode + provisional real client; idempotent by
  content hash. ΓΕΣΥ: manual XML upload (`gesy/upload`).
- Frontend: full tenant + admin UIs, ECharts dashboards, PWA shell, in-app dialogs.
- Smoke test (`scripts/smoke-test.sh`) exercises ~40 endpoints end-to-end.

## What is STUBBED / non-functional (looks done but isn't)

| Area | Location | State |
|---|---|---|
| Profitability snapshots | `workers/snapshots.py` `compute_nightly` | stub → always live-fallback / empty |
| Data retention (GDPR) | `workers/snapshots.py` `apply_retention` | stub → nothing deleted |
| GESY automation | `workers/ingestion.py` `gesy_xml_ingest` | stub (manual upload only) |
| Order-suggestion recompute | `orders.py` | calls non-existent task; fake "accepted" |
| Tenant data export (GDPR) | `tenants.py` | calls non-existent task; fake "accepted" |
| myDATA / ΑΑΔΕ | `admin.py` | placeholder MARK |
| MFA | `auth_service.py:53` | `mfa_code` accepted & ignored |
| Billing checkout | `subscriptions.py:36` | hardcoded fake URL, no provider |
| Region mapping | `utils/anonymization.py` | placeholder split |
| Live HDIKA wholesale price | `hdika_client.py:274` | hardcoded `0` → **profitability wrong for real ΗΔΙΚΑ tenants** |
| Frontend export polling | `components/export/ExportButton.tsx` | single fetch, not real polling |

## Testing & CI

- Only 3 backend test files; **no integration tests**; `IngestionEngine` and
  `admin.py` untested. No frontend tests.
- CI added on `quick-wins` branch (`.github/workflows/ci.yml`): ruff+pytest
  blocking; mypy/tsc/lint advisory; frontend build. **Not yet run** (needs push).
- No lockfiles (`uv.lock`/`package-lock.json` absent) → non-reproducible builds.

## Changes made on `quick-wins` (2026-06-07) — 10 quick wins

Backend (`#1` config fail-fast on default secrets; `#2` regex escape in doctor
search; `#3` hardened lxml/XXE parser; `#4` page-size caps; `#5` hashed+atomic
single-use reset tokens; `#6` reject `padmin` in tenant context), infra (`#7`
Mongo/Redis bound to localhost in dev; `#8` Portainer bound to localhost),
frontend (`#9` `sandbox` on newsletter iframe), tooling (`#10` CI workflow).

**`#7`/`#8` now fully implemented (2026-06-07, supersedes the earlier stopgaps):**
- Mongo auth: `--auth --keyFile` (keyfile auto-generated into `mongo_keyfile` volume),
  root user via `MONGO_INITDB_ROOT_*`, `mongo-init` authenticates for `rs.initiate`.
- Redis auth: `requirepass` + authenticated healthcheck.
- Creds live in `.env` (`MONGO_ROOT_*`, `REDIS_PASSWORD`, embedded in URIs); `.env.example`
  updated; prod-secrets gate now also rejects dev creds in `MONGODB_URI`/`REDIS_URL`.
- Vault TLS: self-signed cert via `infra/scripts/gen-vault-tls.sh` (gitignored),
  `vault.hcl` `tls_disable=0`, hvac CA verification (`VAULT_CACERT`), unseal scripts on
  https, `mongo-backup.sh` authenticated, systemd `ExecStartPre` + Makefile `up` gen cert.

Verification done locally: `py_compile`, both compose files + ci.yml parse (yaml),
`bash -n` on all scripts, real `gen-vault-tls.sh` run (correct SANs, idempotent),
extended prod-gate logic test — all passed.
⚠️ **NOT verified with a live `docker compose up`** — the dev environment has no
Docker/pip/npm. Before deploying, run the checklist below.

### Test checklist before deploying #7/#8 (run where Docker IS available)
1. `cp .env.example .env`; set strong `MONGO_ROOT_PASSWORD`/`REDIS_PASSWORD` and keep
   `MONGODB_URI`/`REDIS_URL` in sync with them.
2. `docker compose up --build` → confirm `mongo` healthy, `mongo-init` exits 0
   (replica set initiated **with auth**), `redis` healthy, `api` connects (no auth errors).
3. `make seed && make smoke` → all green.
4. Prod: `make vault-tls` (or rely on systemd ExecStartPre), `make up`, then
   `make unseal`; confirm api reads secrets from Vault over https (no cert errors).

## Top risks (see security-review.md for full list)

1. Default `JWT_SECRET`/pepper (`change-me-dev-only`) — mitigated by `#1` fail-fast.
2. Mongo/Redis without auth; Vault TLS off; (Portainer exposure mitigated by `#8`).
3. Wrong profitability numbers on real ΗΔΙΚΑ data (wholesale=0).
4. Critical ingestion path has no end-to-end tests.
5. Provisional ΗΔΙΚΑ contract ("ASSUMED") may break ingestion when the real spec lands.
