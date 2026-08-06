// Viewer role + per-app assignment (docs/02-architecture §7 extension).
// Security-critical: an unassigned viewer must see nothing, an assigned
// viewer gets full read + run-now/screenshot-now but zero edit surface, and
// editor's exclusion from channel management must not have regressed.
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

async function createUser(email: string, role: 'admin' | 'editor' | 'viewer'): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: authHeader(adminToken),
    payload: { email, password: 'password123', role },
  });
  expect(res.statusCode).toBe(201);
  const loginRes = await login(ctx.app, email, 'password123');
  return loginRes.accessToken;
}

async function assignApps(userId: string, appIds: string[]): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/users/${userId}/apps`,
    headers: authHeader(adminToken),
    payload: { appIds },
  });
  expect(res.statusCode).toBe(200);
}

async function userId(email: string): Promise<string> {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: authHeader(adminToken) });
  const found = res.json().find((u: { email: string }) => u.email === email);
  expect(found).toBeDefined();
  return found.id;
}

describe('viewer role: app scoping', () => {
  it('an unassigned viewer sees no apps, and cannot fetch one by id', async () => {
    const app = await createApp('Shop');
    const viewerToken = await createUser('viewer1@example.com', 'viewer');

    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/apps', headers: authHeader(viewerToken) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}`,
      headers: authHeader(viewerToken),
    });
    expect(detail.statusCode).toBe(403);
  });

  it('an assigned viewer sees the app, its checks, and its runs', async () => {
    const app = await createApp('Shop');
    const viewerToken = await createUser('viewer2@example.com', 'viewer');
    await assignApps(await userId('viewer2@example.com'), [app.id]);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/apps', headers: authHeader(viewerToken) });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].id).toBe(app.id);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}`,
      headers: authHeader(viewerToken),
    });
    expect(detail.statusCode).toBe(200);

    const checksRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}/checks`,
      headers: authHeader(viewerToken),
    });
    expect(checksRes.statusCode).toBe(200);
    expect(checksRes.json()).toHaveLength(1);

    const runsRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}/runs`,
      headers: authHeader(viewerToken),
    });
    expect(runsRes.statusCode).toBe(200);
  });

  it('a viewer cannot see a different (unassigned) app even by direct id', async () => {
    const shop = await createApp('Shop');
    const blog = await createApp('Blog');
    const viewerToken = await createUser('viewer3@example.com', 'viewer');
    await assignApps(await userId('viewer3@example.com'), [shop.id]);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${blog.id}`,
      headers: authHeader(viewerToken),
    });
    expect(res.statusCode).toBe(403);

    const checksRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${blog.id}/checks`,
      headers: authHeader(viewerToken),
    });
    expect(checksRes.statusCode).toBe(403);
  });

  it('an assigned viewer can run-now and screenshot-now, but cannot edit or create checks/apps, and cannot dry-run', async () => {
    const app = await createApp('Shop');
    const viewerToken = await createUser('viewer4@example.com', 'viewer');
    await assignApps(await userId('viewer4@example.com'), [app.id]);
    const checkId = app.checks[0].id;

    const runNow = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/checks/${checkId}/run`,
      headers: authHeader(viewerToken),
    });
    expect(runNow.statusCode).toBe(202);

    const shotNow = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${app.id}/screenshot`,
      headers: authHeader(viewerToken),
    });
    expect(shotNow.statusCode).toBe(202);

    const editCheck = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/checks/${checkId}`,
      headers: authHeader(viewerToken),
      payload: { enabled: false },
    });
    expect(editCheck.statusCode).toBe(403);

    const createCheck = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${app.id}/checks`,
      headers: authHeader(viewerToken),
      payload: {
        type: 'journey',
        name: 'x',
        intervalMinutes: 5,
        timeoutMs: 30000,
        failureThreshold: 2,
        enabled: true,
        config: { specSource: 'await page.goto("https://x.example.com");' },
      },
    });
    expect(createCheck.statusCode).toBe(403);

    const editApp = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/apps/${app.id}`,
      headers: authHeader(viewerToken),
      payload: { name: 'Renamed' },
    });
    expect(editApp.statusCode).toBe(403);

    const dryRun = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/checks/dry-run',
      headers: authHeader(viewerToken),
      payload: { appId: app.id, type: 'uptime', timeoutMs: 5000, config: { expectedStatus: 200, screenshot: 'never' } },
    });
    expect(dryRun.statusCode).toBe(403);
  });

  it('a viewer cannot run-now a check belonging to an app they are not assigned to', async () => {
    const shop = await createApp('Shop');
    const blog = await createApp('Blog');
    const viewerToken = await createUser('viewer5@example.com', 'viewer');
    await assignApps(await userId('viewer5@example.com'), [shop.id]);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/checks/${blog.checks[0].id}/run`,
      headers: authHeader(viewerToken),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('viewer role: self-service alert channels', () => {
  it('a viewer can create a channel scoped to their own apps, but not with allApps or an unassigned app', async () => {
    const app = await createApp('Shop');
    const other = await createApp('Blog');
    const viewerToken = await createUser('viewer6@example.com', 'viewer');
    await assignApps(await userId('viewer6@example.com'), [app.id]);

    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: authHeader(viewerToken),
      payload: {
        name: 'My Slack',
        type: 'webhook',
        config: { url: 'https://hooks.example.com/x' },
        allApps: false,
        appIds: [app.id],
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().ownerId).toBeDefined();

    const allAppsAttempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: authHeader(viewerToken),
      payload: {
        name: 'All',
        type: 'webhook',
        config: { url: 'https://hooks.example.com/y' },
        allApps: true,
        appIds: [],
      },
    });
    expect(allAppsAttempt.statusCode).toBe(403);

    const unassignedAttempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: authHeader(viewerToken),
      payload: {
        name: 'Sneaky',
        type: 'webhook',
        config: { url: 'https://hooks.example.com/z' },
        allApps: false,
        appIds: [other.id],
      },
    });
    expect(unassignedAttempt.statusCode).toBe(400);
  });

  it("a viewer cannot see or modify another user's channel, including admin-created global ones", async () => {
    const app = await createApp('Shop');
    const globalChannel = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: authHeader(adminToken),
      payload: {
        name: 'Global',
        type: 'webhook',
        config: { url: 'https://hooks.example.com/g' },
        allApps: true,
        appIds: [],
      },
    });
    expect(globalChannel.statusCode).toBe(201);

    const viewerAToken = await createUser('viewer-a@example.com', 'viewer');
    await assignApps(await userId('viewer-a@example.com'), [app.id]);
    const ownChannel = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: authHeader(viewerAToken),
      payload: {
        name: 'Mine',
        type: 'webhook',
        config: { url: 'https://hooks.example.com/a' },
        allApps: false,
        appIds: [app.id],
      },
    });
    expect(ownChannel.statusCode).toBe(201);

    const viewerBToken = await createUser('viewer-b@example.com', 'viewer');
    await assignApps(await userId('viewer-b@example.com'), [app.id]);

    // viewerB's list only shows their own (none) — never viewerA's or the global one.
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/channels', headers: authHeader(viewerBToken) });
    expect(list.json()).toEqual([]);

    // viewerB cannot touch viewerA's channel or the global one.
    const editOthers = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/channels/${ownChannel.json().id}`,
      headers: authHeader(viewerBToken),
      payload: { name: 'Hijacked' },
    });
    expect(editOthers.statusCode).toBe(403);

    const editGlobal = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/channels/${globalChannel.json().id}`,
      headers: authHeader(viewerBToken),
      payload: { name: 'Hijacked' },
    });
    expect(editGlobal.statusCode).toBe(403);
  });

  it('editor is excluded from channel management entirely, unchanged from before viewers existed', async () => {
    const editorToken = await createUser('editor1@example.com', 'editor');
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/channels', headers: authHeader(editorToken) });
    expect(list.statusCode).toBe(403);

    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: authHeader(editorToken),
      payload: {
        name: 'X',
        type: 'webhook',
        config: { url: 'https://hooks.example.com/e' },
        allApps: true,
        appIds: [],
      },
    });
    expect(create.statusCode).toBe(403);
  });

  it('admin retains full access to every channel, including viewer-owned ones', async () => {
    const app = await createApp('Shop');
    const viewerToken = await createUser('viewer-c@example.com', 'viewer');
    await assignApps(await userId('viewer-c@example.com'), [app.id]);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: authHeader(viewerToken),
      payload: {
        name: 'Mine',
        type: 'webhook',
        config: { url: 'https://hooks.example.com/c' },
        allApps: false,
        appIds: [app.id],
      },
    });

    const asAdmin = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/channels/${created.json().id}/deliveries`,
      headers: authHeader(adminToken),
    });
    expect(asAdmin.statusCode).toBe(200);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/channels', headers: authHeader(adminToken) });
    expect(list.json().some((c: { id: string }) => c.id === created.json().id)).toBe(true);
  });
});
