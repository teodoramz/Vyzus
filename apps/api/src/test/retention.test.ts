// Phase 7 retention: expired runs + their artifact files are deleted (files
// first, then rows), screenshots/traces past their window are pruned, and
// incidents are kept.
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { SETTINGS_KEYS } from '@vyzus/shared';
import { applications, checks, incidents, runs, settings } from '../db/schema.js';
import { runRetention } from '../services/retention.js';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from './helpers.js';

let ctx: TestContext;
let artifactsRoot: string;

beforeAll(async () => {
  ctx = await buildTestApp();
  artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vyzus-retention-'));
});

afterAll(async () => {
  await closeTestApp(ctx);
  await fs.rm(artifactsRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb(ctx);
});

const DAY = 24 * 60 * 60 * 1000;

async function seedAppCheck() {
  const [app] = await ctx.dbHandle.db
    .insert(applications)
    .values({ name: 'R', landingUrl: 'https://r.example.com', tags: [] })
    .returning();
  const [check] = await ctx.dbHandle.db
    .insert(checks)
    .values({
      appId: app!.id,
      type: 'uptime',
      name: 'U',
      intervalMinutes: 5,
      config: {
        mode: 'http',
        expectedStatus: 200,
        maxDurationMs: 0,
        visualDiffPercent: 0,
        certExpiryWarningDays: 0,
        screenshot: 'always',
      },
    })
    .returning();
  return { app: app!, check: check! };
}

/** Insert a run with real artifact files at started_at = now - ageDays. */
async function seedRun(appId: string, checkId: string, ageDays: number) {
  const startedAt = new Date(Date.now() - ageDays * DAY);
  const [run] = await ctx.dbHandle.db
    .insert(runs)
    .values({ checkId, status: 'failed', trigger: 'schedule', startedAt, durationMs: 100 })
    .returning();
  const dir = path.join(artifactsRoot, appId, run!.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'screenshot.png'), 'PNG');
  await fs.writeFile(path.join(dir, 'trace.zip'), 'ZIP');
  const screenshotPath = path.join(appId, run!.id, 'screenshot.png');
  const tracePath = path.join(appId, run!.id, 'trace.zip');
  await ctx.dbHandle.db.update(runs).set({ screenshotPath, tracePath }).where(eq(runs.id, run!.id));
  return { run: run!, dir, screenshotPath, tracePath };
}

describe('runRetention', () => {
  it('deletes runs older than runs_days along with their artifact files, keeps recent', async () => {
    const { app, check } = await seedAppCheck();
    const oldRun = await seedRun(app.id, check.id, 120); // > 90d default
    const freshRun = await seedRun(app.id, check.id, 1);

    const result = await runRetention(ctx.dbHandle.db, artifactsRoot, pino({ level: 'silent' }));
    expect(result.deletedRuns).toBe(1);

    // Old run + its files gone; fresh run + files intact.
    const remaining = await ctx.dbHandle.db.select({ id: runs.id }).from(runs);
    expect(remaining.map((r) => r.id)).toEqual([freshRun.run.id]);
    expect(existsSync(oldRun.dir)).toBe(false);
    expect(existsSync(freshRun.dir)).toBe(true);
  });

  it('prunes screenshots past screenshots_days and traces past traces_days without deleting the run', async () => {
    const { app, check } = await seedAppCheck();
    // 40 days old: within runs_days (90) but past screenshots (30) and traces (14).
    const r = await seedRun(app.id, check.id, 40);

    const result = await runRetention(ctx.dbHandle.db, artifactsRoot, pino({ level: 'silent' }));
    expect(result.deletedRuns).toBe(0);
    expect(result.deletedScreenshots).toBe(1);
    expect(result.deletedTraces).toBe(1);

    const [row] = await ctx.dbHandle.db.select().from(runs).where(eq(runs.id, r.run.id));
    expect(row!.screenshotPath).toBeNull();
    expect(row!.tracePath).toBeNull();
    expect(existsSync(path.join(artifactsRoot, r.screenshotPath))).toBe(false);
    expect(existsSync(path.join(artifactsRoot, r.tracePath))).toBe(false);
  });

  it('respects custom retention settings and keeps incidents', async () => {
    const { app, check } = await seedAppCheck();
    const r = await seedRun(app.id, check.id, 5);
    const [incident] = await ctx.dbHandle.db
      .insert(incidents)
      .values({ checkId: check.id, openedAt: new Date(Date.now() - 5 * DAY), openingRunId: r.run.id })
      .returning();

    // Tighten runs retention to 2 days → the 5-day-old run is expired.
    await ctx.dbHandle.db
      .insert(settings)
      .values({ key: SETTINGS_KEYS.runsDays, value: 2 })
      .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } });

    const result = await runRetention(ctx.dbHandle.db, artifactsRoot, pino({ level: 'silent' }));
    expect(result.deletedRuns).toBe(1);

    // Incident kept; its opening_run_id nulled by ON DELETE SET NULL.
    const [inc] = await ctx.dbHandle.db.select().from(incidents).where(eq(incidents.id, incident!.id));
    expect(inc).toBeDefined();
    expect(inc!.openingRunId).toBeNull();
  });
});
