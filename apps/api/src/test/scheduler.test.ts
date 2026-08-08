// Phase 3: BullMqSchedulerService against real Redis — repeatable upsert on
// check mutations, removal on disable/delete, reconcileSchedules from the DB.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { pino } from 'pino';
import { QUEUE_NAMES, checkRepeatableJobId } from '@vyzus/shared';
import { applications, checks } from '../db/schema.js';
import { BullMqSchedulerService } from '../services/scheduler.js';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from './helpers.js';

let ctx: TestContext;
let service: BullMqSchedulerService;

beforeAll(async () => {
  ctx = await buildTestApp();
  service = new BullMqSchedulerService(ctx.redis, ctx.dbHandle.db, pino({ level: 'silent' }));
});

afterAll(async () => {
  await service.close();
  await closeTestApp(ctx);
});

beforeEach(async () => {
  await resetDb(ctx);
  const q = new Queue(QUEUE_NAMES.checks, { connection: ctx.redis });
  await q.obliterate({ force: true }).catch(() => undefined);
  await q.close();
});

async function listSchedulers() {
  const q = new Queue(QUEUE_NAMES.checks, { connection: ctx.redis });
  const schedulers = await q.getJobSchedulers(0, -1, true);
  await q.close();
  return schedulers;
}

async function seedCheck(intervalMinutes = 5, enabled = true, appEnabled = true) {
  const [app] = await ctx.dbHandle.db
    .insert(applications)
    .values({ name: 'A', landingUrl: 'https://a.example.com', tags: [], enabled: appEnabled })
    .returning();
  const [check] = await ctx.dbHandle.db
    .insert(checks)
    .values({
      appId: app!.id,
      type: 'uptime',
      name: 'U',
      intervalMinutes,
      enabled,
      config: {
        mode: 'http',
        expectedStatus: 200,
        maxDurationMs: 0,
        visualDiffPercent: 0,
        certExpiryWarningDays: 0,
        screenshot: 'on_failure',
      },
    })
    .returning();
  return { app: app!, check: check! };
}

describe('BullMqSchedulerService', () => {
  it('upserts a repeatable for an enabled check and removes it when disabled', async () => {
    const { check } = await seedCheck(3);
    await service.syncCheck(check, true);

    let schedulers = await listSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]!.key).toBe(checkRepeatableJobId(check.id));
    expect(Number(schedulers[0]!.every)).toBe(3 * 60_000);

    // Interval change re-syncs in place (same key, new every).
    await service.syncCheck({ ...check, intervalMinutes: 7 }, true);
    schedulers = await listSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(Number(schedulers[0]!.every)).toBe(7 * 60_000);

    // Disable → removed.
    await service.syncCheck({ ...check, enabled: false }, true);
    schedulers = await listSchedulers();
    expect(schedulers).toHaveLength(0);
  });

  it('disabling the app removes the schedule via syncCheck(appEnabled=false)', async () => {
    const { check } = await seedCheck();
    await service.syncCheck(check, true);
    expect(await listSchedulers()).toHaveLength(1);
    await service.syncCheck(check, false);
    expect(await listSchedulers()).toHaveLength(0);
  });

  it('enqueueRun adds a priority-1 job carrying the returned runId', async () => {
    const { check } = await seedCheck();
    const { runId } = await service.enqueueRun(check.id, 'screenshot');
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    const q = new Queue(QUEUE_NAMES.checks, { connection: ctx.redis });
    const jobs = await q.getJobs(['prioritized', 'waiting']);
    await q.close();
    const job = jobs.find((j) => (j.data as { runId?: string }).runId === runId);
    expect(job).toBeDefined();
    expect(job!.opts.priority).toBe(1);
    expect(job!.data).toMatchObject({ checkId: check.id, trigger: 'screenshot', runId });
  });

  it('reconcileSchedules rebuilds Redis from the DB and drops stale entries', async () => {
    const enabled = await seedCheck(5, true, true);
    const disabled = await seedCheck(5, false, true);
    const appOff = await seedCheck(5, true, false);

    // Simulate drift: stale scheduler for the disabled check + an orphan.
    await service.syncCheck({ ...disabled.check, enabled: true }, true);
    await service.syncCheck({ ...enabled.check, id: '99999999-9999-4999-8999-999999999999' }, true);

    await service.reconcileSchedules();

    const schedulers = await listSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]!.key).toBe(checkRepeatableJobId(enabled.check.id));
    void appOff;
  });
});
