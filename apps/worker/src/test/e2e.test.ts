// End-to-end worker pipeline: real BullMQ queue + Redis + Postgres.
// Covers: on-demand run honoring the API-minted runId, run persistence +
// denormalized fields, run.finished pub/sub, incident open → alerts job,
// recovery → resolved + recovered job, screenshot trigger, dry-run inline
// result, malformed job never crashing the worker.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue, Worker, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import {
  QUEUE_NAMES,
  CHECK_JOB_NAMES,
  RUN_FINISHED_CHANNEL,
  INCIDENT_OPENED_CHANNEL,
  INCIDENT_RESOLVED_CHANNEL,
  type CheckJobPayload,
  type DryRunJobPayload,
} from '@vyzus/shared';
import { checks, incidents, runs } from '@vyzus/shared/db';
import { createProcessor } from '../processor.js';
import { ArtifactStore } from '../artifacts.js';
import { closeBrowser } from '../browser.js';
import { connectDb, truncateAll, seedAppWithCheck, startTestSite, testWorkerConfig, type TestSite } from './helpers.js';
import type { WorkerDbHandle } from '../db.js';
import { TEST_REDIS_URL } from './env.js';

let handle: WorkerDbHandle;
let site: TestSite;
let redis: Redis;
let sub: Redis;
let queue: Queue;
let queueEvents: QueueEvents;
let worker: Worker;
let processorClose: () => Promise<void>;
let artifactsRoot: string;
const events: { channel: string; data: Record<string, unknown> }[] = [];

beforeAll(async () => {
  handle = connectDb();
  site = await startTestSite();
  artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vyzus-e2e-'));

  redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  sub = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  await sub.subscribe(RUN_FINISHED_CHANNEL, INCIDENT_OPENED_CHANNEL, INCIDENT_RESOLVED_CHANNEL);
  sub.on('message', (channel, message) => {
    events.push({ channel, data: JSON.parse(message) as Record<string, unknown> });
  });

  const config = testWorkerConfig({ ARTIFACTS_DIR: artifactsRoot });
  const processor = createProcessor({
    db: handle.db,
    redis,
    config,
    log: pino({ level: 'silent' }),
    store: new ArtifactStore(artifactsRoot),
  });
  processorClose = processor.close;

  queue = new Queue(QUEUE_NAMES.checks, { connection: redis });
  queueEvents = new QueueEvents(QUEUE_NAMES.checks, {
    connection: redis.duplicate({ maxRetriesPerRequest: null }),
  });
  worker = new Worker(QUEUE_NAMES.checks, (job) => processor.process(job), {
    connection: redis,
    concurrency: 2,
  });
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await processorClose();
  await queueEvents.close();
  await queue.close();
  await closeBrowser();
  sub.disconnect();
  redis.disconnect();
  await site.close();
  await handle.sql.end({ timeout: 5 });
  await fs.rm(artifactsRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(handle);
  for (const name of [QUEUE_NAMES.alerts, QUEUE_NAMES.checks]) {
    // force: our own worker stays attached to `checks`; obliterate drops any
    // stale jobs/schedulers another suite may have left on the shared Redis.
    const q = new Queue(name, { connection: redis });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  }
  events.length = 0;
  site.setDown(false);
});

async function runJob(name: string, payload: CheckJobPayload): Promise<void> {
  const job = await queue.add(name, payload, { removeOnComplete: true, removeOnFail: true });
  await job.waitUntilFinished(queueEvents, 60_000);
}

async function alertJobs(): Promise<{ name: string; data: Record<string, unknown> }[]> {
  const alerts = new Queue(QUEUE_NAMES.alerts, { connection: redis });
  const jobs = await alerts.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
  await alerts.close();
  return jobs.map((j) => ({ name: j.name, data: j.data as Record<string, unknown> }));
}

describe('worker pipeline', () => {
  it('executes a manual run, persists it under the given runId, and publishes run.finished', async () => {
    const { app, check } = await seedAppWithCheck(handle, site.url);
    const runId = randomUUID();
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId });

    const [run] = await handle.db.select().from(runs).where(eq(runs.id, runId));
    expect(run).toBeDefined();
    expect(run!.status).toBe('passed');
    expect(run!.trigger).toBe('manual');
    expect(run!.workerId).toBe('test-worker');
    expect((run!.metrics as Record<string, unknown>).httpStatus).toBe(200);

    const [freshCheck] = await handle.db.select().from(checks).where(eq(checks.id, check.id));
    expect(freshCheck!.lastStatus).toBe('passed');
    expect(freshCheck!.lastRunAt).not.toBeNull();

    // pub/sub reached our subscriber
    await new Promise((r) => setTimeout(r, 200));
    const finished = events.find((e) => e.channel === RUN_FINISHED_CHANNEL);
    expect(finished).toBeDefined();
    expect(finished!.data).toMatchObject({
      type: 'run.finished',
      appId: app.id,
      checkId: check.id,
      runId,
      status: 'passed',
    });
  });

  it('opens an incident after threshold failures and resolves it on recovery', async () => {
    const { check } = await seedAppWithCheck(handle, site.url, { failureThreshold: 2 });

    site.setDown(true);
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual' });
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual' });

    const openIncidents = await handle.db.select().from(incidents).where(eq(incidents.checkId, check.id));
    expect(openIncidents).toHaveLength(1);
    expect(openIncidents[0]!.resolvedAt).toBeNull();

    let jobs = await alertJobs();
    expect(jobs.some((j) => j.data.event === 'down' && j.data.incidentId === openIncidents[0]!.id)).toBe(true);

    // Recovery
    site.setDown(false);
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual' });

    const [resolved] = await handle.db.select().from(incidents).where(eq(incidents.id, openIncidents[0]!.id));
    expect(resolved!.resolvedAt).not.toBeNull();
    expect(resolved!.resolvingRunId).not.toBeNull();

    jobs = await alertJobs();
    expect(jobs.some((j) => j.data.event === 'recovered')).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    expect(events.some((e) => e.channel === INCIDENT_OPENED_CHANNEL)).toBe(true);
    expect(events.some((e) => e.channel === INCIDENT_RESOLVED_CHANNEL)).toBe(true);
  }, 120_000);

  it('screenshot trigger forces a capture even when config says on_failure', async () => {
    const { app, check } = await seedAppWithCheck(handle, site.url); // on_failure, run passes
    const runId = randomUUID();
    await runJob(CHECK_JOB_NAMES.screenshot, { checkId: check.id, trigger: 'screenshot', runId });

    const [run] = await handle.db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.status).toBe('passed');
    expect(run!.screenshotPath).toBe(path.join(app.id, runId, 'screenshot.png'));
    const stat = await fs.stat(path.join(artifactsRoot, run!.screenshotPath!));
    expect(stat.size).toBeGreaterThan(500);
  });

  it('executes an uptime dry-run and returns the result inline without persisting', async () => {
    const { app } = await seedAppWithCheck(handle, site.url);
    const payload: DryRunJobPayload = {
      dryRun: true,
      appId: app.id,
      type: 'uptime',
      config: { expectedStatus: 200, screenshot: 'never' },
      timeoutMs: 10_000,
    };
    const job = await queue.add(CHECK_JOB_NAMES.dryRun, payload, { removeOnComplete: true, removeOnFail: true });
    const result = (await job.waitUntilFinished(queueEvents, 60_000)) as Record<string, unknown>;
    expect(result.status).toBe('passed');
    expect((result.metrics as Record<string, unknown>).httpStatus).toBe(200);

    const allRuns = await handle.db.select().from(runs);
    expect(allRuns).toHaveLength(0); // nothing persisted
  });

  it('executes a journey dry-run with a failing spec and reports the error inline', async () => {
    const { app } = await seedAppWithCheck(handle, site.url);
    const payload: DryRunJobPayload = {
      dryRun: true,
      appId: app.id,
      type: 'journey',
      config: {
        specSource: `await page.goto(${JSON.stringify(site.url)});\nawait expect(page.locator('#nope')).toBeVisible({ timeout: 1500 });`,
      },
      timeoutMs: 30_000,
    };
    const job = await queue.add(CHECK_JOB_NAMES.dryRun, payload, { removeOnComplete: true, removeOnFail: true });
    const result = (await job.waitUntilFinished(queueEvents, 90_000)) as Record<string, unknown>;
    expect(result.status).toBe('failed');
    expect(String(result.errorMessage)).toContain('#nope');
  }, 120_000);

  it('a malformed job fails cleanly and the worker keeps processing', async () => {
    const bad = await queue.add('manual-run', { nonsense: true }, { removeOnComplete: true, removeOnFail: true });
    await expect(bad.waitUntilFinished(queueEvents, 30_000)).rejects.toThrow(/Malformed/);

    // Worker still alive: a valid job right after succeeds.
    const { check } = await seedAppWithCheck(handle, site.url);
    const runId = randomUUID();
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId });
    const [run] = await handle.db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.status).toBe('passed');
  });

  it('keeps every screenshot it takes, across a pass/fail transition', async () => {
    const { check } = await seedAppWithCheck(handle, site.url, {}, { screenshot: 'always' });
    const shotPath = async (runId: string): Promise<string | null> => {
      const [run] = await handle.db.select().from(runs).where(eq(runs.id, runId));
      return run!.screenshotPath;
    };
    const exists = async (rel: string | null): Promise<boolean> => {
      if (!rel) return false;
      return fs
        .access(path.join(artifactsRoot, rel))
        .then(() => true)
        .catch(() => false);
    };

    // Four runs: two passing, then two failing. Screenshots used to be
    // superseded within each same-outcome streak; now all four are retained.
    const run1 = randomUUID();
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId: run1 });
    const shot1 = await shotPath(run1);

    const run2 = randomUUID();
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId: run2 });
    const shot2 = await shotPath(run2);

    site.setDown(true);
    const run3 = randomUUID();
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId: run3 });
    const shot3 = await shotPath(run3);

    const run4 = randomUUID();
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId: run4 });
    const shot4 = await shotPath(run4);

    const shots = [shot1, shot2, shot3, shot4];
    // Every run kept its own DB reference — none was nulled by a later run.
    for (const shot of shots) expect(shot).not.toBeNull();
    // Four distinct paths, four files still on disk.
    expect(new Set(shots).size).toBe(4);
    for (const shot of shots) expect(await exists(shot)).toBe(true);
  }, 120_000);

  it('keeps every screenshot when several runs of the same check race concurrently', async () => {
    // Simulates a burst of overdue repeatable jobs draining after a worker
    // restart, or a manual run landing next to a scheduled tick: several runs
    // for the SAME check processed in parallel by the worker's concurrency.
    // This used to be the worst case for the streak-supersede race; with
    // nothing superseded, the invariant is simply that no run loses its file.
    const { check } = await seedAppWithCheck(handle, site.url, {}, { screenshot: 'always' });
    const runIds = Array.from({ length: 5 }, () => randomUUID());
    await Promise.all(
      runIds.map((runId) => runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId })),
    );

    const stored = await handle.db
      .select({ id: runs.id, screenshotPath: runs.screenshotPath })
      .from(runs)
      .where(eq(runs.checkId, check.id));
    expect(stored).toHaveLength(5);
    for (const row of stored) {
      expect(row.screenshotPath).not.toBeNull();
      expect(
        await fs.access(path.join(artifactsRoot, row.screenshotPath!)).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
    }
  }, 120_000);

  it('skips a scheduled run for a disabled check without persisting anything', async () => {
    const { check } = await seedAppWithCheck(handle, site.url, { enabled: false });
    await runJob(CHECK_JOB_NAMES.scheduled, { checkId: check.id, trigger: 'schedule' });
    const allRuns = await handle.db.select().from(runs);
    expect(allRuns).toHaveLength(0);
  });
});

// Visual regression through the real pipeline. A defaced or broken-CSS deploy
// still returns 200 and still satisfies every selector assertion — pixels are
// the only signal, and they only exist because screenshots are kept per run.
describe('visual regression', () => {
  it('fails a run whose page looks different, and passes when it does not', async () => {
    const { check } = await seedAppWithCheck(handle, site.url, {}, { screenshot: 'always', visualDiffPercent: 5 });

    // First run: nothing to compare against, so it must pass.
    const first = randomUUID();
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId: first });
    const [run1] = await handle.db.select().from(runs).where(eq(runs.id, first));
    expect(run1!.status).toBe('passed');

    // Second run, unchanged page: still passes, and now records the measurement.
    const second = randomUUID();
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId: second });
    const [run2] = await handle.db.select().from(runs).where(eq(runs.id, second));
    expect(run2!.status).toBe('passed');
    expect((run2!.metrics as Record<string, unknown>).visualDiffPercent).toBeTypeOf('number');

    // Third run after a repaint: same HTTP 200, same #hero selector, but the
    // page looks completely different.
    site.setRepainted(true);
    const third = randomUUID();
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId: third });
    const [run3] = await handle.db.select().from(runs).where(eq(runs.id, third));
    expect(run3!.status).toBe('failed');
    expect(run3!.errorMessage).toMatch(/changed visually/i);
    expect((run3!.metrics as Record<string, unknown>).visualDiffPercent as number).toBeGreaterThan(5);
  }, 120_000);

  it('never fails on visual change when the threshold is off', async () => {
    const { check } = await seedAppWithCheck(handle, site.url, {}, { screenshot: 'always', visualDiffPercent: 0 });
    site.setRepainted(false);
    const a = randomUUID();
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId: a });

    site.setRepainted(true);
    const b = randomUUID();
    await runJob(CHECK_JOB_NAMES.manual, { checkId: check.id, trigger: 'manual', runId: b });
    const [run] = await handle.db.select().from(runs).where(eq(runs.id, b));
    expect(run!.status).toBe('passed');
    site.setRepainted(false);
  }, 120_000);
});
