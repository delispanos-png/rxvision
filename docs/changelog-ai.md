# AI Changelog — RxVision

Chronological log of changes made by AI sessions. Newest first. All changes are on branch
`quick-wins`, **uncommitted** (no commit/push per agreement). Dates absolute.

## 2026-06-07

### Audit (documentation only)
- Full engineering + responsive + UI/UX + security + tech-debt audit. Created/updated:
  `architecture-review.md`, `technology-stack.md`, `technical-debt.md`,
  `security-review.md`, `quick-wins.md`, `responsive-audit.md`, `ui-ux-review.md`,
  `responsive-fixes-plan.md`, `docs/execution-roadmap.md`, `docs/audit-summary.md`.
- Built the AI operating system: `CLAUDE.md`, `docs/project-state.md`, `docs/decisions.md`,
  `docs/todo.md`, `docs/handoff.md`, this changelog, and `docs/ai/*`
  (README/RESUME/HANDOFF/TMUX/LONG-RUNNING-TASKS/CONVENTIONS + journal + runs) plus
  `scripts/ai/*` (rxvision-tmux.sh, session-start.sh, run-task.sh).

### Code changes (security/quality — on `quick-wins`, uncommitted)
- **Quick wins #1–#10:** prod fail-fast on default secrets; regex-escape doctor search
  (ReDoS); hardened lxml/XXE parser; page-size caps; hashed+atomic single-use reset
  tokens; reject `padmin` in tenant context; Mongo/Redis localhost bind (dev); Portainer
  localhost bind; `sandbox` on newsletter iframe; CI workflow.
- **#7/#8 completed:** Mongo `--auth`+keyfile (auto-gen volume) + authed `mongo-init`;
  Redis `requirepass`; Vault TLS self-signed (`gen-vault-tls.sh`) + hvac CA verify +
  unseal scripts on https; authed mongo backup; systemd ExecStartPre; `.env.example`,
  prod-gate, Makefile updates.
- **T-07** public TLS: `enable-public-tls.sh` reads token via hidden prompt (no CLI arg),
  validates `.env`; `.env.example` + `Caddyfile {$CADDY_TLS:internal}`.
- **T-04** JWT domain separation: `JWT_PLATFORM_SECRET`, tenant/platform audiences,
  `decode_platform_token`; deps/platform_auth updated; tests updated + new cross-decode test.
- **T-05** rate limiting (`app/core/ratelimit.py`, Redis fixed-window, fail-open) on
  login/forgot/reset/platform-login; real MFA via `pyotp` (`verify_totp`, enforced in
  `auth_service.login`); `pyotp` dep; test added.
- **T-01** Vault mandatory in prod: no in-memory fallback in prod, `vault.assert_ready()`
  in `main.lifespan`; test added.

> Verification for all of the above was static only (no Docker/pip/pytest in the authoring
> env): `py_compile`, `yaml`/`bash -n`, isolated logic tests. A real `pytest` +
> `docker compose up` run is the outstanding validation gate (see `docs/todo.md`).
