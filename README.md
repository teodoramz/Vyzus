# Vyzus — User-Simulation & Synthetic Monitoring Platform

[![CI](https://github.com/teodoramz/Vyzus/actions/workflows/ci.yml/badge.svg)](https://github.com/teodoramz/Vyzus/actions/workflows/ci.yml)
[![Security](https://github.com/teodoramz/Vyzus/actions/workflows/security.yml/badge.svg)](https://github.com/teodoramz/Vyzus/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Vyzus drives a real Chromium browser against your applications on a schedule,
simulating what a user actually does, and tells you the moment something breaks.
It monitors HTTP services, raw TCP/UDP ports and TLS certificates, runs recorded
**Playwright** user journeys, and gives you a dashboard with live status,
response-time metrics, screenshots, incident history and alerting.

## What it does

- **Enroll web applications** — name, landing URL, tags, optional encrypted credentials.
- **Two kinds of checks per application:**
  - **Uptime check**, in either of two modes:
    - `http` — loads the page in a real browser, asserts HTTP status / CSS selector /
      body text / page title, records timing metrics (TTFB, DOMContentLoaded, full
      load) and takes a screenshot.
    - `port` — a raw TCP or UDP reachability probe against any host and port, with
      one-click presets for common services and an optional forced IPv4/IPv6 family.
      TCP ports can additionally perform a **TLS handshake and validate the
      certificate** (trust chain, expiry, hostname), with an opt-in escape hatch for
      deliberately self-signed internal services.
  - **User journey** — a full Playwright test (recorded with `playwright codegen` or
    hand-written) uploaded/edited in the dashboard, simulating a real user flow
    (login, search, checkout, …). A failing journey never marks the application
    itself down — a broken login flow is not a dead landing page.
- **Scheduler** — every check runs on its own interval (e.g. every 5 minutes),
  with jitter and concurrency limits.
- **Dashboard** — grid of all apps with live UP/DOWN status, availability % (24h/7d/30d),
  response-time charts, run history, screenshot gallery, incident timeline.
- **On-demand screenshot** — one click captures the landing page *right now*.
- **Alerting** — Slack/Discord webhooks + generic JSON webhooks on down/recovery,
  with a configurable consecutive-failure threshold.
- **Failure artifacts** — screenshot, Playwright trace, and error details for every failed run.
- **Roles** — `admin`, `editor`, and `viewer` (read/run only, scoped to explicitly
  assigned applications, enforced server-side).
- **Realistic browser fingerprint** — real User-Agent, viewport, locale and timezone
  with Chromium's automation flags suppressed, so monitored sites serve the real page
  rather than a bot challenge.

## Stack

| Layer | Technology |
|---|---|
| Language | TypeScript everywhere (monorepo, pnpm workspaces) |
| API | Fastify + Zod + JWT auth |
| Scheduler / queue | BullMQ (Redis) — repeatable jobs per check |
| Check execution | Playwright workers (official Playwright Docker image) |
| Database | PostgreSQL 16 + Drizzle ORM |
| Dashboard | React + Vite + Tailwind + Recharts, Monaco editor for tests |
| Artifacts | Shared Docker volume (screenshots, traces), served by the API |
| Deployment | Docker Compose (single host), workers horizontally scalable |

## Repository layout

```
.
├── apps/
│   ├── api/                   # Fastify REST API + artifact server
│   ├── worker/                # Playwright check executor (BullMQ consumer)
│   └── dashboard/             # React SPA
├── packages/
│   └── shared/                # Zod schemas, types, constants, DB schema
├── docs/                      # Full specification (see Documentation below)
├── infra/                     # Dockerfiles, nginx config
├── scripts/
│   └── sync-targets.mjs       # Provision apps/checks from targets/ via the API
├── targets/                   # Optional: apps/checks as files (targets/README.md)
├── docker-compose.yml
└── .env.example
```

## Quick start

```bash
cp .env.example .env
# then edit .env:
#   POSTGRES_PASSWORD  — any strong value
#   JWT_SECRET         — e.g. openssl rand -hex 48
#   ENCRYPTION_KEY     — exactly:  openssl rand -hex 32

docker compose up -d --build
# dashboard: http://localhost:8080
```

The API migrates the database on boot. On first visit the dashboard shows a
**setup screen** where you create the initial administrator. There is no default
account and no admin password in the environment, so a freshly deployed instance
has no credentials to guess — the first person to reach it claims it, and setup
is permanently closed afterwards.

Enroll an application in the dashboard (it gets a default uptime check) and the
first run appears live within its interval.

### Demo data

Seed three demo applications (healthy example.com, a guaranteed-DOWN target that
demonstrates incidents + alerts, and one with a journey check). Idempotent —
safe to run more than once:

```bash
docker compose exec api node dist/seed-demo.js
# (local dev: pnpm --filter @vyzus/api seed)
```

## Development

```bash
pnpm install                                     # bootstrap the workspace
docker compose -f docker-compose.test.yml up -d  # Postgres :5433 + Redis :6380 for tests

pnpm lint && pnpm format:check                   # ESLint + Prettier
pnpm typecheck                                   # strict tsc across all packages
pnpm test                                        # real integration tests
                                                 # (DB, Redis, BullMQ, Chromium)
pnpm --filter @vyzus/api db:generate             # Drizzle migration from schema changes
```

Hosts without the bundled Playwright browser can point the worker (and its
sandbox) at a system browser: `export VYZUS_CHROMIUM_EXECUTABLE=/usr/bin/chromium`.

### Managing targets as files

Prefer version-controlled targets over clicking through the UI? Put apps + journey
checks under `targets/` and sync them via the same REST API the dashboard uses:

```bash
VYZUS_API_URL=http://localhost:8080/api/v1 VYZUS_EMAIL=... VYZUS_PASSWORD=... \
  pnpm sync-targets            # add --dry-run to preview, --prune to delete stragglers
```

See [`targets/README.md`](targets/README.md) for the file format and
[`docs/07-user-guide.md`](docs/07-user-guide.md) §5 for the full walkthrough.

## Documentation

| Document | Contents |
|---|---|
| [01 — Requirements](docs/01-requirements.md) | Numbered functional and non-functional requirements |
| [02 — Architecture](docs/02-architecture.md) | Components, queues, data flow, and the journey-sandbox security model |
| [03 — Data model](docs/03-data-model.md) | The exact PostgreSQL schema |
| [04 — API specification](docs/04-api-spec.md) | REST and WebSocket contract, alert payloads |
| [05 — Infrastructure](docs/05-infrastructure.md) | Compose, images, volumes, environment, operations |
| [06 — Implementation plan](docs/06-implementation-plan.md) | How the build was staged; kept as a historical record |
| [07 — User guide](docs/07-user-guide.md) | Day-to-day use: adding targets, writing checks, reading the dashboard |

Start with the [user guide](docs/07-user-guide.md) if you want to run it, or
[architecture](docs/02-architecture.md) if you want to understand it.

## CI

GitHub Actions run on every push/PR:

- **CI** — ESLint + Prettier, build, strict typecheck, and the full integration
  test suite (real Postgres/Redis/BullMQ/Chromium), all three Docker images, and a
  guard that the Playwright version stays in lockstep with the worker image tag.
  Documentation-only changes skip the expensive jobs.
- **Security** — CodeQL static analysis, `pnpm audit` (fails on high/critical),
  PR dependency review, gitleaks secret scan, and Trivy scans of all three
  images plus the source tree.
- **Dependabot** — weekly npm/Actions/Docker updates (Playwright pinned; it must
  be bumped together with the worker image tag).

## License

[MIT](LICENSE).
