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

### #2 Test coverage — backend isolation tests DONE
- `test_invariants.py`: BaseRepository round-trip tenant-isolation tests (reads/writes/update/
  delete/aggregate scoped; pagination clamp). mongomock-motor. CI green (45 passed).
- Also fixed 2 pre-existing `main` CI breakages (noted in NOTES.md): ruff F401 in routers/
  ingestion.py; stale assertion in test_hdika_client.py (ingestion stream changed external_id to
  barcode:execNo). Frontend unit-test runner: proposed in QUESTIONS.md (needs sign-off); e2e needs
  CI service containers (out of current CI) — documented.

### #3 Accessibility (WCAG AA) + #4 Dark-mode — high-impact pass DONE
- Dark-mode: added `dark:` variants across shell + shared components (body, Modal, Card, QueryState,
  DateInput, Topbar, Export menus, Logo, KpiCard, InsightCard, SelectFilter, ContactCard, login
  inputs, marketing/admin layouts, nutrition gradient cards).
- A11y: `aria-label` on icon-only buttons/links (theme/lang toggles, sidebar collapse, CopyButton,
  contact tel/sms/mail, cross-sell), search-input labels, Intro dismiss made keyboard-operable
  (role/tabIndex/onKeyDown), marketing layout `<main>` landmark, CalendarHeatmap `role="img"`+label
  (other charts already had it). tsc 0, lint 0, build ✓ (24 files).

### #5 SEO/PWA — DONE
- `app/robots.ts` (allow public surface, disallow authed app + /api), `app/sitemap.ts` (public
  routes), enhanced `layout.tsx` metadata (metadataBase, Open Graph, Twitter, title template),
  `app/offline/page.tsx` + next-pwa `fallbacks.document: "/offline"`. Build emits /robots.txt,
  /sitemap.xml, /offline; PWA precaches the offline fallback. tsc 0, lint 0, build ✓.

### #6 Email templates (render layer) — DONE
- `email_template.py` already had a responsive/branded newsletter renderer; added reusable
  `render_transactional()` (welcome/reset/notifications: 600px table, inline styles, preheader,
  brand header, optional CTA). Added `tests/test_email_template.py` (merge-tags escaping,
  responsive newsletter, transactional with/without CTA). Did NOT touch the comms send backend.

### #9 Dependency audit (report-only) — DONE
- `docs/reports/dependency-audit.md`: `npm audit` = 1 critical / 10 high / 2 moderate (mostly
  transitive via unmaintained `next-pwa` + `jspdf`/`xlsx`/`next`); all fixes are breaking or
  none → NOT applied. Backend: `pip-audit` not runnable here (no pip) — manual pyproject review
  (recommend PyJWT over python-jose; add pip-audit to CI). Prioritised action list included.

### Remaining
- #7 audit-log viewer (read-only admin page + endpoint); #8 onboarding/registration polish;
  #10 i18n (progressive). Frontend e2e + pip-audit-in-CI need sign-off (QUESTIONS.md).
