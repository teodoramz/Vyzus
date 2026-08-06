// GET /apps/:id/runs — run history merged across every check of an
// application, with optional checkId/status filters and keyset pagination
// (mirrors GET /checks/:id/runs — see docs/04-api-spec.md).
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runs } from '../db/schema.js';
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

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await closeTestApp(ctx);
});

beforeEach(async () => {
  await resetDb(ctx);
  const res = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  adminToken = res.accessToken;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createApp(): Promise<any> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/apps',
    headers: authHeader(adminToken),
    payload: { name: 'Shop', landingUrl: 'https://shop.example.com' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function addJourneyCheck(appId: string): Promise<any> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${appId}/checks`,
    headers: authHeader(adminToken),
    payload: {
      type: 'journey',
      name: 'Login flow',
      intervalMinutes: 5,
      timeoutMs: 30000,
      failureThreshold: 2,
      enabled: true,
      config: { specSource: 'await page.goto("https://shop.example.com");' },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function insertRun(
  checkId: string,
  overrides: Partial<{ status: 'passed' | 'failed' | 'error' | 'timeout'; startedAt: Date }> = {},
): Promise<string> {
  const id = randomUUID();
  await ctx.dbHandle.db.insert(runs).values({
    id,
    checkId,
    status: overrides.status ?? 'passed',
    trigger: 'schedule',
    startedAt: overrides.startedAt ?? new Date(),
    durationMs: 100,
    workerId: 'test-worker',
  });
  return id;
}

describe('GET /apps/:id/runs', () => {
  it('merges runs across every check of the app, newest first', async () => {
    const app = await createApp();
    const uptimeCheckId = app.checks[0].id;
    const journey = await addJourneyCheck(app.id);

    const t0 = new Date('2026-01-01T00:00:00Z');
    const uptimeRun = await insertRun(uptimeCheckId, { startedAt: new Date(t0.getTime() + 1000) });
    const journeyRun = await insertRun(journey.id, { startedAt: new Date(t0.getTime() + 2000) });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}/runs`,
      headers: authHeader(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(2);
    // newest (journey) first
    expect(body.runs[0].id).toBe(journeyRun);
    expect(body.runs[0].checkName).toBe('Login flow');
    expect(body.runs[0].checkType).toBe('journey');
    expect(body.runs[1].id).toBe(uptimeRun);
    expect(body.runs[1].checkName).toBe('Landing uptime');
    expect(body.runs[1].checkType).toBe('uptime');
  });

  it('filters by checkId', async () => {
    const app = await createApp();
    const uptimeCheckId = app.checks[0].id;
    const journey = await addJourneyCheck(app.id);
    await insertRun(uptimeCheckId);
    const journeyRun = await insertRun(journey.id);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}/runs?checkId=${journey.id}`,
      headers: authHeader(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe(journeyRun);
  });

  it('filters by status', async () => {
    const app = await createApp();
    const uptimeCheckId = app.checks[0].id;
    await insertRun(uptimeCheckId, { status: 'passed' });
    const failedRun = await insertRun(uptimeCheckId, { status: 'failed' });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}/runs?status=failed`,
      headers: authHeader(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe(failedRun);
  });

  it('paginates with a cursor across checks', async () => {
    const app = await createApp();
    const uptimeCheckId = app.checks[0].id;
    const journey = await addJourneyCheck(app.id);
    const t0 = new Date('2026-01-01T00:00:00Z');
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const checkId = i % 2 === 0 ? uptimeCheckId : journey.id;
      ids.push(await insertRun(checkId, { startedAt: new Date(t0.getTime() + i * 1000) }));
    }

    const page1 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}/runs?limit=2`,
      headers: authHeader(adminToken),
    });
    const body1 = page1.json();
    expect(body1.runs).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();
    expect(body1.runs.map((r: { id: string }) => r.id)).toEqual([ids[4], ids[3]]);

    const page2 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}/runs?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: authHeader(adminToken),
    });
    const body2 = page2.json();
    expect(body2.runs.map((r: { id: string }) => r.id)).toEqual([ids[2], ids[1]]);
  });

  it('scopes strictly to the requested app — an unrelated app has no runs', async () => {
    const app = await createApp();
    const other = await createApp();
    await insertRun(app.checks[0].id);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${other.id}/runs`,
      headers: authHeader(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toHaveLength(0);
  });
});
