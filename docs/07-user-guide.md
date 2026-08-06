# 07 — User guide

This is the day-to-day operator's guide: how to add targets, write checks, read the
dashboard, and — if you'd rather manage targets as files than clicks — how to
automate provisioning. For system design see `docs/02-architecture.md`; for the API
contract see `docs/04-api-spec.md`.

## 1. Adding an application

Dashboard: **Overview → "+ New application"** — name and landing URL are required;
tags are optional and used for filtering the grid. A default **uptime check** (5 min
interval, expects HTTP 200) is created automatically — you can edit or delete it
afterward like any other check.

API equivalent: `POST /apps` (see §5 for scripting this).

## 2. Uptime checks

An uptime check loads the landing page in a real browser and asserts on it. Fields:

| Field | Meaning |
|---|---|
| Expected HTTP status | defaults to 200 |
| CSS selector present (optional) | fails if `page.locator(selector)` isn't visible |
| Text present on page (optional) | fails if `document.body.innerText` doesn't contain it |
| Screenshot | `always`, `on_failure` (default), or `never` |

It also records timing metrics (TTFB, DOM-content-loaded, full load) shown on the
app's response-time chart.

## 3. Journey checks (user-simulation tests)

A journey check is a short Playwright script that simulates a real user flow —
login, search, add-to-cart, whatever you need to verify actually works, not just
that the server responds.

### 3.1 What to write

Paste **bare steps only** — no `import`, no `export`, no wrapping function:

```ts
await page.goto('https://example.com');
await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible();
await page.getByRole('link', { name: 'Learn more' }).click();
await expect(page).toHaveURL(/iana\.org/);
```

`page`, `context`, and `expect` are already in scope — the worker wraps whatever
you write in its own function before running it
(`docs/02-architecture.md` §5.2):

```ts
export default async ({ page, context, expect }) => {
  <your steps go here>
};
```

**Do not paste a full `export default async function ...` wrapper of your own** —
it'll be nested inside the one above and fail to parse. This is exactly the mistake
the editor's own placeholder used to demonstrate before it was fixed; if you're
looking at an old screenshot or cached page showing a `function run(page) {...}`
example, ignore it.

### 3.2 Recording one

```bash
npx playwright codegen https://your-site.com
```

This opens a real browser. Click through the flow you want simulated; codegen prints
the corresponding Playwright actions live. Copy just the action lines into the
check editor — strip the `import { test, expect } from '@playwright/test';`,
`test('...', async ({ page }) => { ... })` wrapper codegen adds; keep only what was
inside the `{ }`.

### 3.3 Dry run

Every check editor has a **Dry run** button: executes the spec once immediately
against the real target and shows pass/fail/error inline, without saving or
scheduling anything. Use it to iterate — it's much faster than save → wait for the
next scheduled run → check the result.

### 3.4 What happens on save

The check runs on its configured interval like any uptime check. Each run executes
in an isolated child process — a crash, hang, or `while(true){}` in your spec can't
take down the worker; it's hard-killed at the check's timeout and recorded as
`timeout` (`docs/02-architecture.md` §7). A failure captures a screenshot at the
point of failure plus a full Playwright trace, downloadable from the run's detail
page — open it with `npx playwright show-trace <file>` for a step-by-step replay.

### 3.5 Limits and common errors

- 64 KB max spec size (shown as a live counter under the editor).
- `String must contain at least 1 character(s)` on dry-run/save means the spec
  field is empty — type or paste something before running.
- Browser context uses a realistic desktop Chrome fingerprint, not Chromium's bare
  headless defaults, so checks aren't trivially flagged as bots by the sites they
  monitor.
- Some low-numbered ports (e.g. 9) are on Chromium's built-in "unsafe ports" list
  and are blocked before any connection is attempted (`net::ERR_UNSAFE_PORT`) —
  this is a browser security restriction, not an application bug; avoid picking
  those ports for real targets.

## 4. Reading the dashboard

- **Overview grid**: one card per app — live status (green Up / red Down / gray
  Paused / amber Unknown), 24h availability, last response time, a sparkline, and
  the latest screenshot thumbnail. Updates live over WebSocket; falls back to
  polling if the connection drops.
- **App detail**: availability over 24h/7d/30d, a response-time chart, full run
  history (filterable by status), a screenshot gallery, and the incident timeline.
- **On-demand screenshot**: the "Screenshot now" button on any app forces an
  immediate capture regardless of the check's normal screenshot policy.
- **Incidents**: open automatically after a check's configured number of
  consecutive failures (default 2), and resolve automatically on the next success.
  A banner at the top of the dashboard lists open incidents.
- **Channels**: Slack, Discord, or a generic signed webhook — configured under
  **Channels**, attached to specific apps or all of them, with a "Send test" button.

## 5. Automating target & test provisioning

Yes — everything above is also a thin layer over the REST API
(`docs/04-api-spec.md`), so you can manage targets and journey tests as files and
sync them programmatically instead of clicking through the UI.

### 5.1 File convention + sync script

`targets/` at the repo root holds one directory per application; `scripts/sync-targets.mjs`
reads it and upserts apps/checks via the API. Full reference: `targets/README.md`.
Quick shape:

```
targets/
  example-landing/
    app.json                     # { name, landingUrl, tags, intervalMinutes }
    checks/
      example-journey.journey.ts # bare Playwright steps, see §3.1
      landing.uptime.json        # optional: customize the default uptime check
```

Run it:

```bash
VYZUS_API_URL=http://localhost:8080/api/v1 \
VYZUS_EMAIL=admin@example.com VYZUS_PASSWORD=password123 \
node scripts/sync-targets.mjs           # add --dry-run to preview, --prune to delete
                                         # checks with no matching file
```

It's idempotent (matches by name, only sends real diffs) and safe to run from cron,
a CI pipeline, or a pre-deploy hook — put your targets under version control and
this becomes "infrastructure as code" for your monitoring fleet. Applications are
never deleted by the script, even with `--prune` (only checks are).

### 5.2 Or drive the API directly

If the file convention doesn't fit your workflow, the script is just ~250 lines
calling four endpoints — read it as a working example and call the API however
suits you (a CI step, a Terraform-style provider, a one-off curl script):

```bash
TOKEN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"'"$EMAIL"'","password":"'"$PASSWORD"'"}' | jq -r .accessToken)

curl -s -X POST "$API/apps" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"My app","landingUrl":"https://my-app.example.com","tags":["prod"]}'

curl -s -X POST "$API/apps/$APP_ID/checks" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"journey","name":"Login flow","intervalMinutes":5,"timeoutMs":30000,"failureThreshold":2,"enabled":true,"config":{"specSource":"await page.goto(...);"}}'
```

Full request/response shapes are Zod schemas in `packages/shared/src/schemas/` —
the same ones the dashboard and API validate against, so there's no separate
"automation API" to learn; it's the exact contract the UI itself uses.

### 5.3 What isn't built (yet)

The platform doesn't watch a git repo and auto-sync on push — `sync-targets.mjs` (or
your own script against the API) has to be *run*, by you, cron, or CI. Native
git-sync is a possible v2 feature (`docs/06-implementation-plan.md` backlog) but
isn't implemented; the file-based approach above gets you version-controlled targets
today without it.
