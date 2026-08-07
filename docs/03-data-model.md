# 03 — Data model (PostgreSQL 16, Drizzle ORM)

All IDs are `uuid` (default `gen_random_uuid()`), all timestamps `timestamptz` with
`created_at`/`updated_at` defaults. Drizzle schema lives in
`apps/api/src/db/schema.ts` (imported read-only by the worker via `packages/shared` re-export).

## users
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| email | text UNIQUE NOT NULL | lowercase |
| password_hash | text NOT NULL | argon2id |
| role | enum `admin` \| `editor` \| `viewer` | |
| refresh_token_hash | text NULL | rotated on refresh |
| created_at / updated_at | timestamptz | |

## user_app_access
| column | type | notes |
|---|---|---|
| user_id | uuid FK → users ON DELETE CASCADE | |
| app_id | uuid FK → applications ON DELETE CASCADE | |

Composite PK `(user_id, app_id)`. Which applications a `viewer` user may see/act on —
irrelevant for `admin`/`editor` (already unrestricted). Managed by admins via
`PUT /users/:id/apps`. See `docs/02-architecture.md` §7 for the full viewer
permission model.

## applications
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| name | text NOT NULL | |
| landing_url | text NOT NULL | the URL monitored & screenshotted |
| tags | text[] DEFAULT '{}' | dashboard filtering |
| auth_config_enc | text NULL | AES-256-GCM blob: `{ basicAuth?, headers? }` |
| enabled | boolean DEFAULT true | disabling pauses all checks |
| created_at / updated_at | timestamptz | |

## checks
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| app_id | uuid FK → applications ON DELETE CASCADE | |
| type | enum `uptime` \| `journey` | |
| name | text NOT NULL | |
| interval_minutes | int NOT NULL CHECK >= 1 | the “every X minutes” |
| timeout_ms | int DEFAULT 30000 | hard kill |
| failure_threshold | int DEFAULT 2 | consecutive failures → incident |
| enabled | boolean DEFAULT true | |
| config | jsonb NOT NULL | uptime is itself a `mode`-discriminated shape — `http`: `{ mode: 'http', expectedStatus, selector?, bodyText?, title?, screenshot: 'always'\|'on_change'\|'on_failure'\|'never', screenshotRefreshMinutes? }`; `port`: `{ mode: 'port', host, port, protocol: 'tcp'\|'udp', family: 'auto'\|'4'\|'6', tls, allowInsecureCert, certExpiryWarningDays }` — journey: `{ specSource: string }`. Rows predating the http/port split omit `mode`; the schema stamps `mode: 'http'` on read (see `packages/shared/src/schemas/checks.ts`), no migration needed. |
| consecutive_failures | int DEFAULT 0 | incident state machine counter |
| last_status | enum `passed`\|`failed`\|`error`\|`timeout` NULL | denormalized for the grid |
| last_run_at | timestamptz NULL | denormalized |
| sort_order | int DEFAULT 0 | user-controlled tab / "run all" order — see `PUT /apps/:id/checks/order` |
| last_screenshot_at | timestamptz NULL | when a screenshot was last stored — drives `screenshotRefreshMinutes`. A column rather than a `MAX()` over runs, so the cadence stays one indexed read on the hot path. |
| created_at / updated_at | timestamptz | |

Index: `(app_id)`. Every application gets a default `uptime` check on creation.

**Screenshot retention**: every screenshot a run takes is kept, paired 1:1 with its
run. How often one is taken is controlled entirely on the way in — the check's
`screenshot` mode plus `screenshotRefreshMinutes` — and nothing removes a stored
screenshot afterwards except age-based retention (`retention.screenshots_days`,
see `apps/api/src/services/retention.ts`).

Migration `0006` dropped `current_screenshot_run_id`/`current_screenshot_path`. They
supported an earlier scheme where a run whose pass/fail outcome matched the previous
run superseded that streak's screenshot — deleting the file and nulling the older
run's `screenshot_path` — to avoid near-identical images piling up. It cost history
the operator wanted, so screenshots accumulate now; tune `screenshots_days` or the
capture policy if the artifacts volume grows faster than you want.

## runs
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| check_id | uuid FK → checks ON DELETE CASCADE | |
| status | enum `passed` \| `failed` \| `error` \| `timeout` | `failed`=assertion, `error`=infra/navigation |
| trigger | enum `schedule` \| `manual` \| `screenshot` | |
| started_at | timestamptz NOT NULL | |
| duration_ms | int NOT NULL | |
| metrics | jsonb NULL | `{ httpStatus, ttfbMs, dclMs, loadMs }` (uptime) / `{ steps }` (journey) |
| error_message | text NULL | truncated to 4 KB |
| screenshot_path | text NULL | relative to artifacts root |
| trace_path | text NULL | journey failures |
| worker_id | text NULL | hostname, debugging |

Indexes: `(check_id, started_at DESC)` — powers history and availability;
partial `(check_id) WHERE status <> 'passed'` — failure filtering.

## incidents
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| check_id | uuid FK → checks ON DELETE CASCADE | |
| opened_at | timestamptz NOT NULL | |
| resolved_at | timestamptz NULL | NULL = ongoing |
| opening_run_id | uuid FK → runs ON DELETE SET NULL | first failing run past threshold |
| resolving_run_id | uuid FK → runs ON DELETE SET NULL | |

Partial unique index `(check_id) WHERE resolved_at IS NULL` — max one open incident per check.

## alert_channels
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| name | text NOT NULL | |
| type | enum `slack` \| `discord` \| `webhook` | slack & discord differ only in payload shape |
| config | jsonb NOT NULL | `{ url, secret? }` — `secret` sent as `X-Vyzus-Signature` HMAC for `webhook` |
| enabled | boolean DEFAULT true | |
| all_apps | boolean DEFAULT true | true → receives alerts for every application |
| owner_id | uuid FK → users ON DELETE CASCADE, NULL | NULL = admin/editor-managed global channel (unchanged v1 behavior); non-null = a viewer's self-service channel, visible/manageable only by that viewer (and admins, for oversight) |

## app_alert_channels
Join table `(app_id, channel_id)` PK — used when `all_apps = false`.

## alert_deliveries
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| incident_id | uuid FK → incidents | |
| channel_id | uuid FK → alert_channels ON DELETE CASCADE | |
| event | enum `down` \| `recovered` | |
| status | enum `sent` \| `failed` | after retries exhausted |
| attempts | int | |
| response_code | int NULL | |
| created_at | timestamptz | |

## settings
Single-row key/value `(key text PK, value jsonb)` for runtime-tunable retention:
`retention.runs_days` (90), `retention.screenshots_days` (30), `retention.traces_days` (14).

## Reserved for v2 (do NOT build now)
`run_stats_hourly (check_id, hour, total, passed, avg_duration_ms)` — only if the
on-demand availability queries ever get slow (see 02-architecture §6).

## Derived values (never stored)
- **App status** — `UP` when everything that has run is passing; `DOWN` only when
  *every* liveness (`uptime`) check is failing; `DEGRADED` when some are failing and
  some are not, including when only a `journey` fails (a broken flow is not a dead
  site, so a journey can never produce `DOWN`); `PAUSED` when the app or all its
  checks are disabled; `UNKNOWN` before anything has run. See
  `apps/api/src/lib/queries.ts` `deriveAppStatus()`.
- **Availability %** = `count(status='passed') / count(*)` over the window from `runs`.
