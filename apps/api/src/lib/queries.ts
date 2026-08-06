// Read helpers shared by the apps/checks routes: availability windows computed
// on demand from `runs`, and the derived application status.
import { and, gte, inArray, sql } from 'drizzle-orm';
import type { AppStatus } from '@vyzus/shared';
import type { Database } from '../db/index.js';
import { runs } from '../db/schema.js';
import type { CheckRow } from '../db/schema.js';

export const WINDOW_MS = {
  h24: 24 * 60 * 60 * 1000,
  d7: 7 * 24 * 60 * 60 * 1000,
  d30: 30 * 24 * 60 * 60 * 1000,
} as const;

/** Fraction of passed runs over [since, now] across the given checks; null if no runs. */
export async function availabilityForChecks(db: Database, checkIds: string[], since: Date): Promise<number | null> {
  if (checkIds.length === 0) return null;
  const rows = await db
    .select({
      total: sql<number>`count(*)::int`,
      passed: sql<number>`count(*) filter (where ${runs.status} = 'passed')::int`,
    })
    .from(runs)
    .where(and(inArray(runs.checkId, checkIds), gte(runs.startedAt, since)));
  const r = rows[0];
  if (!r || r.total === 0) return null;
  return r.passed / r.total;
}

/**
 * Derived app status (03-data-model "Derived values").
 *
 * `DOWN` means the application is unreachable, so it requires *every* liveness
 * check to be failing. One failing check out of several is `DEGRADED` — the
 * app has a problem, but calling that "down" would make a single broken check
 * indistinguishable from a total outage.
 *
 * Liveness = `uptime` checks (both `http` and `port` modes). A failing
 * `journey` can degrade an app but never marks it down: a broken login flow is
 * not a dead site. A journey alone therefore cannot produce `DOWN`, only
 * `DEGRADED`.
 *
 * - PAUSED   — app disabled, or every check disabled
 * - UNKNOWN  — no check has produced a result yet
 * - UP       — everything that has run is passing
 * - DOWN     — at least one liveness check exists and all of them are failing
 * - DEGRADED — anything else: some failing, some passing
 */
export function deriveAppStatus(appEnabled: boolean, checks: CheckRow[]): AppStatus {
  const relevant = checks.filter((c) => c.type === 'uptime' || c.type === 'journey');
  if (relevant.length === 0) return 'UNKNOWN';

  const enabled = relevant.filter((c) => c.enabled);
  if (!appEnabled || enabled.length === 0) return 'PAUSED';

  const withStatus = enabled.filter((c) => c.lastStatus != null);
  if (withStatus.length === 0) return 'UNKNOWN';

  const failing = withStatus.filter((c) => c.lastStatus !== 'passed');
  if (failing.length === 0) return 'UP';

  // Only liveness checks can express "unreachable". If every one of them has
  // run and every one is failing, the app is genuinely down.
  const liveness = withStatus.filter((c) => c.type === 'uptime');
  if (liveness.length > 0 && liveness.every((c) => c.lastStatus !== 'passed')) return 'DOWN';

  return 'DEGRADED';
}
