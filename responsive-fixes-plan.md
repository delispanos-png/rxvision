# RxVision — Responsive & UI/UX Fixes Plan

> CONFIDENTIAL. Sequenced remediation plan for `responsive-audit.md` + `ui-ux-review.md`.
> No code changed yet — **all items require approval before implementation.**
> Date: 2026-06-07. Effort: S ≈ <2h · M ≈ ½–1 day · L ≈ multi-day.

Strategy: ship **shared primitives** first (they each fix many sites at once), then the
high-impact breakpoint/legibility fixes, then polish. Most fixes are CSS/Tailwind +
small component work — low risk, no backend impact.

## Phase A — Foundations (shared primitives; highest leverage)
| ID | Fix | Priority | Effort | Fixes | Impact |
|---|---|---|---|---|---|
| A1 | `<QueryState loading error empty>` wrapper; adopt on every `useQuery` | High | M | U-1, U-2, U-3 | ~30 pages stop silently showing empty/€0 on errors |
| A2 | One `<Modal>` primitive: `max-h-[90vh] overflow-y-auto`, focus trap, Esc, focus restore; migrate DialogHost + 6 bespoke modals | High | M | R-5, U-12, U-17 | a11y + mobile modal usability everywhere |
| A3 | `DataTable`: `Column.fullWidthOnMobile` (block cell) or mobile `⋯` overflow menu; make rows keyboard-operable (`role`,`tabIndex`,Enter/Space) | Critical | M | R-2, U-11 | admin/user tables usable on mobile + keyboard |
| A4 | Content max-width: wrap `<main>` in `mx-auto w-full max-w-[1600px]` (both layouts) | High | M | R-1 | fixes 1440–1920 stretch |

## Phase B — High-impact breakpoint & legibility
| ID | Fix | Priority | Effort | Fixes | Impact |
|---|---|---|---|---|---|
| B1 | `SelectFilter` `min-w-44` → `w-full sm:min-w-44 sm:w-auto`; filter rows `flex-wrap` | High | S | R-3 | no mobile filter overflow |
| B2 | Chart mobile legibility: Heatmap dynamic `interval`/scroll; BarChart reduced `grid.left`/label truncation on mobile | High | M | R-4 | analytics readable on phones |
| B3 | KPI grids: add `md:grid-cols-3/4` step; `KpiCard` value `text-xl sm:text-[26px]`, allow wrap | Medium | S | R-6, R-9 | balanced tablet layout, no value truncation |
| B4 | `break-all`/`truncate`/collapsible on `<code>` ids and `JSON.stringify(stats)` | Medium | S | R-7 | no card overflow |
| B5 | Touch targets → `min-h-[40px]`/`h-11 w-11` on icon buttons, table actions, toolbar | Medium | S | R-8 | fewer mis-taps |

## Phase C — UX correctness & trust
| ID | Fix | Priority | Effort | Fixes | Impact |
|---|---|---|---|---|---|
| C1 | Remove/wire dead affordances: `/pricing`, language switcher, notification bell; mount `InstallButton`; add `not-found.tsx` + `error.tsx` | High | S | U-4, U-24, U-26 | removes broken/fake UI |
| C2 | Stop leaking `JSON.stringify(problem)`; map to friendly messages | Medium | S | U-20 | professional error UX, no payload leak |
| C3 | Ingestion: don't silently save on test/discover | Medium | S | U-21 | no surprise persistence |
| C4 | Toast system (auto-dismiss/stacked) for transient feedback | Medium | M | U-16 | consistent feedback |
| C5 | Password visibility toggle; admin "new staff" pwd → `type=password` | Medium | S | U-8, U-9 | security + usability |

## Phase D — Consistency & a11y polish
| ID | Fix | Priority | Effort | Fixes | Impact |
|---|---|---|---|---|---|
| D1 | Shared `<StatusBadge>`; use `lib/formatters`; adopt `queryKeys` | Medium | S | U-18 | less drift/dup |
| D2 | Unify color tokens (teal vs brand-indigo); fix theme-color drift | Medium | M | U-19 | coherent brand |
| D3 | Contrast pass (slate-400 → 500/600; chart axis colors) | Medium | M | U-14 | WCAG AA |
| D4 | `aria-live` on banners; `aria-label` on icon buttons & charts; next/image for Logo | Medium | S–M | U-13, U-15 | screen-reader support |
| D5 | Breadcrumbs; admin active-state `startsWith`; orphaned content route | Medium | M | U-5, U-6 | navigation clarity |
| D6 | Standardize forms on react-hook-form+zod with inline errors | Medium | L | U-7, U-10 | validation quality |
| D7 | Smaller typography floor (`text-[10/11px]` → `text-xs`) | Low | S | R-10 | legibility |

## Suggested order
A1–A4 (foundations) → B1–B5 (mobile/desktop breaks) → C1–C5 (trust) → D1–D7 (polish).
Phases A+B alone lift the responsive score from ~62 → ~85 and the UX score from ~64 → ~80.

## Verification plan (once a browser/device is available)
After implementing, validate with a real emulator/device pass at the 13 target widths
(esp. 320/375/414 and 1440/1920) + axe/Lighthouse a11y run — this audit was static, so a
visual confirmation pass is the required final gate.
