# RxVision — Frontend (Next.js PWA)

Next.js 14 (App Router, TypeScript). SSR/RSC για shell & SEO marketing pages,
client components για interactive analytics. Εγκαταστάσιμο PWA με offline shell.

## 1. Folder structure
```
frontend/src/
├── app/
│   ├── (marketing)/              # public: landing, pricing, login
│   │   ├── page.tsx  pricing/  login/
│   ├── (app)/                    # authenticated shell (layout: sidebar+topbar)
│   │   ├── layout.tsx            # role/module-based menu, auth guard
│   │   ├── dashboard/page.tsx
│   │   ├── prescriptions/page.tsx
│   │   ├── doctors/page.tsx  doctors/[id]/page.tsx
│   │   ├── patients/page.tsx
│   │   ├── icd10/page.tsx
│   │   ├── profitability/page.tsx
│   │   ├── future/page.tsx
│   │   ├── orders/page.tsx
│   │   ├── closing/page.tsx
│   │   ├── pharmacyone/page.tsx
│   │   └── settings/(users|modules|ingestion|billing)/page.tsx
│   ├── api/                      # BFF route handlers (proxy + token refresh)
│   ├── manifest.ts               # PWA manifest
│   └── layout.tsx                # root (providers)
├── components/
│   ├── charts/ (LineChart, BarChart, DonutChart — ECharts wrappers, lazy)
│   ├── tables/ (DataTable, drill-down row)
│   ├── filters/ (DateRange, FundSelect, DoctorSelect, Icd10Select, PeriodCompare)
│   ├── kpi/ (KpiCard, TrendBadge)
│   ├── layout/ (Sidebar, Topbar, ModuleGuard)
│   └── export/ (ExportButton: csv|xlsx|pdf)
├── lib/ (apiClient.ts, auth.ts, rbac.ts, formatters.ts, queryKeys.ts)
├── hooks/ (useDashboard, usePrescriptions, useProfitability, useModuleAccess)
├── store/ (uiStore.ts — Zustand: filters, sidebar, theme)
└── styles/ (tailwind)
```

## 2. State management & data fetching
- **TanStack Query** για server state: caching, background refetch, pagination,
  `staleTime` ταιριαστό με backend cache. Query keys στο `lib/queryKeys.ts`.
- **Zustand** για ελαφρύ UI/global filter state (date range, επιλεγμένα φίλτρα,
  theme, sidebar) — μοιράζεται μεταξύ modules.
- **Data fetching strategy:** RSC για το πρώτο, μη-ευαίσθητο shell (γρήγορο TTFB)·
  client components + TanStack Query για interactive φίλτρα/drill-downs. BFF route
  handlers (`app/api/*`) κρατούν το refresh token σε HttpOnly cookie και κάνουν proxy
  στο FastAPI με τον access token — ο browser δεν αγγίζει ποτέ refresh token.

## 3. Charts
- **ECharts** (`echarts-for-react`), lazy-loaded ανά chart για μικρό bundle.
  Line (trends/timeseries), bar (top N), donut (mix ανά ταμείο/κατηγορία),
  heatmap (εκτελέσεις ανά ημέρα/ώρα). Κοινό theme (brand colors), responsive.

## 4. RBAC & module-based navigation
- `useModuleAccess(moduleKey)` → `enabled|trial|locked` από `/auth/me`.
- `<ModuleGuard module="profitability">` wrap-άρει σελίδες· locked → upsell screen.
- Sidebar χτίζεται δυναμικά από permissions+modules (κρυμμένα όσα δεν επιτρέπονται).
- Διπλός έλεγχος: το backend επιβάλλει πάντα (UI gating = UX, όχι security).

## 5. Export
- `ExportButton` καλεί endpoint με `?format=` → λαμβάνει job id → polling/notification →
  download signed URL. Excel (xlsx), CSV, PDF (server-rendered για συνέπεια).

## 6. PWA
- `manifest.ts`: name "RxVision", icons, `display: standalone`, theme color, el locale.
- **Service worker** (next-pwa/Workbox):
  - **App shell precache** (offline-friendly): layout, fonts, icons → ανοίγει offline.
  - **Runtime caching:**
    - GET analytics → `StaleWhileRevalidate` (γρήγορο, ανανεώνεται στο background).
    - `/auth/me`, dashboard summary → `NetworkFirst` με fallback cache.
    - static assets → `CacheFirst` με versioning.
  - **Offline UX:** όταν offline, δείχνει τελευταία cached δεδομένα + banner «offline,
    στοιχεία από <timestamp>». Mutations (π.χ. trigger sync) → disabled offline.
- Installable (A2HS), splash screens, responsive (mobile-first· ο φαρμακοποιός το ανοίγει
  και από κινητό στο ταμείο).

## 7. Βασικά UI screens
1. **Login** — email/password (+MFA), brand, link σε pricing.
2. **Dashboard** — KPI cards (εκτελέσεις σήμερα/μήνα, αξία, αιτούμενα, #ασφαλισμένων,
   κερδοφορία), timeseries chart, top-3 widgets (ιατροί/ICD-10/σκευάσματα), date-range filter.
3. **Prescription Analytics** — πίνακας + φίλτρα (ημέρα/μήνα/ταμείο/ιατρό/ICD-10/σκεύασμα),
   period compare, trend chart, drill-down σε μεμονωμένη συνταγή (items).
4. **Doctor Analytics** — λίστα ιατρών + στήλες (συνταγές/αξία/κερδοφορία/νέοι πελάτες),
   doctor detail με trends.
5. **Patient Analytics** — ανώνυμα: κατανομές ανά age_group/φύλο/περιοχή, retention cohort,
   αξία ανά ασφαλισμένο (buckets).
6. **ICD-10 Analytics** — top διαγνώσεις, αξία & κερδοφορία ανά διάγνωση.
7. **Profitability** — μεικτό κέρδος/περιθώριο ανά ταμείο/ιατρό/κατηγορία, λίστα ειδών
   χαμηλής κερδοφορίας, «ασύμφορες κατηγορίες».
8. **Future Prescriptions** — ημερολόγιο συνταγών που ανοίγουν, demand forecast.
9. **Order Suggestions** — προτεινόμενη παραγγελία (qty), export προς φαρμακαποθήκη.
10. **Monthly Closing** — control checklist, ασυμφωνίες/ελλείψεις, συγκεντρωτικά ταμείων, lock.
11. **PharmacyOne** (add-on) — πωλήσεις εκτός συνταγής, ανά πωλητή/χρήστη, ανεκτέλεστα.
12. **Settings** — Users/Roles, Modules (plan), Ingestion (credentials + jobs/errors), Billing.

## 8. Tech choices summary
TanStack Query + Zustand, Tailwind + shadcn/ui (προσβάσιμα components), ECharts,
react-hook-form + zod (forms/validation), next-intl (el/en), next-pwa.
