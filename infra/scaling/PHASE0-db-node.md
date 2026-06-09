# Phase 0 — Move MongoDB + Redis to their own node

Goal: split state off `RxVisionSRV01` (157.180.26.98, all-in-one) onto a dedicated **data
node** on a Hetzner private network, so app nodes become stateless & cloneable.

## Preconditions (hard gates — do NOT start without all three)
1. **Rotate the Hetzner + Cloudflare tokens** (the ones shared in chat are burned). Provide
   the NEW Hetzner token — we will not build persistent billable infra with a leaked token.
2. **Agreed maintenance window** — expect ~5–15 min of brief app downtime at cutover
   (low-traffic time). The DB stays read-safe throughout (we restore from a fresh dump).
3. **Verified backup exists** — ✅ done: `backups/rxvision-*.archive.gz` (restorable, dry-run OK).

## Plan (each step reversible; rollback = repoint app back to local DB + restore dump)
1. **Provision data node** (Terraform, private net): `hcloud_server` type `cpx21`, label
   `role=data`, private IP `10.0.1.10`, firewall: 27017/6379 open ONLY to `10.0.1.0/24`.
2. **Stand up Mongo+Redis** on it (`docker-compose.data.yml`): single-node replica set `rs0`
   (keep the same replica-set name so connection strings keep working), `--auth --keyFile`,
   Redis `--requirepass`. Same creds as today (from current `.env`).
3. **Load data**: `mongorestore` the verified dump into the new node. Verify counts match
   (executions / items / patients) before cutover.
4. **Cutover** (the brief window):
   - On `RxVisionSRV01`, edit `.env`: `MONGODB_URI` + `REDIS_URL` → the data node's private IP.
   - Switch app compose to the **app-only** file (drop the local mongo/redis services).
   - `docker compose up -d` → app reconnects to the remote DB. Smoke test `/health` + a page.
5. **Verify & decommission** the local mongo/redis only after 24–48h of stable operation.

## Rollback (instant)
Revert `.env` to the local DB + `docker compose up -d` with the original compose. (Local DB
is untouched until step 5, so rollback is immediate.) Worst case: `mongorestore` the dump.

## After Phase 0
Adding an app node = `terraform apply -var node_count=N` (each node app-only, points at the
data node, auto-registers behind the LB). Then Cloudflare `app.rxvision.gr → LB`.
