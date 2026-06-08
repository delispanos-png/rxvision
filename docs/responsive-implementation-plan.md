# RxVision — Responsive Implementation Plan (apply-ready)

> CONFIDENTIAL. Exact, file-by-file plan to finish the responsive/UX work. Companion to
> `responsive-fixes-plan.md` (strategy). Date: 2026-06-07.
> **Status:** Phase A foundations + 2 Phase B fixes already implemented on `quick-wins`
> (typecheck-clean, uncommitted). The rest below is **not yet applied** — needs approval
> and ideally a browser pass. Verified with `node_modules/.bin/tsc --noEmit` (only 3
> pre-existing errors remain, in `Invoices.tsx` + `subscribers/[id]`, untouched by us).

## Already done (this session)
- Content `max-w-[1600px]` in `(app)/layout.tsx`, `admin/layout.tsx`.
- `DataTable`: keyboard rows (`role/tabIndex/Enter-Space`) + `Column.fullWidthOnMobile`.
- `DialogHost`: `max-h-[90vh] overflow-y-auto`.
- New `components/ui/QueryState.tsx` and `components/ui/Modal.tsx`.
- `fullWidthOnMobile` + `flex-wrap` on action columns: `settings/users`, `admin/staff`,
  `admin/subscribers`.
- `SelectFilter` width (`w-full sm:w-auto sm:min-w-44`), `KpiCard` value (`text-xl sm:text-[26px]`).

## Remaining — Phase A: adopt `<QueryState>` everywhere
**Pattern** (replace the silent `?? []`/`?? 0`):
```tsx
import { QueryState } from "@/components/ui/QueryState";
const q = useQuery({ queryKey: [...], queryFn: ... });
const rows = q.data?.items ?? [];
return (
  <QueryState isLoading={q.isLoading} isError={q.isError}
              isEmpty={!rows.length} onRetry={() => q.refetch()}>
    {/* existing table/chart/list using rows */}
  </QueryState>
);
```
**Apply to** (file → query): `(app)/dashboard` (7 queries — wrap each card section),
`prescriptions:75`, `doctors:37`, `patients:70`, `icd10:55`, `profitability:75`,
`future:44`, `orders:46`, `closing:59`, `pharmacyone:43`, `doctors/[id]:30`; admin:
`admin/page:33`, `subscribers:30`, `subscriptions:85`, `billing:35`, `health:62`,
`staff:45`, `Invoices:31`, `idika/noeton/smtp/maintenance`. (~30 sites.)
**Special:** `ModuleGuard.tsx:10-17` — distinguish `/auth/me` *error* from *locked*:
```tsx
const me = useQuery({ queryKey: queryKeys.me(), queryFn: ... });
if (me.isError) return <QueryState isError onRetry={() => me.refetch()}>{null}</QueryState>;
const state = me.data?.modules?.[module] ?? "locked";
```

## Remaining — Phase A: migrate modals to `<Modal>`
Replace each hand-rolled overlay (`EditUserModal` users:212, `OpenTenantModal`
subscribers:100, staff Add/Edit:176/224, `PostModal` content:83, `InvoiceModal`
Invoices:116) with:
```tsx
<Modal open={open} onClose={onClose} title="…" size="md"
       footer={<><button onClick={onClose}>Άκυρο</button><button onClick={save}>Αποθήκευση</button></>}>
  {/* form fields */}
</Modal>
```
Then optionally back `DialogHost` with `<Modal>` too (keep its alert/confirm/prompt API).
Gives focus trap + Esc + max-height everywhere for free.

## Remaining — Phase B (exact changes)
- **KPI grids — add `md:` step.** In each page's KPI wrapper change
  `grid-cols-2 ... lg:grid-cols-5` → `grid-cols-2 md:grid-cols-3 lg:grid-cols-5` (or
  `...md:grid-cols-4`). Files: `dashboard:66`, `doctors:67`, `prescriptions:99`,
  `icd10:88`, `future:71`, `patients:94`, `orders:78`, `profitability:92`, `closing:89`.
- **HeatmapChart.tsx** — dynamic hour-axis density on small screens:
  ```ts
  // xAxis.axisLabel: interval based on container width (e.g. show every 3rd label <480px),
  // or wrap the chart in `overflow-x-auto` with a min-width so it scrolls on mobile.
  ```
- **BarChart.tsx:27** — `grid.left: 120` → responsive: `left: window.innerWidth < 480 ? 64 : 120`
  (or use `containLabel: true` and let ECharts size the gutter; truncate long labels with
  `axisLabel.formatter` to ~16 chars on mobile).
- **Touch targets** — bump: Topbar icon buttons `h-9 w-9` → `h-10 w-10` (`Topbar.tsx:68,76`),
  admin hamburger (`admin/layout.tsx:103`), RichEditor toolbar `h-8 w-8` → `h-9 w-9`,
  table action buttons `px-2 py-1` → `px-2.5 py-1.5`.
- **Break long strings** — `subscribers/[id]:158` & `ingestion:158`
  `JSON.stringify(...)` → wrap in `<pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">`;
  `<code>` ids (Topbar:107) → add `break-all`.

## Remaining — Phase C (UX correctness — small, safe)
- Remove dead `/pricing` link (`login:137`); add `app/not-found.tsx` + `app/error.tsx`
  (branded). Mount `<InstallButton/>` in `Topbar`. Remove/wire language switcher
  (`Topbar:73`) + notification bell (`Topbar:76`).
- Replace `JSON.stringify(e.problem)` user-facing strings with friendly messages
  (subscribers/[id]:63,77,85; staff:81,88,95; idika:48; noeton:29; ingestion:167).
- Password visibility toggle component; admin "new staff" pwd `type="text"` → `password`
  (`staff:239`).

## Phase D (flagged — needs review, larger/riskier)
Color-token unification (teal vs brand-indigo), full toast system, react-hook-form
standardization, contrast pass, breadcrumbs, i18n. Do with visual review, not unattended.

## Verification gate
After applying: `node_modules/.bin/tsc --noEmit` clean, then `npm run build`, then a real
device/emulator pass at 320/375/414/768/1024/1440/1920 + axe/Lighthouse. (npm deps are now
installed locally; `tsc` works.)
