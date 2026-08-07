// Retention (Phase 7 / FR-7). A daily `maintenance` repeatable enqueues a
// `{ task: 'retention' }` job that this API-side worker consumes:
//   - runs older than retention.runs_days      → delete artifact files, then row
//   - screenshots older than screenshots_days  → delete file, null the path
//   - traces older than traces_days            → delete file, null the path
// Files are always removed before the DB change (05-infrastructure: "files
// first, then rows") so a crash can't orphan a path that points at a missing
// file. Incidents are kept (opening/resolving_run_id are ON DELETE SET NULL).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { and, isNotNull, lt, inArray } from 'drizzle-orm';
import { QUEUE_NAMES, DEFAULT_RETENTION, SETTINGS_KEYS, maintenanceJobPayloadSchema } from '@vyzus/shared';
import type { Database } from '../db/index.js';
import { runs, settings } from '../db/schema.js';

export interface RetentionResult {
  deletedRuns: number;
  deletedScreenshots: number;
  deletedTraces: number;
}

interface RetentionDays {
  runsDays: number;
  screenshotsDays: number;
  tracesDays: number;
}

async function loadRetention(db: Database): Promise<RetentionDays> {
  const rows = await db.select().from(settings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (key: string, fallback: number): number => {
    const v = map.get(key);
    return typeof v === 'number' ? v : fallback;
  };
  return {
    runsDays: num(SETTINGS_KEYS.runsDays, DEFAULT_RETENTION.runsDays),
    screenshotsDays: num(SETTINGS_KEYS.screenshotsDays, DEFAULT_RETENTION.screenshotsDays),
    tracesDays: num(SETTINGS_KEYS.tracesDays, DEFAULT_RETENTION.tracesDays),
  };
}

async function removeFile(artifactsDir: string, relPath: string, log: FastifyBaseLogger): Promise<void> {
  const root = path.resolve(artifactsDir);
  const abs = path.resolve(root, relPath);
  // Never escape the artifacts root, and never remove the root itself.
  if (abs === root || !abs.startsWith(root + path.sep)) return;
  // recursive: run-directory removal (screenshot + trace together) needs it.
  await fs
    .rm(abs, { force: true, recursive: true })
    .catch((err) => log.warn({ err, abs }, 'retention: file remove failed'));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Run one retention pass. Batches keep memory bounded; files are removed before
 * the corresponding DB mutation.
 */
export async function runRetention(
  db: Database,
  artifactsDir: string,
  log: FastifyBaseLogger,
  nowMs = Date.now(),
): Promise<RetentionResult> {
  const days = await loadRetention(db);
  const result: RetentionResult = { deletedRuns: 0, deletedScreenshots: 0, deletedTraces: 0 };

  // 1) Expired runs — delete their whole artifact dir, then the row.
  const runsCutoff = new Date(nowMs - days.runsDays * DAY_MS);
  for (;;) {
    const batch = await db
      .select({ id: runs.id, screenshotPath: runs.screenshotPath, tracePath: runs.tracePath })
      .from(runs)
      .where(lt(runs.startedAt, runsCutoff))
      .limit(500);
    if (batch.length === 0) break;
    for (const r of batch) {
      // Remove the run's directory (covers screenshot + trace) then any stray files.
      const anyPath = r.screenshotPath ?? r.tracePath;
      if (anyPath) await removeFile(artifactsDir, path.dirname(anyPath), log);
    }
    await db.delete(runs).where(
      inArray(
        runs.id,
        batch.map((r) => r.id),
      ),
    );
    result.deletedRuns += batch.length;
    if (batch.length < 500) break;
  }

  // 2) Screenshots past screenshots_days (run itself still retained).
  const shotCutoff = new Date(nowMs - days.screenshotsDays * DAY_MS);
  for (;;) {
    const batch = await db
      .select({ id: runs.id, screenshotPath: runs.screenshotPath })
      .from(runs)
      .where(and(isNotNull(runs.screenshotPath), lt(runs.startedAt, shotCutoff)))
      .limit(500);
    if (batch.length === 0) break;
    for (const r of batch) {
      if (r.screenshotPath) await removeFile(artifactsDir, r.screenshotPath, log);
    }
    await db
      .update(runs)
      .set({ screenshotPath: null })
      .where(
        inArray(
          runs.id,
          batch.map((r) => r.id),
        ),
      );
    result.deletedScreenshots += batch.length;
    if (batch.length < 500) break;
  }

  // 3) Traces past traces_days.
  const traceCutoff = new Date(nowMs - days.tracesDays * DAY_MS);
  for (;;) {
    const batch = await db
      .select({ id: runs.id, tracePath: runs.tracePath })
      .from(runs)
      .where(and(isNotNull(runs.tracePath), lt(runs.startedAt, traceCutoff)))
      .limit(500);
    if (batch.length === 0) break;
    for (const r of batch) {
      if (r.tracePath) await removeFile(artifactsDir, r.tracePath, log);
    }
    await db
      .update(runs)
      .set({ tracePath: null })
      .where(
        inArray(
          runs.id,
          batch.map((r) => r.id),
        ),
      );
    result.deletedTraces += batch.length;
    if (batch.length < 500) break;
  }

  log.info(result, 'retention pass complete');
  return result;
}

export interface RetentionWorkerOptions {
  connection: Redis;
  db: Database;
  artifactsDir: string;
  log: FastifyBaseLogger;
  /** Invoked for `{ task: 'heartbeat' }` — the dead-man's switch pass. */
  onHeartbeat: () => Promise<void>;
}

/** Consume the `maintenance` queue in-process. */
export function startRetentionWorker(options: RetentionWorkerOptions): Worker {
  const { connection, db, artifactsDir, log } = options;
  const worker = new Worker(
    QUEUE_NAMES.maintenance,
    async (job) => {
      const parsed = maintenanceJobPayloadSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ jobId: job.id, data: job.data }, 'malformed maintenance job — dropping');
        return;
      }
      if (parsed.data.task === 'retention') await runRetention(db, artifactsDir, log);
      else await options.onHeartbeat();
    },
    { connection: connection.duplicate({ maxRetriesPerRequest: null }), concurrency: 1 },
  );
  worker.on('error', (err) => log.error({ err }, 'retention worker error'));
  return worker;
}
