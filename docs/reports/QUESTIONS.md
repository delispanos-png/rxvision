# Quality & Hardening — open questions (need a product/process decision)

Per the workstream rules I keep working on other items while these wait.

1. **Frontend e2e in CI** — login/dashboard/prescriptions/exports e2e needs a running app +
   browser + a backend (service containers in CI). Current CI runs only typecheck/lint/build.
   Decision: add a Playwright job with service containers (Mongo/Redis/api) to CI, or keep e2e
   out of CI and run it manually? (I add CI-runnable *unit* tests now regardless.)
2. **Frontend unit-test runner** — none configured today. I propose **Vitest + React Testing
   Library** (jsdom, no server/port) for pure-logic/component tests, added as a `test` script +
   an optional CI step. OK to add the dev-dependency + a CI step? (Additive; no app behavior change.)
3. **`pip-audit` in CI** — add a `pip-audit` step to the backend CI job so Python advisories are
   tracked? (This sandbox has no pip.)
