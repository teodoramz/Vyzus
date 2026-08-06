# Vyzus — User-Simulation & Synthetic Monitoring Platform

![CI](../../actions/workflows/ci.yml/badge.svg)
![Security](../../actions/workflows/security.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

Vyzus continuously simulates real users against your web applications using
**Playwright**, on a configurable schedule (every X minutes per check), and gives you a
**dashboard** showing the live availability of every enrolled application's landing page,
with **on-demand screenshots**, response-time metrics, incident history, and alerting.

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
├── docs/                     # Full specification — READ THESE FIRST
│   ├── 01-requirements.md    # Functional & non-functional requirements
│   ├── 02-architecture.md    # System design, components, data flow, security
│   ├── 03-data-model.md      # PostgreSQL schema (Drizzle)
│   ├── 04-api-spec.md        # REST + WebSocket API contract
│   ├── 05-infrastructure.md  # Docker Compose, images, volumes, env, ops
│   ├── 06-implementation-plan.md  # Phased build plan with acceptance criteria
│   └── 07-user-guide.md      # How to use it: apps, checks, journeys, automation
├── infra/                    # Dockerfiles, nginx config
├── apps/
│   ├── api/                  # Fastify REST API + artifact server
│   ├── worker/                # Playwright check executor (BullMQ consumer)
│   └── dashboard/             # React SPA
├── packages/
│   └── shared/                # Shared types, Zod schemas, constants
├── scripts/
│   └── sync-targets.mjs       # Provision apps/checks from targets/ via the API
├── targets/                   # Optional: apps/checks as files (see targets/README.md)
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
pnpm install                                   # bootstrap workspace
docker compose -f docker-compose.test.yml up -d # Postgres :5433 + Redis :6380 for tests
pnpm typecheck && pnpm test                    # all packages; api+worker suites are
                                               # real integration tests (DB, Redis,
                                               # BullMQ, Playwright)
pnpm lint && pnpm format:check                  # ESLint + Prettier
pnpm --filter @vyzus/api db:generate        # drizzle migration from schema changes
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

The complete specification lives in [`docs/`](docs/): numbered requirements,
architecture (including the journey-sandbox security model), the exact data
model, the REST/WS API contract, infrastructure/ops, the phased implementation
plan, and a [user guide](docs/07-user-guide.md) covering day-to-day use (adding
targets, writing uptime/journey checks, reading the dashboard, automating
provisioning).

## CI

GitHub Actions run on every push/PR:

- **CI** — ESLint + Prettier, build, strict typecheck, and the full integration
  test suite (real Postgres/Redis/BullMQ/Chromium), all three Docker images, and a
  guard that the Playwright version stays in lockstep with the worker image tag.
- **Security** — CodeQL static analysis, `pnpm audit` (fails on high/critical),
  PR dependency review, gitleaks secret scan, and a Trivy scan of the api image.
- **Release** — pushing a `v*.*.*` tag re-verifies the tagged commit, publishes
  signed multi-tag images to GHCR with build provenance, scans them with Trivy,
  and opens a GitHub release using that version's `CHANGELOG.md` section.
- **Dependabot** — weekly npm/Actions/Docker updates (Playwright pinned; it must
  be bumped together with the worker image tag).

## Releases

Versioned per [Semantic Versioning](https://semver.org/); see
[CHANGELOG.md](CHANGELOG.md). Container images are published to GHCR on every
tagged release as `api`, `worker`, and `dashboard`, tagged `1.2.3`, `1.2`, `1`,
and `latest`.

To cut a release: update `CHANGELOG.md`, then

```bash
git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0
```

## License

[MIT](LICENSE).
