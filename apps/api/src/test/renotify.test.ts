// Still-down reminders. The contract is about state that persists between
// passes — "announced once, then again N minutes later, then not again until
// due" — so this drives the real database rather than the pure function alone.
import { pino } from 'pino';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SETTINGS_KEYS, type CheckAlertJobPayload } from '@vyzus/shared';
import { applications, checks, incidents, runs, settings } from '../db/schema.js';
import { runRenotify, type IncidentAlertPublisher } from '../services/renotify.js';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from './helpers.js';

let ctx: TestContext;
const log = pino({ level: 'silent' });

function fakeQueue(): IncidentAlertPublisher & { jobs: CheckAlertJobPayload[] } {
  const jobs: CheckAlertJobPayload[] = [];
  return { jobs, add: async (_name, data) => void jobs.push(data) };
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

async function seedOpenIncident(openedAt: Date, lastNotifiedAt: Date | null) {
  const db = ctx.dbHandle.db;
  const [app] = await db
    .insert(applications)
    .values({ name: 'R', landingUrl: 'https://r.example.com', tags: [] })
    .returning();
  const [check] = await db
    .insert(checks)
    .values({
      appId: app!.id,
      type: 'uptime',
      name: 'landing',
      intervalMinutes: 5,
      config: { mode: 'http', expectedStatus: 200, maxDurationMs: 0, visualDiffPercent: 0, screenshot: 'never' },
    })
    .returning();
  const [run] = await db
    .insert(runs)
    .values({ checkId: check!.id, status: 'failed', trigger: 'schedule', startedAt: openedAt, durationMs: 10 })
    .returning();
  const [incident] = await db
    .insert(incidents)
    .values({ checkId: check!.id, openedAt, openingRunId: run!.id, lastNotifiedAt })
    .returning();
  return { app: app!, check: check!, incident: incident! };
}

async function setCadence(minutes: number) {
  await ctx.dbHandle.db.insert(settings).values({ key: SETTINGS_KEYS.renotifyMinutes, value: minutes });
}

describe('runRenotify', () => {
  it('does nothing when the cadence is off (the default)', async () => {
    await seedOpenIncident(new Date(Date.now() - 10 * 60 * MIN), null);
    const q = fakeQueue();
    expect((await runRenotify(ctx.dbHandle.db, q, log)).renotified).toEqual([]);
    expect(q.jobs).toHaveLength(0);
  });

  it('re-announces an incident that is overdue, then not again until due', async () => {
    await setCadence(30);
    const now = new Date();
    const { incident } = await seedOpenIncident(
      new Date(now.getTime() - 120 * MIN),
      new Date(now.getTime() - 60 * MIN),
    );

    const q = fakeQueue();
    const first = await runRenotify(ctx.dbHandle.db, q, log, now);
    expect(first.renotified).toEqual([incident.id]);
    expect(q.jobs).toEqual([{ incidentId: incident.id, event: 'down' }]);

    // A minute later it is no longer due — the stamp moved.
    const second = await runRenotify(ctx.dbHandle.db, q, log, new Date(now.getTime() + MIN));
    expect(second.renotified).toEqual([]);
    expect(q.jobs).toHaveLength(1);

    // Once the cadence elapses again, it fires once more.
    const third = await runRenotify(ctx.dbHandle.db, q, log, new Date(now.getTime() + 31 * MIN));
    expect(third.renotified).toEqual([incident.id]);
    expect(q.jobs).toHaveLength(2);
  });

  it('leaves a recently-notified incident alone', async () => {
    await setCadence(30);
    const now = new Date();
    await seedOpenIncident(new Date(now.getTime() - 120 * MIN), new Date(now.getTime() - 5 * MIN));
    const q = fakeQueue();
    expect((await runRenotify(ctx.dbHandle.db, q, log, now)).renotified).toEqual([]);
  });

  it('never re-announces a resolved incident', async () => {
    await setCadence(30);
    const now = new Date();
    const { incident } = await seedOpenIncident(
      new Date(now.getTime() - 120 * MIN),
      new Date(now.getTime() - 60 * MIN),
    );
    await ctx.dbHandle.db.update(incidents).set({ resolvedAt: now }).where(eq(incidents.id, incident.id));

    const q = fakeQueue();
    expect((await runRenotify(ctx.dbHandle.db, q, log, now)).renotified).toEqual([]);
    expect(q.jobs).toHaveLength(0);
  });

  it('stamps last_notified_at so the cadence survives a restart', async () => {
    await setCadence(30);
    const now = new Date();
    const { incident } = await seedOpenIncident(new Date(now.getTime() - 120 * MIN), null);

    await runRenotify(ctx.dbHandle.db, fakeQueue(), log, now);

    const [row] = await ctx.dbHandle.db.select().from(incidents).where(eq(incidents.id, incident.id));
    expect(row!.lastNotifiedAt).not.toBeNull();
    expect(row!.lastNotifiedAt!.getTime()).toBe(now.getTime());
  });
});
