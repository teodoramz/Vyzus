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
  ctx.scheduler.syncCalls = [];
  ctx.scheduler.removeCalls = [];
  ctx.scheduler.removeAppCalls = [];
  ctx.scheduler.enqueueCalls = [];
  const res = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  adminToken = res.accessToken;
});

describe('health', () => {
  it('reports db and redis up', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: true, redis: true });
  });
});

describe('first-boot setup', () => {
  // These tests deliberately truncate WITHOUT re-seeding an admin, to
  // reproduce a genuinely fresh install (the shared beforeEach always seeds
  // one, which is the post-setup state).
  async function emptyDb(): Promise<void> {
    await ctx.dbHandle.sql.unsafe('TRUNCATE users RESTART IDENTITY CASCADE');
  }

  it('reports needsSetup only while there are no users', async () => {
    await emptyDb();
    const fresh = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/setup-status' });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toEqual({ needsSetup: true });

    await resetDb(ctx); // seeds the admin again
    const seeded = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/setup-status' });
    expect(seeded.json()).toEqual({ needsSetup: false });
  });

  it('creates the first admin and returns a usable session', async () => {
    await emptyDb();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'founder@example.com', password: 'setup-password-1' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe('founder@example.com');
    expect(body.user.role).toBe('admin');
    expect(res.cookies.find((c) => c.name === 'refreshToken')?.value).toBeTruthy();

    // The returned token must actually work on an admin-only route.
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: authHeader(body.accessToken),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toHaveLength(1);
  });

  it('refuses a second setup once any user exists', async () => {
    await emptyDb();
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'founder@example.com', password: 'setup-password-1' },
    });
    expect(first.statusCode).toBe(201);

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'attacker@example.com', password: 'setup-password-2' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('SETUP_ALREADY_DONE');
  });

  it('rejects a too-short password', async () => {
    await emptyDb();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'founder@example.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('auth', () => {
  it('logs in the seeded admin', async () => {
    const res = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    const body = res.body as { accessToken: string; user: { email: string; role: string } };
    expect(body.accessToken).toBeTruthy();
    expect(body.user.email).toBe(ADMIN_EMAIL);
    expect(body.user.role).toBe('admin');
    expect(res.refreshCookie).toBeTruthy();
  });

  // The refresh cookie's Secure flag follows PUBLIC_URL's scheme, not NODE_ENV.
  // Marking it Secure on a plain-HTTP deployment makes the browser discard it,
  // which silently breaks session refresh.
  it.each([
    ['https://vyzus.example.com', true],
    ['http://vyzus.example.com:8080', false],
  ])('sets Secure=%s on the refresh cookie for PUBLIC_URL %s', async (publicUrl, expectSecure) => {
    const scoped = await buildTestApp({ PUBLIC_URL: publicUrl });
    try {
      const res = await scoped.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const cookie = res.cookies.find((c) => c.name === 'refreshToken');
      expect(cookie).toBeDefined();
      expect(Boolean(cookie?.secure)).toBe(expectSecure);
      // Unconditional hardening, asserted here so it cannot regress unnoticed.
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite).toBe('Strict');
    } finally {
      await closeTestApp(scoped);
    }
  });

  it('rejects a wrong password with 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects an unknown email with 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns the current user from /auth/me and guards it', async () => {
    const ok = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(adminToken) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().email).toBe(ADMIN_EMAIL);

    const noToken = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(noToken.statusCode).toBe(401);

    const badToken = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader('garbage') });
    expect(badToken.statusCode).toBe(401);
  });
});

describe('refresh rotation', () => {
  it('rotates the refresh token and invalidates the previous one', async () => {
    const first = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(first.refreshCookie).toBeTruthy();

    // Rotate once.
    const r1 = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refreshToken: first.refreshCookie },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().accessToken).toBeTruthy();
    const cookie2 = r1.cookies.find((c) => c.name === 'refreshToken')?.value ?? '';
    expect(cookie2).toBeTruthy();
    expect(cookie2).not.toBe(first.refreshCookie);

    // Re-using the FIRST (now rotated-out) token must fail.
    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refreshToken: first.refreshCookie },
    });
    expect(reuse.statusCode).toBe(401);

    // The NEW token still works... until logout.
    const r2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refreshToken: cookie2 },
    });
    expect(r2.statusCode).toBe(200);
    const cookie3 = r2.cookies.find((c) => c.name === 'refreshToken')?.value ?? '';

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { refreshToken: cookie3 },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refreshToken: cookie3 },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('rejects refresh with no cookie', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh' });
    expect(res.statusCode).toBe(401);
  });
});

describe('role guard', () => {
  async function createEditor(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(adminToken),
      payload: { email: 'editor@example.com', password: 'editor-password-1', role: 'editor' },
    });
    expect(res.statusCode).toBe(201);
    const loginRes = await login(ctx.app, 'editor@example.com', 'editor-password-1');
    return loginRes.accessToken;
  }

  it('lets admin manage users but forbids editor', async () => {
    const editorToken = await createEditor();

    const adminList = await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: authHeader(adminToken) });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().length).toBe(2);

    const editorList = await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: authHeader(editorToken) });
    expect(editorList.statusCode).toBe(403);
    expect(editorList.json().error.code).toBe('FORBIDDEN');

    const noAuth = await ctx.app.inject({ method: 'GET', url: '/api/v1/users' });
    expect(noAuth.statusCode).toBe(401);
  });

  it('lets editor manage applications', async () => {
    const editorToken = await createEditor();
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      headers: authHeader(editorToken),
      payload: { name: 'Editor App', landingUrl: 'https://example.com' },
    });
    expect(create.statusCode).toBe(201);

    const unauth = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      payload: { name: 'X', landingUrl: 'https://example.com' },
    });
    expect(unauth.statusCode).toBe(401);
  });
});

describe('applications + checks CRUD', () => {
  // Returns the parsed JSON detail; test payloads are intentionally loosely typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function createApp(overrides: Record<string, unknown> = {}): Promise<any> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      headers: authHeader(adminToken),
      payload: { name: 'Shop', landingUrl: 'https://shop.example.com', tags: ['prod'], ...overrides },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it('creates an app with a default uptime check and syncs its schedule', async () => {
    const app = await createApp();
    expect(app.status).toBe('UNKNOWN');
    expect(app.checks).toHaveLength(1);
    expect(app.checks[0].type).toBe('uptime');
    expect(app.checks[0].name).toBe('Landing uptime');
    expect(app.checks[0].intervalMinutes).toBe(5);
    // Default policy for a brand-new app: capture the failure AND the
    // recovery, plus an hourly refresh so a healthy app's picture stays current.
    expect(app.checks[0].config.screenshot).toBe('on_change');
    expect(app.checks[0].config.screenshotRefreshMinutes).toBe(60);
    expect(app.checks[0].availability24h).toBeNull();

    // The scheduler seam was invoked for the new check.
    expect(ctx.scheduler.syncCalls.some((c) => c.checkId === app.checks[0].id)).toBe(true);
  });

  it('validates the create body', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      headers: authHeader(adminToken),
      payload: { name: '', landingUrl: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('lists apps with an embedded summary', async () => {
    await createApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/apps', headers: authHeader(adminToken) });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0].checksCount).toBe(1);
    expect(list[0].status).toBe('UNKNOWN');
    expect(list[0].latestScreenshotRunId).toBeNull();
  });

  it('filters apps by tag', async () => {
    await createApp({ tags: ['prod'] });
    await createApp({ name: 'Staging', tags: ['staging'] });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/apps?tag=staging',
      headers: authHeader(adminToken),
    });
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].name).toBe('Staging');
  });

  it('creates, updates, and deletes a journey check', async () => {
    const app = await createApp();
    ctx.scheduler.syncCalls = [];

    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${app.id}/checks`,
      headers: authHeader(adminToken),
      payload: {
        name: 'Login journey',
        type: 'journey',
        intervalMinutes: 10,
        config: { specSource: "await page.goto('https://shop.example.com');" },
      },
    });
    expect(create.statusCode).toBe(201);
    const check = create.json();
    expect(check.type).toBe('journey');
    expect(check.config.specSource).toContain('page.goto');
    expect(ctx.scheduler.syncCalls.some((c) => c.checkId === check.id)).toBe(true);

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.id}/checks`,
      headers: authHeader(adminToken),
    });
    expect(list.json()).toHaveLength(2);

    // Update interval → re-sync.
    ctx.scheduler.syncCalls = [];
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/checks/${check.id}`,
      headers: authHeader(adminToken),
      payload: { intervalMinutes: 3 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().intervalMinutes).toBe(3);
    expect(ctx.scheduler.syncCalls.some((c) => c.checkId === check.id)).toBe(true);

    // Config that doesn't match the check type is rejected.
    const mismatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/checks/${check.id}`,
      headers: authHeader(adminToken),
      payload: { config: { expectedStatus: 200, screenshot: 'always' } },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('CONFIG_TYPE_MISMATCH');

    // Run now → enqueue.
    const run = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/checks/${check.id}/run`,
      headers: authHeader(adminToken),
    });
    expect(run.statusCode).toBe(202);
    expect(run.json().runId).toBeTruthy();
    expect(ctx.scheduler.enqueueCalls.some((c) => c.checkId === check.id && c.trigger === 'manual')).toBe(true);

    // Delete → remove schedule.
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/checks/${check.id}`,
      headers: authHeader(adminToken),
    });
    expect(del.statusCode).toBe(204);
    expect(ctx.scheduler.removeCalls).toContain(check.id);
  });

  it('creates an uptime check in port mode, rejects a host that looks like a URL, and reads old http configs missing `mode`', async () => {
    const app = await createApp();

    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${app.id}/checks`,
      headers: authHeader(adminToken),
      payload: {
        name: 'SSH port',
        type: 'uptime',
        intervalMinutes: 5,
        config: { mode: 'port', host: 'example.com', port: 22, protocol: 'tcp', family: 'auto' },
      },
    });
    expect(create.statusCode).toBe(201);
    const check = create.json();
    expect(check.type).toBe('uptime');
    expect(check.config).toMatchObject({ mode: 'port', host: 'example.com', port: 22, protocol: 'tcp' });

    // Host must be a bare host, not a URL — a likely paste mistake.
    const badHost = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${app.id}/checks`,
      headers: authHeader(adminToken),
      payload: {
        name: 'bad host',
        type: 'uptime',
        intervalMinutes: 5,
        config: { mode: 'port', host: 'https://example.com', port: 443 },
      },
    });
    expect(badHost.statusCode).toBe(400);

    // The app's own auto-created check predates the http/port split and has
    // no `mode` key at all — must still validate as an implicit http config
    // rather than 400ing on every existing check.
    const legacyPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/checks/${app.checks[0].id}`,
      headers: authHeader(adminToken),
      payload: { config: { expectedStatus: 200, screenshot: 'never' } },
    });
    expect(legacyPatch.statusCode).toBe(200);
    expect(legacyPatch.json().config).toMatchObject({
      mode: 'http',
      expectedStatus: 200,
      maxDurationMs: 0,
      visualDiffPercent: 0,
    });

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/checks/${check.id}`,
      headers: authHeader(adminToken),
    });
    expect(del.statusCode).toBe(204);
  });

  it('disabling an app removes its check schedules', async () => {
    const app = await createApp();
    ctx.scheduler.removeAppCalls = [];
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/apps/${app.id}`,
      headers: authHeader(adminToken),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PAUSED');
    expect(ctx.scheduler.removeAppCalls).toHaveLength(1);
    expect(ctx.scheduler.removeAppCalls[0]).toContain(app.checks[0].id);
  });

  it('rejects an on-demand screenshot on a disabled app', async () => {
    const app = await createApp({ enabled: false });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${app.id}/screenshot`,
      headers: authHeader(adminToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('APP_DISABLED');
  });

  it('enqueues an on-demand screenshot on the uptime check', async () => {
    const app = await createApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${app.id}/screenshot`,
      headers: authHeader(adminToken),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().runId).toBeTruthy();
    expect(ctx.scheduler.enqueueCalls.some((c) => c.trigger === 'screenshot')).toBe(true);
  });

  it('deletes an app and cascades', async () => {
    const app = await createApp();
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/apps/${app.id}`,
      headers: authHeader(adminToken),
    });
    expect(del.statusCode).toBe(204);
    expect(ctx.scheduler.removeAppCalls.at(-1)).toContain(app.checks[0].id);

    const get = await ctx.app.inject({ method: 'GET', url: `/api/v1/apps/${app.id}`, headers: authHeader(adminToken) });
    expect(get.statusCode).toBe(404);
  });
});

describe('encrypted app credentials', () => {
  it('stores auth config encrypted and never returns the secret', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      headers: authHeader(adminToken),
      payload: {
        name: 'Protected',
        landingUrl: 'https://staging.example.com',
        authConfig: { basicAuth: { username: 'u', password: 'p' } },
      },
    });
    expect(res.statusCode).toBe(201);
    const app = res.json();
    expect(app.hasAuthConfig).toBe(true);
    expect(JSON.stringify(app)).not.toContain('basicAuth');

    // The stored blob must be ciphertext, not plaintext JSON.
    const rows = await ctx.dbHandle.sql`select auth_config_enc from applications where id = ${app.id}`;
    const enc = rows[0]?.auth_config_enc as string;
    expect(enc).toBeTruthy();
    expect(enc).not.toContain('password');
    expect(enc.split('.')).toHaveLength(3);
  });
});
