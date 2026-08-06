#!/usr/bin/env node
// Provisions applications and checks from files under targets/ (see
// targets/README.md for the directory convention) via the same REST API the
// dashboard uses — nothing here is a special backdoor. Upserts by name and is
// safe to re-run: unchanged apps/checks are left alone.
//
// Usage:
//   VYZUS_API_URL=http://localhost:8080/api/v1 \
//   VYZUS_EMAIL=admin@example.com VYZUS_PASSWORD=password123 \
//   node scripts/sync-targets.mjs [--dir targets] [--prune] [--dry-run]
//
// --prune   also deletes checks that exist on the server but have no
//           matching file locally (apps are never deleted by this script).
// --dry-run print the planned create/update/delete actions without calling
//           the API's write endpoints.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const API_URL = (process.env.VYZUS_API_URL ?? 'http://localhost:8080/api/v1').replace(/\/$/, '');
const TARGETS_DIR = path.resolve(process.cwd(), opt('--dir', 'targets'));
const PRUNE = flag('--prune');
const DRY_RUN = flag('--dry-run');

function log(...m) {
  console.log(...m);
}
function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// ---- auth ----

async function login() {
  if (process.env.VYZUS_TOKEN) return process.env.VYZUS_TOKEN;
  const email = process.env.VYZUS_EMAIL;
  const password = process.env.VYZUS_PASSWORD;
  if (!email || !password) {
    fail('set VYZUS_EMAIL + VYZUS_PASSWORD (or VYZUS_TOKEN) in the environment');
  }
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) fail(`login failed: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.accessToken;
}

// ---- thin API client ----

function makeClient(token) {
  async function call(method, urlPath, body) {
    const res = await fetch(`${API_URL}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = json?.error?.message ?? text ?? res.statusText;
      throw new Error(`${method} ${urlPath} -> HTTP ${res.status}: ${msg}`);
    }
    return json;
  }
  return {
    listApps: () => call('GET', '/apps'),
    createApp: (body) => call('POST', '/apps', body),
    updateApp: (id, body) => call('PATCH', `/apps/${id}`, body),
    listChecks: (appId) => call('GET', `/apps/${appId}/checks`),
    createCheck: (appId, body) => call('POST', `/apps/${appId}/checks`, body),
    updateCheck: (id, body) => call('PATCH', `/checks/${id}`, body),
    removeCheck: (id) => call('DELETE', `/checks/${id}`, undefined),
  };
}

// ---- targets/ file convention ----
//
// targets/<slug>/app.json           { name, landingUrl, tags?, enabled?, intervalMinutes? }
// targets/<slug>/checks/*.journey.ts   bare Playwright steps -> a journey check
//                                       named after the file (kebab-case -> Title Case),
//                                       or a `// name: Custom Name` first line to override.
// targets/<slug>/checks/*.uptime.json  { name, intervalMinutes?, timeoutMs?, failureThreshold?,
//                                        enabled?, config: { expectedStatus?, selector?,
//                                        bodyText?, screenshot? } }
// See targets/README.md for the full reference and a worked example.

function titleCase(slug) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function readJourneyFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  let name = titleCase(path.basename(filePath, '.journey.ts'));
  let body = raw;
  const nameMatch = lines[0]?.match(/^\/\/\s*name:\s*(.+)$/);
  if (nameMatch) {
    name = nameMatch[1].trim();
    body = lines.slice(1).join('\n').replace(/^\n+/, '');
  }
  // Trailing newline is a file-editing/git convention, not meaningful spec
  // content — trim it so a normally-saved file doesn't diff forever against
  // specSource saved without one (e.g. typed in the dashboard's Monaco editor).
  return { name, specSource: body.replace(/\s+$/, '') };
}

async function discoverTargets() {
  const entries = await fs.readdir(TARGETS_DIR, { withFileTypes: true }).catch(() => []);
  const targets = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(TARGETS_DIR, entry.name);
    const appJsonPath = path.join(dir, 'app.json');
    const appJsonRaw = await fs.readFile(appJsonPath, 'utf8').catch(() => null);
    if (!appJsonRaw) continue; // not a target dir (e.g. no app.json yet)
    const appSpec = JSON.parse(appJsonRaw);
    const checksDir = path.join(dir, 'checks');
    const checkFiles = await fs.readdir(checksDir).catch(() => []);
    const journeyChecks = [];
    const uptimeChecks = [];
    for (const file of checkFiles) {
      if (file.endsWith('.journey.ts')) {
        journeyChecks.push(await readJourneyFile(path.join(checksDir, file)));
      } else if (file.endsWith('.uptime.json')) {
        const spec = JSON.parse(await fs.readFile(path.join(checksDir, file), 'utf8'));
        uptimeChecks.push(spec);
      }
    }
    targets.push({ slug: entry.name, appSpec, journeyChecks, uptimeChecks });
  }
  return targets;
}

// ---- sync ----

function appNeedsUpdate(existing, spec) {
  const patch = {};
  if (spec.landingUrl !== undefined && spec.landingUrl !== existing.landingUrl) patch.landingUrl = spec.landingUrl;
  if (spec.tags !== undefined && JSON.stringify(spec.tags) !== JSON.stringify(existing.tags)) patch.tags = spec.tags;
  if (spec.enabled !== undefined && spec.enabled !== existing.enabled) patch.enabled = spec.enabled;
  return patch;
}

function journeyCheckBody(name, specSource, overrides = {}) {
  return {
    type: 'journey',
    name,
    intervalMinutes: overrides.intervalMinutes ?? 5,
    timeoutMs: overrides.timeoutMs ?? 30000,
    failureThreshold: overrides.failureThreshold ?? 2,
    enabled: overrides.enabled ?? true,
    config: { specSource },
  };
}

function uptimeCheckBody(spec) {
  return {
    type: 'uptime',
    name: spec.name,
    intervalMinutes: spec.intervalMinutes ?? 5,
    timeoutMs: spec.timeoutMs ?? 30000,
    failureThreshold: spec.failureThreshold ?? 2,
    enabled: spec.enabled ?? true,
    config: spec.config ?? { expectedStatus: 200, screenshot: 'on_failure' },
  };
}

function checkNeedsUpdate(existing, desiredBody) {
  const patch = {};
  for (const key of ['intervalMinutes', 'timeoutMs', 'failureThreshold', 'enabled']) {
    if (desiredBody[key] !== undefined && desiredBody[key] !== existing[key]) patch[key] = desiredBody[key];
  }
  if (JSON.stringify(desiredBody.config) !== JSON.stringify(existing.config)) patch.config = desiredBody.config;
  return patch;
}

async function syncTarget(client, target, stats) {
  const { slug, appSpec, journeyChecks, uptimeChecks } = target;
  const existingApps = await client.listApps();
  let app = existingApps.find((a) => a.name === appSpec.name);

  if (!app) {
    log(`+ app "${appSpec.name}" (${slug})`);
    stats.appsCreated++;
    if (!DRY_RUN) {
      app = await client.createApp({
        name: appSpec.name,
        landingUrl: appSpec.landingUrl,
        tags: appSpec.tags ?? [],
        intervalMinutes: appSpec.intervalMinutes ?? 5,
      });
    } else {
      app = { id: null, name: appSpec.name, checks: [] };
    }
  } else {
    const patch = appNeedsUpdate(app, appSpec);
    if (Object.keys(patch).length > 0) {
      log(`~ app "${appSpec.name}": ${Object.keys(patch).join(', ')}`);
      stats.appsUpdated++;
      if (!DRY_RUN) app = await client.updateApp(app.id, patch);
    } else {
      log(`= app "${appSpec.name}" (unchanged)`);
    }
  }

  const existingChecks = app.id ? await client.listChecks(app.id) : (app.checks ?? []);
  const desired = [
    ...journeyChecks.map((j) => ({ name: j.name, body: journeyCheckBody(j.name, j.specSource) })),
    ...uptimeChecks.map((u) => ({ name: u.name, body: uptimeCheckBody(u) })),
  ];
  const desiredNames = new Set(desired.map((d) => d.name));

  for (const { name, body } of desired) {
    const existingCheck = existingChecks.find((c) => c.name === name);
    if (!existingCheck) {
      log(`  + check "${name}" (${body.type})`);
      stats.checksCreated++;
      if (!DRY_RUN && app.id) await client.createCheck(app.id, body);
    } else {
      const patch = checkNeedsUpdate(existingCheck, body);
      if (Object.keys(patch).length > 0) {
        log(`  ~ check "${name}": ${Object.keys(patch).join(', ')}`);
        stats.checksUpdated++;
        if (!DRY_RUN) await client.updateCheck(existingCheck.id, patch);
      } else {
        log(`  = check "${name}" (unchanged)`);
      }
    }
  }

  if (PRUNE) {
    for (const c of existingChecks) {
      if (!desiredNames.has(c.name)) {
        log(`  - check "${c.name}" (not in files, pruning)`);
        stats.checksPruned++;
        if (!DRY_RUN) await client.removeCheck(c.id);
      }
    }
  }
}

async function main() {
  const targets = await discoverTargets();
  if (targets.length === 0) {
    log(`No targets found under ${path.relative(process.cwd(), TARGETS_DIR)}/ — see targets/README.md.`);
    return;
  }
  const token = await login();
  const client = makeClient(token);
  const stats = { appsCreated: 0, appsUpdated: 0, checksCreated: 0, checksUpdated: 0, checksPruned: 0 };

  for (const target of targets) {
    await syncTarget(client, target, stats);
  }

  log('');
  log(
    `${DRY_RUN ? '[dry run] ' : ''}apps: +${stats.appsCreated} ~${stats.appsUpdated} · ` +
      `checks: +${stats.checksCreated} ~${stats.checksUpdated} -${stats.checksPruned}`,
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((err) => fail(err.stack ?? err.message));
}
