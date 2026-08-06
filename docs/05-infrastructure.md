# 05 — Infrastructure & operations

The compose file, Dockerfiles, nginx config and `.env.example` at the repo root are the
**authoritative** infra artifacts — this doc explains how to operate them.

## Services & images

| Service | Dockerfile | Base image | Port |
|---|---|---|---|
| dashboard | `infra/dashboard.Dockerfile` | node:24-slim → nginx:1.27-alpine | **8080 → 80** (only exposed port) |
| api | `infra/api.Dockerfile` | node:24-slim | 3000 (internal) |
| worker | `infra/worker.Dockerfile` | mcr.microsoft.com/playwright:v1.54.0-noble | — |
| postgres | — | postgres:16-alpine | 5432 (internal) |
| redis | — | redis:7-alpine | 6379 (internal) |

All Dockerfiles are multi-stage pnpm-workspace builds: install with
`--filter <pkg>...`, build shared + app, then `pnpm deploy --prod` for a pruned runtime
layer. **The worker image tag must match the `playwright` version in
`apps/worker/package.json`** — bump them together.

## Volumes
- `pgdata` — Postgres data.
- `redisdata` — Redis AOF/RDB (schedules survive restarts; even if lost, the API's
  `reconcileSchedules()` rebuilds them from Postgres on boot).
- `artifacts` — screenshots & traces; mounted in **worker (rw)** and **api (rw — the
  retention job deletes here)**. Layout: `/data/artifacts/<appId>/<runId>/{screenshot.png,trace.zip}`.
  Named volumes are created root-owned, so the one-shot `volume-init` service chowns it
  to uid 1001 (worker `pwuser`) before api/worker start, and the api container runs as
  the same uid (`user: "1001:1001"`) so retention can delete worker-written files.

## Runtime hardening (already in compose)
- worker: `shm_size: 1gb` (Chromium requirement), `no-new-privileges`, non-root `pwuser`,
  2 GB memory limit. Scale with `docker compose up -d --scale worker=3` — BullMQ
  distributes jobs automatically, no extra config.
- api: runs as `node` user, migrations run on process start before listening
  (drizzle `migrate()` — safe because concurrent API replicas aren't used in v1).
- Only nginx publishes a host port; put a TLS terminator (Caddy/Traefik/cloud LB) in
  front for production and set `PUBLIC_URL` accordingly.

## Environment variables (`.env`)
See `.env.example`. Notable:
- `ENCRYPTION_KEY` — 32-byte hex; app credentials become unreadable if lost/rotated.
- No admin credentials live in the environment. The first administrator is
  created through the dashboard's first-boot setup screen (`POST /auth/setup`),
  which is gated on the users table being empty and is permanently rejected
  (409) once any user exists.
- `PUBLIC_URL` — used to build screenshot/run links inside alert payloads.
- `WORKER_CONCURRENCY` — parallel browser contexts per worker (4 ≈ ~1.5 GB RSS).

## Capacity planning
One worker at concurrency 4 sustains ~30–60 runs/min (browser-bound; uptime checks
~2–5 s, journeys 10–60 s). Formula: runs/min = Σ(checks / interval). 200 apps × 2 checks
@ 5 min = 80 runs/min → run 2 workers. Postgres/Redis are nowhere near limits at this scale.

## Ops runbook
```bash
docker compose up -d --build            # deploy / upgrade
docker compose logs -f worker           # follow check execution (pino JSON)
docker compose up -d --scale worker=3   # more browser capacity
docker compose exec postgres pg_dump -U vyzus vyzus > backup.sql   # backup (plus copy the artifacts volume)
curl -s localhost:8080/api/v1/health    # liveness
```

Upgrade path to Kubernetes later: images are already stateless-12-factor; replace
compose with a Helm chart (api Deployment, worker Deployment + HPA, managed
Postgres/Redis, artifacts → S3/MinIO — the artifact store is behind one module,
`apps/worker/src/artifacts.ts`, precisely so this swap stays local).

## CI (backlog, not v1)
GitHub Actions: pnpm install → typecheck → unit tests → build all three images.
No registry push required while deploys are `compose up --build` on the host.
