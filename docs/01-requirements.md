# 01 — Requirements

## 1. Functional requirements

### FR-1 Application enrollment
- FR-1.1 CRUD for **applications**: name, landing-page URL, optional base URL, tags, enabled flag.
- FR-1.2 An application can be disabled: all its checks pause, history is kept.
- FR-1.3 Optional per-application HTTP basic-auth / custom headers for protected staging environments (stored encrypted).

### FR-2 Checks
- FR-2.1 Each application has one or more **checks** of type `uptime` or `journey`. `uptime` isn't
  web-only: it has two modes, `http` and `port`, both "is the thing itself reachable" checks that
  drive the app's Up/Down badge identically — they differ only in config shape and executor.
- FR-2.2 **Uptime check, `http` mode** (created automatically with every application, configurable):
  - Navigates to the landing URL with a real Chromium browser.
  - Asserts: HTTP status < 400 (configurable expected status), optional CSS selector present, optional body text present, optional page title contains, page loads within timeout.
  - Records metrics: HTTP status, TTFB, DOMContentLoaded, load event, total duration.
  - Takes a viewport-size screenshot per policy: `always` (every run), `on_change` (every failure
    plus the first success afterwards), `on_failure`, or `never`. `on_change`/`on_failure` may also
    set `screenshotRefreshMinutes` so a healthy check refreshes its picture on that cadence
    (default 60 for new checks) instead of showing whatever it looked like at the last incident.
    Consecutive same-outcome runs still collapse to one file (screenshot streak dedup,
    `docs/03-data-model.md`); the Screenshot button always captures regardless of policy.
- FR-2.2a **Uptime check, `port` mode**: a raw TCP/UDP reachability probe, no browser involved.
  - Target: a domain name or IPv4/IPv6 literal (`host`), a `port`, `protocol` (`tcp`/`udp`), and an
    optional forced `family` (`auto`/`4`/`6`).
  - TCP: connect succeeds -> `passed`; actively refused -> `failed`; no response within timeout ->
    `timeout`. A small set of common services (HTTP, HTTPS, SSH, mail ports, common databases, etc.)
    are offered as one-click presets in the dashboard that fill in port/protocol/TLS.
  - UDP has no handshake, so "up" is inherently fuzzier: a reply datagram or an explicit
    ICMP-unreachable error are the only unambiguous signals; silence within the timeout is reported
    as `passed` (matching how port scanners treat UDP as "open|filtered"), never as a false `failed`
    against a well-behaved but silent service.
  - Optional `tls: true` wraps the TCP connection in a TLS handshake and validates the peer
    certificate (chain trust, expiry, hostname) using the host's own trust store — an invalid cert
    fails the check exactly like a closed port. `allowInsecureCert: true` relaxes this to "handshake
    completed" only (for a deliberately self-signed internal service); certificate metrics (issuer,
    subject, expiry, trust) are still recorded either way.
  - `certExpiryWarningDays` (0 = off, the default) fails the check while the certificate is still
    valid but within that many days of expiring, so the renewal has a window to happen in — an
    already-expired certificate is too late to be actionable. Applies regardless of
    `allowInsecureCert`: a self-signed certificate expires like any other.
  - Both `uptime` modes drive the application's status badge. `DOWN` requires *every*
    liveness check to be failing; a single failing check among several is `DEGRADED`.
    A failing `journey` can degrade an application but never marks it `DOWN`.
- FR-2.3 **Journey check**:
  - The test body is a Playwright TypeScript snippet uploaded or pasted/edited in the dashboard (Monaco editor). Users record it locally with `npx playwright codegen <url>`.
  - The platform wraps the snippet in its own runner harness (see 02-architecture §5.2); the snippet exports steps using the standard `page` API.
  - On failure: screenshot at point of failure + Playwright trace saved as artifacts.
- FR-2.4 Every check has: interval (minutes, min 1), timeout (ms), failure threshold (N consecutive failures before an incident opens, default 2), enabled flag.
- FR-2.5 "Run now" button executes any check immediately, out of schedule.
- FR-2.6 Checks can be validated ("dry run") before saving: run once, show the result, don't persist a scheduled job.

### FR-3 Scheduling
- FR-3.1 Each enabled check runs automatically every `interval` minutes (BullMQ repeatable job).
- FR-3.2 A random jitter (0–15 s) is applied so checks don't stampede at the same second.
- FR-3.3 A run that exceeds its timeout is killed and recorded as status `timeout`.
- FR-3.4 Missed schedules (worker down) are not back-filled; the next tick just runs.

### FR-4 Dashboard
- FR-4.1 **Overview grid**: one card per application — current status (UP / DEGRADED / DOWN / PAUSED / UNKNOWN), availability % for 24 h, last response time, sparkline, latest screenshot thumbnail. Auto-refreshes via WebSocket.
- FR-4.2 **Application detail page**: per-check status, availability 24 h / 7 d / 30 d, response-time chart, run history table (filterable by status), screenshot gallery, incident timeline.
- FR-4.3 **Run detail**: metrics, error message, screenshot, downloadable Playwright trace.
- FR-4.4 **On-demand screenshot**: button on app card and detail page → enqueues an immediate screenshot job → result appears live.
- FR-4.5 **Check editor**: Monaco editor with TypeScript syntax highlighting for journey specs; form editor for uptime checks.
- FR-4.6 Global header: totals (apps up/down), active incidents banner.

### FR-5 Alerting
- FR-5.1 Alert channels: **Slack/Discord incoming webhook** and **generic webhook** (POST JSON). Channels are defined globally and attached to applications (default: all).
- FR-5.2 An **incident** opens when a check fails `failure_threshold` times consecutively → `check.down` alert fires. It resolves on the first subsequent success → `check.recovered` alert fires (with downtime duration).
- FR-5.3 Alert payload includes: app name, check name, status, error, run URL, screenshot URL, timestamp.
- FR-5.4 Alert deliveries are retried (3 attempts, exponential backoff) and logged.

### FR-6 Users & auth
- FR-6.1 Login with email + password (JWT access + refresh tokens). Passwords hashed with argon2id.
- FR-6.2 Roles: `admin` (manage users, channels, everything) and `editor` (manage apps/checks, view all).
- FR-6.3 On a fresh install (no users), the dashboard serves a first-boot setup
  screen that creates the initial `admin`. There is no environment-seeded admin
  and no built-in default account, so an unconfigured instance has no
  credentials to guess.

### FR-7 Data retention
- FR-7.1 Configurable retention: runs (default 90 days), screenshots (default 30 days), traces (default 14 days). A daily cleanup job enforces it.
- FR-7.2 Incidents are kept indefinitely (they are small and are the SLA record).

## 2. Non-functional requirements

- **NFR-1 Performance**: dashboard API reads < 100 ms p95 (pre-aggregated availability); a worker executes checks concurrently (default 4 browser contexts per worker); UI initial load < 2 s.
- **NFR-2 Scale target**: 200 applications × ~2 checks at 5-min intervals ≈ 80 check-runs/min — comfortably one worker; workers scale horizontally with `docker compose up --scale worker=N`.
- **NFR-3 Reliability**: worker crash mid-run → BullMQ marks the job stalled and it is retried once; API and worker restart automatically (`restart: unless-stopped`).
- **NFR-4 Security**:
  - Journey specs are **arbitrary code** — they execute only inside the worker container (no privileges, no host mounts other than the artifacts volume, non-root user) in a separate child process per run, with hard timeout and output limits. Only authenticated `editor`/`admin` users can create specs. See 02-architecture §7.
  - Secrets (app credentials/headers) encrypted at rest (AES-256-GCM, key from env).
  - JWT secrets, DB password etc. only via env; nothing baked into images.
- **NFR-5 Observability**: structured JSON logs (pino) everywhere; `/health` endpoints on api and worker; queue depth and run stats exposed at `/api/v1/stats`.
- **NFR-6 Portability**: everything runs from `docker compose up` on any Linux host; no cloud dependencies.

## 3. Explicitly out of scope (v1)

- Multi-region probes, public status page, SSL-expiry checks, maintenance windows,
  email/Telegram alerts, SSO — all listed in 06-implementation-plan §Backlog as v2 candidates.
