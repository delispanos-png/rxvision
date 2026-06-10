# Quality & Hardening — SUMMARY

Branch **`quality-hardening`** (off `main`). Self-contained; no infra/ingestion/worker/secret/
gdpr changes. **CI green** throughout (backend ruff+pytest 48 passed; frontend tsc·lint·build).
No push to main / merge / deploy — left for review.

## ✅ Done (9.5 / 10 mission items)

| # | Item | Outcome |
|---|---|---|
| 1 | TypeScript strict cleanup | **Verified complete** — ignore flags already off; `tsc` 0 errors, `next lint` 0 errors. |
| 2 | Test coverage (backend) | BaseRepository tenant-isolation round-trip tests added to `test_invariants.py` (reads/writes/update/delete/aggregate scoped; pagination clamp). |
| 3 | Accessibility (WCAG AA) | aria-labels on icon-only buttons/links, search-input labels, keyboard-operable Intro dismiss, `<main>` landmark, chart `role="img"`. |
| 4 | Dark-mode completion | `dark:` variants across shell + shared components + nutrition gradient cards. |
| 5 | SEO/PWA | `robots.ts`, `sitemap.ts`, Open Graph/Twitter metadata, `/offline` page + next-pwa fallback. |
| 6 | Email templates (render layer) | `render_transactional()` added to `email_template.py` + render-layer tests. Comms backend untouched. |
| 7 | Audit-log viewer (read-only) | `GET /admin/audit-logs` (platform-admin, filters + pagination) + admin page + nav entry. |
| 8 | Onboarding/registration polish | dark-mode + a11y (label assoc, aria-invalid, role=alert) + onTouched validation + password show/hide + inline 409. |
| 9 | Dependency audit (report-only) | `docs/reports/dependency-audit.md` — npm audit (1 crit/10 high/2 mod) + backend review + prioritised plan. No upgrades applied. |

| 10 | i18n (stretch, **progressive**) | Mechanism confirmed; navigation shell fully bilingual (Sidebar + Settings tabs + collapse aria); **`docs/reports/i18n-plan.md`** (approach + glossary + per-page batches) for the remaining page-body strings. |

## ⏳ Remaining
- **#10 page-body translation** — hundreds of hard-coded Greek strings across app/admin/marketing
  pages; follow `i18n-plan.md` batches. Genuinely progressive (per the mission's "stretch").

## ⚠️ Cross-stream fixes (NOTES.md) — `main` had RED CI from the ingestion stream
Fixed to unblock this branch's CI, **without touching ingestion source**:
- ruff F401 (unused `HdikaAdapter` import) in `routers/ingestion.py`.
- stale assertion in `test_hdika_client.py` (ingestion changed `external_id` → `barcode:execNo`).
The ingestion owner should be aware `main` CI was failing before this branch.

## Open questions (need sign-off — QUESTIONS.md)
- Frontend unit-test runner (Vitest) + e2e (Playwright service containers) — add to CI?
- Add `pip-audit` step to backend CI.

## Guardrails honoured
No `docker compose`/restarts; no edits to `.env`/Vault/`infra/`/`docker-compose*`/
`services/ingestion/*`/`workers/*`/`core/db.py`/`docs/gdpr/*`. Tenant isolation preserved (and
now round-trip-tested). Static checks only. Commits often; branch left for review.
