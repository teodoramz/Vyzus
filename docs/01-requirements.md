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
    `certExpiryWarningDays` (0 = off, the default) fails the check while the site's TLS
    certificate is still valid but within that many days of expiring. Read from the
    navigation Chromium already performed (`response.securityDetails()`), so it costs no
    extra connection and reflects what the browser actually negotiated. Only meaningful
    for an `https://` landing URL. Previously this existed only on `port` checks, so the
    most common way to monitor a site said nothing about its certificate until browsers
    were already refusing it. Both executors now share one rule
    (`packages/shared/src/cert-expiry.ts`).
    `visualDiffPercent` (0 = off, the default) compares each screenshot with the previous
    stored one for the same check and fails when that percentage of pixels or more differ —
    catching defacement, broken CSS and blank-page deploys that still return HTTP 200 and
    satisfy every selector assertion. A percentage rather than a pixel count, so it means
    the same at any viewport. Requires a screenshot mode that captures on passing runs; the
    first capture has no baseline and always passes, as does a run whose baseline file
    retention has already removed. A size change counts as fully changed.
    `maxDurationMs` (0 = off, the default) fails a run that returned the expected status
    but took longer, so "up but badly degraded" stops being invisible. Measured from
    navigation through the last assertion and recorded as `responseMs` in run metrics —
    screenshot capture is excluded, being the platform's own overhead rather than the
    target's. A genuine assertion failure keeps its own error message.
    Every screenshot taken is kept and stays paired with its run — capture frequency is
    controlled by the policy above, never by discarding stored images afterwards
    (`docs/03-data-model.md`). The Screenshot button always captures regardless of policy.
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
- FR-1.4 **Login throttling**: `POST /auth/login` refuses further attempts with `429`
  and a `Retry-After` header once 8 failures accumulate inside 15 minutes. Two
  independent counters, either of which can lock: one per email address (one account
  ground down from many hosts) and one per client IP (one host spraying many
  accounts). Checked before the password is verified, so a locked-out caller costs no
  argon2 work. A correct password clears both counters. `POST /auth/setup` is not
  throttled — it is single-use and 409s afterwards, so throttling it would only offer
  a way to lock a fresh install out of its own first login.
- FR-5.3a **Still-down reminders**: `alerts.renotify_minutes` (Settings, 0 = off, the
  default) re-announces an incident that is still open on that cadence until it
  resolves. A single message into a busy channel at 02:00 is an outage nobody sees.
  - Measured from the *last notification*, not from `opened_at`, so enabling the
    cadence does not fire a burst of catch-up reminders for long-running incidents.
  - Reminders go through the same `alerts` queue as the original, so an active
    maintenance window suppresses them identically — planned work does not stay
    silent for one message and then start paging.
  - `incidents.last_notified_at` is stamped *before* publishing: a crash between the
    two skips one reminder, which is much better than a crash loop re-announcing the
    same incident on every restart.
- FR-5.5 **Dependency suppression**: an application may declare a `parentAppId` — the
  gateway, router or host it sits behind. While any ancestor is `DOWN`, this
  application's `down` alerts are suppressed.
  - One dead upstream should page once, not once per service behind it. Forty alerts
    describing a single fault is how people learn to ignore the channel.
  - Walks the whole chain, not just the immediate parent: a dead host makes a service
    two levels below it just as much collateral.
  - `DEGRADED` deliberately does **not** suppress — a partly-working upstream can still
    leave a specific downstream genuinely broken, and hiding that behind an unrelated
    fault is worse than an extra alert.
  - **Recoveries are never suppressed.** Having been told the upstream failed, you want
    to hear this service came back; a silent recovery leaves the incident looking open.
  - Cycles are rejected on write (`PARENT_CYCLE`); the traversal also terminates on one
    defensively, since bad data must not hang the alerter.
- FR-6.4 **Public status page**: `GET /api/v1/status`, unauthenticated, plus a `/status`
  route in the dashboard rendered outside the auth guard.
  - Applications opt **in** via `is_public` (default false). A status page that opts
    applications in by accident is a data leak, not a cosmetic bug.
  - Exposes application name, derived status, and 24h/30d availability; incidents are
    reduced to application name and timing.
  - Deliberately **not** exposed: landing URLs (often internal), check names and types
    (they describe internal topology), and run error messages (they routinely carry
    internal hostnames, stack traces and query strings). The payload has its own schema
    rather than being a subset of the authenticated views, so adding a field elsewhere
    cannot leak it here by accident.
  - Does not consult `lib/access.ts`: that layer answers "what may this *user* see", and
    there is no user. Passing it a null user would be the kind of shortcut that becomes
    a leak the first time its defaults change.
  - Cached 30s and rate-limited to 60 requests per minute per client IP. It is the only
    unauthenticated endpoint that queries the database, and it runs five queries per
    request; uncached, it is a free amplification primitive. Status is derived from check
    results that change on check intervals, so the cache costs no useful freshness.
- FR-5.4 **Maintenance windows**: a scheduled window suppresses alert *delivery* for one
  application, or platform-wide (admin only), between `startsAt` and `endsAt` (half-open,
  so adjacent windows leave no unsuppressed instant).
  - Suppression never stops execution. Checks keep running, runs are recorded, and
    incidents still open and close — so the history stays complete, and the dead-man's
    switch (FR-2.4), which watches for runs *stopping*, is unaffected. A window that
    paused execution would trip it.
  - Platform alerts (`monitoring.stalled`) are never suppressed: "the monitoring itself
    stopped" is exactly what you still want to hear during a deploy.
  - The dashboard banners an active window, so a silenced platform is never mistaken
    for a healthy one.
- FR-2.4 **Dead-man's switch**: if no check completes anywhere on the platform within
  `heartbeat.stall_minutes` (Settings, default 15, 0 disables), Vyzus raises a
  platform-level `monitoring.stalled` alert to every all-apps channel and banners the
  dashboard. A `monitoring.resumed` alert follows when runs return. Each transition
  alerts exactly once.
  - This is the failure no per-check alert can express: a dead worker fires no checks,
    so nothing fails, no incident opens, and the last known status is served forever —
    silence is indistinguishable from health.
  - The threshold is raised automatically to twice the shortest enabled check interval
    when that is longer, so a deployment whose only check runs hourly does not alert
    every 15 minutes.
  - Silence is not a fault when there is nothing to run: an app or check that is
    disabled, or a threshold of 0, never triggers it.
  - The switch runs in the API process, not the worker — a switch hosted by the
    process it watches dies with it.
- FR-1.5 **Session login**: an application may carry a form-based login (URL, field
  selectors, credentials, optional signed-in proof selector) inside `authConfig`, which
  is already encrypted at rest as `applications.auth_config_enc` (AES-256-GCM).
  - The worker drives the real form in the same browser context before the check runs,
    so the session cookie it establishes carries into the check — no storage state is
    serialised and nothing secret is written to disk.
  - Without it, any target behind a normal login renders as the login page to the
    checker and the screenshot captures nothing useful.
  - A failed login ends the run with its own message rather than falling through to
    fail the check's assertions against the login page, which would report something
    misleading. Credentials never appear in error messages or metrics.
  - The login is given at most half the check timeout, so a hanging login cannot
    consume the whole budget.
- FR-1.6 **Default checks**: a newly enrolled application is created with a starter set
  derived from its landing URL, so it is meaningfully monitored without anyone opening
  the check editor:
  - **Landing uptime** (`http`) — always, at the chosen interval.
  - **DNS resolves** (`dns`, A record) — unless the host is an IP literal, where there is
    nothing to resolve. Every 15 minutes: records rarely move.
  - **TLS certificate** (`port` + `tls`, 14-day expiry warning) — `https://` targets only,
    against the URL's own port. Hourly: an expiry date does not change minute to minute.
  - **No ping check.** ICMP is blocked by most CDNs and many cloud providers, so a
    default ping would report a healthy site as unreachable — and since `ping` is a
    liveness mode it would drag the application badge down on the day it was added. The
    guiding rule for every default is that it must *pass* on day one for a healthy
    target; one that cries wolf immediately teaches people to ignore the badge.
  - Each starter check gets its own schedule, and its own cadence.
  - `createDefaultChecks: false` on `POST /apps` suppresses the set. `sync-targets` sends
    it, because the target files own that application's checks and `--prune` would
    otherwise delete the starter set on the next run.
  - The default TLS check does **not** enforce chain trust (`allowInsecureCert: true`),
    so a deliberately self-signed internal service passes. That costs no coverage: the
    landing uptime check loads the site in Chromium, which refuses an untrusted
    certificate outright, so a broken chain on a public site already fails there. The
    expiry warning is unaffected by the flag — a self-signed certificate expires like any
    other, and catching that is the point of the check. Turn the flag off per-check to
    enforce the chain as well.
- FR-2.2b **Uptime check, `ping` mode**: ICMP echo. Answers "is this host reachable at
  all", which a TCP port probe cannot — a machine with every port closed is still up, and
  a router or appliance may expose no port worth probing.
  - Uses unprivileged ICMP (`SOCK_DGRAM` via iputils), permitted by Docker's default
    `net.ipv4.ping_group_range`, so the worker needs **no `CAP_NET_RAW`** and still runs
    as non-root `pwuser`.
  - A host answering nothing always fails. `maxPacketLossPercent` and `maxRttMs`
    (both 0 = off) are opt-in on top of that, for a link that is degraded rather than down.
- FR-2.2c **Uptime check, `dns` mode**: resolve a name and optionally assert the answer.
  Catches the failure where the service is fine but nobody can find it — an expired
  domain, a botched record change, a stale secondary, a hijacked zone. None of those show
  up in an HTTP check run from a machine whose resolver still has the old answer cached.
  - `recordType` covers A, AAAA, CNAME, MX, TXT, NS. `resolver` queries a specific
    nameserver rather than the system one, which is how a stale secondary is caught.
  - `expectedValues` matches as a substring, because an MX answer carries a priority and
    a TXT value is often a long policy string — requiring the whole thing verbatim would
    make the assertion unusable in exactly the cases people want it. Empty means any
    successful resolution passes.
  - A lookup failure (NXDOMAIN, timeout) is `failed`, not `error`: it is the answer, not
    an infrastructure fault of ours.
- FR-2.5 **Push (heartbeat) check**: the monitored job reports in, rather than Vyzus
  reaching out. Covers everything unreachable *from* the monitor — cron jobs, backup
  scripts, batch imports, hosts behind NAT.
  - `GET`/`POST /api/v1/push/:token` records the ping. Necessarily unauthenticated:
    the point is that a shell script can `curl` it with no credential plumbing. The
    token (32 bytes of CSPRNG output) is the credential, scoped to one check, revoked
    by regenerating it. Unknown tokens 404 without revealing whether they ever existed.
  - Health is decided by the check's own scheduled run, not by the endpoint: the run
    asks "has a ping arrived within interval + `graceMinutes`?". Modelling it as an
    ordinary run is why incidents, alerts, availability, run history and the WS feed
    need no special case for this type.
  - `graceMinutes` exists because a job on a 5-minute cron never lands exactly on the
    mark; without slack every such check would flap.
  - A check that has never been pinged measures from its creation, so a new check does
    not fail before its job has had a chance to run once.
  - Failing `push` checks **degrade** an application, never mark it `DOWN`: a stalled
    background job does not mean the site is unreachable.
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
- FR-5.1 Alert channels: **email (SMTP)**, **Slack/Discord incoming webhook**, and **generic
  webhook** (POST JSON). Channels are defined globally and attached to applications (default: all).
  - Config is validated against the channel's `type` at the request body, which is where the
    discriminant lives. `alert_channels.config` itself carries no discriminant and is never
    re-parsed on read, so adding `email` needed no data migration for existing rows.
  - Email sends both a plain-text and an HTML part, renders the platform
    `monitoring.stalled`/`resumed` alerts as well as check alerts, and escapes
    operator-supplied text (application and check names) before it reaches HTML.
  - The SMTP password is redacted from every response as `hasPassword`, kept separate from
    `hasSecret` (the webhook HMAC signing secret) because they are different claims.
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
  - Secrets encrypted at rest (AES-256-GCM, key from env): app credentials and headers,
    plus alert-channel signing secrets and SMTP passwords. None of it is ever returned
    by the API — responses carry boolean presence flags instead.
  - JWT secrets, DB password etc. only via env; nothing baked into images.
- **NFR-5 Observability**: structured JSON logs (pino) everywhere; `/health` endpoints on api and worker; queue depth and run stats exposed at `/api/v1/stats`.
- **NFR-6 Portability**: everything runs from `docker compose up` on any Linux host; no cloud dependencies.

## 3. Scope boundaries

Deferred past v1 and since delivered: public status page, SSL-expiry checks,
maintenance windows, email alerts. Still out of scope: multi-region probes, Telegram
and other integrations, SSO. See 06-implementation-plan §Backlog.
