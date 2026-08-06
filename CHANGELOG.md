# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.0.0] - 2026-08-06

First public release. Vyzus is a self-hosted synthetic monitoring and
user-simulation platform: it drives a real Chromium browser against your
applications on a schedule, tells you when they break, and keeps the evidence.

### Monitoring

- **Applications** with a landing URL, tags, an enabled flag, and optional
  per-application HTTP basic-auth credentials or custom headers (encrypted at
  rest with AES-256-GCM).
- **Uptime checks** in two modes, both of which drive an application's Up/Down
  status:
  - `http` — navigates to the URL in a real browser and asserts HTTP status, an
    optional CSS selector, optional body text, and optional page-title
    substring. Records TTFB, DOMContentLoaded, load-event, and total duration.
    Screenshots follow a configurable policy: every run, on failure and
    recovery (the default), on failure only, or never — optionally with a
    refresh cadence so a healthy check still updates its picture periodically.
  - `port` — a raw TCP or UDP reachability probe against any host and port, with
    an optional forced IPv4/IPv6 family. Common services (HTTP, HTTPS, SSH,
    SMTP/IMAP/POP3 and their TLS variants, DNS, PostgreSQL, MySQL, Redis,
    MongoDB, RDP, LDAP) are one-click presets.
  - Port checks over TCP can additionally perform a **TLS handshake and validate
    the certificate** — chain of trust, expiry, and hostname. An invalid
    certificate fails the check like a closed port; `allowInsecureCert` relaxes
    that to "handshake completed" for deliberately self-signed internal
    services, while still recording issuer, subject, expiry, and days-until-
    expiry on every run.
- **Journey checks** run a Playwright TypeScript snippet (recorded with
  `playwright codegen` or hand-written) to simulate a real user flow. Failures
  capture a point-of-failure screenshot and a full Playwright trace. A failing
  journey never marks the application itself as down — a broken login flow is
  not the same thing as a dead landing page.
- **Scheduling** per check, from one minute upward, with 0-15s jitter so checks
  do not stampede. Runs that exceed their timeout are killed and recorded as
  `timeout`.
- **Run now** and **on-demand screenshot** for any check, out of schedule.
- **Dry run** validates an unsaved check configuration and returns the result
  inline without persisting anything.
- **Applications and journey checks can be kept as files** under `targets/` and
  synced through the same REST API the dashboard uses (`pnpm sync-targets`,
  with `--dry-run` and `--prune`), for teams that would rather version-control
  their monitoring than click through a UI.
- Checks present a **normal browser fingerprint** — real User-Agent, viewport,
  locale, and timezone, with Chromium's automation flags suppressed — so
  monitored sites serve the real page rather than a bot challenge.

### Incidents and alerting

- An **incident** opens after a configurable number of consecutive failures and
  resolves on the first subsequent success, recording total downtime.
- **Alert channels**: Slack and Discord incoming webhooks, plus generic JSON
  webhooks signed with an HMAC-SHA256 signature header. Channels attach to all
  applications or to a specific subset.
- Deliveries are retried with exponential backoff and every attempt is logged
  with its response code.
- The dashboard shows incidents on a dedicated page, as a transient toast when
  one opens, and as an unread count on the header bell that clears once you have
  actually looked.

### Dashboard

- **Overview grid** with per-application status, 24-hour availability, last
  response time, a response-time sparkline, and the latest screenshot. Down
  applications sort first. Updates live over WebSocket, falling back to polling.
- **Application detail** with per-check availability over 24h/7d/30d, a
  response-time chart, filterable run history, a screenshot gallery, and an
  incident timeline. Checks can be reordered.
- **Run detail** with metrics, error output, screenshot, and a downloadable
  Playwright trace.
- **Check editor** with a form for uptime checks and a Monaco editor for journey
  specs.
- Strict light and dark themes, defaulting to light and remembering an explicit
  choice across pages. Monospace type for every metric, URL, and timestamp so
  they align in columns.

### Accounts and access control

- **First-boot setup screen** creates the initial administrator on a fresh
  install. There is no default account and no admin credentials in the
  environment; setup is gated on the users table being empty and is permanently
  closed once any user exists.
- Three roles: `admin` (everything, including users and channels), `editor`
  (applications and checks), and `viewer` (read and run only, scoped to
  explicitly assigned applications). Scoping is enforced in the database queries
  and on the WebSocket, not just in the UI.
- Email and password login with argon2id hashing, short-lived JWT access tokens,
  and rotating refresh tokens in an httpOnly cookie.

### Operations

- Runs entirely from `docker compose up` — API, worker, dashboard, Postgres, and
  Redis. Workers scale horizontally with `--scale worker=N`.
- Journey specs are untrusted code and execute only inside a separate child
  process in the worker container, with a clean environment (no platform
  secrets), a hard timeout, and output limits.
- Configurable retention for runs, screenshots, and traces, enforced by a daily
  cleanup job. Incidents are kept indefinitely as the SLA record.
- Consecutive same-outcome uptime runs collapse to a single stored screenshot
  instead of accumulating one near-identical file per run.
- Structured JSON logging, `/health` endpoints, and queue/run statistics at
  `/api/v1/stats`.

[Unreleased]: https://github.com/teodoramz/Vyzus/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/teodoramz/Vyzus/releases/tag/v1.0.0
