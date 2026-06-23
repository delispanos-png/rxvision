# Handoff — RxVision (current)

> Snapshot for the next session. Top-level mirror of the latest `docs/ai/journal/` entry.
> The full process lives in `docs/ai/HANDOFF.md` (how to hand off) and `docs/ai/RESUME.md`
> (how to resume). Updated: **2026-06-07**.

## Where we are
- Branch **`quick-wins`** (off `main` @ `f0f494e`). **Pushed to `origin/quick-wins`; CI GREEN**
  (Frontend tsc·lint·build + Backend ruff·pytest; mypy advisory). NOT merged, no PR yet.
- A large body of security/quality work is implemented but **static-checked only** — no
  Docker/pip/pytest in the authoring environment.
- A complete audit (architecture, tech-stack, tech-debt, security, responsive, UI/UX) and
  the AI operating system are in place.

## Done (this session)
- Quick wins #1–#10; T-01 (Vault mandatory in prod), T-04 (JWT domain separation),
  T-05 (rate limiting + MFA), T-07 (public-TLS hardening), #7/#8 (Mongo/Redis auth, Vault
  TLS). See `docs/changelog-ai.md` and `docs/decisions.md` (D-001…D-019).
- Audit reports (repo root) + `docs/execution-roadmap.md` + `docs/audit-summary.md`.

## The single most important next step
**Validate for real.** Push `quick-wins` so CI runs `pytest` (T-01/T-04/T-05 tests +
invariants), and run `docker compose up` on a machine with Docker to confirm Mongo/Redis
auth (#7), Vault TLS (#8) and the auth changes (login/refresh/admin) end-to-end. Until
then, treat all code changes as "implemented, not verified live".

## Then (priority order — see docs/todo.md / docs/execution-roadmap.md)
1. **T-06** wire wholesale pricing → fixes profitability correctness (currently wrong for
   real ΗΔΥΚΑ tenants). 
2. Responsive/UX **Phase A** foundations (`<QueryState>`, `<Modal>`, DataTable mobile/keyboard,
   max-width) — see `responsive-fixes-plan.md`.
3. Remaining P0/P1 security (SSRF allow-list M2, audit logging M5, lockfiles), then the stubs
   (retention/snapshots/GESY/export).

## Guardrails (always)
No commit/push unless asked · ask before app-source edits · no secrets in chat · reply in
Greek · work inside the `rxvision` tmux session (`bash scripts/ai/rxvision-tmux.sh`).

## Resume
`tmux attach -t rxvision` → window 0:claude → `cd ~ && claude --continue`. Or a fresh
session: follow `docs/ai/RESUME.md` (or run `bash scripts/ai/session-start.sh`).
