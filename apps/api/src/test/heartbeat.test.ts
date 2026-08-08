// Dead-man's switch: the platform notices when its own checks stop running.
//
// The failure being guarded against is silence — a dead worker fires no checks,
// so nothing fails and no per-check alert can ever fire. These tests drive the
// real database and assert on what the heartbeat enqueues, since "an alert was
// published exactly once per transition" is the whole contract.
import { pino } from 'pino';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SETTINGS_KEYS, type MonitoringAlertJobPayload } from '@vyzus/shared';
import { applications, checks, runs, settings } from '../db/schema.js';
import { runHeartbeat, readStalledSince, type AlertPublisher } from '../services/heartbeat.js';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from './helpers.js';

let ctx: TestContext;
const log = pino({ level: 'silent' });

/** Records what the heartbeat publishes instead of touching a real queue. */
function fakeQueue(): AlertPublisher & { jobs: { name: string; data: MonitoringAlertJobPayload }[] } {
  const jobs: { name: string; data: MonitoringAlertJobPayload }[] = [];
  return {
    jobs,
    add: async (name, data) => {
      jobs.push({ name, data });
      return undefined;
    },
  };
}

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await closeTestApp(ctx);
});

beforeEach(async () => {
  await resetDb(ctx);
});

const MIN = 60 * 1000;

async function seed(opts: { intervalMinutes?: number; enabled?: boolean; createdAt?: Date } = {}) {
  const db = ctx.dbHandle.db;
  const [app] = await db
    .insert(applications)
    .values({ name: 'H', landingUrl: 'https://h.example.com', tags: [] })
    .returning();
  const [check] = await db
    .insert(checks)
    .values({
      appId: app!.id,
      type: 'uptime',
      name: 'landing',
      intervalMinutes: opts.intervalMinutes ?? 5,
      enabled: opts.enabled ?? true,
      config: {
        mode: 'http',
        expectedStatus: 200,
        maxDurationMs: 0,
        visualDiffPercent: 0,
        certExpiryWarningDays: 0,
        screenshot: 'never',
      },
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning();
  return { app: app!, check: check! };
}

async function addRun(checkId: string, startedAt: Date) {
  await ctx.dbHandle.db
    .insert(runs)
    .values({ checkId, status: 'passed', trigger: 'schedule', startedAt, durationMs: 100 });
}

async function setStall(minutes: number) {
  await ctx.dbHandle.db.insert(settings).values({ key: SETTINGS_KEYS.heartbeatStallMinutes, value: minutes });
}

describe('runHeartbeat', () => {
  it('stays quiet while runs are arriving', async () => {
    const { check } = await seed();
    const now = new Date();
    await addRun(check.id, new Date(now.getTime() - 2 * MIN));

    const q = fakeQueue();
    const result = await runHeartbeat(ctx.dbHandle.db, q, log, now);

    expect(result.stalled).toBe(false);
    expect(result.transition).toBeNull();
    expect(q.jobs).toHaveLength(0);
    expect(await readStalledSince(ctx.dbHandle.db)).toBeNull();
  });

  it('publishes exactly one stalled alert and does not repeat it', async () => {
    const { check } = await seed();
    const now = new Date();
    await addRun(check.id, new Date(now.getTime() - 60 * MIN));

    const q = fakeQueue();
    const first = await runHeartbeat(ctx.dbHandle.db, q, log, now);
    expect(first.stalled).toBe(true);
    expect(first.transition).toBe('stalled');
    expect(q.jobs).toHaveLength(1);
    expect(q.jobs[0]!.name).toBe('monitoring.stalled');
    expect(q.jobs[0]!.data).toMatchObject({ event: 'stalled', thresholdMinutes: 15 });

    // A continuing stall must not re-alert every minute.
    const second = await runHeartbeat(ctx.dbHandle.db, q, log, new Date(now.getTime() + MIN));
    expect(second.stalled).toBe(true);
    expect(second.transition).toBeNull();
    expect(q.jobs).toHaveLength(1);

    expect(await readStalledSince(ctx.dbHandle.db)).not.toBeNull();
  });

  it('publishes a resumed alert once when runs come back', async () => {
    const { check } = await seed();
    const now = new Date();
    await addRun(check.id, new Date(now.getTime() - 60 * MIN));

    const q = fakeQueue();
    await runHeartbeat(ctx.dbHandle.db, q, log, now);
    expect(q.jobs).toHaveLength(1);

    // The worker comes back and completes a run.
    const later = new Date(now.getTime() + 2 * MIN);
    await addRun(check.id, later);

    const recovered = await runHeartbeat(ctx.dbHandle.db, q, log, later);
    expect(recovered.stalled).toBe(false);
    expect(recovered.transition).toBe('resumed');
    expect(q.jobs).toHaveLength(2);
    expect(q.jobs[1]!.name).toBe('monitoring.resumed');
    expect(await readStalledSince(ctx.dbHandle.db)).toBeNull();

    // And stays quiet afterwards.
    await runHeartbeat(ctx.dbHandle.db, q, log, new Date(later.getTime() + MIN));
    expect(q.jobs).toHaveLength(2);
  });

  it('is disabled when the threshold is 0', async () => {
    const { check } = await seed();
    await setStall(0);
    const now = new Date();
    await addRun(check.id, new Date(now.getTime() - 24 * 60 * MIN));

    const q = fakeQueue();
    const result = await runHeartbeat(ctx.dbHandle.db, q, log, now);
    expect(result.stalled).toBe(false);
    expect(q.jobs).toHaveLength(0);
  });

  it('does not alert when every check is disabled — silence is then expected', async () => {
    const { check } = await seed({ enabled: false });
    const now = new Date();
    await addRun(check.id, new Date(now.getTime() - 24 * 60 * MIN));

    const q = fakeQueue();
    const result = await runHeartbeat(ctx.dbHandle.db, q, log, now);
    expect(result.stalled).toBe(false);
    expect(q.jobs).toHaveLength(0);
  });

  it('does not alert when the app is disabled, even with an enabled check', async () => {
    const { app, check } = await seed();
    await ctx.dbHandle.db.update(applications).set({ enabled: false }).where(eq(applications.id, app.id));
    const now = new Date();
    await addRun(check.id, new Date(now.getTime() - 24 * 60 * MIN));

    const q = fakeQueue();
    expect((await runHeartbeat(ctx.dbHandle.db, q, log, now)).stalled).toBe(false);
    expect(q.jobs).toHaveLength(0);
  });

  // The guard that keeps a long-interval deployment from alerting constantly.
  it('respects the shortest-interval floor over the configured threshold', async () => {
    const { check } = await seed({ intervalMinutes: 60 });
    const now = new Date();
    await addRun(check.id, new Date(now.getTime() - 90 * MIN));

    const q = fakeQueue();
    const result = await runHeartbeat(ctx.dbHandle.db, q, log, now);
    // 90m of silence is past the 15m setting but inside 2x the 60m interval.
    expect(result.effectiveThresholdMinutes).toBe(120);
    expect(result.stalled).toBe(false);
    expect(q.jobs).toHaveLength(0);
  });

  it('surfaces the stall through computeStats', async () => {
    const { check } = await seed();
    const now = new Date();
    await addRun(check.id, new Date(now.getTime() - 60 * MIN));
    await runHeartbeat(ctx.dbHandle.db, fakeQueue(), log, now);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(await readStalledSince(ctx.dbHandle.db)).toMatch(/^\d{4}-/);
  });
});
