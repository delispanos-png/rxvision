# RxVision — Responsive QA Test Results

> CONFIDENTIAL. Real-browser responsive QA of the `quick-wins` frontend.
> Date: 2026-06-08. Tool: Playwright + Chromium (run in a `mcr.microsoft.com/playwright`
> container with `--network host`), driving a local `next dev` server on `:3100`.
> Method: each route loaded at 6 widths; checked `document.scrollWidth > innerWidth`
> (horizontal-overflow = the #1 responsive bug) + element-level diagnosis of any offender.

## How it was run
- Auth bypassed by injecting `localStorage` tokens; **API mocked** (`/auth/me` → all modules
  enabled; every other `/api/v1/**` → `[]`), so authed pages render without a backend.
- Widths: **320, 390, 768, 1024, 1440, 1920**.
- 19 routes × 6 widths = **114 checks**.

## Result: ✅ 0 / 114 overflow issues (after 1 fix)
All pages render with **no horizontal overflow** at every tested width; **0** wrongly
redirected to login (auth mock worked).

| Page group | Routes | Result |
|---|---|---|
| Auth/marketing | login, register, forgot-password, reset-password | ✅ clean |
| Tenant analytics | dashboard, prescriptions, doctors, patients, icd10, profitability, future, orders, closing, pharmacyone | ✅ clean |
| Settings | settings/users, settings/modules, settings/ingestion | ✅ clean |
| Account/onboarding | account, onboarding | ✅ clean |

## Admin console (second pass)
Extended the same harness (padmin token + `/platform/auth/me` mock) to the 12 admin routes
× 6 widths = **72 checks → 0 issues** after one fix. `/admin/idika` (the concurrent agent's
file) was QA'd read-only and is clean — not modified here.

**Combined: 31 routes × 6 widths = 186 overflow checks, all clean (after 2 fixes).**

## Issues found & fixed
- **`/admin/noeton` @ 320/390px — +78px / +8px overflow.** A long URL in an inline
  `<code>{OUR_HOST}/api/noeton/webhooks}</code>` wasn't wrapping. Fixed with `break-all` on
  the `<code>` tags + `break-words` on the `<li>`. Re-verified → 0/72.
- **`/orders` @ 320px — +27px horizontal overflow.** Element-level diagnosis pinpointed the
  header action group `<div class="flex items-center gap-2">` (recompute button + the
  long-labelled `ExportButton` "Εξαγωγή προς φαρμακαποθήκη") staying at its 331px content
  width as a non-shrinking flex item. `flex-wrap` alone didn't help (the item kept max-content
  width); the fix was **`w-full flex-wrap sm:w-auto sm:justify-end`** so it takes the full row
  on mobile and wraps its buttons. Re-verified live → `scrollWidth=320` (no overflow).
  *(File: `frontend/src/app/(app)/orders/page.tsx` — uncommitted, pending the rebase batch.)*

## ⚠️ Honest scope limitations (what this run did NOT cover)
1. **Empty data only.** The API was mocked to `[]`, so pages were QA'd with empty/loading
   states + layout chrome. **Data-dense rendering** (long tables, many KPIs, charts with real
   data, long Greek labels) was NOT exercised — could surface overflow not seen here. A fuller
   pass needs seeded data (backend via `docker compose up` + `make seed`).
2. **Admin console — now tested** (12 routes, 0 issues after the noeton fix). The R-2
   action-column tables (subscribers/staff) showed no overflow with the
   `fullWidthOnMobile` fix in place. (Still empty-data only — see #1.)
3. **Overflow-only metric.** This checks horizontal overflow (the highest-signal bug). It does
   NOT assess visual polish, contrast, touch-target sizes, or interaction — those need a human
   eye / axe / Lighthouse.
4. Dev build (`next dev`), not the production bundle; PWA disabled in dev.

## Recommended next QA steps
- Bring up the full stack + seed data, re-run this harness against data-dense pages.
- Extend the harness to admin pages (platform token + admin mocks) to verify R-2.
- Add axe-core + Lighthouse passes for a11y/perf.
