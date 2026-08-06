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

## Stats & ops
| Route | Semantics |
|---|---|
| `GET /stats` | `{ apps: { total, up, down, paused }, openIncidents, queueDepth, runsLast24h }` — header bar. **Viewer-scoped**: every count except `queueDepth` (a platform-wide operational number, not app data) is restricted to assigned apps |
| `GET /health` | liveness (checks DB + Redis ping); unauthenticated |

## WebSocket — `/ws`
Auth: `?token=<accessToken>` on upgrade. Server → client events (JSON, fed by Redis pub/sub):

```ts
{ type: 'run.finished',      appId, checkId, runId, status, durationMs, hasScreenshot }
{ type: 'incident.opened',   appId, checkId, incidentId }
{ type: 'incident.resolved', appId, checkId, incidentId, downtimeSeconds }
{ type: 'stats.updated',     up, down, openIncidents }   // throttled to 1/s
```

**Viewer-scoped fan-out**: `run.finished`/`incident.*` are only sent to a `viewer`
socket if the event's `appId` is one they're assigned to (checked once at connect
time from `user_app_access` — an assignment change takes effect on reconnect, same
as any other JWT-claims-derived permission here). `stats.updated` carries
platform-wide aggregates with no per-viewer equivalent, so it's simply never sent
to viewer sockets — the dashboard's `GET /stats` (already viewer-scoped) is what
drives their header regardless.

Client sends nothing except pings. Dashboard falls back to 30 s polling if WS drops.

## Alert webhook payloads (outbound)

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
`slack` / `discord` channels receive the same information rendered as Block Kit /
embed messages (red for down, green for recovered).
