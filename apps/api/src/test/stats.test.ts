// Phase 7: GET /stats aggregates + throttled WS stats.updated.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { RUN_FINISHED_CHANNEL } from '@vyzus/shared';
import { applications, checks, incidents, runs } from '../db/schema.js';
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
let token: string;

beforeAll(async () => {
  ctx = await buildTestApp();
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await closeTestApp(ctx);
});

beforeEach(async () => {
  await resetDb(ctx);
  token = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
});

/** Insert an app with a single uptime check at a given last_status/enabled. */
async function makeApp(name: string, lastStatus: 'passed' | 'failed' | null, enabled = true) {
  const [app] = await ctx.dbHandle.db
    .insert(applications)
    .values({ name, landingUrl: `https://${name}.example.com`, tags: [], enabled })
    .returning();
  await ctx.dbHandle.db.insert(checks).values({
    appId: app!.id,
    type: 'uptime',
    name: 'U',
    intervalMinutes: 5,
    enabled,
    lastStatus,
    lastRunAt: lastStatus ? new Date() : null,
    config: { mode: 'http', expectedStatus: 200, maxDurationMs: 0, screenshot: 'on_failure' },
  });
  return app!;
}

describe('GET /stats', () => {
  it('counts an app with one failing and one passing check as degraded, not down', async () => {
    const app = await makeApp('mixed', 'passed');
    await ctx.dbHandle.db.insert(checks).values({
      appId: app.id,
      type: 'uptime',
      name: 'second',
      intervalMinutes: 5,
      lastStatus: 'failed',
      lastRunAt: new Date(),
      config: { mode: 'http', expectedStatus: 200, maxDurationMs: 0, screenshot: 'on_failure' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/stats', headers: authHeader(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().apps).toMatchObject({ total: 1, up: 0, degraded: 1, down: 0 });
  });

  it('returns app status counts, open incidents, queue depth, and runs in 24h', async () => {
    const up = await makeApp('up', 'passed');
    await makeApp('down', 'failed');
    await makeApp('paused', 'passed', false);
    await makeApp('unknown', null);

    // One open incident + a couple of runs in the last 24h.
    const [check] = await ctx.dbHandle.db.select().from(checks).where(eq(checks.appId, up.id));
    await ctx.dbHandle.db.insert(incidents).values({ checkId: check!.id, openedAt: new Date() });
    await ctx.dbHandle.db.insert(runs).values([
      { checkId: check!.id, status: 'passed', trigger: 'schedule', startedAt: new Date(), durationMs: 100 },
      { checkId: check!.id, status: 'failed', trigger: 'schedule', startedAt: new Date(), durationMs: 200 },
    ]);
    ctx.scheduler.queueDepth = 3;

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/stats', headers: authHeader(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apps: { total: 4, up: 1, degraded: 0, down: 1, paused: 1 },
      openIncidents: 1,
      queueDepth: 3,
      runsLast24h: 2,
      // Runs are fresh in this fixture, so the dead-man's switch is quiet.
      monitoringStalledSince: null,
    });
  });

  it('requires authentication', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/stats' });
    expect(res.statusCode).toBe(401);
  });

  it("scopes counts to a viewer's assigned apps only", async () => {
    const up = await makeApp('up', 'passed');
    const down = await makeApp('down', 'failed');
    void down;

    const [upCheck] = await ctx.dbHandle.db.select().from(checks).where(eq(checks.appId, up.id));
    await ctx.dbHandle.db.insert(incidents).values({ checkId: upCheck!.id, openedAt: new Date() });
    await ctx.dbHandle.db
      .insert(runs)
      .values({ checkId: upCheck!.id, status: 'passed', trigger: 'schedule', startedAt: new Date(), durationMs: 50 });

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(token),
      payload: { email: 'stats-viewer@example.com', password: 'password123', role: 'viewer' },
    });
    expect(createRes.statusCode).toBe(201);
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/users/${createRes.json().id}/apps`,
      headers: authHeader(token),
      payload: { appIds: [up.id] }, // NOT the down app
    });
    const { accessToken: viewerToken } = await login(ctx.app, 'stats-viewer@example.com', 'password123');

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/stats', headers: authHeader(viewerToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      apps: { total: 1, up: 1, degraded: 0, down: 0, paused: 0 },
      openIncidents: 1,
      runsLast24h: 1,
    });
  });
});

describe('WS stats.updated', () => {
  it('emits stats.updated to clients after a run.finished event', async () => {
    await makeApp('a', 'passed');
    await makeApp('b', 'failed');

    const { port } = ctx.app.server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 300));

    const statsMsg = new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no stats.updated')), 5000);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        if (msg.type === 'stats.updated') {
          clearTimeout(t);
          resolve(msg);
        }
      });
    });

    await ctx.redis.publish(
      RUN_FINISHED_CHANNEL,
      JSON.stringify({
        type: 'run.finished',
        appId: '11111111-1111-4111-8111-111111111111',
        checkId: '22222222-2222-4222-8222-222222222222',
        runId: '33333333-3333-4333-8333-333333333333',
        status: 'passed',
        durationMs: 10,
        hasScreenshot: false,
      }),
    );

    const stats = await statsMsg;
    expect(stats).toMatchObject({ type: 'stats.updated', up: 1, down: 1, openIncidents: 0 });
    socket.close();
  });
});
