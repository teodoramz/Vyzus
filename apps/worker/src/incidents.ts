// Incident state machine (02-architecture §3 step 4).
// - failure: atomically bump checks.consecutive_failures; when it reaches
//   failure_threshold and no incident is open, open one (the partial unique
//   index `incidents_one_open_per_check_idx` makes this race-safe).
// - success: reset the counter; resolve any open incident.
// The caller enqueues alert jobs / publishes WS events from the returned
// transitions — this module only touches Postgres.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { checks, incidents, type CheckRow, type IncidentRow } from '@vyzus/shared/db';
import type { WorkerDatabase } from './db.js';

export interface RunOutcomeForIncidents {
  id: string;
  status: 'passed' | 'failed' | 'error' | 'timeout';
  startedAt: Date;
}

export interface IncidentTransitions {
  opened: IncidentRow | null;
  resolved: { incident: IncidentRow; downtimeSeconds: number } | null;
}

const UNIQUE_VIOLATION = '23505';

export async function evaluateIncident(
  db: WorkerDatabase,
  check: Pick<CheckRow, 'id' | 'failureThreshold'>,
  run: RunOutcomeForIncidents,
): Promise<IncidentTransitions> {
  if (run.status === 'passed') {
    await db.update(checks).set({ consecutiveFailures: 0 }).where(eq(checks.id, check.id));

    const [open] = await db
      .select()
      .from(incidents)
      .where(and(eq(incidents.checkId, check.id), isNull(incidents.resolvedAt)))
      .limit(1);
    if (!open) return { opened: null, resolved: null };

    const resolvedAt = new Date();
    const [resolvedRow] = await db
      .update(incidents)
      .set({ resolvedAt, resolvingRunId: run.id })
      .where(and(eq(incidents.id, open.id), isNull(incidents.resolvedAt)))
      .returning();
    if (!resolvedRow) return { opened: null, resolved: null }; // raced with another worker
    const downtimeSeconds = Math.max(0, Math.round((resolvedAt.getTime() - resolvedRow.openedAt.getTime()) / 1000));
    return { opened: null, resolved: { incident: resolvedRow, downtimeSeconds } };
  }

  // Failure path: atomic counter bump.
  const [bumped] = await db
    .update(checks)
    .set({ consecutiveFailures: sql`${checks.consecutiveFailures} + 1` })
    .where(eq(checks.id, check.id))
    .returning({ consecutiveFailures: checks.consecutiveFailures });
  const count = bumped?.consecutiveFailures ?? 0;
  if (count < check.failureThreshold) return { opened: null, resolved: null };

  const [existingOpen] = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(and(eq(incidents.checkId, check.id), isNull(incidents.resolvedAt)))
    .limit(1);
  if (existingOpen) return { opened: null, resolved: null };

  try {
    const [openedRow] = await db
      .insert(incidents)
      .values({ checkId: check.id, openedAt: run.startedAt, openingRunId: run.id })
      .returning();
    return { opened: openedRow ?? null, resolved: null };
  } catch (err) {
    // Another worker opened it between our SELECT and INSERT — fine.
    if (isUniqueViolation(err)) return { opened: null, resolved: null };
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
