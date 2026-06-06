# RxVision — Deployment

## 1. Περιβάλλοντα
| Env | Σκοπός | Notes |
|---|---|---|
| `local` | dev | docker-compose, seed data, mongo-express |
| `staging` | QA/UAT | ίδιο stack, anonymized/synthetic data |
| `production` | live | K8s, replica set, autoscale |

## 2. Phase 1 — Docker Compose (MVP)
`docker-compose.yml` σηκώνει: `web, api, worker, beat, mongo, redis` (+ προαιρετικά
`vault`, `mongo-express` σε dev). Ένα `.env` ανά env. Δες [../docker-compose.yml](../docker-compose.yml).

```bash
cp .env.example .env
docker compose up --build
# web :3000 · api :8000 (/api/docs) · mongo :27017 · redis :6379
```
- Images build από `backend/Dockerfile`, `frontend/Dockerfile` (multi-stage, non-root).
- Mongo ως single-node **replica set** ακόμη και σε dev (χρειάζεται για transactions/change
  streams & για parity με prod).
- Healthchecks σε όλα τα services· `api` περιμένει mongo/redis healthy.

## 3. CI/CD
- **CI (GitHub Actions):** lint (ruff/eslint) → type (mypy/tsc) → unit tests (pytest/vitest)
  → build images → SCA/SAST scan → push σε registry (tag = git sha).
- **CD:** staging auto-deploy σε merge στο `main`· production με manual approval (tag).
- DB index sync τρέχει αυτόματα στο app startup (`ensure_indexes`), migrations data-level
  μέσω versioned scripts (`backend/migrations/`).

## 4. Phase 2 — Kubernetes (έτοιμο migration)
- **Deployments:** `api` (HPA σε CPU/RPS, ≥2 replicas), `web` (≥2), `worker` (HPA σε queue
  depth), `beat` (1 replica, leader). Stateless → εύκολο scale.
- **StatefulSet:** MongoDB 3-node replica set (ή managed Atlas) + PVCs encrypted.
- **Redis:** managed ή Redis Sentinel/Cluster.
- **Ingress:** Traefik/NGINX + cert-manager (Let's Encrypt) για TLS, WAF, rate-limit.
- **Secrets:** Vault + External Secrets Operator (όχι plain k8s secrets για creds/peppers).
- **Config:** Helm chart ανά service· values ανά env. Namespace ανά env.
- **mTLS** εσωτερικά (service mesh optional, π.χ. Linkerd).
- **Sharding (όταν χρειαστεί):** shard key `tenant_id` (hashed) στα μεγάλα collections.
- **Dedicated-tier tenants:** ξεχωριστή Mongo DB/cluster — ο `TenantDatabaseResolver`
  δρομολογεί ανάλογα με `isolation_tier` (καμία αλλαγή σε business code).

## 5. Observability & ops
- **Logs:** structured JSON → Loki/ELK, κάθε γραμμή με `tenant_id`+`request_id`.
- **Metrics:** Prometheus (RPS, latency p50/p95, queue depth, sync success rate) → Grafana.
- **Tracing:** OpenTelemetry → Tempo/Jaeger.
- **Errors:** Sentry (api & web).
- **Alerts:** failed sync streak, high error rate, queue backlog, cert expiry, mongo lag.

## 6. Backups & DR
- Nightly Mongo snapshot (encrypted) + PITR (oplog) σε prod. Restore drills τριμηνιαία.
- Per-tenant logical export on demand (GDPR portability & tenant backup).
- RPO ≤ 1h, RTO ≤ 4h (στόχοι MVP, σφίγγουν με την κλίμακα).

## 7. DNS & domains (rxvision.gr)
- `rxvision.gr` & `www` → marketing/app (web).
- `app.rxvision.gr` → PWA (αν θέλουμε διαχωρισμό από marketing).
- `api.rxvision.gr` → FastAPI gateway.
- Cloudflare ως DNS + proxy (CDN/WAF/TLS). Records & proxy setup: βλ. ομάδα infra.
