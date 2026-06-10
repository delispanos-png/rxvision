# Quality & Hardening — progress log

Branch: `quality-hardening` (off `main`). Self-contained; no infra/ingestion/worker/secret/
gdpr changes. Static checks only (CI runs tsc/lint/build + pytest). No push to main / merge / deploy.

## 2026-06-10

### #1 TypeScript strict cleanup — VERIFIED COMPLETE (already satisfied on main)
- `frontend/next.config.js` already has `typescript.ignoreBuildErrors: false` +
  `eslint.ignoreDuringBuilds: false` (no ignore flags to remove).
- `npm run typecheck` (`tsc --noEmit`) → **0 errors**. `npx next lint` → **exit 0** (1 non-blocking
  *warning*: react-hooks/exhaustive-deps `latestJob` in `settings/ingestion/page.tsx` — left
  untouched: it's adjacent to the infra/ingestion stream's surface and it is a warning, not an
  error; noted in NOTES.md). CI already runs all three steps and they pass.

### Next (in mission priority order)
- #2 Test coverage (backend repos/services + extend test_invariants; frontend where CI-runnable).
- #3 Accessibility (WCAG 2.1 AA). #4 Dark-mode completion.
- Secondary: SEO/PWA/robots/sitemap/offline; audit-log viewer (read-only); email templates
  (render layer); onboarding polish. Report: dependency audit. Stretch: i18n.
