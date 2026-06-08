# RxVision — UI/UX & Accessibility Review

> CONFIDENTIAL — proprietary CloudOn IP. Read-only audit, no code changed.
> Date: 2026-06-07 · Branch `quick-wins`. Method: static code analysis (no browser).

## Summary
UX maturity is mid-to-high for an MVP: consistent visual language (KpiCard / PanelCard /
DataTable / ECharts), a real in-app dialog system (appAlert/Confirm/Prompt), the
responsive table→card pattern, good auth-error mapping, and destructive-action guards in
admin. The dominant weaknesses are **systemic, not cosmetic**:
1. Almost every `useQuery` swallows errors via `?? []`/`?? 0` — **no error UI anywhere**.
2. **Accessibility** gaps — non-keyboard-operable rows, no modal focus trap, unlabeled
   icon buttons/charts, no `aria-live`, low-contrast text, raw `<img>`.
3. **Inconsistency** — two color systems (teal vs brand-indigo), three+ modal
   implementations, raw-`useState` vs react-hook-form, duplicated badges/formatters.
4. **Unfinished UX** — dead `/pricing` link, non-functional language switcher &
   notification bell, unmounted PWA install button, MFA/Export/CY stubs, no
   `not-found`/`error`/`loading` routes.

## UX score: **64 / 100** · Accessibility sub-score: **45 / 100**

---

## 1. Loading / Error / Empty states

### U-1 · No error UI on any query (silent failures) — **High / M**
- **Desc:** No `error.tsx`/`loading.tsx`/`not-found.tsx` exist. Every page uses
  `?? []`/`?? 0`; `isError` is never read. Tenant: dashboard:50-54, prescriptions:75,
  doctors:37, patients:70, icd10:55, profitability:75, future:44, orders:46, closing:59,
  pharmacyone:43, doctors/[id]:30. Admin: page:33, subscribers:30, subscriptions:85,
  billing:35, health:62, staff:45, Invoices:31, idika/noeton/smtp/maintenance.
- **Impact:** an API outage looks identical to "no data" / €0 — users think their data is
  gone. **Fix:** a shared `<QueryState loading error empty>` wrapper around every query
  (error banner + retry). One component fixes ~30 sites. **Effort:** M.

### U-2 · ModuleGuard false-locks the app on `/auth/me` error — **High / S**
- **Desc:** `ModuleGuard.tsx:10-17` — on `/auth/me` failure `data` is undefined →
  `state="locked"` → every gated page shows the upsell screen. **Impact:** a transient
  error hides the whole app behind "module locked". **Fix:** distinguish error from
  locked; show retry. **Effort:** S.

### U-3 · Inconsistent loading indicators — **Medium / S**
- **Desc:** Some pages guard with a spinner; dashboard renders `?? 0` immediately (KPIs
  flash 0). Loading copy ("Φόρτωση…") duplicated ~20×. **Fix:** shared `<Loading/>` +
  consistent usage (folds into U-1). **Effort:** S.

## 2. Navigation & IA

### U-4 · Dead `/pricing` link + no styled 404 — **High / S**
- **Desc:** `login/page.tsx:137` links to non-existent `/pricing`; no `not-found.tsx` →
  default unstyled English 404. **Fix:** remove/build the link; add branded `not-found.tsx`.
  **Effort:** S.
### U-5 · No breadcrumbs / weak location cues — **Medium / M**
- **Desc:** Location conveyed only by sidebar active state + `<h1>`; detail pages use
  manual "← Πίσω". **Fix:** breadcrumb component on detail/nested routes. **Effort:** M.
### U-6 · Admin active-state + orphaned routes — **Medium / S**
- **Desc:** `admin/layout.tsx:73` exact-match active state won't highlight `subscribers/[id]`;
  `/admin/content/[type]` exists but is not in the nav (unreachable). **Fix:** `startsWith`
  active logic; add/remove content route from nav. **Effort:** S.

## 3. Forms UX

### U-7 · Inconsistent form stack & validation — **Medium / L**
- **Desc:** react-hook-form+zod only on login/register; everything else raw `useState`
  with imperative checks dumped into one banner (reset:37, account:79). No inline
  field-level errors outside login/register. **Fix:** standardize on react-hook-form+zod;
  shared field components. **Effort:** L.
### U-8 · No password visibility toggle anywhere — **Medium / S**
- **Desc:** all password fields lack show/hide (login/register/reset/account/onboarding/
  ingestion/admin login). **Fix:** reusable password input with toggle. **Effort:** S.
### U-9 · Admin "new staff" password is `type="text"` — **Medium / S**
- **Desc:** `admin/staff/page.tsx:239` renders the new admin password in cleartext
  on-screen. **Fix:** `type="password"` + toggle. **Effort:** S.
### U-10 · Misc form polish — **Low / S**
- No autofocus on first field; no visual required-field marker; success feedback
  inconsistent (inline ✓ vs appAlert vs nothing). **Effort:** S.

## 4. Accessibility

### U-11 · Clickable rows/cards not keyboard-operable — **High / M**
- **Desc:** `DataTable.tsx:63-66,82-85` puts `onRowClick` on `<tr>`/`<div>` with no
  `role`/`tabIndex`/key handler (doctors drilldown is mouse-only). **Fix:** role="button",
  tabIndex=0, Enter/Space handler (or wrap a real link). **Effort:** M.
### U-12 · No focus trap / management in any modal — **High / M**
- **Desc:** `DialogHost` sets `role=dialog aria-modal` but no Tab trap / focus restore;
  the 6+ hand-rolled overlays have no role/aria at all; background stays tabbable; only
  DialogHost handles Esc. **Fix:** one `<Modal>` primitive with focus trap + Esc + restore.
  **Effort:** M.
### U-13 · Icon-only buttons / charts unlabeled — **Medium / S–M**
- **Desc:** Topbar bell/globe (Topbar.tsx:73,76), newsletter device toggles (`title` only),
  ExportButton caret lack accessible names; all ECharts canvases lack `role="img"`/label/
  data fallback. **Fix:** `aria-label`s; chart `aria-label` + optional data table.
  **Effort:** S (buttons) / M (charts).
### U-14 · Low color contrast — **Medium / M**
- **Desc:** pervasive `text-slate-400` on white (~2.6:1, fails AA) for KPI subs, labels,
  axis labels (`theme.ts:11`), loading text; disabled buttons at `opacity-40`. **Fix:**
  shift secondary text to `slate-500/600`; audit chart palette. **Effort:** M.
### U-15 · Banners/toasts lack `aria-live`; raw `<img>` — **Medium / S**
- **Desc:** newsletter/staff/ingestion/maintenance notices not announced; `Logo.tsx:5-6`
  uses `<img>` (eslint-disabled) → layout shift. **Fix:** `aria-live="polite"`; next/image.
  **Effort:** S.

## 5. Feedback & Consistency

### U-16 · Two feedback systems; no real toast — **Medium / M**
- **Desc:** `dialogStore` (appAlert/Confirm/Prompt) used widely, but many flows keep ad-hoc
  inline `notice`/`error` strings that persist until replaced. **Fix:** one toast system
  (auto-dismiss, stacked) for transient feedback; keep dialogs for confirms. **Effort:** M.
### U-17 · Three+ modal implementations — **Medium / M** (see U-12; consolidate).
### U-18 · Duplicated badges / formatters / query keys — **Medium / S**
- **Desc:** `STATUS_STYLE` redefined in subscribers:14, subscribers/[id]:25, admin/page:12,
  subscriptions:31 (+ modules/Invoices/staff variants); `eur/num` redefined in
  dashboard:20-22 instead of `lib/formatters`; `queryKeys` helper largely bypassed by
  inline arrays (cache-key drift; ModuleGuard omits `retry:false` on the shared `me()` key).
  **Fix:** shared `<StatusBadge>`, use `formatters`, adopt `queryKeys`. **Effort:** S.
### U-19 · Color system drift (teal vs brand-indigo) — **Medium / M**
- **Desc:** tenant analytics/DialogHost use `brand` (indigo); marketing register button,
  onboarding, settings/modules+billing, ModuleGuard, filter focus rings use `teal`; admin
  uses raw `indigo`. `manifest theme_color #4f46e5` vs chart brand `#6366f1`. **Fix:** one
  token system. **Effort:** M.

## 6. Key workflows (friction)

### U-20 · Technical errors leaked to users — **Medium / S**
- **Desc:** admin + ingestion render `JSON.stringify(e.problem)` to operators/users
  (subscribers/[id]:63,77,85; staff:81,88,95; idika:48; noeton:29; ingestion discover:167,
  sync stats:158). **Fix:** map to friendly messages (Invoices.tsx already does this).
  **Effort:** S.
### U-21 · Ingestion "test/discover" silently saves the form — **Medium / S**
- **Desc:** `settings/ingestion:93,101` persist the whole (possibly invalid) form before
  testing, without consent. **Fix:** test against unsaved values or confirm-before-save.
  **Effort:** S.
### U-22 · Onboarding lets users skip setup silently — **Low / S**
- **Desc:** "Μετάβαση στο Dashboard" always available; CY path is a disabled stub. **Fix:**
  confirm/guard when leaving setup incomplete. **Effort:** S.
### U-23 · Newsletter: no draft/autosave; preset overwrites edited body — **Low / M**.

## 7. PWA

### U-24 · Install button never mounted — **High / S**
- **Desc:** `pwa/InstallButton.tsx` has zero usages → users can't install except via
  browser menu. **Fix:** mount in Topbar/settings. **Effort:** S.
### U-25 · No offline fallback page — **Medium / S**
- **Desc:** runtimeCaching covers reads, but uncached routes/mutations fail into the
  no-error-UI gap (U-1). **Fix:** offline fallback + error UI. **Effort:** S.

## 8. i18n

### U-26 · Non-functional language switcher + English leaks — **Medium / S**
- **Desc:** Topbar globe "EL" button has no handler (implies multi-language that doesn't
  exist); English tokens leak to operators (MRR/ARR/trial/seats/past_due/"Super Admin",
  raw status values). No i18n framework (all hardcoded Greek). **Fix:** remove/wire the
  switcher; translate admin tokens; plan i18n later. **Effort:** S now / L for full i18n.

## 9. Unfinished UX (clearly-labeled stubs — lower urgency)
- MFA toggle "(σύντομα)" (account:229) · ExportButton polling stub (sets false
  expectation, **Medium**) · CY/ΓΕΣΥ ingestion stub · notification bell with permanent
  unread dot and no panel (**Low**, implies features that don't exist) · dead admin
  coming-soon nav branch · unused `queryKeys`/InstallButton exports.

## Cross-cutting top fixes (by ROI)
1. Shared `<QueryState>` wrapper on every query — kills U-1 + U-2 (~30 sites). **M**
2. One `<Modal>` (focus trap/Esc) + keyboard-operable DataTable rows — U-11/U-12/U-17. **M**
3. Remove/wire dead affordances + add `not-found.tsx`/`error.tsx` — U-4/U-24/U-26. **S**
4. Stop leaking `JSON.stringify(problem)` — U-20. **S**
5. Consolidate badges/formatters/colors — U-18/U-19. **S–M**
