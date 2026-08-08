# 05 — Infrastructure & operations

The compose file, Dockerfiles, nginx config and `.env.example` at the repo root are the
**authoritative** infra artifacts — this doc explains how to operate them.

## Services & images

| Service | Dockerfile | Base image | Port |
|---|---|---|---|
| dashboard | `infra/dashboard.Dockerfile` | node:24-slim → nginx:1.31-alpine | **8080 → 80** (only exposed port) |
| api | `infra/api.Dockerfile` | node:24-slim | 3000 (internal) |
| worker | `infra/worker.Dockerfile` | mcr.microsoft.com/playwright:v1.62.1-noble | — |
| postgres | — | postgres:16-alpine | 5432 (internal) |
| redis | — | redis:7-alpine | 6379 (internal) |

All Dockerfiles are multi-stage pnpm-workspace builds: install with
`--filter <pkg>...`, build shared + app, then `pnpm deploy --prod` for a pruned runtime
layer. **The worker image tag must match the `playwright` version in
`apps/worker/package.json`** — bump them together; the `playwright-lockstep` CI job
enforces it, and Dependabot is configured to leave that image alone because its
docker ecosystem cannot see the npm pin.

Node stays on the **24 LTS** line. Dependabot skips node majors: 25 is not LTS and
unbundled corepack, so `corepack enable` in these Dockerfiles exits 127 on it.

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
- api: runs as `node` user, migrations run on process start before listening.
  Drizzle's migrator does not lock, so `runMigrations()` wraps it in a Postgres
  advisory lock: concurrent starters queue and the late ones find nothing to do.
  Without it, the moment during `docker compose up -d --build api` when the old
  and new containers overlap was enough to make the loser die on an object the
  winner had already created.
- Only nginx publishes a host port. It can terminate TLS itself (see below), or you
  can leave it on HTTP behind an external terminator (Caddy/Traefik/cloud LB) — either
  way set `PUBLIC_URL` to the address browsers actually use.

## HTTPS

The default stack serves plain HTTP on `${DASHBOARD_PORT:-8080}`, which is fine for
local development. Anything reachable by other people should be served over TLS: the
platform handles login credentials on `/auth/login` and `/auth/setup`, and issues a
refresh cookie.

TLS is opt-in through a compose override, so the default path stays exactly as it is
and a missing certificate can never break a development stack.

### 1. Put the certificate and key in place

```
infra/certs/fullchain.pem    certificate followed by any intermediates
infra/certs/privkey.pem      the matching private key, PEM, not passphrase-protected
```

`infra/certs/` is gitignored, so a real key cannot be committed by accident.

**From Let's Encrypt** (certbot writes exactly these two filenames):

```bash
mkdir -p infra/certs
cp /etc/letsencrypt/live/<domain>/fullchain.pem infra/certs/
cp /etc/letsencrypt/live/<domain>/privkey.pem   infra/certs/
```

Renewal replaces the files on the host; nginx keeps the old ones in memory until it
reloads, so add `docker compose exec dashboard nginx -s reload` to your renewal hook
(or just restart the dashboard service).

**Self-signed, for testing only** — browsers will warn, which is expected:

```bash
mkdir -p infra/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout infra/certs/privkey.pem -out infra/certs/fullchain.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

### 2. Point `PUBLIC_URL` at the https address

```
PUBLIC_URL=https://vyzus.example.com
```

This is not cosmetic. `PUBLIC_URL`'s scheme decides whether the refresh cookie is
marked `Secure` (`isSecureOrigin` in `apps/api/src/config.ts`), and it is embedded in
the links inside alert payloads. Leaving it on `http://` while serving HTTPS means
alert links point at the redirect and the cookie is not marked `Secure`.

`HTTP_PORT` and `HTTPS_PORT` default to 80 and 443 and only need setting if those are
taken. A non-443 HTTPS port also needs the `return 301` line in `infra/nginx-tls.conf`
adjusted, since a redirect cannot discover the published port on its own.

### 3. Bring the stack up with the override

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
```

Port 80 now answers only with a 301 to HTTPS; 443 serves the dashboard, the API and
the WebSocket. To go back to plain HTTP, drop the `-f docker-compose.tls.yml`.

### What the override changes

| | Default | With `docker-compose.tls.yml` |
|---|---|---|
| Published ports | `8080:80` | `80:80`, `443:443` |
| nginx config | `infra/nginx.conf` | `infra/nginx-tls.conf` |
| Certificates | none | `infra/certs/` mounted read-only |
| HSTS header | not sent | `max-age=31536000; includeSubDomains` |

Both configs `include` `infra/nginx-common.conf` for the actual routing, so the HTTP
and HTTPS server blocks cannot drift apart. TLS settings are 1.2/1.3 only, ECDHE +
AEAD ciphers, session tickets off, client cipher preference.

## Environment variables (`.env`)
See `.env.example`. Notable:
- `ENCRYPTION_KEY` — 32-byte hex; app credentials become unreadable if lost/rotated.
- No admin credentials live in the environment. The first administrator is
  created through the dashboard's first-boot setup screen (`POST /auth/setup`),
  which is gated on the users table being empty and is permanently rejected
  (409) once any user exists.
- `PUBLIC_URL` — builds screenshot/run links inside alert payloads, and its scheme
  decides whether the refresh cookie carries `Secure`. Must match how browsers
  actually reach the dashboard.
- `WORKER_CONCURRENCY` — parallel browser contexts per worker (4 ≈ ~1.5 GB RSS).

## Monitoring the monitor

A monitoring tool has to be more trustworthy than the things it watches, and its worst
failure is silence: if it stops working, nothing fails, no alert fires, and the
dashboard keeps serving the last known status. Silence is indistinguishable from health
unless something is deliberately watching for it.

**Vyzus covers part of this itself, and cannot cover the rest.** Configuring the second
half is not optional if you rely on these alerts.

### What covers what

| Failure | Covered by | Notes |
|---|---|---|
| A monitored target goes down | the check itself | the ordinary case |
| Worker process dies or crashloops | dead-man's switch | it watches for *runs stopping*, so a worker that is alive but wedged is caught too |
| Postgres or Redis unreachable | dead-man's switch, partly | runs stop, so it notices — but if Postgres is down the API cannot read settings or send anything |
| **API process dies** | **nothing internal** | the switch runs *in* the API; it dies with it |
| **Host or network dies** | **nothing internal** | |
| The external checker dies | nothing | see "where to stop", below |

`heartbeat.stall_minutes` (Settings, default 15) is the dead-man's switch: the API
evaluates it once a minute and alerts when no check has completed platform-wide inside
the window. It lives in the API rather than the worker on purpose — a switch hosted by
the process it exists to watch dies with it. But that only moves the problem: nothing
inside Vyzus can report that Vyzus is gone.

### The external check

Point something *outside this host* at:

```
GET https://vyzus.example.com/api/v1/health
```

| Response | Meaning |
|---|---|
| `200` `{"status":"ok","db":true,"redis":true}` | API up, Postgres and Redis reachable |
| `503` `{"status":"degraded","db":false,...}` | API up but a dependency is down — the booleans say which |
| hangs, then times out | API or host is gone. **This is the case the internal switch can never report.** |

Two things to get right:

- **Do not point it at `/`.** nginx serves the dashboard from disk, so the root returns
  `200` even when the API container is dead. A check on `/` would report green through
  exactly the outage you are trying to catch. Use `/api/v1/health`.
- **Run it from another machine.** A checker on the same host dies with the host, which
  is one of the failures it is supposed to catch.
- **Give the check its own timeout.** A dead API does not produce a fast `502`: nginx
  waits on the upstream, so the request hangs rather than failing immediately (measured
  at >20s with the api container stopped). A checker with no timeout will sit there
  instead of alerting. Ten seconds is plenty — a healthy `/health` is two pings.

The endpoint is unauthenticated and returns three booleans and nothing else — no
application data, no counts, no names — so it is safe to hand to a third-party checker
or a free hosted monitor.

### Three ways to do it

**A second Vyzus** — if you already run two instances, give each an `uptime` check on
the other's `/api/v1/health`, with alert channels that do not share infrastructure.
Mutual monitoring, no extra tooling.

**Any external uptime monitor** — Uptime Kuma, a hosted free tier, your cloud
provider's health check. This is the pragmatic answer for most single-instance
deployments, and it is worth doing even though it means running a second tool: it is
cheap, and it is the only thing that catches a dead host.

**cron + curl**, when there is nothing else to hand — on a *different* machine:

```bash
#!/usr/bin/env bash
# /etc/cron.d entry: */5 * * * * /usr/local/bin/vyzus-liveness
set -uo pipefail
if ! curl -fsS --max-time 10 https://vyzus.example.com/api/v1/health > /dev/null; then
  # -f makes curl exit non-zero on 5xx as well as on a refused connection
  printf 'Subject: Vyzus is not answering\n\nGET /api/v1/health failed at %s\n' "$(date -Is)" \
    | sendmail you@example.com
fi
```

### Where to stop

Whatever watches Vyzus is itself unwatched, and chasing that produces an infinite
regress. The practical rule: the outermost checker should be something with a different
failure mode from Vyzus — a different host, ideally a different provider, and a
notification path that does not depend on your own infrastructure. One layer of that is
enough for a self-hosted tool; two is diminishing returns.

## Held-back dependencies

Dependabot runs weekly and most updates are expected to merge on their own. Four are
pinned on purpose; each is recorded in `.github/dependabot.yml` next to its ignore
rule, and each has a reason that will not be obvious from the version number alone:

| Pinned | Why |
|---|---|
| `playwright` (npm) + `mcr.microsoft.com/playwright` (docker) | Version-locked to each other; the `playwright-lockstep` CI job fails if they drift. Dependabot's two ecosystems cannot see each other, so it always proposes half a bump. Move both by hand. |
| `bullmq` — exact `5.80.2` | 5.81.3 loses job keys and locks mid-processing (`Missing key for job ... moveToFinished`), failing four e2e pipeline tests. Re-test the worker suite before unpinning. |
| `node` majors | 24 is LTS. 25 unbundled corepack, so `corepack enable` exits 127 in all three Dockerfiles. Patch and minor bumps of the 24 line still arrive. |

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

## CI

Three GitHub Actions workflows, all running on push to `main`, on pull requests and
on demand (Security adds a weekly schedule). See the README for what each covers.

Two things about them are worth knowing before editing:

- **Action references are resolved during "Set up job"**, before any step runs, and a
  composite action's *own* nested references are resolved too. `trivy-action@v0.28.0`
  pinned `setup-trivy@v0.2.1`, which was later removed upstream, so all four Trivy
  jobs failed in a few seconds with no step output at all. If a job dies in "Set up
  job", check the action refs before anything else.
- **Dependabot PRs get a read-only `GITHUB_TOKEN`** regardless of the `permissions:`
  block, so `upload-sarif` cannot write and the job would fail. Those uploads are
  skipped for `dependabot[bot]`; the scans still run.

Images are built but not pushed by CI — deploys are `compose up --build` on the host.
`release.yml` is the one that publishes, on a semver tag.
