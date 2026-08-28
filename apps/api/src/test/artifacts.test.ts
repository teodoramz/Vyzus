// GET /runs/:id/artifacts/{screenshot,trace} — the only routes that serve files
// off disk. Paths come from the database, but the row is written by the worker
// from data the monitored site influences, so the traversal guard matters.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applications, checks, runs } from '../db/schema.js';
import {
  buildTestApp,
  closeTestApp,
  resetDb,
  login,
  authHeader,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let adminToken: string;
let artifactsRoot: string;

beforeAll(async () => {
  artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vyzus-artifacts-'));
  ctx = await buildTestApp({ ARTIFACTS_DIR: artifactsRoot });
});

afterAll(async () => {
  await closeTestApp(ctx);
  await fs.rm(artifactsRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb(ctx);
  // The artifacts directory is part of the isolation boundary too: truncating
  // the tables alone leaves one test's files on disk for the next one to find.
  await fs.rm(artifactsRoot, { recursive: true, force: true });
  await fs.mkdir(artifactsRoot, { recursive: true });
  adminToken = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
});

/** A run row plus, optionally, the files its columns point at. */
async function seedRun(opts: { screenshot?: string | null; trace?: string | null; writeFiles?: boolean } = {}) {
  const db = ctx.dbHandle.db;
  const [app] = await db
    .insert(applications)
    .values({ name: 'App', landingUrl: 'https://example.com', tags: [] })
    .returning();
  const [check] = await db
    .insert(checks)
    .values({
      appId: app!.id,
      type: 'uptime',
      name: 'Landing',
      intervalMinutes: 5,
      config: {
        mode: 'http',
        expectedStatus: 200,
        maxDurationMs: 0,
        visualDiffPercent: 0,
        certExpiryWarningDays: 0,
        screenshot: 'never',
      },
    })
    .returning();
  const [run] = await db
    .insert(runs)
    .values({
      checkId: check!.id,
      status: 'passed',
      trigger: 'schedule',
      startedAt: new Date(),
      durationMs: 10,
      screenshotPath: opts.screenshot ?? null,
      tracePath: opts.trace ?? null,
    })
    .returning();

  if (opts.writeFiles !== false) {
    for (const rel of [opts.screenshot, opts.trace]) {
      if (!rel) continue;
      const abs = path.join(artifactsRoot, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, `bytes of ${path.basename(rel)}`);
    }
  }
  return run!;
}

const get = (runId: string, kind: string, token = adminToken) =>
  ctx.app.inject({
    method: 'GET',
    url: `/api/v1/runs/${runId}/artifacts/${kind}`,
    headers: authHeader(token),
  });

describe('artifact streaming', () => {
  it('streams a screenshot as an image', async () => {
    const run = await seedRun({ screenshot: 'app/run/screenshot.png' });
    const res = await get(run.id, 'screenshot');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.body).toBe('bytes of screenshot.png');
  });

  // A zip rendered inline is a browser deciding what to do with an archive the
  // monitored site influenced; force the download instead.
  it('streams a trace as an attachment', async () => {
    const run = await seedRun({ trace: 'app/run/trace.zip' });
    const res = await get(run.id, 'trace');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="trace-${run.id}.zip"`);
  });

  it('404s when the run has no artifact of that kind', async () => {
    const run = await seedRun({ screenshot: 'app/run/screenshot.png' });
    expect((await get(run.id, 'trace')).statusCode).toBe(404);
  });

  // Retention deletes files but leaves the row, so this is the ordinary state
  // of an old run rather than an error condition.
  it('404s when the row points at a file that is gone', async () => {
    const run = await seedRun({ screenshot: 'app/run/screenshot.png', writeFiles: false });
    expect((await get(run.id, 'screenshot')).statusCode).toBe(404);
  });

  it('404s for an unknown run', async () => {
    expect((await get('00000000-0000-4000-8000-000000000000', 'screenshot')).statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const run = await seedRun({ screenshot: 'app/run/screenshot.png' });
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${run.id}/artifacts/screenshot` });
    expect(res.statusCode).toBe(401);
  });

  // The stored path is data, so it gets treated as untrusted: anything that
  // resolves outside ARTIFACTS_DIR is refused rather than served.
  it.each([
    ['../../../../etc/passwd', 'a relative escape'],
    ['app/../../../../etc/passwd', 'an escape after a valid segment'],
    ['/etc/passwd', 'an absolute path'],
  ])('refuses to serve %s (%s)', async (stored) => {
    const run = await seedRun({ screenshot: stored, writeFiles: false });
    const res = await get(run.id, 'screenshot');

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('root:');
  });
});
