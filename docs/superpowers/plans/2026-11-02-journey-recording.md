# Journey Recording (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste any recorded Playwright script into Vyzus, keep passwords out of scripts as encrypted per-application secrets, and give Vyzus its own test websites to simulate users against.

**Architecture:** A pure normaliser in `packages/shared` turns any codegen output into the step-only body the sandbox expects; the API applies it on save. Secrets live encrypted on the application, are decrypted by the worker per run, handed to the journey sandbox through its temp config file, exposed to the script as `secret(name)`, and scrubbed from error text and the failure trace before anything is stored. A small local test-sites server provides login, JavaScript-rendered and shop flows for end-to-end tests and the demo.

**Tech Stack:** TypeScript, Fastify, Drizzle (Postgres), BullMQ, Playwright 1.62.1, React; new deps `acorn` (shared, parsing) and `fflate` (worker, trace zip rewrite).

**Spec:** `docs/superpowers/specs/2026-11-02-journey-recording-design.md` (parts 1, 2, 4 and the test sites). Part 3, the extension, is Plan B, written after its spike.

## Global Constraints

- Branch: all work on `feature/journey-recording`. Never commit to `main`.
- Commit messages: a short title only. No body, no `Co-Authored-By`, no attribution of any kind.
- No real deployment identifiers anywhere (code, tests, fixtures, docs, commit messages). Use `example.test` hosts and synthetic names.
- Docs prose uses hyphens, not em-dashes.
- Playwright stays at 1.62.1 (lockstep with the worker image).
- Encryption uses the existing `encryptJson` / `decryptJson` (AES-256-GCM, `ENCRYPTION_KEY`).
- A secret value must never appear in: any check `config`, any API response, `runs.error_message`, worker logs, a Redis job payload, or a saved `trace.zip`.
- Secret names match `^[A-Za-z][A-Za-z0-9_]{0,63}$` and are case-sensitive. Secret values are 4 to 4096 characters.
- The journey spec size limit (`JOURNEY_SPEC_MAX_BYTES`) applies to the spec after normalisation.

## Review Focus

1. A very short secret would make redaction mangle unrelated text; values under 4 characters are refused on save (Task 4).
2. A secret containing `"` or `\` appears JSON-escaped inside trace files; the scrub replaces both the raw and the escaped form (Task 5).
3. A codegen file pasted from Windows carries CRLF line endings and possibly a BOM; it normalises and parses the same as LF (Task 2).
4. The same password typed into two fields (password and confirm) becomes one secret and both lines are rewritten (Task 2).
5. A pasted full file over the size limit but under it once normalised is accepted; the limit is measured after normalisation (Task 3).

---

### Task 1: Test websites

**Files:**
- Create: `apps/test-sites/package.json` (name `@vyzus/test-sites`, private, `type: module`, scripts `build` via tsup, `start` running `dist/cli.js`)
- Create: `apps/test-sites/tsconfig.json` (extends `../../tsconfig.base.json`)
- Create: `apps/test-sites/src/server.ts`
- Create: `apps/test-sites/src/cli.ts` (starts the server on `PORT`, default 4000, host `0.0.0.0`)
- Create: `apps/test-sites/journeys/login.journey.ts`, `spa.journey.ts`, `shop.journey.ts`
- Test: `apps/worker/src/test/test-sites.test.ts`

**Interfaces:**
- Produces: `startTestSites(opts?: { port?: number; host?: string }): Promise<TestSites>` where
  `TestSites = { url: string; setBroken(v: boolean): void; close(): Promise<void> }`.
- Produces: fixed fixture credentials, exported as `TEST_SITE_USER = 'demo@example.test'` and `TEST_SITE_PASSWORD = 'correct-horse-battery'`.
- Produces: the three journey files, step-only bodies (no imports, no wrapper). `login.journey.ts` uses `secret('password')` for the password and the literal user email.

Routes the server must serve (plain HTML, no external assets):
- `GET /` title "Vyzus test sites", links to `/login`, `/spa`, `/shop`.
- `GET /login` form `#email`, `#password` (type password), submit button "Sign in". `POST /login` with the fixture credentials sets an httpOnly cookie and redirects to `/dashboard`; wrong credentials re-render `/login` with text "Wrong email or password".
- `GET /dashboard` requires the cookie (else redirect to `/login`), shows heading "Welcome back".
- `GET /spa` empty `#items` list filled by inline script fetching `GET /api/items` (JSON `["Alpha","Beta","Gamma"]`) after a 300 ms delay.
- `GET /shop` three products each with button "Add to cart"; cart state in a cookie; `GET /cart` lists items with "Checkout" link; `GET /checkout` form `#name`, `#address`, button "Place order"; `POST /checkout` redirects to `/order/confirmed` showing "Order confirmed".
- `setBroken(true)`: `/checkout` returns HTTP 500 with body "Checkout unavailable".

- [ ] **Step 1: Write the failing test** in `apps/worker/src/test/test-sites.test.ts`: start the sites, then for each of the three journey files run it through the real sandbox (`runInSandbox` with `specSource` read from the file, `secrets: { password: TEST_SITE_PASSWORD }`, `timeoutMs: 30000`, `artifactsDir: null`) and expect `status: 'passed'`. Then `setBroken(true)`, run `shop.journey.ts`, expect `status: 'failed'` and `errorMessage` to contain `Checkout unavailable` or `500`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && VYZUS_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx vitest run src/test/test-sites.test.ts`
Expected: FAIL, module `@vyzus/test-sites` not found.

- [ ] **Step 3: Implement the server and journeys.** Node `http` only, no framework. Add `@vyzus/test-sites` as a devDependency of `@vyzus/worker` and `@vyzus/api`. The sandbox `secrets` field does not exist yet: this task's test depends on Task 5 for the login journey, so mark that one case `it.todo` until Task 5 and enable it there.

- [ ] **Step 4: Run the test to verify it passes** (same command). Expected: PASS for spa, shop, broken-shop; login is `todo`.

- [ ] **Step 5: Commit**

```bash
git add apps/test-sites apps/worker/src/test/test-sites.test.ts apps/worker/package.json apps/api/package.json pnpm-lock.yaml
git commit -m "Add local test websites"
```

### Task 2: Journey spec normaliser

**Files:**
- Create: `packages/shared/src/journey-spec.ts` (export from `packages/shared/src/index.ts`)
- Create: `apps/api/src/test/fixtures/codegen/` with `test-target.ts`, `library-target.js`, `steps-only.ts`, `crlf-bom.ts` (hand-written to match Playwright 1.62.1 codegen output shapes)
- Test: `apps/api/src/test/journey-spec.test.ts`
- Modify: `packages/shared/package.json` (dependency `acorn@^8.18.0`)

**Interfaces:**
- Produces:
  - `normalizeJourneySpec(source: string): { spec: string; removed: string[] }` - `removed` holds human-readable notes, e.g. `'import statements'`, `'test() wrapper'`, `'browser setup and teardown'`.
  - `parseJourneySpec(spec: string): { ok: true } | { ok: false; error: string }` - parses `(async () => {\n${spec}\n})` with acorn, `ecmaVersion: 'latest'`.
  - `findSecretReferences(spec: string): string[]` - unique names from `secret('x')` / `secret("x")` calls, via the AST.
  - `findPasswordLiterals(spec: string): PasswordLiteral[]` with `PasswordLiteral = { start: number; end: number; value: string; suggestedName: string }` (offsets of the string literal including quotes).
  - `moveLiteralsToSecrets(spec: string, literals: PasswordLiteral[], names: Record<string, string>): { spec: string; secrets: Record<string, string> }` - `names` maps a literal value to the chosen secret name; replaces each literal with `secret('<name>')`.

A `.fill()` is a password fill when its receiver locator is any of: `getByLabel(/password/i or 'Password'...)`, `getByPlaceholder(...password...)`, `getByRole('textbox', { name: ...password... })`, `locator('[type=password]')` / `locator('input[type="password"]')`, or a `locator('#...password...')` / `[name=...password...]` selector. Match "password" case-insensitively in the string or regex argument.

- [ ] **Step 1: Write the failing tests**

```ts
describe('normalizeJourneySpec', () => {
  it('unwraps a test-target codegen file', () => {
    const { spec, removed } = normalizeJourneySpec(fixture('test-target.ts'));
    expect(spec).not.toMatch(/import|test\(/);
    expect(spec).toContain("await page.goto('http://example.test/login');");
    expect(removed).toEqual(expect.arrayContaining(['import statements', 'test() wrapper']));
  });
  it('strips library-target setup and teardown', () => {
    const { spec, removed } = normalizeJourneySpec(fixture('library-target.js'));
    expect(spec).not.toMatch(/chromium\.launch|newContext|newPage|\.close\(\)|require\(/);
    expect(removed).toContain('browser setup and teardown');
  });
  it('leaves a steps-only spec unchanged', () => {
    const src = fixture('steps-only.ts');
    expect(normalizeJourneySpec(src)).toEqual({ spec: src.trim(), removed: [] });
  });
  it('handles CRLF and a BOM', () => {
    const { spec } = normalizeJourneySpec(fixture('crlf-bom.ts'));
    expect(spec).not.toContain('\r');
    expect(spec.charCodeAt(0)).not.toBe(0xfeff);
    expect(parseJourneySpec(spec)).toEqual({ ok: true });
  });
});
describe('parseJourneySpec', () => {
  it('rejects broken syntax with the parser message', () => {
    const r = parseJourneySpec('await page.click(');
    expect(r.ok).toBe(false);
  });
});
describe('findSecretReferences', () => {
  it('lists unique names in both quote styles', () => {
    expect(findSecretReferences(`secret('password'); secret("apiKey"); secret('password')`).sort()).toEqual(['apiKey', 'password']);
  });
});
describe('findPasswordLiterals / moveLiteralsToSecrets', () => {
  it.each([
    `await page.getByLabel('Password').fill('pw-0001');`,
    `await page.getByLabel(/password/i).fill('pw-0001');`,
    `await page.getByPlaceholder('Your password').fill('pw-0001');`,
    `await page.getByRole('textbox', { name: 'Password' }).fill('pw-0001');`,
    `await page.locator('input[type="password"]').fill('pw-0001');`,
    `await page.locator('#password').fill('pw-0001');`,
    `await page.locator('[name=password]').fill('pw-0001');`,
  ])('finds a password fill: %s', (line) => {
    expect(findPasswordLiterals(line).map((l) => l.value)).toEqual(['pw-0001']);
  });
  it('ignores a non-password field', () => {
    expect(findPasswordLiterals(`await page.getByLabel('Email').fill('a@example.test');`)).toEqual([]);
  });
  it('collapses the same password typed twice into one secret', () => {
    const src = `await page.getByLabel('Password').fill('hunter22');\nawait page.getByLabel('Confirm password').fill('hunter22');`;
    const lits = findPasswordLiterals(src);
    const { spec, secrets } = moveLiteralsToSecrets(src, lits, { hunter22: 'password' });
    expect(spec).not.toContain('hunter22');
    expect(spec.match(/secret\('password'\)/g)).toHaveLength(2);
    expect(secrets).toEqual({ password: 'hunter22' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && VYZUS_TEST_NO_DOCKER=1 npx vitest run src/test/journey-spec.test.ts`
Expected: FAIL, exports not found.

- [ ] **Step 3: Implement `journey-spec.ts`** using acorn ASTs and source slicing (never regex over code for structure). Strip a leading BOM and convert CRLF to LF first. Unwrap: a top-level `test(...)` / `test.describe` call's callback body; a library-target IIFE's body, dropping statements that declare or call `chromium`/`firefox`/`webkit`.`launch`, `browser.newContext`, `context.newPage`, `*.close()`, and the `// ---` separator comment line codegen emits. Return the trimmed body.

- [ ] **Step 4: Run the tests to verify they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/api/src/test/journey-spec.test.ts apps/api/src/test/fixtures pnpm-lock.yaml
git commit -m "Add journey spec normaliser"
```

### Task 3: Normalise on save, fix the default script

**Files:**
- Modify: `apps/api/src/routes/checks.ts` (create, patch, dry-run for `type: 'journey'`)
- Modify: `packages/shared/src/schemas/checks.ts` (size refine stays on the stored spec)
- Modify: `apps/dashboard/src/components/JourneyConfigFields.tsx` (`DEFAULT_JOURNEY_SPEC`, live normalise note)
- Modify: `scripts/sync-targets.mjs` (normalise before comparing)
- Test: `apps/api/src/test/journey-save.test.ts`

**Interfaces:**
- Consumes: `normalizeJourneySpec`, `parseJourneySpec` from Task 2.
- Produces: journey create/patch/dry-run store and run the normalised spec; an unparseable spec is `400` with code `INVALID_JOURNEY_SPEC` and the parser message.

- [ ] **Step 1: Write the failing tests**: (a) POST a journey whose `specSource` is the test-target fixture -> 201 and the stored `config.specSource` has no `import`/`test(`; (b) PATCH with the library-target fixture -> stored spec normalised; (c) POST `'await page.click('` -> 400 `INVALID_JOURNEY_SPEC`; (d) a full file whose raw size exceeds `JOURNEY_SPEC_MAX_BYTES` only because of setup lines, but whose normalised body fits -> 201; (e) `DEFAULT_JOURNEY_SPEC` passes `parseJourneySpec` and does not mention `heading`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && VYZUS_TEST_NO_DOCKER=1 npx vitest run src/test/journey-save.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In the route, normalise before the schema's size check runs: relax the request-body size refine on `specSource` to `4 * JOURNEY_SPEC_MAX_BYTES` and enforce `JOURNEY_SPEC_MAX_BYTES` on the normalised result in the route (400 `JOURNEY_SPEC_TOO_LARGE`). New `DEFAULT_JOURNEY_SPEC`:

```ts
export const DEFAULT_JOURNEY_SPEC = `// Paste a recording from \`npx playwright codegen <url>\` - the whole file is fine.
await page.goto('https://example.com');
await expect(page).toHaveTitle(/Example Domain/);
`;
```

In the editor, run `normalizeJourneySpec` on change and, when `removed` is non-empty, show "Removed: <notes joined by ', '>" under the editor. In `sync-targets.mjs`, import `normalizeJourneySpec` from `../packages/shared/dist/index.js` and compare normalised specs.

- [ ] **Step 4: Run the tests to verify they pass**, then the full API suite.

Run: `cd /home/kali/Desktop/platforma-usersimulation/Vyzus && VYZUS_TEST_NO_DOCKER=1 pnpm --filter @vyzus/api test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/shared apps/dashboard scripts/sync-targets.mjs
git commit -m "Normalise journey scripts on save"
```

### Task 4: Application secrets storage and API

**Files:**
- Modify: `packages/shared/src/db/schema.ts` (`applications.secretsEnc: text('secrets_enc')`, `applications.secretNames: text('secret_names').array().notNull().default(sql\`'{}'\`)`)
- Create: migration via `pnpm --filter @vyzus/api db:generate`
- Modify: `packages/shared/src/schemas/common.ts` (`secretNameSchema`; here because `apps.ts` already imports `checks.ts`, so either importing the other would cycle)
- Modify: `packages/shared/src/schemas/apps.ts` (`secretsPatchSchema`, `secretNames` on `appSchema`)
- Modify: `apps/api/src/routes/apps.ts`, `apps/api/src/routes/checks.ts`, `apps/api/src/lib/mappers.ts`
- Test: `apps/api/src/test/app-secrets.test.ts`

**Interfaces:**
- Consumes: `findSecretReferences` (Task 2).
- Produces:
  - `secretNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)`
  - `secretsPatchSchema = z.record(secretNameSchema, z.string().min(4).max(4096).nullable())` - on `createAppBodySchema` and `updateAppBodySchema` as optional `secrets`.
  - `appSchema.secretNames: z.array(z.string())`, sorted; empty for viewers.
  - `toApp(row, opts: { includeSecretNames: boolean })` - routes pass `req.authUser.role !== 'viewer'`.
  - Errors: `409 SECRET_IN_USE` (body lists journey check names), `400 UNKNOWN_SECRET` (body lists missing names).
  - `decryptAppSecrets(row: { secretsEnc: string | null }, key: string): Record<string, string>` in `packages/shared/src/node/app-secrets.ts` (used by the worker in Task 5).

`secretNames` is stored in plain text alongside the encrypted map because names are not secret and listing them must not require the key.

- [ ] **Step 1: Write the failing tests**: create an app with `secrets: { password: 'correct-horse-battery' }` -> response `secretNames: ['password']` and no value anywhere in the JSON; DB `secrets_enc` is not null and does not contain the value; PATCH `{ secrets: { apiKey: 'k-12345' } }` keeps `password` and adds `apiKey`; PATCH `{ secrets: { apiKey: null } }` deletes it; value `'abc'` -> 400; name `'1bad'` -> 400; a journey check on that app using `secret('password')` saves; one using `secret('missing')` -> 400 `UNKNOWN_SECRET` naming `missing`; deleting `password` while that journey exists -> 409 `SECRET_IN_USE` naming the check; a viewer assigned to the app sees `secretNames: []`; an editor can PATCH secrets, a viewer gets 403.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && VYZUS_TEST_NO_DOCKER=1 npx vitest run src/test/app-secrets.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Merge semantics: decrypt current map, apply patch (absent keeps, `null` deletes), re-encrypt, write `secretNames` from the merged keys. Before a delete, scan the app's journey checks with `findSecretReferences`. Journey create/patch validates references against the app's `secretNames`.

- [ ] **Step 4: Run the tests to verify they pass**, then the full API suite (command as in Task 3). Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/api
git commit -m "Store journey secrets per application"
```

### Task 5: Secrets at run time, redaction and trace scrub

**Files:**
- Modify: `apps/worker/src/sandbox/protocol.ts` (`HarnessConfig.secrets: Record<string, string>`)
- Modify: `apps/worker/src/sandbox/spawn.ts` (`SandboxInput.secrets`, wrap signature, redaction, trace scrub)
- Modify: `apps/worker/src/sandbox/runner-harness.ts` (pass `secret`)
- Modify: `apps/worker/src/executors/journey.ts`, `apps/worker/src/processor.ts`
- Create: `apps/worker/src/sandbox/redact.ts`
- Modify: `apps/worker/package.json` (dependency `fflate`)
- Test: `apps/worker/src/test/journey-secrets.test.ts`; enable the login case in `test-sites.test.ts`

**Interfaces:**
- Consumes: `decryptAppSecrets` (Task 4), `startTestSites`, `TEST_SITE_PASSWORD`, `login.journey.ts` (Task 1).
- Produces:
  - `SandboxInput.secrets?: Record<string, string>` (default `{}`).
  - Spec wrapper signature: `export default async ({ page, context, expect, secret }) => { ... }`.
  - `secret(name)` throws `Error('Unknown secret "<name>"')` for a missing name.
  - `redactSecrets(text: string, values: string[]): string` - replaces each value and its `JSON.stringify(value).slice(1, -1)` form with `[secret]`.
  - `scrubTraceZip(zipPath: string, values: string[]): Promise<void>` - rewrites every entry whose bytes decode as UTF-8 text through `redactSecrets`; binary entries untouched.

- [ ] **Step 1: Write the failing tests** against the login test site through `runInSandbox` with `artifactsDir` set to a temp dir:
  - login journey with `secrets: { password: TEST_SITE_PASSWORD }` -> `passed`;
  - same journey with a wrong secret and a final `expect(page.getByText('Welcome back')).toBeVisible({ timeout: 2000 })` -> `failed`; the returned `errorMessage` does not contain the wrong value; `trace.zip` exists, and unzipping it (fflate) and searching every entry finds neither the value nor its JSON-escaped form;
  - a secret value `p"ss\\word-9` typed into the field, journey forced to fail -> neither form appears in the trace;
  - `secret('nope')` -> `failed` with `Unknown secret "nope"`;
  - rotation, through the processor (`createProcessor` from `@vyzus/worker/testkit`): run the login journey check with the app's stored secret correct -> `passed`; update `applications.secrets_enc` to a wrong value; run again -> `failed`; restore -> `passed`. This proves secrets are decrypted per run, not cached.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/worker && VYZUS_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx vitest run src/test/journey-secrets.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Secrets travel only in `config.json` in the sandbox temp dir (already deleted after the run), never in the child env. In the parent, after the child exits: `redactSecrets` the result's `errorMessage` and the stderr/stdout tails before they are returned or logged, and `scrubTraceZip` the trace before `executeJourney` hands it to the artifact store. The processor's journey branch passes `decryptAppSecrets(app, config.ENCRYPTION_KEY)`; widen `execute()`'s `app` parameter to include `secretsEnc`.

- [ ] **Step 4: Run the tests to verify they pass**, enable and run the login case in `test-sites.test.ts`, then the full worker suite.

Run: `cd /home/kali/Desktop/platforma-usersimulation/Vyzus && VYZUS_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @vyzus/worker test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/worker pnpm-lock.yaml
git commit -m "Inject journey secrets and scrub them from artifacts"
```

### Task 6: Dry runs with secrets

**Files:**
- Modify: `packages/shared/src/schemas/checks.ts` (`dryRunBodySchema` gains optional `secrets: z.record(secretNameSchema, z.string().min(4).max(4096))`)
- Modify: `packages/shared/src/queues.ts` (`dryRunJobPayloadSchema` gains optional `secretsEnc: z.string()`)
- Modify: `apps/api/src/routes/checks.ts` (encrypt into the payload), `apps/worker/src/processor.ts` (merge)
- Test: extend `apps/api/src/test/app-secrets.test.ts`; `apps/worker/src/test/journey-secrets.test.ts`

**Interfaces:**
- Consumes: Task 4 and Task 5.
- Produces: `secretsEnc = encryptJson(body.secrets, key)` on the job; the worker runs with `{ ...decryptAppSecrets(app, key), ...decryptJson(payload.secretsEnc, key) }` (request values win).

- [ ] **Step 1: Write the failing tests**: API dry-run with `secrets: { password: 'unsaved-pass-1' }` -> the `MockScheduler.dryRunCalls[0]` payload has `secretsEnc`, and `JSON.stringify(payload)` does not contain `unsaved-pass-1`; a journey referencing a name that is neither stored nor in the request -> 400 `UNKNOWN_SECRET`. Worker: `processDryRun` with an encrypted `secretsEnc` runs the login journey green.

- [ ] **Step 2: Run them to verify they fail** (API and worker commands from Tasks 4 and 5). Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run both suites in full.** Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/api apps/worker
git commit -m "Support secrets in journey dry runs"
```

### Task 7: Dashboard - secrets and password move

**Files:**
- Modify: `apps/dashboard/src/components/AppEditModal.tsx` (Secrets section)
- Modify: `apps/dashboard/src/components/JourneyConfigFields.tsx`, `apps/dashboard/src/pages/CheckEditor.tsx`
- Modify: `apps/dashboard/src/api/endpoints.ts` (types follow the shared schemas)

**Interfaces:**
- Consumes: `secretNames` on `App` (Task 4), `findPasswordLiterals` / `moveLiteralsToSecrets` (Task 2), dry-run `secrets` (Task 6).

Behaviour:
- **AppEditModal:** a "Secrets" list of `secretNames`, each with "Replace" and "Delete" (Delete goes through `ConfirmButton`; a `409 SECRET_IN_USE` shows the journeys named in the error through `ErrorBanner`). "Add secret" takes a name and a password-type value input. Values are never prefilled or displayed.
- **Journey editor:** when `findPasswordLiterals` finds any, show a notice "This script contains a password. Store it as a secret instead?" with a name field per distinct value (default `suggestedName`). If the name already exists on the app, the notice says "This application already has a secret called <name>" with choices "Use the stored one" and "Replace it". Accepting rewrites the editor text and queues the values.
- **Save:** `CheckEditor` PATCHes the app's `secrets` first, then saves the check. Dry run sends queued values as `secrets`.

- [ ] **Step 1: Implement the three behaviours above.**

- [ ] **Step 2: Typecheck and lint.**

Run: `cd /home/kali/Desktop/platforma-usersimulation/Vyzus && pnpm typecheck && pnpm lint`
Expected: 0 errors.

- [ ] **Step 3: Browser verification** with a throwaway Playwright script (in the scratchpad, never committed) against the running stack: paste the test-target fixture containing a password fill into a new journey on a demo app, accept the move, save, then confirm via the API that the check's `specSource` has `secret('password')` and no literal, `GET /apps/:id` shows `secretNames: ['password']`, and a dry run passes against the test sites. Then add a second secret in AppEditModal and delete it; try deleting `password` and confirm the in-use error names the journey.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard
git commit -m "Manage journey secrets in the dashboard"
```

### Task 8: Test sites in the demo

**Files:**
- Create: `infra/test-sites.Dockerfile`
- Modify: `docker-compose.yml` (service `test-sites` under profile `demo`, internal network only, no published port)
- Modify: `apps/api/src/seed-demo.ts` (when `VYZUS_DEMO_SITES_URL` is set, add an app per site with its journey, and secret `password` on the login app)
- Modify: `README.md` (one short paragraph: how to start the demo with `--profile demo` and seed it)

**Interfaces:**
- Consumes: Task 1's `cli.ts` and journey files, Task 4's `secrets` on app create.

- [ ] **Step 1: Start the demo stack and seed it.**

Run: `docker compose --profile demo up -d --build && docker compose exec -e VYZUS_DEMO_SITES_URL=http://test-sites:4000 api node dist/seed-demo.js`
Expected: the seed reports the three test-site applications created.

- [ ] **Step 2: Verify** the three journeys run green within one interval (query `runs` for them), and that `docker compose ps` shows no published port on `test-sites`.

- [ ] **Step 3: Commit**

```bash
git add infra/test-sites.Dockerfile docker-compose.yml apps/api/src/seed-demo.ts README.md
git commit -m "Run the test websites in the demo"
```

### Final check

- [ ] Full gate on the branch: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build`, both test suites, all three Docker images build.
- [ ] Leak sweep: after the suites, grep the test database dump, the worker logs from the run, and every `trace.zip` under the test artifacts dirs for the fixture secret values. Expected: no matches.
- [ ] Push `feature/journey-recording`; do not merge.
