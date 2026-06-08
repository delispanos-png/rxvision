# TODO / Backlog — RxVision

> Prioritized backlog for session continuity. Tick items as done with a date.
> Source of truth for "what next". Last updated: **2026-06-07**.

## Status legend
`[ ]` open · `[~]` in progress · `[x]` done (with date) · `[>]` deferred/blocked

---

## P0 — Security hardening (finish what quick-wins started)

- [x] **#1** Fail-fast on default JWT secret / pepper / wildcard CORS — 2026-06-07
- [x] **#2** Escape `$regex` in doctor search (ReDoS) — 2026-06-07
- [x] **#3** Hardened lxml parser for GESY upload (XXE) — 2026-06-07
- [x] **#4** Cap `limit`/`page_size` — 2026-06-07
- [x] **#5** Hash + atomic single-use reset tokens — 2026-06-07
- [x] **#6** Reject `padmin` tokens in tenant context — 2026-06-07
- [x] **#9** `sandbox` on newsletter preview iframe — 2026-06-07
- [x] **T-01** Vault mandatory in prod — 2026-06-07. *(C2)* `vault_service` no longer
      falls back to an in-memory store in prod (`_degrade` seeds only in dev); new
      `assert_ready()` called in `main.lifespan` refuses to boot in prod without a
      reachable/authed Vault. `.env.example` notes it's required. Test added.
- [ ] **T-09** Provision a random per-tenant pepper into Vault at tenant creation
      (`provisioning.open_tenant` / `onboarding.register`), so peppers stop being derived
      from the global one. Touches the anonymization continuity path → needs a test +
      care that existing tenants keep their current (derived) pepper. (refines T-01)
- [x] **T-02** Mongo & Redis authentication — keyfile auto-gen in volume + auth ON;
      requirepass; creds in `.env`; backup script + prod gate updated — 2026-06-07. *(H4)*
- [x] **T-03** Vault TLS — self-signed cert (`gen-vault-tls.sh`), `tls_disable=0`,
      hvac CA verify, unseal scripts on https, systemd ExecStartPre — 2026-06-07. *(H6)*
      ⚠️ **Not yet validated with a live `docker compose up`** (no Docker in the dev
      env where this was written) — see test checklist in project-state.md.
- [x] **T-04** Separate JWT keys/audiences for tenant vs platform tokens — 2026-06-07. *(H1)*
      New `JWT_PLATFORM_SECRET`; platform tokens signed with it + `aud=rxvision/platform`,
      tenant tokens `aud=rxvision/tenant`; `decode_platform_token` verifies both; gate +
      `.env.example` updated; tests updated + new cross-decode test. ⚠️ Deploy note: existing
      tokens (no `aud`) become invalid → users/admins must re-login once.
- [x] **T-05** Rate limiting + MFA verification — 2026-06-07. *(M6)*
      Redis fixed-window limiter (`app/core/ratelimit.py`, fail-open) on tenant login,
      platform login, forgot, reset. Real TOTP via `pyotp`: `auth_service.login` now
      verifies `mfa_code` when `mfa_enabled` (returns `{"mfa_required": True}` → 401
      `mfa_required`). New dep `pyotp`. Test added (importorskip).
- [ ] **T-08** MFA enrollment flow — generate per-user `mfa_secret` (store in Vault),
      QR/provisioning URI, verify-on-enable, disable, recovery codes. T-05 only added
      the *verification* path; no user can self-enable MFA yet (UI still says "σύντομα").
- [~] **M2** SSRF allow-list / private-IP filtering on tenant-supplied ΗΔΙΚΑ `base_url`.
      **PAUSED 2026-06-08** — `backend/app/utils/net.py` guard built (uncommitted, not wired);
      wiring touches `ingestion.py` which the concurrent ΗΔΙΚΑ agent owns. Finish after rebase
      onto the new `main`. *(see project-state §Active concurrency)*
- [ ] Audit logging for PHI reads + failed logins; WORM/append-only audit store. *(M5)*

## P0 — Tooling / quality gate

- [x] **#10** Minimal CI (ruff+pytest blocking; mypy/tsc/lint advisory) — 2026-06-07
- [x] AI Tech Lead persistent working environment (`docs/ai/` + `scripts/ai/`) — 2026-06-07 (D-016)
- [ ] Add lockfiles (`uv.lock`/`poetry.lock`, `package-lock.json`); switch Docker
      to `npm ci` + locked pip install for reproducible builds.
- [x] Push `quick-wins` + CI green — 2026-06-08 (PR #1; ruff·pytest + tsc·lint·build pass).
- [ ] **Validate #7/#8 with a live `docker compose up`** (checklist in project-state.md) —
      CI doesn't spin up the full stack, so DB-auth + Vault-TLS are still un-smoke-tested.

## P1 — Data correctness (analytics must be trustworthy)

- [x] **T-06** Wholesale pricing resolution — DONE 2026-06-08 (py_compile + logic test;
      `pytest` runs in CI). `IngestionEngine._effective_wholesale` resolves cost by priority:
      source feed → real product masterdata → estimate from retail
      (`WHOLESALE_FALLBACK_MARGIN_PCT`, default 25%, flagged `wholesale_source="estimated"`).
      `_resolve_items` no longer clobbers a known masterdata price with 0. Fixes the
      gross_profit==amount_claimed (100%-margin) bug for live ΗΔΙΚΑ. ΓΕΣΥ/synthetic unaffected
      (carry real wholesale). ⚠️ Estimate is approximate — real masterdata/PharmacyOne price
      feed is the proper long-term source (a price-list import remains a good follow-up).
- [ ] Verify ΗΔΙΚΑ `repeat_total`/`repeat_current` mapping against the real spec
      (drives future-prescription generation).
- [ ] End-to-end tests for `IngestionEngine` (dedup, idempotency, future-rx, counters).
- [ ] Integration tests (FastAPI `TestClient`) for auth, RBAC gating, tenant isolation.

## P1 — Complete the stubs (compliance-ordered)

- [ ] Implement data retention/erasure worker (`apply_retention`) — **GDPR**.
- [ ] Implement profitability snapshots worker (`compute_nightly`).
- [ ] Implement tenant data export (GDPR portability).
- [ ] Move blocking HDIKA sync off the event loop (background task, not sync-in-async).

## P2 — Maintainability

- [ ] Split `admin.py` (1.164 LOC, ~12 concerns) into routers + services.
- [ ] Extract shared backend utils (`_now/_oid/_slugify/_month_range`, repeated in ~8 files).
- [ ] Unify `apiClient.ts` + `adminClient.ts` (shared `ApiError`/refresh/redirect);
      single `API_BASE`; adopt the `queryKeys` registry consistently.
- [ ] Make ingestion item replace transactional (Mongo session; `rs0` supports it).
- [ ] Add error states to frontend pages currently failing silently.

## P2 — Dependency hygiene

- [ ] Upgrade Next.js → ≥14.2.25 (or 15.x) for known CVEs incl. CVE-2025-29927.
- [ ] Replace `python-jose` → PyJWT (unmaintained, CVE history).
- [ ] Plan Motor → async PyMongo migration (Motor deprecated upstream).
- [ ] Raise `python-multipart` floor ≥0.0.18; replace/upgrade `next-pwa` (Serwist).

## P3 — Productization / scale

- [ ] Real billing (payment provider), GESY automation, myDATA integration.
- [ ] Observability (logs/metrics/Sentry), healthchecks + restart on all services.
- [ ] Mongo HA / backup-restore drills (PITR, offsite, encryption-at-rest).
- [ ] Remove hardcoded server IP from `infra/docker/Caddyfile` before public go-live.
- [x] **T-07** Public TLS hardening — 2026-06-07. `enable-public-tls.sh` no longer
      takes the token as a CLI arg; it ensures `CADDY_TLS=dns cloudflare {env.CF_API_TOKEN}`,
      and if `CF_API_TOKEN` is missing reads it via a HIDDEN prompt (`read -rs`) and writes
      it to `.env` (chmod 600); never prints the value. Added `CADDY_TLS`/`CF_API_TOKEN`
      to `.env.example`; Caddyfile now `{$CADDY_TLS:internal}`. Token confirmed already
      set in the server `.env` (scenario A). *(D-015)*

## Responsive / UI-UX (from 2026-06-07 audit — see responsive-fixes-plan.md)
> All require approval + a live browser/device validation pass (audit was static).
- [x] **T-10/T-11/T-12 (Responsive Phase A/B/C)** DONE 2026-06-08 (on `quick-wins`,
      tsc 0-errors + `next build` exit 0). QueryState on all 9 analytics pages + ModuleGuard;
      `<Modal>`/`<QueryState>` components; DataTable keyboard+fullWidthOnMobile; max-width;
      DialogHost max-h; KPI `md:` grids; BarChart/Heatmap mobile; touch targets; dead-UI
      removed (/pricing, lang, bell); InstallButton mounted; friendly errors; not-found/error
      pages. **Bonus:** fixed 3 pre-existing type errors → enabled the type gate
      (`ignoreBuildErrors:false`). ⚠️ Still needs a real device/emulator + axe/Lighthouse pass.
- [x] **T-14** Migrate the 6 bespoke modals onto `<Modal>` — DONE 2026-06-08 (tsc 0 +
      build exit 0). EditUserModal, OpenTenantModal, Edit/AddStaffModal, PostModal,
      InvoiceModal → all now get focus trap + Esc + focus-restore + max-h scroll. Bonus:
      admin "new staff" password `type=text`→`password` (U-9); friendly errors in those
      modals. (DialogHost left as-is — already has Esc + max-h.) Needs the device pass.
- [~] **T-15** Responsive Phase D — partially done 2026-06-08 (tsc 0 + build exit 0):
      ✅ color-token unification (teal→brand, 51 occ / 10 files); ✅ chart a11y
      (`role="img"`+aria-label on Line/Bar/Donut/Heatmap); ✅ chart contrast (axis +
      visualMap `#94a3b8`→`#64748b`).
      **T-15b (partly done 2026-06-08, tsc 0 + build exit 0):**
      ✅ Toast system built (`store/toastStore.ts` + `components/ui/ToastHost.tsx`, mounted in
      Providers; `toastSuccess/Error/Info`, auto-dismiss, aria-live) — modeled on dialogStore;
      adopted additively in orders recompute as proof. ✅ Targeted contrast: `.rx-label`
      slate-400→500.
      ⏳ **Still needs a browser/visual + UX review (NOT done unattended):** migrate the ~10
      scattered inline `notice` strings to toasts (behavior change); **react-hook-form
      standardization across ~10 forms** (large refactor, high regression risk tsc can't catch);
      broad `text-slate-400` body-text contrast sweep (visual judgment).
- [x] **T-16** ESLint enabled — DONE 2026-06-08. Added `.eslintrc.json` (next/core-web-vitals)
      + `eslint`/`eslint-config-next` devDeps; lint clean (0/0); flipped
      `eslint.ignoreDuringBuilds:false`. `npm run build` passes with BOTH type+lint gates.
      Side effect: `frontend/package-lock.json` was generated — regenerate cleanly with a
      fresh `npm install` before relying on it (it came from a partial `--no-save` install).
- [ ] **T-13 (Phase D leftovers)** Consistency/a11y not yet done: shared `<StatusBadge>` +
      use `lib/formatters` (dedup), breadcrumbs, password show/hide toggles, ingestion
      test-without-silent-save. (Color tokens / chart a11y / chart contrast already done in T-15.)

### Audit status
- [x] Full audit complete — 2026-06-07. Reports in repo root + `docs/audit-summary.md`
      (scores + top-20) + `docs/execution-roadmap.md`. *(D-020)*

---

### Open questions for the user (carry forward)
1. Go-live market priority — Greece (ΗΔΙΚΑ) first, or GR+CY together? (affects GESY automation priority)
2. Security-first sequencing vs parallel feature work for demos?
3. ~~Public TLS method~~ → RESOLVED 2026-06-07: Let's Encrypt via Cloudflare DNS-01 (D-015).
