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
 * Derived app status (03-data-model "Derived values") — based on `uptime`
 * checks only. A journey (user-simulation) check failing means some flow
 * broke, not that the site is down; mixing the two into one badge made a
 * broken login form look identical to a dead landing page. An uptime check
 * in `port` mode failing (e.g. 443 stopped accepting connections) is exactly
 * the same kind of "the thing itself is down" signal as one in `http` mode,
 * so no mode-based distinction is needed here — both are still `type ===
 * 'uptime'` rows. Availability numbers/charts on the app-detail page are
 * still per-check as before — this only narrows what drives the grid's
 * Up/Down badge.
 * - UNKNOWN — no uptime check exists at all (nothing to judge availability by)
 * - PAUSED  — app disabled, or every uptime check disabled
 * - UNKNOWN — an enabled uptime check exists but has never run
 * - DOWN    — any enabled uptime check's last_status is not `passed`
 * - UP      — otherwise
 */
export function deriveAppStatus(appEnabled: boolean, checks: CheckRow[]): AppStatus {
  const uptimeChecks = checks.filter((c) => c.type === 'uptime');
  if (uptimeChecks.length === 0) return 'UNKNOWN';
  const enabled = uptimeChecks.filter((c) => c.enabled);
  if (!appEnabled || enabled.length === 0) return 'PAUSED';
  const withStatus = enabled.filter((c) => c.lastStatus != null);
  if (withStatus.length === 0) return 'UNKNOWN';
  const anyDown = withStatus.some((c) => c.lastStatus !== 'passed');
  return anyDown ? 'DOWN' : 'UP';
}
