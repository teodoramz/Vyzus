# targets/ — provisioning applications and checks from files

Everything in this directory is optional local tooling — the dashboard and API don't
read it. It's consumed by `scripts/sync-targets.mjs`, which upserts the same
applications/checks it describes via the normal REST API (`docs/04-api-spec.md`).
Use it if you want your monitored targets and journey tests to live in version
control instead of being clicked together in the UI.

## Layout

```
targets/
  <slug>/                       # slug is just a directory name, free-form
    app.json                    # required — the application
    checks/
      <name>.journey.ts         # a journey check (bare Playwright steps)
      <name>.uptime.json        # an uptime check (JSON config)
```

### `app.json`

```json
{
  "name": "Example Landing",
  "landingUrl": "https://example.com",
  "tags": ["demo"],
  "intervalMinutes": 5,
  "enabled": true
}
```

`name` is the match key — the script looks up existing applications by exact name.
Rename an app here and the script creates a *new* one rather than renaming the old
one (renaming isn't supported by the API on purpose, to keep run history unambiguous).
`intervalMinutes` only affects the default "Landing uptime" check created alongside
a brand-new app; it has no effect once the app already exists.

### `checks/*.journey.ts`

The file content is exactly what you'd paste into the dashboard's journey editor —
bare Playwright steps, no `import`/`export`/function wrapper. `page`, `context`, and
`expect` are already in scope; see `docs/07-user-guide.md` for the full format and
common mistakes.

The check's name defaults to the filename in Title Case (`login-flow.journey.ts` →
"Login Flow"). Override it with a `// name: ...` comment on the very first line:

```ts
// name: Checkout flow
await page.goto('https://shop.example.com/cart');
await page.getByRole('button', { name: 'Checkout' }).click();
await expect(page.getByText('Payment details')).toBeVisible();
```

Interval/timeout/failure-threshold aren't configurable per-file yet — new journey
checks are created with the defaults (5 min, 30 s, 2 failures). Adjust them in the
dashboard after creation if needed; the script won't overwrite fields it doesn't
manage.

### `checks/*.uptime.json`

```json
{
  "name": "Landing uptime",
  "intervalMinutes": 5,
  "timeoutMs": 30000,
  "failureThreshold": 2,
  "config": {
    "expectedStatus": 200,
    "bodyText": "Welcome",
    "screenshot": "on_failure"
  }
}
```

`name: "Landing uptime"` matches the default check every new app is created with,
so you can use this file to customize it declaratively instead of editing it by hand.

## Running it

```bash
VYZUS_API_URL=http://localhost:8080/api/v1 \
VYZUS_EMAIL=admin@example.com VYZUS_PASSWORD=password123 \
node scripts/sync-targets.mjs
```

(or `VYZUS_TOKEN=<jwt>` instead of email/password — useful in CI with a
service-account-style login done once elsewhere).

- Safe to re-run: unchanged apps/checks are skipped, only diffs are sent.
- `--dry-run` prints the plan without writing anything.
- `--prune` also **deletes** any check that exists on the server but has no
  matching file in this directory — including the auto-created "Landing uptime"
  check if you haven't declared a `*.uptime.json` for it. Only pass `--prune` once
  every check you want kept has a file here. Applications are never deleted by
  this script, pruned or not.
- `--dir <path>` points at a different targets directory.

## Example

`targets/example-landing/` is a real, working example (the same app + journey used
in the walkthrough in `docs/07-user-guide.md`) — copy it as a starting point.
