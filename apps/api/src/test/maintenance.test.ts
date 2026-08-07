// Maintenance window routes. The suppression behaviour itself is covered in
// alerter.test.ts; this covers who may create what, and the derived `active`
// flag the dashboard banner reads.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applications } from '../db/schema.js';
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
let appId: string;

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await closeTestApp(ctx);
});

beforeEach(async () => {
  await resetDb(ctx);
  adminToken = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
  const [app] = await ctx.dbHandle.db
    .insert(applications)
    .values({ name: 'Shop', landingUrl: 'https://shop.example.com', tags: [] })
    .returning();
  appId = app!.id;
});

function create(body: Record<string, unknown>, token = adminToken) {
  return ctx.app.inject({ method: 'POST', url: '/api/v1/maintenance', headers: authHeader(token), payload: body });
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('maintenance windows', () => {
  it('creates a window and reports it active while it is running', async () => {
    const res = await create({ appId, reason: 'deploy', startsAt: iso(-60_000), endsAt: iso(60_000) });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.active).toBe(true);
    expect(body.appName).toBe('Shop');
    expect(body.createdByEmail).toBe(ADMIN_EMAIL);
  });

  it('reports a future window as not active', async () => {
    const res = await create({ appId, reason: 'later', startsAt: iso(60_000), endsAt: iso(120_000) });
    expect(res.json().active).toBe(false);
  });

  it('rejects a window that ends before it starts', async () => {
    const res = await create({ appId, reason: 'backwards', startsAt: iso(60_000), endsAt: iso(-60_000) });
    expect(res.statusCode).toBe(400);
  });

  it('/active returns only the windows suppressing right now', async () => {
    await create({ appId, reason: 'now', startsAt: iso(-60_000), endsAt: iso(60_000) });
    await create({ appId, reason: 'later', startsAt: iso(60_000), endsAt: iso(120_000) });
    await create({ appId, reason: 'past', startsAt: iso(-120_000), endsAt: iso(-60_000) });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/maintenance/active',
      headers: authHeader(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { reason: string }[];
    expect(rows.map((r) => r.reason)).toEqual(['now']);
  });

  it('deleting a window ends the suppression immediately', async () => {
    const created = await create({ appId, reason: 'deploy', startsAt: iso(-60_000), endsAt: iso(60_000) });
    const id = created.json().id;

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/maintenance/${id}`,
      headers: authHeader(adminToken),
    });
    expect(del.statusCode).toBe(204);

    const active = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/maintenance/active',
      headers: authHeader(adminToken),
    });
    expect(active.json()).toHaveLength(0);
  });

  // Silencing every application at once is a bigger decision than silencing
  // one an editor already manages.
  it('requires admin for a platform-wide window', async () => {
    const editor = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(adminToken),
      payload: { email: 'editor@example.com', password: 'editor-password-1', role: 'editor' },
    });
    expect(editor.statusCode).toBe(201);
    const editorToken = (await login(ctx.app, 'editor@example.com', 'editor-password-1')).accessToken;

    const scoped = await create(
      { appId, reason: 'ok for an editor', startsAt: iso(0), endsAt: iso(60_000) },
      editorToken,
    );
    expect(scoped.statusCode).toBe(201);

    const global = await create(
      { appId: null, reason: 'everything', startsAt: iso(0), endsAt: iso(60_000) },
      editorToken,
    );
    expect(global.statusCode).toBe(403);

    const asAdmin = await create({ appId: null, reason: 'everything', startsAt: iso(0), endsAt: iso(60_000) });
    expect(asAdmin.statusCode).toBe(201);
    expect(asAdmin.json().appId).toBeNull();
  });

  it('requires authentication', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/maintenance' });
    expect(res.statusCode).toBe(401);
  });
});
