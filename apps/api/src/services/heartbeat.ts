// Dead-man's switch (backlog task 4). A `maintenance` repeatable fires every
// minute; this evaluates whether the platform has gone silent and, on a
// transition, enqueues a platform-level alert.
//
// The failure it exists for: the worker container dies, checks stop running,
// nothing fails, no incident opens, no alert fires, and the dashboard serves
// the last known status forever. Silence looks exactly like health.
//
// Transitions only — the state lives in `settings` under
// `heartbeat.stalled_since`, so a continuing stall does not re-alert every
// minute, and recovery sends exactly one `resumed`.
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  QUEUE_NAMES,
  SETTINGS_KEYS,
  DEFAULT_HEARTBEAT_STALL_MINUTES,
  evaluateHeartbeat,
  type MonitoringAlertJobPayload,
} from '@vyzus/shared';
import type { Database } from '../db/index.js';
import { applications, checks, runs, settings } from '../db/schema.js';

/** Where the stall state is persisted. Not user-configurable, so not in SETTINGS_KEYS. */
const STALLED_SINCE_KEY = 'heartbeat.stalled_since';

/**
 * The only thing the heartbeat needs from the alerts queue. Narrow on purpose:
 * BullMQ's `Queue['add']` carries five generic parameters that a test double
 * would have to reproduce exactly, which tests nothing useful. A real `Queue`
 * satisfies this structurally.
 */
export interface AlertPublisher {
  add(
    name: string,
    data: MonitoringAlertJobPayload,
    opts?: { removeOnComplete?: boolean; removeOnFail?: number },
  ): Promise<unknown>;
}

export interface HeartbeatResult {
  stalled: boolean;
  silentForSeconds: number;
  effectiveThresholdMinutes: number;
  /** Set when this pass changed state and enqueued an alert. */
  transition: 'stalled' | 'resumed' | null;
}

async function readSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return row ? String(row.value) : null;
}

async function writeSetting(db: Database, key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } });
}

/**
 * One evaluation pass. `since` anchors the "never ran anything" case — without
 * it a fresh deployment with no runs at all reads as infinitely silent and
 * alerts immediately.
 */
export async function runHeartbeat(
  db: Database,
  alertsQueue: AlertPublisher,
  log: FastifyBaseLogger,
  now: Date = new Date(),
): Promise<HeartbeatResult> {
  const stallRaw = await readSetting(db, SETTINGS_KEYS.heartbeatStallMinutes);
  const stallMinutes = stallRaw == null ? DEFAULT_HEARTBEAT_STALL_MINUTES : Number(stallRaw);

  // Enabled checks on enabled applications — a paused app should not make the
  // platform look dead.
  const [agg] = await db
    .select({
      enabledChecks: sql<number>`count(*)::int`,
      shortestInterval: sql<number | null>`min(${checks.intervalMinutes})::int`,
      // Newest check creation, used as the "since" anchor when nothing has run.
      newestCheckAt: sql<Date | null>`max(${checks.createdAt})`,
    })
    .from(checks)
    .innerJoin(applications, eq(checks.appId, applications.id))
    .where(and(eq(checks.enabled, true), eq(applications.enabled, true)));

  const [last] = await db.select({ lastRunAt: sql<Date | null>`max(${runs.startedAt})` }).from(runs);

  const enabledChecks = agg?.enabledChecks ?? 0;
  const lastRunAt = last?.lastRunAt ? new Date(last.lastRunAt) : null;
  const since = agg?.newestCheckAt ? new Date(agg.newestCheckAt) : now;

  const verdict = evaluateHeartbeat({
    now,
    lastRunAt,
    enabledChecks,
    shortestIntervalMinutes: agg?.shortestInterval ?? null,
    stallMinutes,
    since,
  });

  const stalledSince = await readSetting(db, STALLED_SINCE_KEY);
  const wasStalled = stalledSince != null && stalledSince !== '';

  let transition: HeartbeatResult['transition'] = null;

  if (verdict.stalled && !wasStalled) {
    await writeSetting(db, STALLED_SINCE_KEY, now.toISOString());
    transition = 'stalled';
  } else if (!verdict.stalled && wasStalled) {
    await writeSetting(db, STALLED_SINCE_KEY, '');
    transition = 'resumed';
  }

  if (transition) {
    const payload: MonitoringAlertJobPayload = {
      event: transition,
      silentForSeconds: verdict.silentForSeconds,
      thresholdMinutes: verdict.effectiveThresholdMinutes,
      lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    };
    await alertsQueue.add(`monitoring.${transition}`, payload, { removeOnComplete: true, removeOnFail: 100 });
    log.warn({ ...payload, enabledChecks }, `monitoring ${transition}`);
  }

  return { ...verdict, transition };
}

/** Current stall state for `/stats`; null when healthy. */
export async function readStalledSince(db: Database): Promise<string | null> {
  const value = await readSetting(db, STALLED_SINCE_KEY);
  return value == null || value === '' ? null : value;
}

/** The alerts queue handle the heartbeat publishes to. */
export function createAlertsQueue(connection: Redis): Queue {
  return new Queue(QUEUE_NAMES.alerts, { connection: connection.duplicate({ maxRetriesPerRequest: null }) });
}
