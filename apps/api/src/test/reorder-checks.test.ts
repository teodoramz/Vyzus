// PUT /apps/:id/checks/order — persists check tab / "run all" order.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
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
    // About ordering, not the starter set — opt out and create the single
    // baseline check this suite is written against, so a change to the
    // defaults cannot reshuffle its expectations.
    payload: { name: 'Shop', landingUrl: 'https://shop.example.com', createDefaultChecks: false },
  });
  expect(res.statusCode).toBe(201);
  const created = res.json();

  const check = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${created.id}/checks`,
    headers: authHeader(adminToken),
    payload: {
      type: 'uptime',
      name: 'Landing uptime',
      intervalMinutes: 5,
      timeoutMs: 30000,
      failureThreshold: 2,
      enabled: true,
      config: {
        mode: 'http',
        expectedStatus: 200,
        screenshot: 'on_change',
        maxDurationMs: 0,
        visualDiffPercent: 0,
        certExpiryWarningDays: 0,
      },
    },
  });
  expect(check.statusCode).toBe(201);
  return { ...created, checks: [check.json()] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function addJourneyCheck(appId: string, name: string): Promise<any> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${appId}/checks`,
    headers: authHeader(adminToken),
    payload: {
      type: 'journey',
      name,
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

describe('PUT /apps/:id/checks/order', () => {
  it('new checks append after existing ones and GET routes reflect the new order', async () => {
    const app = await createApp();
    const b = await addJourneyCheck(app.id, 'B');
    const c = await addJourneyCheck(app.id, 'C');
    // default uptime check ("Landing uptime") was created first -> [uptime, B, C]

    const listRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}/checks`,
      headers: authHeader(adminToken),
    });
    expect(listRes.json().map((c: { name: string }) => c.name)).toEqual(['Landing uptime', 'B', 'C']);

    // Reorder to [C, uptime, B]
    const reordered = [c.id, app.checks[0].id, b.id];
    const putRes = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${app.id}/checks/order`,
      headers: authHeader(adminToken),
      payload: { checkIds: reordered },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().map((c: { id: string }) => c.id)).toEqual(reordered);

    // GET /apps/:id/checks reflects the new order
    const listRes2 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}/checks`,
      headers: authHeader(adminToken),
    });
    expect(listRes2.json().map((c: { name: string }) => c.name)).toEqual(['C', 'Landing uptime', 'B']);

    // GET /apps/:id (app detail) also reflects the new order
    const detailRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}`,
      headers: authHeader(adminToken),
    });
    expect(detailRes.json().checks.map((c: { name: string }) => c.name)).toEqual(['C', 'Landing uptime', 'B']);
  });

  it("rejects a checkIds set that does not match the app's actual checks", async () => {
    const app = await createApp();
    const other = await createApp();

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${app.id}/checks/order`,
      headers: authHeader(adminToken),
      payload: { checkIds: [other.checks[0].id] }, // belongs to a different app
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ORDER');
  });

  it('requires authentication', async () => {
    const app = await createApp();
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${app.id}/checks/order`,
      payload: { checkIds: [app.checks[0].id] },
    });
    expect(res.statusCode).toBe(401);
  });
});
