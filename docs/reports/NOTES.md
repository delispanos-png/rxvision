# Quality & Hardening — notes (cross-stream, left untouched)

Things I deliberately did NOT change (guardrails / collision avoidance), recorded for the owners.

- **`frontend/src/app/(app)/settings/ingestion/page.tsx`** — `next lint` warning
  `react-hooks/exhaustive-deps` (missing dep `latestJob`, line ~78). Non-blocking (lint exits 0).
  Left untouched: this ΗΔΙΚΑ-connection UI is adjacent to the infra/ingestion stream. Suggested
  fix for its owner: add `latestJob` to the effect deps or wrap in `useCallback`.
- **Backend `pip-audit`** could not be run here (no pip in this sandbox; backend tests run only in
  CI). The dependency-audit report covers `npm audit` directly + a manual review of `pyproject.toml`;
  `pip-audit` should be run in CI / an environment with pip.
- **Frontend e2e tests** (login/dashboard/exports) require a running app + browser; the guardrails
  forbid binding ports / containers and the current CI runs only typecheck/lint/build (no server).
  Frontend testing here is limited to pure-logic unit tests (no server). E2e is documented as a
  follow-up needing a CI service container — see QUESTIONS.md.
- **GDPR module** (branch `gdpr-compliance`, `docs/gdpr/`, DSAR/consent files) — NOT on this branch
  (off `main`); not touched.
