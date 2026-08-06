# 02 — Architecture

## 1. System overview

```
                        ┌─────────────────────────────────────────────┐
                        │                Docker host                  │
                        │                                             │
  Browser ──────────────►  dashboard (nginx)                          │
  (user)     :8080      │   ├─ serves React SPA                       │
                        │   └─ proxies /api & /ws ──► api             │
                        │                              │              │
                        │        ┌─────────────────────┤              │
                        │        ▼                     ▼              │
                        │   PostgreSQL 16          Redis 7            │
                        │   (state, results)       (BullMQ queues)    │
                        │        ▲                     ▲              │
                        │        │                     │              │
                        │   worker × N  ◄──────────────┘              │
                        │   (Playwright, consumes jobs,               │
                        │    writes runs + artifacts)                 │
                        │        │                                    │
                        │        ▼                                    │
                        │   artifacts volume (screenshots, traces)    │
                        │    ▲ read by api (serves files to UI)       │
                        └────┼────────────────────────────────────────┘
                             └── alert webhooks ──► Slack / Discord / any URL
```

Five services, one compose file:

| Service | Image | Responsibility |
|---|---|---|
| `dashboard` | nginx + built SPA | Serve UI, reverse-proxy `/api` and `/ws` to api |
| `api` | node:24-slim | REST API, auth, WebSocket push, artifact file server, schedule management, alert dispatch |
| `worker` | mcr.microsoft.com/playwright | Execute checks with real browsers, write results & artifacts |
| `postgres` | postgres:16 | Source of truth |
| `redis` | redis:7 | BullMQ job queues + repeatable schedules |

## 2. Monorepo layout (pnpm workspaces)

```
apps/api         Fastify app. src/: plugins/ (auth, db, redis, ws), routes/ (auth, apps,
                 checks, runs, incidents, channels, users, stats, artifacts), services/
                 (scheduler.ts, alerter.ts, retention.ts), index.ts
apps/worker      BullMQ Worker. src/: executors/ (uptime.ts, journey.ts), sandbox/
                 (runner-harness.ts, spawn.ts), artifacts.ts, index.ts
apps/dashboard   React SPA. src/: pages/ (Overview, AppDetail, RunDetail, CheckEditor,
                 Channels, Users, Login), components/, api/ (typed client), ws.ts
packages/shared  Zod schemas (single source of validation truth, inferred TS types),
                 queue names, job payload types, alert payload types, constants
```

Shared Zod schemas are used by the API for request validation **and** by the dashboard
client for response typing — never duplicate a shape.

## 3. Data flow: a scheduled check run

1. **Schedule registration** — when a check is created/updated/enabled, the API upserts a
   BullMQ *repeatable job* on queue `checks` with `every = interval_minutes * 60_000`,
   `jobId = check:<uuid>` (dedup key). Deleting/disabling removes the repeatable.
   On boot the API runs `reconcileSchedules()`: DB is the source of truth, Redis is
   rebuilt to match (fixes drift after Redis flush).
2. **Execution** — a worker picks the job, loads the check + app from Postgres, applies
   0–15 s jitter, then runs the matching executor (see §5) inside a fresh browser context.
3. **Persist** — worker inserts a `runs` row (status, metrics jsonb, error, artifact
   paths) and updates the check's denormalized `last_status` / `last_run_at`.
4. **State machine** — worker calls `evaluateIncident(check, run)`:
   - `consecutive_failures` counter on the check row (atomic UPDATE).
   - counter reaches `failure_threshold` and no open incident → INSERT incident,
     enqueue `alerts` job `check.down`.
   - success while an incident is open → resolve incident, enqueue `check.recovered`.
5. **Notify UI** — worker PUBLISHes `run.finished` on Redis pub/sub; the API's WS plugin
   forwards it to subscribed dashboard clients → cards update without polling.
6. **Alert dispatch** — API-side `alerter` consumes the `alerts` queue, renders payloads
   per channel type, POSTs with 3-attempt backoff, logs delivery in `alert_deliveries`.

On-demand actions ("run now", "screenshot now") enqueue a normal one-off job on the same
`checks` queue with priority 1 (scheduled runs are priority 5), so they jump the line.

## 4. Queues (BullMQ)

| Queue | Producer | Consumer | Payload |
|---|---|---|---|
| `checks` | API scheduler (repeatable + on-demand) | worker | `{ checkId, trigger: 'schedule'\|'manual'\|'screenshot' }` |
| `alerts` | worker (incident transitions) | API alerter | `{ incidentId, event: 'down'\|'recovered' }` |
| `maintenance` | API (daily repeatable) | API | `{ task: 'retention' }` |

Worker concurrency: `WORKER_CONCURRENCY` (default 4) jobs in parallel, each in its own
browser **context** (one shared Chromium instance per worker process, contexts are cheap
and isolated). Job options: `attempts: 2`, `backoff: 30s`, `removeOnComplete/Fail: true`
(results live in Postgres, not Redis).

## 5. Check executors (worker)

### 5.1 Uptime executor
- `context.newPage()` → `page.goto(url, { waitUntil: 'load', timeout })`.
- Collect: response status, `performance.timing`-derived TTFB / DCL / load, total ms.
- Assertions from check config: expected status, `page.locator(sel)` visible, body contains text.
- Screenshot per config (`always` / `on_failure` / `never`), full-page PNG →
  `/artifacts/<appId>/<runId>/screenshot.png`.

### 5.2 Journey executor (user-supplied code)
The stored spec is the *body* of a journey function. The harness wraps it:

```ts
// what the user writes/records (codegen output body):
await page.goto('https://shop.example.com');
await page.getByRole('link', { name: 'Sign in' }).click();
await page.getByLabel('Email').fill('demo@example.com');
...
await expect(page.getByText('Welcome')).toBeVisible();
```

Execution: the worker **spawns a separate Node child process** (`sandbox/spawn.ts`) that:
1. Writes the spec into a temp runner file that imports `{ chromium, expect }`,
   opens a context with tracing on, and evals the body with `page`/`expect`/`context` in scope.
2. Enforces: hard kill at `timeout_ms`, max 10 MB stdout, no access to platform env vars
   (clean `env`), runs as the container's non-root `pwuser`.
3. Reports result as a single JSON line on stdout; on failure saves failure screenshot +
   `trace.zip` to the artifacts dir.

Rationale: child process isolates crashes/hangs/globals from the worker loop; the
container boundary is the security boundary (see §7).

## 6. Availability computation

- `runs` has a composite index `(check_id, started_at desc)`.
- Availability % = successful runs / total runs over the window, computed by SQL on demand
  for detail pages, and **cached in Redis for 60 s** for the overview grid
  (key `avail:<checkId>:<window>`).
- If volume ever demands it, switch to an hourly rollup table `run_stats_hourly` —
  schema reserved in 03-data-model but **not built in v1**.

## 7. Security model

- **Threat: journey specs are arbitrary code.** Accepted by design (that's the feature).
  Containment: only `editor`/`admin` roles can write specs; specs execute exclusively in
  the worker container — non-root, `no-new-privileges`, only mounts the artifacts volume,
  no Docker socket, no platform secrets in the child process env. The worker's DB
  credentials live in the worker *parent* process only. A malicious spec can burn CPU or
  make network calls — same power as any monitoring agent — but cannot touch the host or
  the platform DB.
- **Auth**: argon2id password hashes; JWT access (15 min) + refresh (7 d, rotated,
  httpOnly cookie); role check middleware on every mutating route.
- **App credentials** (basic auth/headers for protected targets): AES-256-GCM encrypted
  with `ENCRYPTION_KEY` env; decrypted only in the worker at run time.
- **Artifacts**: served by the API behind auth (`GET /api/v1/runs/:id/artifacts/:name`),
  never as a public static dir.
- **Network**: only `dashboard` publishes a host port. api/postgres/redis are reachable
  solely on the internal compose network.
- **Viewer role** (three-tier RBAC: `admin` > `editor` > `viewer`): a `viewer` is
  granted read + run-now/screenshot-now access to a specific subset of
  applications via `user_app_access` (admin-managed, `PUT /users/:id/apps`) —
  never a blanket capability. Every read route that returns app/check/run/
  incident data is scoped to that set at the query level (`lib/access.ts`),
  not filtered client-side; the two allowed write-shaped actions (run an
  existing check, capture a screenshot) check the same assignment before
  enqueueing. Real-time fan-out (`/ws`) and the aggregate `/stats` endpoint are
  scoped the same way, so a restricted viewer never learns even the *existence*
  of apps outside their assignment via a side channel. Editors are deliberately
  unaffected by this role — they retain the unrestricted access they had before
  it existed. The one deliberately asymmetric case: a viewer may create/manage
  their *own* alert-channel subscriptions (self-service notification routing)
  scoped to their assigned apps, while remaining unable to touch global
  admin-managed channels — see `docs/04-api-spec.md` Alert channels.

## 8. Key design decisions (and why)

| Decision | Why |
|---|---|
| TypeScript everywhere | Playwright is Node-native; workload is I/O-bound; one language, shared types |
| BullMQ repeatables as the scheduler | Battle-tested, per-job intervals, dedup by jobId, survives restarts, no cron service to build |
| Postgres as single source of truth, Redis rebuildable | `reconcileSchedules()` means Redis can be flushed with zero data loss |
| Fastify + Zod | Fastest mainstream Node framework; Zod schemas shared with the SPA |
| Drizzle ORM | Thin, SQL-first, fast, painless migrations (`drizzle-kit`) |
| One Chromium per worker, context per run | Contexts start in ~10 ms vs ~500 ms per browser; full isolation between runs |
| Artifacts on a shared volume, not in DB | Screenshots/traces are MBs; DB stores only paths; retention job deletes files + rows together |
| WebSocket push for the grid | 200 apps polling every 5 s would be silly; Redis pub/sub → WS fan-out is trivial |
| nginx in front | Static SPA serving, gzip, single origin (no CORS), one exposed port |
