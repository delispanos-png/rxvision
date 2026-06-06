# RxVision

**Multi-tenant SaaS PWA για στατιστική ανάλυση εκτελέσεων συνταγών φαρμακείων.**

Domain: `rxvision.gr` · Markets: 🇬🇷 Ελλάδα (ΗΔΙΚΑ) & 🇨🇾 Κύπρος (ΓΕΣΥ)

---

## Τι είναι

Ανεξάρτητο εργαλείο analytics που αντλεί εκτελεσμένες συνταγές (ανεξάρτητα από το εμπορικό
πρόγραμμα του φαρμακείου), τις ανωνυμοποιεί, και παράγει στατιστικά & προβλέψεις:
ανά ασφαλισμένο, ιατρό, ICD-10, σκεύασμα, ταμείο — μαζί με κερδοφορία, μελλοντικές
συνταγές, προτάσεις παραγγελίας και έλεγχο κλεισίματος μήνα.

## Stack (τεχνικές αποφάσεις σε μία ματιά)

| Layer | Επιλογή | Γιατί |
|---|---|---|
| Backend / API | **Python 3.12 + FastAPI** | async I/O, Pydantic v2 validation, auto OpenAPI, ώριμο oικοσύστημα |
| DB | **MongoDB 7** (Motor async driver) | ευέλικτο schema για ετερογενή ingestion, ισχυρό aggregation framework για analytics |
| Cache / queue broker | **Redis 7** | rate-limit, sessions, Celery broker, hot-aggregation cache |
| Background jobs | **Celery + Redis** (beat για scheduling) | sync workers, GDPR jobs, snapshot precompute |
| Frontend | **Next.js 14 (App Router) + TypeScript** | SSR/RSC, PWA-ready, role-based routing |
| PWA | **next-pwa / Workbox** | offline shell, installable, caching |
| Charts | **ECharts** (μέσω `echarts-for-react`) | πλούσια στατιστικά γραφήματα, καλό performance σε μεγάλα datasets |
| State / data | **TanStack Query + Zustand** | server-state caching + ελαφρύ client state |
| Auth | **JWT access + refresh**, RBAC | stateless API, tenant-scoped |
| Container | **Docker / docker-compose** → **Kubernetes** (Phase 2) | dev parity, ομαλό migration path |
| Secrets | **HashiCorp Vault** (ή cloud KMS) | credentials ΗΔΙΚΑ/ΓΕΣΥ, encryption keys |

## Δομή repo

```
rxvision/
├── docs/            # Πλήρης αρχιτεκτονική — διάβασε με τη σειρά παρακάτω
├── backend/         # FastAPI service (api, services, repositories, workers)
├── frontend/        # Next.js PWA
├── infra/           # docker-compose, Dockerfiles, k8s manifests
└── docker-compose.yml
```

## Διάβασε τα docs με αυτή τη σειρά

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — συνολική αρχιτεκτονική, multi-tenancy, modules, αποφάσεις
2. [docs/DATABASE.md](docs/DATABASE.md) — όλα τα MongoDB collections (πεδία, indexes, σχέσεις, παραδείγματα)
3. [docs/API.md](docs/API.md) — REST endpoints ανά module
4. [docs/ANALYTICS.md](docs/ANALYTICS.md) — aggregation pipelines (έτοιμα queries)
5. [docs/INGESTION.md](docs/INGESTION.md) — ΗΔΙΚΑ / ΓΕΣΥ sync, workers, validation
6. [docs/SECURITY_GDPR.md](docs/SECURITY_GDPR.md) — security model & GDPR
7. [docs/FRONTEND.md](docs/FRONTEND.md) — Next.js structure, screens, PWA
8. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — deploy plan (Docker → K8s)
9. [docs/ROADMAP.md](docs/ROADMAP.md) — MVP & Phase 2

## Quick start (dev)

```bash
cp .env.example .env          # συμπλήρωσε secrets
docker compose up --build     # api:8000, web:3000, mongo:27017, redis:6379
# OpenAPI docs: http://localhost:8000/api/docs
```
