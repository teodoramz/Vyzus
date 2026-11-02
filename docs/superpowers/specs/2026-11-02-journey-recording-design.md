# Journey recording - design

Status: awaiting approval
Branches: `feature/journey-recording` (parts 1, 2, 4), `feature/recorder-extension` (part 3)

## Intent

Anyone should be able to create a user-simulation journey by doing the flow once in
their own browser, including people who don't write code and don't know Playwright.

Today it takes five steps that each lose someone: install Node and Playwright, run
`npx playwright codegen <url>`, hand-delete the `import` lines and the `test(...)`
wrapper (Vyzus wants "just the steps"), paste, and accept that any password typed while
recording is now sitting in the script in plain text.

## Current state (verified)

- A journey's script (`specSource`) is stored in the check's plain `config` jsonb and
  returned by `GET /checks/:id`. A journey that logs in keeps its password readable in
  the database, the API and the editor.
- The journey sandbox receives only `specSource`, `timeoutMs` and `artifactsDir`
  (`apps/worker/src/sandbox/spawn.ts`). No credentials reach it, so today there is no way
  for a recorded login to work without the password in the script.
- Pasting a full codegen file breaks: the sandbox wraps the text in its own
  `export default async ({ page, context, expect }) => { ... }`, so an `import` or a
  nested `test(...)` inside that body fails.
- The default script for a new journey asserts the `<h1>Example Domain</h1>` that
  example.com removed, so every new journey starts out failing.

## Goals

1. **Paste anything.** A full codegen file (test target or library target) or bare
   steps all work. Vyzus normalises it and shows what it removed.
2. **No password in a script, ever.** Values typed into password fields become
   encrypted journey secrets, referenced from the script by name and injected at run
   time.
3. **Record from the browser.** A Chrome extension records the flow, lets the user add
   simple checks ("this text should appear"), shows the steps in plain language, and
   saves the journey straight into Vyzus.
4. Fix the default journey script.

## Non-goals

- Firefox in the first version. The recorder relies on `chrome.debugger`, which only
  Chromium-family browsers have; Chrome, Edge and Brave are covered first. Firefox is a
  planned follow-up phase (it needs a different recording approach), and Safari is not
  planned.
- Publishing to the Chrome Web Store in the first version. Distribution is a zip from
  the repo's release, loaded unpacked.
- Editing a recording step by step inside the extension beyond deleting a step. Fine
  edits happen in the Vyzus journey editor, which already exists.
- Multi-tab flows and cross-origin popups recorded perfectly.

## Anti-goals (a failure even if it works)

- **Flaky selectors.** A recording that passes today and fails tomorrow for no reason
  produces false alerts, which is worse than no recorder.
- **A secret leaking anywhere**: the script, the check's config, an API response, a run's
  error message, a log line, git.
- **An extension that can read every site all the time.** It attaches only to the tab
  the user chooses, only while recording.

## Part 1: Paste anything

Normalisation runs in one shared function used by both the API (on save, so a paste
through the API or `sync-targets` works too) and the dashboard editor (live, so the user
sees the result before saving).

It removes `import`/`require` lines, unwraps a `test('name', async ({ page }) => { ... })`
body, and strips library-target boilerplate (`chromium.launch`, `newContext`, `newPage`,
`close` calls). Anything it removes is listed under the editor ("Removed 3 lines of
setup code") so nothing changes silently.

The normalised result must parse as a JavaScript function body. A script that doesn't
parse is a `400` on save with the parser's message, not a failed run discovered later.

The API normalises structure only. It never rewrites a password literal into a secret on
its own: that move happens in the editor and the extension, where the user sees it.
`sync-targets` runs the same shared normaliser before comparing, so a target file that
was already normalised on the server doesn't produce a PATCH on every run. Secrets
through `sync-targets` are out of scope for this version.

## Part 2: Journey secrets

An encrypted map of name to value **per application**, shared by all of that
application's journeys, stored in a new `applications.secrets_enc` column with the same
AES-256-GCM key and pattern as `alert_channels.secrets_enc`. The script refers to them as
`secret('password')`.

Per application because the event that actually happens to a password is that it
changes: with one copy per application it is updated once, not hunted down across every
journey that logs into the same site. The existing session-login credentials in
`applications.auth_config_enc` stay where they are; journeys don't read them.

Recording a journey that types a password for an application that already has a secret
of that name asks the user whether to reuse the stored one or replace it. Replacing it is
also how a user rotates a password by simply recording the login again. Deleting a
secret still referenced by a journey is a `409` that names those journeys.

Through the API, secrets are a top-level `secrets` field on application create and
update, kept out of any check's `config` (`journeyConfigSchema` is strict and the update
union matches on config shape). Editing them requires the same role as editing the
application. They are write-only: responses list the names that exist, never values. On
update, an absent name keeps its value and `null` deletes it. A journey whose script
calls `secret('x')` for a name its application doesn't have is a `400` on save, listing
the missing names.

At run time the worker decrypts them and hands them to the sandbox in the same temp file
that already carries the spec, and the harness exposes `secret(name)` alongside `page`,
`context` and `expect`. An unknown name throws a clear error naming the secret. The temp
file is deleted after the run, as it is today.

Every secret value is redacted from a run's error message and logs before they are
stored. Playwright puts the filled value in some failure messages
(`locator.fill(..., 'hunter2')`), and that must not reach `runs.error_message`.

The failure trace is the other carrier: a Playwright trace records each `fill` value and
the DOM snapshots hold input values. Before a `trace.zip` is written to the artifacts
volume, every text entry in it is scanned and each secret value replaced. A test opens
the saved zip and asserts no secret occurs anywhere in it. Screenshots need nothing:
password inputs render masked. A secret typed into an ordinary visible text field would
show in a screenshot; that is documented rather than solved.

Dry runs: the dashboard and extension send secret values with the dry-run request over
the existing HTTPS connection. The API encrypts them into the job payload with
`ENCRYPTION_KEY` before it goes on the queue, and the worker decrypts them. Redis never
holds a plaintext secret. A dry run already carries its `appId`, so the worker uses that
application's stored secrets and only values not yet saved need to travel in the
request.

Existing journeys are not migrated. Rewriting a user's script without telling them
breaks the rule that nothing changes silently. Instead, opening an existing journey in
the editor flags any password literal and offers the same move into a secret.

When a pasted or recorded script contains `.fill(<password field>, '<literal>')`, Vyzus
moves the literal into a secret and rewrites the line to `secret('...')`. A password
field is recognised by its locator (`type=password`, or a label/name/placeholder
containing "password"). The user sees the move happen and can rename the secret.

## Part 3: Browser extension

A Chrome extension in `apps/extension/`, a workspace package built to a zip. It uses
**playwright-crx** as a library: that package bundles Playwright's own recorder, the same
engine as `playwright codegen`, which is what keeps selectors as good as codegen's
instead of hand-rolled heuristics.

**Spike first, as a gate.** playwright-crx's latest release is 0.15.0 (June 2025) and
bundles an older Playwright than Vyzus's 1.62.1, and one store review reports it doing
nothing on a recent Chrome. Before any extension code, a throwaway spike confirms it
records on current Chrome and its output runs on Playwright 1.62.1. If it doesn't, the
options (fork and update it, build a smaller own recorder, or stop at parts 1 and 2) come
back to the user before going further.

The spike passes if, on the current stable Chrome with the extension loaded unpacked, a
recording of the login test site produces a script that runs green on Playwright 1.62.1
after part 1's normaliser. Small syntax differences the normaliser can absorb are a
pass. Needing a pinned older Chrome, or patching playwright-crx's internals, is a fail
and goes back to the user.

User flow:

1. First run: the user enters their Vyzus address and an API token, once.
2. On the site to monitor, they click the extension and choose "Start recording".
3. They do the flow. The recorder's toolbar lets them add checks by clicking an element:
   "this should be visible", "this text should appear".
4. "Stop" shows the steps in plain language ("Go to /login", "Type into Email",
   "Click Sign in", "Check that 'Welcome' appears"), with password entries already shown
   as secrets.
5. They pick the application, name the journey, and save. The extension creates the
   journey check (normalised by part 1, secrets stored by part 2) through the API, and
   offers a dry run.

Permissions: `debugger` (required by the recorder), `activeTab`, `storage`, `sidePanel`,
and host access to the user's Vyzus address only, requested at setup. The token is kept
in `chrome.storage.local`.

## Part 4: Default journey script

The default for a new journey checks the page title instead of the removed heading.

## Test sites

A small set of sites under our control, served locally for tests and optionally for the
demo: a login form leading to a dashboard, a page whose content is rendered by
JavaScript, and a shop with cart and checkout. They replace the dependency on
example.com, which already broke the demo once, and they are what the end-to-end tests
below record against.

## Testing

The user asked for this feature to be tested thoroughly. The bar is that every promise
in this document has a test that would fail if the promise broke.

- **Normalisation:** unit tests over real codegen output captured from Playwright 1.62.1
  (test target, library target, bare steps), plus malformed input, mixed quoting, and a
  script that is already normalised (must come back unchanged).
- **Password detection:** each locator form that marks a password field is detected, and
  a non-password field is left alone.
- **Secrets, API:** create, read (names only), keep-on-absent, delete-on-null, delete
  refused while referenced, unknown reference refused on save, role enforcement, and a
  viewer can never read names or values.
- **Secrets, no leaks:** after a run that uses a secret and after a run that deliberately
  fails on the filled field, the secret value appears in none of: `checks.config`,
  `applications.config`, any API response, `runs.error_message`, worker logs, the Redis
  job payload, and the saved `trace.zip` (opened and searched).
- **Secrets, at run time:** a journey using `secret()` logs into the login test site and
  passes; an unknown name fails with a message naming it; a rotated secret is picked up
  on the next run.
- **Dry run:** with stored secrets, with unsaved secrets, and that Redis never holds a
  plaintext value.
- **Test sites:** each site's journey runs green, and the deliberately breakable site
  turns it red with a useful error.
- **Extension:** builds; a Playwright test loads the unpacked extension in Chromium,
  records a login-and-checkout flow on the test sites, converts the password into a
  secret, saves through a test API, and the saved journey then runs green in the real
  worker. The plain-language step list is checked against the recording.
- **Regression:** the full existing suite stays green on both branches.

## Delivery

Parts 1, 2 and 4 on `feature/journey-recording`; part 3 on `feature/recorder-extension`
after the spike. Each branch is reviewed by the user at merge. Commit messages are a
short title only.

## Calls made in this design (for review)

- Chromium-family browsers first; Firefox as a later phase.
- Script syntax for a secret is `secret('name')`.
- Secrets travel as a top-level `secrets` field; `null` deletes one; an unknown name is
  rejected on save.
- The API never moves passwords into secrets on its own; the editor and extension do.
- Secrets are scrubbed from failure traces, not by disabling traces.
- Dry-run secrets are encrypted in the queue payload.
- Existing journeys are flagged in the editor, not migrated.
- `sync-targets` gets the normaliser but not secrets, in this version.
- No Web Store listing in the first version.
- The extension is gated on a spike with a defined pass line.

- Secrets belong to an application and are shared by its journeys (the user delegated
  this choice).

## Left to the builder

- The parser used for normalisation.
- Exact wording of the plain-language steps.
- The extension's visual layout.
