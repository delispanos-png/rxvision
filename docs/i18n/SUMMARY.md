# i18n (EN) — SUMMARY

Branch **`i18n-en`** (off `main`). Frontend-only; every user-facing Greek string is now bilingual
via the existing `useT()` hook (`t("Ελληνικά", "English")`), Greek kept verbatim and the default
locale. **tsc 0 · next lint 0 · build ✓.** No backend changes, no push to main / merge / deploy.

## Done
- **All 25 `(app)` pages** — dashboard, prescriptions(+detail), doctors(+detail), icd10, patients
  (+detail), profitability, future, pharmacyone, orders, order-advisor, advisor, nutrition, closing,
  communications, account, onboarding, and all `settings/*` (users, modules, ingestion,
  communications, billing, gdpr) + settings layout tabs.
- **Shared components** — `ui/`, `tables/` (DataTable pagination/empty), `kpi/`, `filters/`,
  `export/`, `charts/` (day-name/tooltip/aria defaults + locale-aware date formatting), `advisor/`,
  `patients/`, `prescriptions/` (RepeatTree), `newsletter/` (RichEditor toolbar), `brand/`, `pwa/`,
  `legal/` (cookie banner), `layout/` (Topbar aria; Sidebar was already bilingual).
- **Contextual help registry** (`lib/help.ts`) — `Help` type extended with optional `*_en` fields;
  all 16 page entries fully translated; `components/help/PageHelp.tsx` resolves locale via prefStore
  (falls back to Greek if an EN field is missing).

## Pattern applied
- `useT()` is a hook → kept at component top level. Module-scope string constants (column-def
  arrays, label maps, select options, message templates) were converted to small factory functions
  `make…(t)` or `{el,en}` objects resolved with `t`, so nothing calls the hook out of scope.
- Locale-sensitive date formatting switched `el-GR` ↔ `en-GB` where hard-coded.

## NOT translated (by design)
- **Backend-generated text** (per guardrails — frontend-only, no backend changes): advisor/
  order-advisor **insight & cross-sell** content, nutrition **plan** text, closing **checklist**
  labels/details, server `detail`/error messages, and any value rendered straight from API/props.
  These are flagged in `PROGRESS.md`; translating them requires backend i18n (separate workstream).
- Brand/identifier tokens kept verbatim: RxVision, PharmacyOne, Noeton, ΗΔΙΚΑ, ΓΕΣΥ, ΕΟΠΥΥ, ΑΑΔΕ,
  ΑΜΚΑ, ΑΦΜ, myDATA, ICD-10, ATC, plan names, code/identifiers/API paths.

## Verification
`tsc --noEmit` 0 errors · `next lint` 0 errors · `next build` exit 0. Static checks only (no
containers/ports). Glossary: `docs/i18n/glossary.md`.
