// GET /incidents — the global, cross-app Incidents tab. Keyset-paginated,
// carries denormalized appId/appName/checkName, supports ?open= and ?appId=.
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { incidents } from '../db/schema.js';
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
async function createApp(name: string): Promise<any> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/apps',
    headers: authHeader(adminToken),
    payload: { name, landingUrl: 'https://shop.example.com' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function insertIncident(checkId: string, openedAt: Date, resolvedAt: Date | null = null): Promise<string> {
  const id = randomUUID();
  await ctx.dbHandle.db.insert(incidents).values({ id, checkId, openedAt, resolvedAt });
  return id;
}

describe('GET /incidents', () => {
  it('returns denormalized appName/checkName, newest first', async () => {
    const app = await createApp('Shop');
    const checkId = app.checks[0].id;
    const t0 = new Date('2026-01-01T00:00:00Z');
    // Only one open incident per check is allowed (partial unique index) — the
    // older one must be resolved.
    await insertIncident(checkId, t0, new Date(t0.getTime() + 500));
    const newer = await insertIncident(checkId, new Date(t0.getTime() + 1000));

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/incidents', headers: authHeader(adminToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.incidents).toHaveLength(2);
    expect(body.incidents[0].id).toBe(newer);
    expect(body.incidents[0].appName).toBe('Shop');
    expect(body.incidents[0].checkName).toBe('Landing uptime');
  });

  it('filters to open-only', async () => {
    const app = await createApp('Shop');
    const checkId = app.checks[0].id;
    const t0 = new Date('2026-01-01T00:00:00Z');
    const openId = await insertIncident(checkId, t0);
    await insertIncident(checkId, new Date(t0.getTime() + 1000), new Date(t0.getTime() + 2000));

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/incidents?open=true',
      headers: authHeader(adminToken),
    });
    const body = res.json();
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0].id).toBe(openId);
  });

  it('paginates with a cursor', async () => {
    const app = await createApp('Shop');
    const checkId = app.checks[0].id;
    const t0 = new Date('2026-01-01T00:00:00Z');
    // Only the last is left open — the partial unique index allows at most
    // one open incident per check.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const openedAt = new Date(t0.getTime() + i * 1000);
      const resolvedAt = i < 2 ? new Date(openedAt.getTime() + 500) : null;
      ids.push(await insertIncident(checkId, openedAt, resolvedAt));
    }

    const page1 = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/incidents?limit=2',
      headers: authHeader(adminToken),
    });
    const body1 = page1.json();
    expect(body1.incidents.map((i: { id: string }) => i.id)).toEqual([ids[2], ids[1]]);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/incidents?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: authHeader(adminToken),
    });
    const body2 = page2.json();
    expect(body2.incidents.map((i: { id: string }) => i.id)).toEqual([ids[0]]);
    expect(body2.nextCursor).toBeNull();
  });

  it('filters by appId, scoping strictly to that app', async () => {
    const app1 = await createApp('Shop');
    const app2 = await createApp('Blog');
    await insertIncident(app1.checks[0].id, new Date());
    const blogIncident = await insertIncident(app2.checks[0].id, new Date());

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/incidents?appId=${app2.id}`,
      headers: authHeader(adminToken),
    });
    const body = res.json();
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0].id).toBe(blogIncident);
  });
});
