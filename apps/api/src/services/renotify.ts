// Re-notification pass (backlog task 12). Runs on the same per-minute
// `maintenance` repeatable as the dead-man's switch, because both answer
// "given the current time, what should have been said by now".
//
// Alerting once and going quiet means an outage that opened at 02:00 is
// announced exactly once, into a channel nobody is reading. This re-announces
// open incidents on a configurable cadence until they resolve.
//
// Suppression is NOT re-implemented here: the reminder goes through the same
// `alerts` queue as the original, so an active maintenance window suppresses it
// at dispatch exactly like the first alert. Doing it any other way would mean
// planned work stayed silent for one message and then started paging.
import { and, eq, isNull, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { SETTINGS_KEYS, DEFAULT_RENOTIFY_MINUTES, dueForRenotify, type CheckAlertJobPayload } from '@vyzus/shared';
import type { Database } from '../db/index.js';
import { incidents, settings } from '../db/schema.js';

/** Same narrow seam as the heartbeat's publisher — see services/heartbeat.ts. */
export interface IncidentAlertPublisher {
  add(
    name: string,
    data: CheckAlertJobPayload,
    opts?: { removeOnComplete?: boolean; removeOnFail?: number },
  ): Promise<unknown>;
}

export interface RenotifyResult {
  /** Incidents re-announced on this pass. */
  renotified: string[];
}

export async function runRenotify(
  db: Database,
  alertsQueue: IncidentAlertPublisher,
  log: FastifyBaseLogger,
  now: Date = new Date(),
): Promise<RenotifyResult> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEYS.renotifyMinutes)).limit(1);
  const renotifyMinutes = row ? Number(row.value) : DEFAULT_RENOTIFY_MINUTES;
  if (renotifyMinutes <= 0) return { renotified: [] };

  const open = await db
    .select({
      incidentId: incidents.id,
      openedAt: incidents.openedAt,
      lastNotifiedAt: incidents.lastNotifiedAt,
    })
    .from(incidents)
    .where(isNull(incidents.resolvedAt));

  const due = dueForRenotify({ now, renotifyMinutes, candidates: open });
  if (due.length === 0) return { renotified: [] };

  // Stamp before publishing, not after. If the process dies between the two, a
  // reminder is skipped — which is far better than the alternative ordering,
  // where a crash loop would re-announce the same incident on every restart.
  await db
    .update(incidents)
    .set({ lastNotifiedAt: now })
    .where(
      and(
        inArray(
          incidents.id,
          due.map((d) => d.incidentId),
        ),
        isNull(incidents.resolvedAt),
      ),
    );

  for (const candidate of due) {
    const payload: CheckAlertJobPayload = { incidentId: candidate.incidentId, event: 'down' };
    await alertsQueue.add('check.down', payload, { removeOnComplete: true, removeOnFail: 100 });
  }
  log.info({ count: due.length, renotifyMinutes }, 'still-down reminders published');

  return { renotified: due.map((d) => d.incidentId) };
}
