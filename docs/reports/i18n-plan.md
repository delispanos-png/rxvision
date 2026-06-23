# i18n — plan & glossary (#10, progressive)

## Mechanism (already in place)
- `usePref` (zustand, `store/prefStore.ts`) holds `locale: "el" | "en"` (persisted in
  `localStorage.rx_locale`, default `el`). The Topbar language toggle calls `setLocale`.
- **`useT()`** returns `t(el, en)` → the active-locale string. Usage in a client component:
  ```tsx
  import { useT } from "@/store/prefStore";
  const t = useT();
  <span>{t("Συνταγές", "Prescriptions")}</span>
  ```
- For non-component data (nav arrays), store both languages and resolve with `t(item.el, item.en)`.

## Status
- **Done / already bilingual:** the main **navigation shell** — Sidebar nav items + section
  titles (el+en), Topbar (theme/language/account), and now the **Settings tabs** + Sidebar
  collapse aria-labels.
- **Remaining (progressive):** page-body strings across `app/(app)/*`, `app/admin/*`,
  `app/(marketing)/*`, and shared components. These are hundreds of hard-coded Greek strings; do
  them page-by-page, wrapping each user-visible string in `t("…", "…")`.

## How to continue (per page)
1. Add `"use client"` if the page isn't already a client component (most app pages are).
2. `const t = useT();` at the top of the component.
3. Replace each user-visible Greek literal with `t("Greek", "English")`. Do NOT translate:
   identifiers, API paths, data values, ICD-10 codes, or brand names (RxVision, PharmacyOne,
   ΗΔΥΚΑ, ΓΕΣΥ, Noeton).
4. Keep server components (no hooks) using a passed-in locale or leaving them el-only if not
   user-critical (e.g. legal pages already have their own metadata).
5. Run `tsc --noEmit` + `next lint` + `build` after each batch.

## Glossary (use consistently)
| Ελληνικά | English |
|---|---|
| Πίνακας Ελέγχου | Dashboard |
| Συνταγές | Prescriptions |
| Ιατροί | Doctors |
| Ασφαλισμένοι | Patients |
| Κερδοφορία | Profitability |
| Μελλοντικές | Upcoming |
| Παραγγελίες | Orders |
| Επικοινωνία | Communications |
| Κλείσιμο μήνα | Month closing |
| Ρυθμίσεις | Settings |
| Χρήστες & Ρόλοι | Users & Roles |
| Χρέωση | Billing |
| Εγγραφή | Sign up |
| Σύνδεση | Sign in |
| Αποθήκευση | Save |
| Διαγραφή | Delete |
| Επεξεργασία | Edit |
| Αναζήτηση | Search |
| Εξαγωγή | Export |
| Φόρτωση… | Loading… |
| Σφάλμα | Error |
| Ημερομηνία | Date |
| Φαρμακείο | Pharmacy |
| Ασφαλιστικό ταμείο | Insurance fund |
| Δραστική ουσία | Active substance |

## Suggested batches (priority order)
1. Auth/marketing (`login`, `register`, `forgot-password`) — public entry points.
2. Dashboard + the 5 analytics pages (highest traffic).
3. Operations pages (future, orders, communications, closing, pharmacyone).
4. Settings sub-pages.
5. Admin console (internal — lower priority; can stay el-first).
