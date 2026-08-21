# 04 — API specification

Base path: `/api/v1`. All requests/responses JSON. All routes require a Bearer access
token except `POST /auth/login`, `POST /auth/refresh`, `GET /auth/setup-status`,
`POST /auth/setup`, `GET /health`.
Validation: every body/query/params has a Zod schema in `packages/shared/src/schemas/`
— the schema IS the contract; this document lists routes and semantics.

Errors: `{ error: { code: string, message: string } }` with proper HTTP status
(400 validation, 401 unauthenticated, 403 role, 404, 409 conflict).

## Auth
| Route | Semantics |
|---|---|
| `GET  /auth/setup-status` | unauthenticated → `{ needsSetup }` — true only while the users table is empty |
| `POST /auth/setup` | unauthenticated, first boot only. `{ email, password }` → 201 `{ accessToken, user }` + refresh cookie, creating the initial `admin`. Gated on an empty users table inside a transaction holding a `SHARE ROW EXCLUSIVE` lock, so concurrent submissions cannot both succeed; permanently 409 `SETUP_ALREADY_DONE` once any user exists. |
| `POST /auth/login` | `{ email, password }` → `{ accessToken, user }` + httpOnly refresh cookie |
| `POST /auth/refresh` | rotates refresh cookie → new `{ accessToken }` |
| `POST /auth/logout` | invalidates refresh token |
| `GET  /auth/me` | current user |

## Users (admin only)
`GET /users` · `POST /users` `{ email, password, role }` (role: `admin`\|`editor`\|`viewer`) ·
`PATCH /users/:id` (role/password) · `DELETE /users/:id`
`GET /users/:id/apps` → `{ appIds }` · `PUT /users/:id/apps` `{ appIds }` — which applications a
`viewer` user may see/act on (irrelevant for admin/editor, already unrestricted).

## Viewer role scoping

A `viewer` is restricted to applications an admin has granted via `PUT /users/:id/apps`
(`docs/02-architecture.md` §7). For every route below marked "viewer-scoped":
`GET` routes return/403 based on `user_app_access`; `POST /checks/:id/run` and
`POST /apps/:id/screenshot` are allowed on an assigned app (running an existing
check isn't "editing" it); every other mutating route (create/update/delete
apps/checks, dry-run) requires `editor`/`admin` regardless of assignment. Channels
are the one exception with bespoke rules — see that section.

## Applications
| Route | Semantics |
|---|---|
| `GET /apps` | list with embedded summary: `{ status, availability24h, lastRun, checksCount, latestScreenshotRunId }`. Query: `?tag=`, `?status=`. **Viewer-scoped**: filtered to assigned apps |
| `POST /apps` | create; also creates the default uptime check (interval from body, default 5) |
| `GET /apps/:id` | full detail incl. checks with `{ availability24h, availability7d, availability30d }`. **Viewer-scoped** |
| `PATCH /apps/:id` | partial update; `enabled:false` unschedules all checks |
| `DELETE /apps/:id` | cascade deletes checks/runs/incidents, removes schedules + artifact files |
| `POST /apps/:id/screenshot` | **on-demand screenshot** — enqueues priority job on the app's uptime check with `trigger:'screenshot'` → `202 { runId }`; result arrives via WS. **Viewer-scoped** (allowed if assigned) |
| `PUT /apps/:id/checks/order` | body `{ checkIds }` — must be exactly the app's current check ids, reordered; persists check-tab / "run all" order → `200` the reordered check list |
| `GET /apps/:id/runs` | run history merged across every check of the app — keyset pagination (`?cursor=`, `?limit=`) plus `?checkId=` and `?status=`; each row adds `checkName`/`checkType`. **Viewer-scoped** |

## Checks
| Route | Semantics |
|---|---|
| `GET /apps/:appId/checks` · `POST /apps/:appId/checks` | config validated per type (journey spec ≤ 64 KB). GET is **viewer-scoped**; new checks append after the app's current max `sortOrder` |
| `GET /checks/:id` · `PATCH /checks/:id` · `DELETE /checks/:id` | any change to interval/enabled re-syncs the BullMQ repeatable. GET is **viewer-scoped** |
| `POST /checks/:id/run` | run now → `202 { runId }`. **Viewer-scoped** (allowed if assigned) |
| `POST /checks/dry-run` | body = full check config (unsaved); runs once, `200` with the run result inline (no persistence). 30 s+timeout budget. Editor/admin only — never viewer |

## Runs
| Route | Semantics |
|---|---|
| `GET /checks/:id/runs` | paginated (`?cursor=`, `?limit=50`, `?status=`, `?hasScreenshot=`). **Viewer-scoped** |
| `GET /apps/:id/runs` | see Applications above |
| `GET /runs/:id` | full run detail. **Viewer-scoped** |
| `GET /runs/:id/artifacts/screenshot` | PNG stream (auth required). **Viewer-scoped** |
| `GET /runs/:id/artifacts/trace` | trace.zip download. **Viewer-scoped** |

## Incidents
`GET /incidents?open=&appId=&cursor=&limit=` → `{ incidents, nextCursor }`, keyset-paginated,
newest first — the global Incidents tab. **Viewer-scoped** (filtered to assigned apps
regardless of `?appId=`) · `GET /apps/:id/incidents` → plain array, capped at 200. **Viewer-scoped**

## Alert channels
`GET/POST /channels` · `PATCH/DELETE /channels/:id` · `POST /channels/:id/test` (sends a test message) ·
`GET /channels/:id/deliveries` — admin unrestricted (as in v1). A `viewer` may
additionally create/manage channels **they own** (self-service alert routing for
their assigned apps): `ownerId` is set to the viewer on create, `allApps:true` is
rejected for them, every `appId` must be one they're assigned to, and they can
never see or touch another user's channel (including admin-created global ones).
`editor` has no channel access at all, unchanged from before the viewer role existed.

Four channel types. Config is validated against `type` **in the request body**, which
is where the discriminant lives — `alert_channels.config` itself carries none and is
never re-parsed on read, so `email` was added with no migration for existing rows.

| type | config |
|---|---|
| `slack` / `discord` | `{ url }` |
| `webhook` | `{ url, secret? }` — `secret` enables `X-Vyzus-Signature` |
| `email` | `{ host, port, secure, username?, password?, from, to[] }` — SMTP |

`secret` and `password` are stored encrypted in `alert_channels.secrets_enc`, never in
`config`. On `PATCH`, omitting them keeps the stored value; changing `type` discards it.

Responses never return a credential: `url` is null for `email`, `hasSecret` reports a
webhook signing secret, `hasPassword` reports an SMTP password (deliberately separate —
they are different claims), and `target` is a display string for the channel list.

## Stats & ops
| Route | Semantics |
|---|---|
| `GET /stats` | `{ apps: { total, up, degraded, down, paused }, openIncidents, queueDepth, runsLast24h, monitoringStalledSince }` — header bar. **Viewer-scoped**: every count except `queueDepth` (a platform-wide operational number, not app data) is restricted to assigned apps. `monitoringStalledSince` is also platform-wide: a stalled platform is stalled for every viewer |
| `GET /health` | liveness (checks DB + Redis ping); unauthenticated |
| `GET /status` | public status page; unauthenticated. Cached 30s (`Cache-Control: public, max-age=30`) and limited to 60 req/min per client IP — it is the only anonymous endpoint that queries the database. Over the limit: `429` with `Retry-After` |
| `GET/PATCH /settings` | retention windows plus `heartbeatStallMinutes` (dead-man's switch) and `renotifyMinutes` (still-down reminders). Read by any authenticated user; PATCH is admin-only |

## API tokens
`GET /tokens` · `POST /tokens` · `DELETE /tokens/:id` — scoped to the caller's **own**
tokens; deliberately not admin-listable, since the stored hashes are useless and a
wider view only widens the blast radius.

A token acts as its owning user — same id, role and per-viewer application scoping — so
every rule in `lib/access.ts` applies unchanged rather than through a second permission
model that could drift. Presented as `Authorization: Bearer vyz_…`; the `vyz_` prefix is
what distinguishes it from a JWT, so neither credential kind costs the other a lookup.

The secret is returned **once**, by `POST /tokens`. Only a SHA-256 hash is stored —
appropriate here because the secret is 256 bits of CSPRNG output, so there is no
dictionary to attack and authentication needs an indexed lookup rather than a scan.

## Maintenance windows
`GET /maintenance` · `POST /maintenance` · `DELETE /maintenance/:id` · `GET /maintenance/active`

Suppresses alert **delivery** for planned work; never execution. Checks keep running and
incidents still open and close, so history stays complete and the dead-man's switch —
which watches for runs *stopping* — is unaffected. Platform `monitoring.stalled` alerts
are never suppressed.

Half-open `[startsAt, endsAt)`, so adjacent windows leave no unsuppressed instant.
`appId: null` is platform-wide and admin-only; a scoped window needs access to that app.
Reading is open to any authenticated user — a viewer needs to know why their application
stopped alerting.

## Heartbeat receipt (push checks)
`GET|POST /push/:token` — **unauthenticated by design.** The point is that a cron job or
backup script can report in with one `curl` and no credential plumbing; the token is the
credential, scoped to one check and revoked by regenerating it. GET is accepted because
`curl` defaults to it and a ping requiring `-X POST` is one people forget to send.

Records only that a ping arrived (`checks.last_ping_at`). Health is decided by the
check's own scheduled run, which asks whether a ping landed within
`intervalMinutes + graceMinutes` — which is why incidents, alerts, availability and the
run history need no special case for this type. An unknown token returns `404` without
revealing whether it ever existed.

## WebSocket — `/ws`
Auth on upgrade: the access token travels in `Sec-WebSocket-Protocol`, not the query
string, which nginx and any proxy in front of it would log. Offer two protocols and the
server negotiates the first, keeping the token out of the response headers too:

```js
new WebSocket('wss://host/ws', ['vyzus.v1', `vyzus.auth.${accessToken}`]);
```

The socket closes with `4401` on a missing or invalid token, and again when the token
expires — reconnect with a fresh one. Server → client events (JSON, fed by Redis pub/sub):

```ts
{ type: 'run.finished',      appId, checkId, runId, status, durationMs, hasScreenshot }
{ type: 'incident.opened',   appId, checkId, incidentId }
{ type: 'incident.resolved', appId, checkId, incidentId, downtimeSeconds }
{ type: 'stats.updated',     up, down, openIncidents }   // throttled to 1/s
```

**Viewer-scoped fan-out**: `run.finished`/`incident.*` are only sent to a `viewer`
socket if the event's `appId` is one they're assigned to (checked once at connect
time from `user_app_access` — an assignment change takes effect on reconnect, which
the token expiry above bounds to one access-token lifetime). `stats.updated` carries
platform-wide aggregates with no per-viewer equivalent, so it's simply never sent
to viewer sockets — the dashboard's `GET /stats` (already viewer-scoped) is what
drives their header regardless.

Client sends nothing except pings. Dashboard falls back to 30 s polling if WS drops.

## Alert webhook payloads (outbound)

Two variants. Every channel receives **both**, so a renderer that only understands check
alerts will throw on the platform one — which is the alert you most need delivered.

Generic `webhook` channel receives (with `X-Vyzus-Signature: hmac-sha256` when secret set):
```json
{
  "event": "check.down" | "check.recovered",
  "application": { "id": "...", "name": "Shop", "landingUrl": "https://..." },
  "check": { "id": "...", "name": "Landing uptime", "type": "uptime" },
  "incident": { "id": "...", "openedAt": "...", "resolvedAt": null, "downtimeSeconds": null },
  "run": { "id": "...", "status": "failed", "errorMessage": "...", "screenshotUrl": "https://<host>/api/v1/runs/<id>/artifacts/screenshot" },
  "timestamp": "2026-07-13T12:00:00Z"
}
```

The platform variant carries no application, check, incident or run — the whole point is
that nothing ran:

```json
{
  "event": "monitoring.stalled" | "monitoring.resumed",
  "monitoring": { "lastRunAt": "2026-08-08T09:00:00Z" | null, "silentForSeconds": 3600, "thresholdMinutes": 15 },
  "timestamp": "2026-08-08T10:00:00Z"
}
```

Sent to every enabled `all_apps` channel: those are the ones subscribed to the platform
rather than to one target. Never suppressed by a maintenance window.
`slack` / `discord` channels receive the same information rendered as Block Kit /
embed messages (red for down, green for recovered).
