// Push (heartbeat) checks: the target reports in rather than Vyzus reaching
// out. Covers the pure staleness rule and the unauthenticated receipt endpoint.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { evaluatePush } from '@vyzus/shared';
import { applications, checks } from '../db/schema.js';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from './helpers.js';

let ctx: TestContext;
const TOKEN = 'a'.repeat(64);

beforeAll(async () => {
  ctx = await buildTestApp();
});
afterAll(async () => {
  await closeTestApp(ctx);
});
beforeEach(async () => {
  await resetDb(ctx);
});

async function seedPushCheck(token = TOKEN, enabled = true) {
  const db = ctx.dbHandle.db;
  const [app] = await db
    .insert(applications)
    .values({ name: 'Batch', landingUrl: 'https://batch.example.com', tags: [] })
    .returning();
  const [check] = await db
    .insert(checks)
    .values({
      appId: app!.id,
      type: 'push',
      name: 'Nightly backup',
      intervalMinutes: 60,
      enabled,
      config: { token, graceMinutes: 5 },
    })
    .returning();
  return { app: app!, check: check! };
}

describe('evaluatePush', () => {
  const now = new Date('2026-08-08T12:00:00Z');
  const base = { now, intervalMinutes: 5, graceMinutes: 2, since: new Date('2026-08-08T00:00:00Z') };

  it('is alive while pings keep arriving', () => {
    const v = evaluatePush({ ...base, lastPingAt: new Date('2026-08-08T11:58:00Z') });
    expect(v.alive).toBe(true);
    expect(v.silentForSeconds).toBe(120);
    expect(v.deadlineSeconds).toBe(7 * 60);
  });

  // The grace allowance is the point: a 5-minute cron never lands on the mark.
  it('tolerates a late ping inside the grace allowance', () => {
    expect(evaluatePush({ ...base, lastPingAt: new Date('2026-08-08T11:54:00Z') }).alive).toBe(true);
  });

  it('fails once the ping is overdue beyond interval + grace', () => {
    expect(evaluatePush({ ...base, lastPingAt: new Date('2026-08-08T11:50:00Z') }).alive).toBe(false);
  });

  // A newly created check must not fail before its job has had a chance to run.
  it('measures from creation when no ping has ever arrived', () => {
    expect(evaluatePush({ ...base, lastPingAt: null, since: new Date('2026-08-08T11:59:00Z') }).alive).toBe(true);
    expect(evaluatePush({ ...base, lastPingAt: null }).alive).toBe(false);
  });
});

describe('POST /push/:token', () => {
  it('records a ping without any authentication', async () => {
    const { check } = await seedPushCheck();

    const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/push/${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const [row] = await ctx.dbHandle.db.select().from(checks).where(eq(checks.id, check.id));
    expect(row!.lastPingAt).not.toBeNull();
  });

  // curl defaults to GET; a ping that needs `-X POST` is one people forget.
  it('accepts GET as well as POST', async () => {
    const { check } = await seedPushCheck();
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/push/${TOKEN}` });
    expect(res.statusCode).toBe(200);
    const [row] = await ctx.dbHandle.db.select().from(checks).where(eq(checks.id, check.id));
    expect(row!.lastPingAt).not.toBeNull();
  });

  it('404s an unknown token and touches nothing', async () => {
    const { check } = await seedPushCheck();
    const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/push/${'b'.repeat(64)}` });
    expect(res.statusCode).toBe(404);
    const [row] = await ctx.dbHandle.db.select().from(checks).where(eq(checks.id, check.id));
    expect(row!.lastPingAt).toBeNull();
  });

  it('moves the timestamp forward on a second ping', async () => {
    const { check } = await seedPushCheck();
    await ctx.app.inject({ method: 'POST', url: `/api/v1/push/${TOKEN}` });
    const [first] = await ctx.dbHandle.db.select().from(checks).where(eq(checks.id, check.id));
    await new Promise((r) => setTimeout(r, 20));
    await ctx.app.inject({ method: 'POST', url: `/api/v1/push/${TOKEN}` });
    const [second] = await ctx.dbHandle.db.select().from(checks).where(eq(checks.id, check.id));
    expect(second!.lastPingAt!.getTime()).toBeGreaterThan(first!.lastPingAt!.getTime());
  });

  // The token addresses one check; it must not match another check's token.
  it('only updates the check owning the token', async () => {
    const a = await seedPushCheck(TOKEN);
    const other = 'c'.repeat(64);
    const b = await seedPushCheck(other);

    await ctx.app.inject({ method: 'POST', url: `/api/v1/push/${other}` });

    const [rowA] = await ctx.dbHandle.db.select().from(checks).where(eq(checks.id, a.check.id));
    const [rowB] = await ctx.dbHandle.db.select().from(checks).where(eq(checks.id, b.check.id));
    expect(rowA!.lastPingAt).toBeNull();
    expect(rowB!.lastPingAt).not.toBeNull();
  });

  // Unauthenticated and it writes: nothing else caps how fast attempts arrive.
  it('rate-limits a caller that floods the endpoint', async () => {
    const from = (ip: string) =>
      ctx.app.inject({
        method: 'GET',
        url: '/api/v1/push/definitely-not-a-real-token',
        headers: { 'x-forwarded-for': ip },
      });

    for (let i = 0; i < 120; i++) expect((await from('198.51.100.4')).statusCode).toBe(404);

    const blocked = await from('198.51.100.4');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // A different host is unaffected — one noisy sender must not silence
    // everyone else's heartbeats.
    expect((await from('198.51.100.5')).statusCode).toBe(404);
  });

  it('rejects a token that is too short to be one of ours', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/push/short' });
    expect(res.statusCode).toBe(400);
  });
});
