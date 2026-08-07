// API tokens: scoped, revocable credentials for automation, so a pipeline
// never holds a human's password. The contract that matters is that a token
// authorizes exactly as its owner does — same role, same viewer scoping — so
// these tests drive real routes rather than the lookup in isolation.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { apiTokens } from '../db/schema.js';
import { hashToken } from '../lib/tokens.js';
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
  adminToken = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
});

async function createToken(body: Record<string, unknown> = { name: 'ci' }) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tokens',
    headers: authHeader(adminToken),
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string; name: string; expiresAt: string | null };
}

describe('API tokens', () => {
  it('returns the secret once at creation and never again', async () => {
    const created = await createToken();
    expect(created.token).toMatch(/^vyz_/);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/tokens', headers: authHeader(adminToken) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('token');

    // Only the hash is stored — the plaintext is unrecoverable from the DB.
    const [stored] = await ctx.dbHandle.db.select().from(apiTokens).where(eq(apiTokens.id, created.id));
    expect(stored!.tokenHash).toBe(hashToken(created.token));
    expect(JSON.stringify(stored)).not.toContain(created.token);
  });

  it('authenticates a protected route as its owner', async () => {
    const { token } = await createToken();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(ADMIN_EMAIL);
  });

  // The token inherits the owner's role, so an admin's token reaches
  // admin-only routes — that is the whole point of reusing the identity.
  it('carries the owner role through to an admin-only route', async () => {
    const { token } = await createToken();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: authHeader(token) });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an unknown token', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader('vyz_notarealtokenatall'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    const { id, token } = await createToken({ name: 'short-lived', expiresInDays: 1 });
    // Move the expiry into the past rather than waiting a day.
    await ctx.dbHandle.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, id));

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(token) });
    expect(res.statusCode).toBe(401);
  });

  it('stops working the moment it is revoked', async () => {
    const { id, token } = await createToken();
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(token) })).statusCode,
    ).toBe(200);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/tokens/${id}`,
      headers: authHeader(adminToken),
    });
    expect(del.statusCode).toBe(204);

    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(token) });
    expect(after.statusCode).toBe(401);
  });

  it('records last-used so unused tokens can be spotted', async () => {
    const { id, token } = await createToken();
    const [before] = await ctx.dbHandle.db.select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(before!.lastUsedAt).toBeNull();

    await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(token) });
    // The stamp is fire-and-forget, so give it a beat to land.
    await new Promise((r) => setTimeout(r, 200));

    const [after] = await ctx.dbHandle.db.select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(after!.lastUsedAt).not.toBeNull();
  });

  it('a JWT still authenticates, unaffected by the token path', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(adminToken) });
    expect(res.statusCode).toBe(200);
  });
});
