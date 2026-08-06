// POST /checks/dry-run route contract (worker-side execution is covered by the
// worker e2e suite; here the MockScheduler stands in for the queue round-trip).
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
let token: string;
let appId: string;

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await closeTestApp(ctx);
});

beforeEach(async () => {
  await resetDb(ctx);
  ctx.scheduler.dryRunCalls = [];
  token = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/apps',
    headers: authHeader(token),
    payload: { name: 'Dry', landingUrl: 'https://dry.example.com' },
  });
  appId = created.json().id;
});

describe('POST /checks/dry-run', () => {
  it('validates, forwards the inlined config to the scheduler, and returns the inline result', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/checks/dry-run',
      headers: authHeader(token),
      payload: {
        appId,
        type: 'journey',
        config: { specSource: "await page.goto('https://example.com');" },
        timeoutMs: 20_000,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'passed', durationMs: 42, metrics: null, errorMessage: null });

    expect(ctx.scheduler.dryRunCalls).toHaveLength(1);
    expect(ctx.scheduler.dryRunCalls[0]).toMatchObject({
      dryRun: true,
      appId,
      type: 'journey',
      timeoutMs: 20_000,
    });
  });

  it('rejects an unknown app and an invalid config', async () => {
    const unknownApp = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/checks/dry-run',
      headers: authHeader(token),
      payload: {
        appId: '99999999-9999-4999-8999-999999999999',
        type: 'uptime',
        config: { expectedStatus: 200, screenshot: 'never' },
      },
    });
    expect(unknownApp.statusCode).toBe(404);

    const badConfig = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/checks/dry-run',
      headers: authHeader(token),
      payload: { appId, type: 'journey', config: { nope: true } },
    });
    expect(badConfig.statusCode).toBe(400);

    const unauth = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/checks/dry-run',
      payload: { appId, type: 'uptime', config: { expectedStatus: 200, screenshot: 'never' } },
    });
    expect(unauth.statusCode).toBe(401);
  });
});
