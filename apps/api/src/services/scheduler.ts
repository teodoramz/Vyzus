// SchedulerService — the boundary between check-mutation routes and BullMQ.
//
// `BullMqSchedulerService` is the real implementation (Phase 3): it owns the
// `checks` Queue + QueueEvents, upserts/removes BullMQ Job Schedulers
// (repeatables) on check mutations, rebuilds Redis from the DB on boot
// (`reconcileSchedules`), enqueues priority-1 on-demand runs carrying an
// API-minted `runId`, and executes dry-runs by awaiting the job return value.
// `NoopSchedulerService` remains for tests that don't want a queue.
import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  QUEUE_NAMES,
  JOB_PRIORITY,
  CHECK_JOB_NAMES,
  checkRepeatableJobId,
  dryRunResultSchema,
  type CheckJobPayload,
  type DryRunJobPayload,
  type DryRunResult,
  type MaintenanceJobPayload,
  type RunTrigger,
} from '@vyzus/shared';
import type { Database } from '../db/index.js';
import { applications, checks, type CheckRow } from '../db/schema.js';

export interface SchedulerService {
  /**
   * Upsert or remove the BullMQ repeatable for a check after a create/update.
   * Enabled checks (with an enabled app) get a repeatable every
   * `intervalMinutes`; disabled ones have theirs removed. Idempotent.
   */
  syncCheck(check: CheckRow, appEnabled: boolean): Promise<void>;

  /** Remove a check's repeatable schedule (on delete or app disable). */
  removeCheck(checkId: string): Promise<void>;

  /** Remove every schedule belonging to an application's checks. */
  removeChecksForApp(checkIds: string[]): Promise<void>;

  /**
   * Enqueue a one-off, priority run (run-now / on-demand screenshot).
   * Returns the run id the worker will persist the resulting run under.
   */
  enqueueRun(checkId: string, trigger: RunTrigger): Promise<{ runId: string }>;

  /** Rebuild Redis repeatables from the DB (source of truth) on boot. Also
   * ensures the daily `maintenance` retention repeatable exists. */
  reconcileSchedules(): Promise<void>;

  /** Number of pending jobs on the `checks` queue (for GET /stats). */
  getQueueDepth(): Promise<number>;

  /**
   * Execute an unsaved check config once (POST /checks/dry-run): enqueue a
   * priority job with the config inlined and await its return value.
   */
  dryRun(payload: DryRunJobPayload, budgetMs: number): Promise<DryRunResult>;

  /** Release queue resources on shutdown. */
  close(): Promise<void>;
}

// docs/02 §4 job options: attempts 2, 30 s backoff, results live in Postgres.
const BASE_JOB_OPTS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'fixed', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

const JOB_NAME_FOR_TRIGGER: Record<RunTrigger, string> = {
  schedule: CHECK_JOB_NAMES.scheduled,
  manual: CHECK_JOB_NAMES.manual,
  screenshot: CHECK_JOB_NAMES.screenshot,
};

const MAINTENANCE_SCHEDULER_ID = 'maintenance:retention';
const MAINTENANCE_EVERY_MS = 24 * 60 * 60 * 1000; // daily

export class BullMqSchedulerService implements SchedulerService {
  private readonly queue: Queue;
  private readonly maintenanceQueue: Queue;
  private queueEvents: QueueEvents | null = null;

  constructor(
    private readonly connection: Redis,
    private readonly db: Database,
    private readonly log: FastifyBaseLogger,
  ) {
    this.queue = new Queue(QUEUE_NAMES.checks, { connection });
    this.maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, { connection });
  }

  async getQueueDepth(): Promise<number> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'prioritized', 'delayed');
    return Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  }

  /** Ensure the daily retention repeatable exists on the `maintenance` queue. */
  private async registerMaintenance(): Promise<void> {
    const payload: MaintenanceJobPayload = { task: 'retention' };
    await this.maintenanceQueue.upsertJobScheduler(
      MAINTENANCE_SCHEDULER_ID,
      { every: MAINTENANCE_EVERY_MS },
      { name: 'retention', data: payload, opts: { removeOnComplete: true, removeOnFail: true } },
    );
    this.log.info('maintenance retention repeatable registered (daily)');
  }

  /** Lazily created: QueueEvents holds a blocking Redis connection. */
  private events(): QueueEvents {
    if (!this.queueEvents) {
      this.queueEvents = new QueueEvents(QUEUE_NAMES.checks, {
        connection: this.connection.duplicate({ maxRetriesPerRequest: null }),
      });
    }
    return this.queueEvents;
  }

  async syncCheck(check: CheckRow, appEnabled: boolean): Promise<void> {
    if (check.enabled && appEnabled) {
      await this.upsertSchedule(check.id, check.intervalMinutes);
      this.log.info({ checkId: check.id, everyMin: check.intervalMinutes }, 'schedule upserted');
    } else {
      await this.removeCheck(check.id);
    }
  }

  private async upsertSchedule(checkId: string, intervalMinutes: number): Promise<void> {
    const data: CheckJobPayload = { checkId, trigger: 'schedule' };
    await this.queue.upsertJobScheduler(
      checkRepeatableJobId(checkId),
      { every: intervalMinutes * 60_000 },
      {
        name: CHECK_JOB_NAMES.scheduled,
        data,
        opts: { ...BASE_JOB_OPTS, priority: JOB_PRIORITY.scheduled },
      },
    );
  }

  async removeCheck(checkId: string): Promise<void> {
    await this.queue.removeJobScheduler(checkRepeatableJobId(checkId));
    this.log.info({ checkId }, 'schedule removed');
  }

  async removeChecksForApp(checkIds: string[]): Promise<void> {
    for (const id of checkIds) await this.removeCheck(id);
  }

  async enqueueRun(checkId: string, trigger: RunTrigger): Promise<{ runId: string }> {
    const runId = randomUUID();
    const data: CheckJobPayload = { checkId, trigger, runId };
    await this.queue.add(JOB_NAME_FOR_TRIGGER[trigger], data, {
      ...BASE_JOB_OPTS,
      priority: JOB_PRIORITY.onDemand,
    });
    this.log.info({ checkId, trigger, runId }, 'on-demand run enqueued');
    return { runId };
  }

  /**
   * DB is the source of truth; Redis is rebuilt to match (02-architecture §3.1).
   * Removes stale/orphaned schedulers, then (re)upserts one per enabled check
   * of an enabled app. Safe after a Redis flush.
   */
  async reconcileSchedules(): Promise<void> {
    const rows = await this.db
      .select({
        id: checks.id,
        intervalMinutes: checks.intervalMinutes,
        checkEnabled: checks.enabled,
        appEnabled: applications.enabled,
      })
      .from(checks)
      .innerJoin(applications, eq(checks.appId, applications.id));

    const desired = new Map<string, number>();
    for (const r of rows) {
      if (r.checkEnabled && r.appEnabled) {
        desired.set(checkRepeatableJobId(r.id), r.intervalMinutes * 60_000);
      }
    }

    const existing = await this.queue.getJobSchedulers(0, -1, true);
    let removed = 0;
    for (const s of existing) {
      if (!s.key) continue;
      const want = desired.get(s.key);
      if (want === undefined) {
        await this.queue.removeJobScheduler(s.key);
        removed += 1;
      }
    }
    for (const [key, every] of desired) {
      // key is `check:<uuid>` — recover the check id for the payload.
      const checkId = key.slice('check:'.length);
      const data: CheckJobPayload = { checkId, trigger: 'schedule' };
      await this.queue.upsertJobScheduler(
        key,
        { every },
        {
          name: CHECK_JOB_NAMES.scheduled,
          data,
          opts: { ...BASE_JOB_OPTS, priority: JOB_PRIORITY.scheduled },
        },
      );
    }
    this.log.info({ desired: desired.size, removedStale: removed }, 'schedules reconciled from DB');
    await this.registerMaintenance();
  }

  async dryRun(payload: DryRunJobPayload, budgetMs: number): Promise<DryRunResult> {
    const job = await this.queue.add(CHECK_JOB_NAMES.dryRun, payload, {
      priority: JOB_PRIORITY.onDemand,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
    const raw: unknown = await job.waitUntilFinished(this.events(), budgetMs);
    return dryRunResultSchema.parse(raw);
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.maintenanceQueue.close();
    if (this.queueEvents) await this.queueEvents.close();
  }
}

/**
 * No-op scheduler for tests that don't exercise the queue. It records intent in
 * the log but touches no Redis. `enqueueRun` still returns a fresh run id so
 * the API contract (202 { runId }) holds.
 */
export class NoopSchedulerService implements SchedulerService {
  constructor(private readonly log: FastifyBaseLogger) {}

  async syncCheck(check: CheckRow, appEnabled: boolean): Promise<void> {
    this.log.debug({ checkId: check.id, enabled: check.enabled, appEnabled }, 'scheduler(noop): syncCheck');
  }

  async removeCheck(checkId: string): Promise<void> {
    this.log.debug({ checkId }, 'scheduler(noop): removeCheck');
  }

  async removeChecksForApp(checkIds: string[]): Promise<void> {
    this.log.debug({ checkIds }, 'scheduler(noop): removeChecksForApp');
  }

  async enqueueRun(checkId: string, trigger: RunTrigger): Promise<{ runId: string }> {
    const runId = randomUUID();
    this.log.debug({ checkId, trigger, runId }, 'scheduler(noop): enqueueRun');
    return { runId };
  }

  async reconcileSchedules(): Promise<void> {
    this.log.info('scheduler(noop): reconcileSchedules');
  }

  async getQueueDepth(): Promise<number> {
    return 0;
  }

  async dryRun(_payload: DryRunJobPayload, _budgetMs: number): Promise<DryRunResult> {
    return { status: 'error', durationMs: 0, metrics: null, errorMessage: 'No scheduler configured' };
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
