// Public status page. The whole risk of this feature is leaking something, so
// most of these assert what is NOT exposed rather than what is.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_KEYS } from '@vyzus/shared';
import { applications, checks, incidents, runs, settings } from '../db/schema.js';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await buildTestApp();
});
afterAll(async () => {
  await closeTestApp(ctx);
});
beforeEach(async () => {
  await resetDb(ctx);
});

async function seedApp(opts: { name: string; isPublic: boolean; failing?: boolean }) {
  const db = ctx.dbHandle.db;
  const [app] = await db
    .insert(applications)
    .values({
      name: opts.name,
      landingUrl: `https://internal-${opts.name}.corp.example.com/secret-path`,
      tags: [],
      isPublic: opts.isPublic,
    })
    .returning();
  const [check] = await db
    .insert(checks)
    .values({
      appId: app!.id,
      type: 'uptime',
      name: 'Internal check name',
      intervalMinutes: 5,
      lastStatus: opts.failing ? 'failed' : 'passed',
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
  return { app: app!, check: check! };
}

const get = () => ctx.app.inject({ method: 'GET', url: '/api/v1/status' });

describe('GET /status', () => {
  it('is reachable with no authentication at all', async () => {
    await seedApp({ name: 'Public', isPublic: true });
    const res = await get();
    expect(res.statusCode).toBe(200);
  });

  it('lists only applications explicitly marked public', async () => {
    await seedApp({ name: 'Public', isPublic: true });
    await seedApp({ name: 'Private', isPublic: false });

    const body = get().then((r) => r.json());
    const page = await body;
    expect(page.applications.map((a: { name: string }) => a.name)).toEqual(['Public']);
    // And the private one leaks nowhere in the payload, not even by name.
    expect(JSON.stringify(page)).not.toContain('Private');
  });

  // Landing URLs are frequently internal; check names describe topology.
  it('never exposes landing URLs or check names', async () => {
    await seedApp({ name: 'Public', isPublic: true });
    const page = (await get()).json();
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('internal-Public.corp.example.com');
    expect(serialized).not.toContain('secret-path');
    expect(serialized).not.toContain('Internal check name');
  });

  // Error text routinely carries internal hostnames and stack traces.
  it('never exposes run error messages through incidents', async () => {
    const { app, check } = await seedApp({ name: 'Public', isPublic: true, failing: true });
    const [run] = await ctx.dbHandle.db
      .insert(runs)
      .values({
        checkId: check.id,
        status: 'failed',
        trigger: 'schedule',
        startedAt: new Date(),
        durationMs: 10,
        errorMessage: 'connect ECONNREFUSED 10.0.0.5:5432 — postgres-primary.internal',
      })
      .returning();
    await ctx.dbHandle.db.insert(incidents).values({ checkId: check.id, openedAt: new Date(), openingRunId: run!.id });

    const page = (await get()).json();
    expect(page.recentIncidents).toHaveLength(1);
    expect(page.recentIncidents[0].appName).toBe('Public');
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('postgres-primary.internal');
    expect(serialized).not.toContain('10.0.0.5');
    void app;
  });

  it('excludes incidents belonging to private applications', async () => {
    const { check } = await seedApp({ name: 'Private', isPublic: false, failing: true });
    await ctx.dbHandle.db.insert(incidents).values({ checkId: check.id, openedAt: new Date() });
    const page = (await get()).json();
    expect(page.recentIncidents).toHaveLength(0);
  });

  it('reports the worst status across public applications as the headline', async () => {
    await seedApp({ name: 'Healthy', isPublic: true });
    await seedApp({ name: 'Broken', isPublic: true, failing: true });
    const page = (await get()).json();
    expect(page.overall).toBe('DOWN');
  });

  it('uses the configured title', async () => {
    await ctx.dbHandle.db.insert(settings).values({ key: SETTINGS_KEYS.statusPageTitle, value: 'Acme status' });
    await seedApp({ name: 'Public', isPublic: true });
    expect((await get()).json().title).toBe('Acme status');
  });

  it('returns an empty page rather than failing when nothing is public', async () => {
    await seedApp({ name: 'Private', isPublic: false });
    const page = (await get()).json();
    expect(page.applications).toEqual([]);
    expect(page.recentIncidents).toEqual([]);
  });
});
