// Job processor for the `checks` queue. Handles scheduled/manual/screenshot
// runs (persisted) and dry-runs (result returned inline, nothing persisted).
// A malformed or stale job must never crash the worker: it is logged and the
// job is failed/skipped (verification gate in docs/06).
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Job } from 'bullmq';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import {
  QUEUE_NAMES,
  CHECK_JOB_NAMES,
  RUN_FINISHED_CHANNEL,
  INCIDENT_OPENED_CHANNEL,
  INCIDENT_RESOLVED_CHANNEL,
  checkJobPayloadSchema,
  dryRunJobPayloadSchema,
  uptimeConfigSchema,
  journeyConfigSchema,
  pushConfigSchema,
  shouldCaptureScreenshot,
  type AlertJobPayload,
  type AppAuthConfig,
  type DryRunResult,
  type RunTrigger,
  type WsEvent,
} from '@vyzus/shared';
import { decryptJson } from '@vyzus/shared/crypto';
import { promises as fs } from 'node:fs';
import { applications, checks, runs, type ApplicationRow, type CheckRow } from '@vyzus/shared/db';
import type { WorkerConfig } from './config.js';
import type { WorkerDatabase } from './db.js';
import { ArtifactStore } from './artifacts.js';
import { comparePng, type DiffOutcome } from './visual-diff.js';
import { executeUptime } from './executors/uptime.js';
import { executeJourney } from './executors/journey.js';
import { executePort } from './executors/port.js';
import { executePush } from './executors/push.js';
import type { ExecutionResult } from './executors/types.js';
import { evaluateIncident } from './incidents.js';

export interface ProcessorDeps {
  db: WorkerDatabase;
  /** Non-blocking connection used for PUBLISH + the alerts producer queue. */
  redis: Redis;
  config: WorkerConfig;
  log: Logger;
  store: ArtifactStore;
}

/** Postgres error 23503 (foreign_key_violation), possibly wrapped by the ORM. */
function isForeignKeyViolation(err: unknown): boolean {
  for (let e = err; e !== null && typeof e === 'object'; e = (e as { cause?: unknown }).cause ?? null) {
    if ((e as { code?: unknown }).code === '23503') return true;
  }
  return false;
}

/**
 * Persists lastStatus/lastRunAt and, for uptime checks that stored a
 * screenshot, the timestamp driving the periodic refresh cadence.
 *
 * Every screenshot a run takes is kept. An earlier version superseded
 * screenshots within a pass/fail streak — a consecutive same-outcome run
 * deleted the previous run's file and nulled its `screenshot_path` — to avoid
 * accumulating near-identical images. That traded away history the operator
 * wanted, so capture frequency is now controlled solely on the way in (the
 * `screenshot` mode and `screenshotRefreshMinutes`), and nothing is removed
 * afterwards except by age-based retention.
 *
 * Concurrent runs of the *same* check are possible (a manual/screenshot
 * trigger landing next to a scheduled tick, or a burst of overdue repeatable
 * jobs draining after a worker restart). The advisory lock keyed by the check
 * id (auto-released at transaction end, no deadlock/leak risk) keeps their
 * updates to this row serialized, so the last writer wins cleanly instead of
 * interleaving.
 */
async function updateCheckAfterRun(
  db: WorkerDatabase,
  check: Pick<CheckRow, 'id' | 'type'>,
  startedAt: Date,
  result: Pick<ExecutionResult, 'status' | 'screenshotPath'>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${check.id}))`);

    const patch: { lastStatus: ExecutionResult['status']; lastRunAt: Date } & Partial<
      Pick<CheckRow, 'lastScreenshotAt'>
    > = { lastStatus: result.status, lastRunAt: startedAt };

    if (check.type === 'uptime' && result.screenshotPath) patch.lastScreenshotAt = startedAt;

    await tx.update(checks).set(patch).where(eq(checks.id, check.id));
  });
}

/** The configured visual-diff threshold, or 0 when this isn't an http-mode check. */
function uptimeVisualThreshold(config: CheckRow['config']): number {
  const parsed = uptimeConfigSchema.safeParse(config);
  if (!parsed.success || parsed.data.mode !== 'http') return 0;
  return parsed.data.visualDiffPercent;
}

/**
 * Compare this run's screenshot against the most recent earlier one for the
 * same check. Returns null when there is nothing to compare against (the first
 * capture, or a file retention has already removed) — a check with no baseline
 * passes rather than failing on our own missing data.
 */
async function compareWithPreviousScreenshot(
  db: WorkerDatabase,
  store: ArtifactStore,
  checkId: string,
  currentRunId: string,
  currentPath: string,
  log: ProcessorDeps['log'],
): Promise<DiffOutcome | null> {
  const [previous] = await db
    .select({ screenshotPath: runs.screenshotPath })
    .from(runs)
    .where(and(eq(runs.checkId, checkId), isNotNull(runs.screenshotPath), ne(runs.id, currentRunId)))
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(1);
  if (!previous?.screenshotPath) return null;

  try {
    const [before, after] = await Promise.all([
      fs.readFile(store.absolutePath(previous.screenshotPath)),
      fs.readFile(store.absolutePath(currentPath)),
    ]);
    return comparePng(before, after);
  } catch (err) {
    // A missing baseline file (retention, manual cleanup) must never fail a
    // run that is otherwise healthy.
    log.warn({ checkId, err }, 'visual diff skipped — could not read a screenshot');
    return null;
  }
}

export function createProcessor(deps: ProcessorDeps): {
  process: (job: Job) => Promise<DryRunResult | void>;
  close: () => Promise<void>;
} {
  const { db, redis, config, log, store } = deps;
  const alertsQueue = new Queue(QUEUE_NAMES.alerts, { connection: redis });

  async function publish(channel: string, event: WsEvent): Promise<void> {
    await redis.publish(channel, JSON.stringify(event)).catch((err) => {
      log.warn({ err, channel }, 'pub/sub publish failed');
    });
  }

  function decryptAuthConfig(app: ApplicationRow): AppAuthConfig | null {
    if (!app.authConfigEnc) return null;
    try {
      return decryptJson<AppAuthConfig>(app.authConfigEnc, config.ENCRYPTION_KEY);
    } catch (err) {
      log.error({ err, appId: app.id }, 'failed to decrypt app credentials — running without them');
      return null;
    }
  }

  async function loadCheckWithApp(checkId: string): Promise<{ check: CheckRow; app: ApplicationRow } | null> {
    const [row] = await db
      .select({ check: checks, app: applications })
      .from(checks)
      .innerJoin(applications, eq(checks.appId, applications.id))
      .where(eq(checks.id, checkId))
      .limit(1);
    return row ?? null;
  }

  async function execute(
    check: Pick<
      CheckRow,
      | 'type'
      | 'config'
      | 'timeoutMs'
      | 'lastStatus'
      | 'lastScreenshotAt'
      | 'intervalMinutes'
      | 'lastPingAt'
      | 'createdAt'
    >,
    app: Pick<ApplicationRow, 'id' | 'landingUrl'>,
    authConfig: AppAuthConfig | null,
    trigger: RunTrigger,
    artifactTarget: { appId: string; runId: string } | null,
  ): Promise<ExecutionResult> {
    const artifacts = artifactTarget ? { store, target: artifactTarget } : undefined;
    if (check.type === 'uptime') {
      const uptimeConfig = uptimeConfigSchema.parse(check.config);
      if (uptimeConfig.mode === 'port') {
        return executePort({ config: uptimeConfig, timeoutMs: check.timeoutMs });
      }

      // Evaluated by the executor once the outcome is known, so the policy can
      // depend on it without a second navigation. The Screenshot button always
      // captures, whatever the mode.
      return executeUptime(
        {
          landingUrl: app.landingUrl,
          authConfig,
          config: uptimeConfig,
          timeoutMs: check.timeoutMs,
          captureScreenshot:
            trigger === 'screenshot'
              ? () => true
              : (status) =>
                  shouldCaptureScreenshot({
                    mode: uptimeConfig.screenshot,
                    refreshMinutes: uptimeConfig.screenshotRefreshMinutes,
                    status,
                    previousStatus: check.lastStatus,
                    lastScreenshotAt: check.lastScreenshotAt,
                  }),
        },
        artifacts,
      );
    }
    if (check.type === 'push') {
      // No network call: the target reports in, so the "run" is a question
      // about time. Everything downstream — incidents, alerts, availability —
      // then works with no special case for this type.
      return executePush({
        config: pushConfigSchema.parse(check.config),
        intervalMinutes: check.intervalMinutes,
        lastPingAt: check.lastPingAt,
        createdAt: check.createdAt,
      });
    }

    const journeyConfig = journeyConfigSchema.parse(check.config);
    return executeJourney({ config: journeyConfig, timeoutMs: check.timeoutMs }, artifacts);
  }

  async function processDryRun(job: Job): Promise<DryRunResult> {
    const parsed = dryRunJobPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
      log.error({ jobId: job.id, issues: parsed.error.issues }, 'malformed dry-run payload');
      return { status: 'error', durationMs: 0, metrics: null, errorMessage: 'Malformed dry-run payload' };
    }
    const payload = parsed.data;
    const [app] = await db.select().from(applications).where(eq(applications.id, payload.appId)).limit(1);
    if (!app) {
      return { status: 'error', durationMs: 0, metrics: null, errorMessage: 'Application not found' };
    }
    try {
      const result = await execute(
        {
          type: payload.type,
          config: payload.config as CheckRow['config'],
          timeoutMs: payload.timeoutMs,
          // A dry run has no persisted check, and stores nothing.
          lastStatus: null,
          lastScreenshotAt: null,
          // Push fields: a dry run has never received a ping and was "created"
          // now, so it reports the honest answer — not yet overdue.
          intervalMinutes: 1,
          lastPingAt: null,
          createdAt: new Date(),
        },
        app,
        decryptAuthConfig(app),
        'manual',
        null, // no artifacts persisted for dry-runs
      );
      return {
        status: result.status,
        durationMs: result.durationMs,
        metrics: result.metrics,
        errorMessage: result.errorMessage,
      };
    } catch (err) {
      log.error({ err, jobId: job.id }, 'dry-run execution crashed');
      return {
        status: 'error',
        durationMs: 0,
        metrics: null,
        errorMessage: err instanceof Error ? err.message : 'Dry-run failed',
      };
    }
  }

  async function processRun(job: Job): Promise<void> {
    const parsed = checkJobPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
      // Log + fail the job; never crash the worker loop.
      log.error({ jobId: job.id, data: job.data, issues: parsed.error.issues }, 'malformed check job');
      throw new Error('Malformed check job payload');
    }
    const { checkId, trigger } = parsed.data;

    const loaded = await loadCheckWithApp(checkId);
    if (!loaded) {
      log.warn({ checkId }, 'check no longer exists — skipping (stale schedule)');
      return;
    }
    const { check, app } = loaded;

    // Disabled check/app: scheduled ticks are skipped quietly (reconcile will
    // clean the schedule up); explicit manual/screenshot requests still run.
    if (trigger === 'schedule' && (!check.enabled || !app.enabled)) {
      log.info({ checkId }, 'check disabled — skipping scheduled run');
      return;
    }

    // FR-3.2: 0–15 s jitter on scheduled runs only, so checks don't stampede.
    if (trigger === 'schedule' && config.MAX_JITTER_MS > 0) {
      await sleep(Math.floor(Math.random() * config.MAX_JITTER_MS));
    }

    const runId = parsed.data.runId ?? randomUUID();
    const startedAt = new Date();
    const result = await execute(check, app, decryptAuthConfig(app), trigger, {
      appId: app.id,
      runId,
    });

    // Visual regression, before the run is persisted so the verdict is stored
    // with it. Compared against the previous stored screenshot for this check —
    // which only exists because screenshots are no longer superseded.
    //
    // A passing run only: a run that already failed has its own reason, and
    // relabelling it as "looks different" would bury the real cause.
    if (
      result.status === 'passed' &&
      result.screenshotPath &&
      check.type === 'uptime' &&
      uptimeVisualThreshold(check.config) > 0
    ) {
      const outcome = await compareWithPreviousScreenshot(db, store, check.id, runId, result.screenshotPath, log);
      if (outcome) {
        result.metrics = { ...(result.metrics ?? {}), visualDiffPercent: Number(outcome.changedPercent.toFixed(3)) };
        const threshold = uptimeVisualThreshold(check.config);
        if (outcome.comparable && outcome.changedPercent >= threshold) {
          result.status = 'failed';
          result.errorMessage = `Page changed visually: ${outcome.changedPercent.toFixed(1)}% of pixels differ from the previous screenshot (limit ${threshold}%)${outcome.reason ? ` — ${outcome.reason}` : ''}`;
        }
      }
    }

    // Persist the run + denormalized check fields. The check (or its app) can be
    // deleted while the browser run is in flight — the cascade removes the checks
    // row, so this insert hits its FK. Discard the result instead of failing the
    // job (nothing to alert on; the entity is gone).
    try {
      await db.insert(runs).values({
        id: runId,
        checkId: check.id,
        status: result.status,
        trigger,
        startedAt,
        durationMs: result.durationMs,
        metrics: result.metrics,
        errorMessage: result.errorMessage,
        screenshotPath: result.screenshotPath,
        tracePath: result.tracePath,
        workerId: config.workerId,
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        log.warn({ checkId, runId }, 'check deleted mid-run — discarding result');
        return;
      }
      throw err;
    }
    await updateCheckAfterRun(db, check, startedAt, result);

    // Incident state machine + alerts + WS events.
    const transitions = await evaluateIncident(db, check, {
      id: runId,
      status: result.status,
      startedAt,
    });

    await publish(RUN_FINISHED_CHANNEL, {
      type: 'run.finished',
      appId: app.id,
      checkId: check.id,
      runId,
      status: result.status,
      durationMs: result.durationMs,
      hasScreenshot: result.screenshotPath != null,
    });

    if (transitions.opened) {
      const alertPayload: AlertJobPayload = { incidentId: transitions.opened.id, event: 'down' };
      await alertsQueue.add('check.down', alertPayload, {
        attempts: 2,
        backoff: { type: 'fixed', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: true,
      });
      await publish(INCIDENT_OPENED_CHANNEL, {
        type: 'incident.opened',
        appId: app.id,
        checkId: check.id,
        incidentId: transitions.opened.id,
      });
      log.warn({ checkId, incidentId: transitions.opened.id }, 'incident OPENED');
    }
    if (transitions.resolved) {
      const alertPayload: AlertJobPayload = {
        incidentId: transitions.resolved.incident.id,
        event: 'recovered',
      };
      await alertsQueue.add('check.recovered', alertPayload, {
        attempts: 2,
        backoff: { type: 'fixed', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: true,
      });
      await publish(INCIDENT_RESOLVED_CHANNEL, {
        type: 'incident.resolved',
        appId: app.id,
        checkId: check.id,
        incidentId: transitions.resolved.incident.id,
        downtimeSeconds: transitions.resolved.downtimeSeconds,
      });
      log.info({ checkId, incidentId: transitions.resolved.incident.id }, 'incident RESOLVED');
    }

    log.info({ checkId, runId, status: result.status, durationMs: result.durationMs, trigger }, 'run finished');
  }

  return {
    async process(job: Job): Promise<DryRunResult | void> {
      if (job.name === CHECK_JOB_NAMES.dryRun) return processDryRun(job);
      return processRun(job);
    },
    async close(): Promise<void> {
      await alertsQueue.close();
    },
  };
}
