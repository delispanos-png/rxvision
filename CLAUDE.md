# CLAUDE.md — RxVision

Orientation for AI coding sessions. Read this first.

> ## ▶ START HERE
> This project has a persistent AI Tech Lead operating system in **`docs/ai/`**.
> 1. Read **`docs/ai/RESUME.md`** and follow it (or run `bash scripts/ai/session-start.sh`).
> 2. `docs/ai/README.md` maps the whole system.
> 3. End every session with **`docs/ai/HANDOFF.md`**.
>
> Living state: `docs/project-state.md` (now), `docs/todo.md` (next),
> `docs/decisions.md` (why), `docs/ai/journal/` (history).

## What this project is

**RxVision** — multi-tenant SaaS PWA for statistical analysis of pharmacy
prescription executions. Markets: 🇬🇷 Greece (ΗΔΙΚΑ) & 🇨🇾 Cyprus (ΓΕΣΥ).
Domain: `rxvision.gr`. Handles **health data / PII → GDPR-sensitive**.

## Stack (one line)

FastAPI (Python 3.12) + MongoDB 7 (Motor) + Redis 7 + Celery · Next.js 14 (App
Router) + TypeScript + Tailwind PWA · Docker Compose → Caddy + Vault. Repo docs
and UI strings are in **Greek**; code, identifiers, and comments are in **English**.

## Repo map

```
backend/app/
  api/v1/routers/   # thin HTTP handlers (one concern each, except admin.py)
  services/         # business logic (auth, provisioning, ingestion, vault, mailer)
  repositories/     # DB access — ALL analytics repos extend BaseRepository
  workers/          # Celery tasks (ingestion, noeton, snapshots)
  core/             # config, db, deps (auth/RBAC), security
  middleware/       # audit
frontend/src/
  app/(app)/        # authenticated tenant analytics
  app/(marketing)/  # login/register/forgot/reset
  app/admin/        # platform back-office (separate `padmin` identity)
  lib/              # apiClient.ts (tenant) + adminClient.ts (platform)
  store/            # zustand: uiStore (filters), navStore, dialogStore
docs/               # architecture docs (Greek) + this memory system
infra/              # compose overlays, Caddy, Vault, scripts, systemd
```

## The ONE rule you must not break

**Tenant isolation by construction.** `repositories/base.py::BaseRepository`
injects `tenant_id` into every query/insert and prepends `{$match: tenant_id}` to
every aggregation. NEVER query a tenant collection without going through a
repository that extends `BaseRepository`. This is unit-tested in
`tests/test_invariants.py` — keep it green.

## Conventions

- **Money is integer cents** everywhere (never floats for currency).
- **PII**: raw AMKA/national_id is pseudonymized (HMAC-SHA256, `utils/anonymization.py`)
  before any write — never persist raw national IDs.
- **Auth**: JWT access+refresh; permissions/modules/roles are baked into the token
  at login (re-resolved on refresh). Two identities: tenant (`tid` claim) vs
  platform admin (`padmin` claim) — they must stay cryptographically distinct.
- Backend lint/format: **ruff** (line-length 100). Type-check: **mypy** (not yet
  clean — advisory in CI). Tests: **pytest** (`asyncio_mode=auto`).
- Frontend: `tsconfig` is `strict`, but `next.config.js` sets
  `ignoreBuildErrors`/`ignoreDuringBuilds` (tech debt — drive to zero, then remove).

## How to run / test

```bash
cp .env.example .env          # fill secrets
docker compose up --build     # api:8000 web:3000 mongo:27017 redis:6379
# OpenAPI: http://localhost:8000/api/docs
make seed                     # demo data ; make smoke ; make test
```
Note: the sandbox where this repo was first analyzed had **no pip/npm/runtime
deps** — full `pytest`/`next build` could not run locally there. CI
(`.github/workflows/ci.yml`) runs them on push.

## Working agreements (from the user)

- **Do not commit or push** unless explicitly asked.
- **Ask before any source-code change.** Documentation/report files are fine to create.
- Work on a branch, not `main`. Current working branch: **`quick-wins`**.
- The user prefers **Greek** for conversational replies.

## Key reference docs (created during analysis, repo root)

`architecture-review.md` · `technology-stack.md` · `technical-debt.md` ·
`security-review.md` · `quick-wins.md` — read these for the full picture.

## Maintaining this memory system

Follow `docs/ai/HANDOFF.md` at the end of every session. In short, after meaningful work update:
- `docs/project-state.md` — what's true now (branch, what changed, what works/stubs).
- `docs/decisions.md` — append any non-obvious decision + its rationale (ADR style).
- `docs/todo.md` — tick done items, add new ones, keep priorities current.
- `docs/ai/journal/YYYY-MM-DD.md` — a session entry (template in HANDOFF.md).
Keep entries dated (absolute dates, not "yesterday").
