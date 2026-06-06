# RxVision — Roadmap & Subscription Model

## A. Subscription / Commercial model

### Plans
| Plan | Τιμή (ανά φαρμακείο/μήνα) | Modules | Limits |
|---|---|---|---|
| **Free Trial** (14–30 ημ.) | €0 | Dashboard + Prescription Analytics + **trial** όλων | 1 pharmacy, 3 μήνες ιστορικό, no API sync (manual) |
| **Basic** | €€ | Dashboard, Prescription, Doctor, ICD-10 analytics | 1 pharmacy, 12 μήνες, ΗΔΙΚΑ sync |
| **Pro** | €€€ | + Patient analytics, **Profitability**, Future, Orders, Monthly Closing | έως 3 pharmacies, 24 μήνες, full sync |
| **Enterprise** | custom | όλα + dedicated isolation, SSO, SLA, support | unlimited pharmacies, 60 μήνες, dedicated DB tier |

### Μηχανική
- **`subscriptions`** collection ορίζει plan, status, `modules_included`, `limits`, `addons`,
  `price_per_pharmacy`, `seats`, `trial_ends_at`.
- **Locked modules:** module όχι στο plan → API `403 module_locked`, UI → upsell screen.
- **Trial modules:** `tenants.modules[key]="trial"` με λήξη· μετά → locked εκτός upgrade.
- **Usage limits:** ελέγχονται σε middleware/service (pharmacies count, history window,
  export count, sync enabled). `GET /subscription/usage` δείχνει usage vs limit.
- **Per-pharmacy pricing:** χρέωση × αριθμό ενεργών pharmacies του tenant.
- **Add-ons:** π.χ. `pharmacyone` — αγοράζεται ξεχωριστά, ανεξάρτητα από το base plan.
- **Billing:** Stripe (subscriptions + metered add-ons)· webhooks ενημερώνουν status·
  dunning/grace period σε αποτυχία πληρωμής (`status: past_due` → read-only μετά grace).

---

## B. MVP roadmap (Phase 1 — ~10–14 εβδ.)

**Στόχος:** ένα φαρμακείο (GR/ΗΔΙΚΑ) βλέπει αξιόπιστα στατιστικά end-to-end.

| Sprint | Παραδοτέο |
|---|---|
| 0 | Repo scaffold, docker-compose, CI, Mongo replica set, index bootstrap, auth (JWT+refresh), tenant middleware, RBAC base, audit logging |
| 1 | Tenant onboarding + users/roles + consent/DPA, subscription (trial/basic) + module gating |
| 2 | **ΗΔΙΚΑ ingestion**: credentials→Vault, full sync, normalizer + **anonymization**, validation, dedup, sync_jobs |
| 3 | Incremental (αέναο) sync + retries + per-tenant error reporting· post-process (counters, future rx) |
| 4 | **Dashboard** (KPIs, timeseries, top widgets) + precompute snapshots |
| 5 | **Prescription Analytics** (φίλτρα, compare, trends, drill-down) + export CSV/Excel |
| 6 | **Doctor** + **ICD-10 analytics** + **Profitability** (βασικό) |
| 7 | PWA (manifest, SW, offline shell, install) + responsive polish + role-based menus |
| 8 | Hardening: rate-limit, security headers, DPIA, backups, staging UAT με πραγματικό φαρμακείο |

**MVP «done» = ** GR φαρμακείο: login → connect ΗΔΙΚΑ → αυτόματος sync → dashboard +
prescription/doctor/ICD-10/profitability analytics → export, με GDPR anonymization & audit.

---

## C. Phase 2 roadmap

| Θέμα | Περιεχόμενο |
|---|---|
| **Κύπρος / ΓΕΣΥ** | XML upload ingestion (manual) → αργότερα API adapter |
| **Patient Analytics** πλήρες | retention cohorts, loyalty, lifecycle |
| **Future Prescriptions & Orders** πλήρη | demand forecast, order suggestions, εφημερίες περιοχής |
| **Monthly Closing Control** | ασυμφωνίες, ελλείψεις, fund totals, period lock |
| **PharmacyOne add-on** | κινήσεις πελάτη, εκτός-συνταγής πωλήσεις, ανά πωλητή/χρήστη, ανεκτέλεστα |
| **Benchmarking** | ανώνυμα cross-tenant («vs μέσος όρος περιοχής») |
| **Kubernetes** | Helm charts, HPA, External Secrets, mTLS, managed Mongo/Redis |
| **Enterprise** | SSO (SAML/OIDC), dedicated DB tier, SLA, advanced RBAC |
| **GraphQL** (αν χρειαστεί) | flexible drill-down για power users |
| **Billing αυτοματισμός** | Stripe metered add-ons, self-serve upgrades |
| **ML forecast** | καλύτερη πρόβλεψη ζήτησης (seasonality, εφημερίες, εμβολιασμοί) |

---

## D. Σύνοψη τεχνικών αποφάσεων (γιατί)
Βλ. αναλυτικά [ARCHITECTURE.md §8](ARCHITECTURE.md). Κορυφαίες:
1. **Shared DB + tenant_id** αρχικά (απλό/φθηνό/benchmarking) με enforcement στο repo layer
   και **έτοιμο** path σε database-per-tenant για Enterprise.
2. **MongoDB** για ετερογενές ingestion + δυνατό aggregation analytics.
3. **Anonymization στο σημείο εισόδου** — PII δεν αγγίζει ποτέ το analytics store.
4. **REST + precomputed snapshots + Redis cache** για γρήγορα, προβλέψιμα dashboards.
5. **FastAPI + Celery + Next.js PWA**, Dockerized, με ξεκάθαρο K8s migration path.
