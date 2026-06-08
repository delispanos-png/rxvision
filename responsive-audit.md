# RxVision — Responsive Design Audit

> CONFIDENTIAL — proprietary CloudOn IP. Read-only audit, no code changed.
> Date: 2026-06-07 · Branch `quick-wins`.
> **Method:** static, code-level analysis of Tailwind classes / inline styles / layout
> structure. No browser was available, so behavior at each width is *inferred from the
> markup*, not visually rendered. Treat as a high-confidence code review, to be confirmed
> with a real device/emulator pass (tracked as a follow-up).

Breakpoints considered: 320 · 360 · 375 · 390 · 414 (mobile) · 768 · 820 (tablet) ·
1024 · 1280 · 1366 · 1440 · 1600 · 1920 (desktop).

## Overall responsive strategy
- **Mobile-first but inconsistently applied.** The tenant `(app)` shell, both sidebars
  (off-canvas drawer → `md:static`), and the shared `DataTable` (desktop table +
  mobile card view) are genuinely responsive. Auth pages are clean single-column cards.
- **No max-content-width cap anywhere.** No custom `screens` in `tailwind.config.js`, no
  `max-w`/`mx-auto` on `<main>` in any of the 3 layouts → content stretches edge-to-edge
  at 1440/1600/1920.
- **Thin breakpoint granularity.** Almost everything jumps `grid-cols-2` straight to
  `lg:` (1024). The 768–1023 tablet band is under-served (KPI rows stuck at 2 columns).
  No `2xl:` usage anywhere.
- **Biggest systemic gap:** the admin console reuses the responsive `DataTable` but puts
  multi-button **action columns** into it; those collapse badly in the mobile card grid.
  Admin was built desktop-first.

## Worst offenders — horizontal scroll / overflow at 320–414px
1. **Admin/settings action-column tables** — `admin/staff/page.tsx:117-129` (5 buttons),
   `settings/users/page.tsx:116-143` (4), `admin/subscribers/page.tsx:46-58`,
   `admin/subscribers/[id]`. Action button clusters render inside `DataTable`'s 2-col
   mobile card value cell (`DataTable.tsx:88-94`) → overflow/squash.
2. **`SelectFilter` `min-w-44`** (`filters/SelectFilter.tsx:25`) = 176px hard floor;
   multi-filter rows (`icd10:72`, `profitability:109`) can exceed 320px.
3. **`JSON.stringify(stats)` blobs** (`admin/subscribers/[id]:158`, `settings/ingestion:158`)
   — long unbreakable strings overflow mobile cards.
4. **HeatmapChart** 24 hour-columns (`charts/HeatmapChart.tsx:36-41`) — illegible <414px.
5. **Horizontal BarChart `grid.left:120`** (`charts/BarChart.tsx:27`) — ~120px gutter
   leaves ~150px plotting area on a 320px card.

## Findings

### R-1 · No max-width cap → desktop stretch (1440/1600/1920) — **High / M**
- **Desc:** `<main>` in `(app)/layout.tsx:13` and `admin/layout.tsx:111` has no
  `max-w`/`mx-auto`. **Impact:** on wide monitors charts/tables/KPI cards stretch
  unnaturally wide, hurting readability and visual polish on the most common business
  displays (1440–1920). **Fix:** wrap children in `mx-auto w-full max-w-[1600px]` (or
  add a `2xl` container). **Effort:** M.

### R-2 · Action columns break in mobile card view — **Critical / M**
- **Desc:** `DataTable.tsx:88-94` renders every non-title column into a `grid-cols-2`
  label/value row; action cells (4–5 buttons) overflow/wrap unreadably ≤414px. Affects
  `admin/staff`, `settings/users`, `admin/subscribers`, `subscribers/[id]`.
  **Impact:** core admin/user-management actions are hard or impossible to use on mobile.
  **Fix:** add a `Column.fullWidthOnMobile` (render the cell block, full width, below the
  card) or collapse actions into an overflow `⋯` menu on mobile. **Effort:** M.

### R-3 · `SelectFilter` hard min-width — **High / S**
- **Desc:** `filters/SelectFilter.tsx:25` `min-w-44`. **Impact:** filter rows overflow at
  320–375. **Fix:** `w-full sm:min-w-44 sm:w-auto`. **Effort:** S.

### R-4 · Chart legibility on mobile — **High / M**
- **Desc:** HeatmapChart (24 cols, `HeatmapChart.tsx:36-41`) and horizontal BarChart
  (`grid.left:120`, `BarChart.tsx:27`) are cramped/illegible ≤414. **Impact:** key
  analytics unreadable on phones. **Fix:** dynamic axis `interval` by width; reduce
  `grid.left` and/or truncate labels on mobile; optional horizontal-scroll wrapper for
  the heatmap. **Effort:** M.

### R-5 · Modals have no max-height / scroll — **Medium / S**
- **Desc:** `ui/DialogHost.tsx:46-49` and 3 bespoke modals (`EditUserModal` users:212,
  `OpenTenantModal` subscribers:100, staff Add/Edit:176/224) set `max-w-md` but no
  `max-h`/scroll; long content / landscape phones overflow the viewport. **Impact:**
  buttons/inputs become unreachable. **Fix:** `max-h-[90vh] overflow-y-auto` on each
  (ideally consolidate to one `<Modal>`). **Effort:** S.

### R-6 · Tablet (768–1023) KPI grids stuck at 2 columns — **Medium / S**
- **Desc:** KPI grids use `grid-cols-2 ... lg:grid-cols-{4,5}` with no `md:` step
  (`dashboard:66`, `doctors:67`, `prescriptions:99`, `icd10:88`, `future:71`,
  `patients:94`, `orders:78`, `profitability:92`, `closing:89`). **Impact:** wasted
  space / unbalanced layout on tablets. **Fix:** add `md:grid-cols-3` (or `4`).
  `doctors/[id]:52` already does this — copy the pattern. **Effort:** S.

### R-7 · Long unbreakable strings overflow cards — **Medium / S**
- **Desc:** `JSON.stringify(stats)` (subscribers/[id]:158, ingestion:158), tenant ids in
  `<code>` (Topbar:107). **Impact:** horizontal overflow in mobile cards. **Fix:**
  `break-all` / `truncate` / render as a collapsible block. **Effort:** S.

### R-8 · Touch targets below 44px — **Medium / S**
- **Desc:** Topbar/admin icon buttons `h-9 w-9` (36px) (`Topbar.tsx:68,76`,
  `admin/layout.tsx:103`), RichEditor toolbar `h-8 w-8` (32px), device toggles `h-7 w-8`
  (28px), table action buttons `px-2 py-1` (~26px). **Impact:** mis-taps on touch
  devices. **Fix:** bump interactive controls toward `min-h-[40px]`/`h-11 w-11` on touch.
  **Effort:** S.

### R-9 · KPI value text not responsive — **Medium / S**
- **Desc:** `kpi/KpiCard.tsx:37` value `text-[26px]` + `truncate`. **Impact:** long
  currency values truncate inside the 2-col mobile grid. **Fix:** `text-xl sm:text-[26px]`
  and allow wrap. **Effort:** S.

### R-10 · Very small typography — **Low / S**
- **Desc:** `text-[10px]`/`text-[11px]` in sidebar group titles, badges, `Logo` subtitle,
  `globals.css:21`. **Impact:** legibility on mobile. **Fix:** raise minimum to `text-xs`.
  **Effort:** S.

## Clean (no responsive concern)
`(marketing)/layout.tsx` + all 4 auth pages, `Card.tsx`, `ModuleGuard.tsx`,
`MaintenanceBanner.tsx`, `Logo.tsx`, `InstallButton.tsx`, root `page.tsx`,
`DataTable` desktop branch (`hidden md:block`).

## Responsive design score: **62 / 100**
Strong primitives (drawer, DataTable card view, fluid charts, clean auth) drag up;
no max-width cap, admin action-column breakage, thin tablet band, chart legibility and
touch-target gaps drag down. See `responsive-fixes-plan.md` for the sequenced plan.
