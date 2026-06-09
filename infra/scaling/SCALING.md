# RxVision — Scaling runbook (VPS + Load Balancer + Terraform)

The app tier (**web / api / worker**) is **stateless** → scales horizontally. All shared
state lives in **MongoDB + Redis**, which must run on their **own node(s)**, not on the app
nodes. The bottleneck under load is the **DB + heavy analytics aggregations**, not FastAPI —
so optimise the DB first, scale app nodes second.

## Target architecture
```
            ┌──────────────┐
  Internet→ │ Hetzner LB    │  (TLS 443 → :443/:8000, health /health)
            └──────┬───────┘
        ┌──────────┼──────────┐         private net 10.0.1.0/24
   ┌────▼───┐  ┌───▼────┐  ┌──▼─────┐
   │ app-1  │  │ app-2  │  │ app-N  │   web+api+worker (docker compose, NO db)
   └────┬───┘  └───┬────┘  └──┬─────┘
        └──────────┼──────────┘
              ┌────▼─────┐
              │  data    │  MongoDB (replica set) + Redis  (own node, backups)
              └──────────┘
```

## Thresholds — when to add a node
Add an app node when **any** holds for ~10 min:
- api/web node CPU **> 70%** sustained, or RAM **> 80%**
- p95 request latency **> 800 ms** (or `/health` flapping)
- Celery queue depth keeps rising (backlog not draining)

Add **DB capacity** (bigger node / read replica / sharding) when:
- Mongo CPU **> 70%** sustained, or working set > RAM, or slow-query log grows.

> 80% of headroom comes from **DB node separation + indexes + precomputed analytics** —
> do that before adding app nodes.

## How to scale out (the process)
1. **Edit** `terraform/terraform.tfvars` → bump `node_count` (e.g. 1 → 2).
2. `terraform apply` — provisions the new server, runs `bootstrap-node.sh`, and **auto-registers
   it behind the load balancer** (health-checked). Zero manual LB edits.
3. Verify the new node passes `/health` in the Hetzner LB targets.
4. To scale **in**, lower `node_count` and `apply`.

## Phase 0 — done / do-first (no new servers)
- [x] **Indexes** on hot fields (`app/core/db.py::INDEXES`, ensured on every startup).
- [ ] **Move MongoDB + Redis to their own node** (compose split: `docker-compose.data.yml`).
- [ ] **Precompute heavy analytics** (advisor/category/cross-sell) into nightly snapshots
      instead of live exec→items→products joins; serve snapshots, recompute via Celery.
- [ ] **Metrics + alerts**: node_exporter + a small Prometheus/Grafana (or Hetzner alerts) on
      the thresholds above; alert → operator bumps `node_count`.

## Notes
- App nodes are **immutable-ish**: each runs the same image + pulls `.env` from your secret
  store at bootstrap (never bake secrets into the image / repo).
- Sessions are JWT (stateless) → no sticky sessions needed.
- The Celery worker is idempotent (upsert on natural key) → running it on every app node is safe.
