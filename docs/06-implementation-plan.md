# 06 — Implementation plan

> **Status: all seven phases are built and shipped in 1.0.0.** This document is
> kept as the record of how the system was staged and what each phase had to
> prove before the next began. For what the product does today, see
> `01-requirements.md` and the [CHANGELOG](../CHANGELOG.md).

Built in this order — each phase ended in a runnable, verifiable state.
Conventions: strict TypeScript everywhere (`tsconfig.base.json`), Zod schemas in
`packages/shared` are the single source of truth for every payload, pino for logs,
vitest for tests. Workspace stubs (`package.json` per app) already list the intended
dependencies — run `pnpm install` at the root first to generate `pnpm-lock.yaml`
(required by the Dockerfiles).

## Phase 1 — Foundation (shared package, DB, migrations)
- `packages/shared`: Zod schemas for all API payloads (04-api-spec), queue names/job
  payload types (02-architecture §4), alert payload types, tsup build.
- `apps/api/src/db/schema.ts`: full Drizzle schema per 03-data-model + relations;
  `drizzle-kit generate` migration committed; `migrate()` + admin-seed on boot.
- **Done when:** `pnpm build` passes at root; `docker compose up postgres` +
  `pnpm --filter @vyzus/api db:migrate` creates all tables.

## Phase 2 — API core (auth + CRUD)
- Fastify app with plugins: drizzle, ioredis, auth (argon2 + JWT access/refresh
  rotation, role guard), zod-validation error mapping.
- Routes: auth, users, apps (incl. auto-created default uptime check), checks,
  channels, settings, health. AES-256-GCM helper for `auth_config_enc`.
- **Done when:** vitest integration suite (against dockerized Postgres) covers login,
  refresh rotation, role guard, app+check CRUD; `curl` happy path works.

## Phase 3 — Scheduler + uptime worker (the heart)
- API `services/scheduler.ts`: upsert/remove BullMQ repeatables on check mutations;
  `reconcileSchedules()` on boot; on-demand enqueue (priority 1) for run-now/screenshot.
- `apps/worker`: BullMQ Worker (concurrency env), shared Chromium, context-per-run;
  uptime executor (metrics, assertions, screenshot per config, artifacts module);
  run persistence + denormalized check fields; incident state machine
  (`evaluateIncident`); Redis pub/sub `run.finished`.
- **Done when:** compose up with a seeded app shows runs appearing every interval;
  killing the target site opens an incident after N failures; recovery resolves it;
  on-demand screenshot lands in the artifacts volume within seconds.

## Phase 4 — Journey executor (sandboxed user code)
- `sandbox/spawn.ts` + `runner-harness.ts` per 02-architecture §5.2: temp runner file,
  clean env, hard timeout kill, JSON-line result protocol, failure screenshot +
  trace.zip, stdout cap.
- Wire into worker; `POST /checks/dry-run` endpoint (API waits on a
  BullMQ job return value with the check config inlined in the payload).
- **Done when:** a pasted `codegen` recording against a public site passes; a spec with
  a failing assertion produces trace + screenshot; `while(true){}` spec is killed at
  timeout and recorded as `timeout`; spec cannot read `DATABASE_URL` (test asserts
  child env is clean).

## Phase 5 — Alerting
- API `services/alerter.ts` consuming the `alerts` queue: render Slack Block Kit /
  Discord embed / generic JSON (04-api-spec payload), HMAC signature, 3-attempt
  backoff, `alert_deliveries` logging; `POST /channels/:id/test`.
- **Done when:** a real Discord/Slack webhook receives red down + green recovery
  messages with working links; deliveries table reflects attempts.

## Phase 6 — Dashboard
- Vite + React + Tailwind + TanStack Query + Recharts + Monaco; typed API client from
  shared schemas; JWT handling with silent refresh; WS hook with polling fallback.
- Pages: Login; **Overview grid** (status cards, sparkline, screenshot thumbnail,
  tag/status filters, live WS updates); **App detail** (availability 24h/7d/30d,
  response-time chart, run history, screenshot gallery, incident timeline, run-now +
  screenshot-now buttons); **Run detail** (metrics, error, screenshot, trace download);
  **Check editor** (form for uptime, Monaco + dry-run button for journey); Channels;
  Users; Settings (retention).
- Follow the `dataviz` skill guidance for charts. Dark mode. Status colors:
  green UP / red DOWN / gray PAUSED / amber UNKNOWN.
- **Done when:** full flow works in a browser end-to-end: login → enroll app → watch
  first run arrive live → force a failure → banner + incident timeline → screenshot
  on demand → edit a journey in Monaco → dry-run → save.

## Phase 7 — Retention, polish, smoke test
- Daily `maintenance` repeatable: delete expired runs + artifact files (transactionally:
  files first, then rows), per `settings` values.
- `GET /stats`, WS `stats.updated`, seed script with 3 demo apps
  (e.g. example.com, a known-404 URL to demo DOWN, one journey).
- One Playwright e2e smoke test driving the dashboard itself (login → enroll → see run).
- README final pass: screenshots, exact quick-start.
- **Done when:** `cp .env.example .env && docker compose up -d --build` on a clean
  host yields a working dashboard with demo data in < 10 min.

## Verification gates (every phase)
`pnpm typecheck && pnpm test` green at root; no `any` without a comment; every route
validated by a shared Zod schema; worker never crashes on a malformed job (log + fail run).

## Backlog

This file is a historical record of how 1.0.0 was staged; the list below has moved on
since. **Delivered after 1.0.0:** certificate expiry warnings (port *and* http checks) ·
maintenance windows · email (SMTP) channels · CI/CD pipelines · latency thresholds
(performance budgets) · visual regression · API tokens · push/heartbeat checks ·
still-down reminders · a dead-man's switch for the platform itself · session login for
authenticated targets · HTTPS deployment.

**Still open:** public status page · ICMP ping and DNS monitors · group monitors with
parent/child suppression · Telegram and other notification integrations (an Apprise
bridge would buy most of them at once) · multi-region probes · hourly rollup table ·
S3/MinIO artifacts · Kubernetes/Helm · multi-step journey timing breakdown.
