# i18n (EN) — progress

Branch `i18n-en` off `main`. Frontend-only; wire every user-facing Greek string through `useT()`
(default locale Greek). No backend changes, no push to main/merge/deploy. Static checks only.

## Mechanism
`import { useT } from "@/store/prefStore"; const t = useT();` → `t("Ελληνικά", "English")`.
Glossary: `docs/i18n/glossary.md`. Pattern reference: `components/layout/Sidebar.tsx` (already bilingual).

## Plan (parallel batches)
- A: dashboard, prescriptions(+[id]), doctors(+[id]), icd10
- B: patients(+[id]), profitability, future, pharmacyone
- C: orders, order-advisor, advisor, nutrition, closing, communications
- D: account, onboarding, settings/* (+ layout)
- E: shared ui/, tables/, kpi/, filters/, export/
- F: shared charts/, help/, patients/, prescriptions/, advisor/, newsletter/, brand/, pwa/, legal/
- G: lib/help.ts registry (add `en` fields)

## Notes
- Backend-generated strings (advisor insights from API, server `detail` messages) are NOT
  translated here — flagged below as work surfaces.
- Final verification: `tsc --noEmit` + `next lint` + `build` run by the orchestrator after batches.
