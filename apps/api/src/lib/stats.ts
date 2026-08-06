// Aggregate counts for GET /stats and the throttled WS `stats.updated` event.
// `allowedAppIds` (viewer scoping, lib/access.ts accessibleAppIds): null means
// unrestricted (admin/editor); an array restricts every count to those apps —
// otherwise a viewer with one assigned app would see the platform's full
// up/down/incident numbers, which both confuses them and leaks that other
// apps exist.
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { applications, checks, incidents, runs } from '../db/schema.js';
import { deriveAppStatus, WINDOW_MS } from './queries.js';

export interface AppCounts {
  total: number;
  up: number;
  degraded: number;
  down: number;
  paused: number;
  unknown: number;
}

/** Derive per-app status for every application in one pass (two table scans). */
export async function computeAppCounts(db: Database, allowedAppIds: string[] | null = null): Promise<AppCounts> {
  const [appRows, checkRows] = await Promise.all([
    allowedAppIds === null
      ? db.select().from(applications)
      : allowedAppIds.length === 0
        ? Promise.resolve([])
        : db.select().from(applications).where(inArray(applications.id, allowedAppIds)),
    db.select().from(checks),
  ]);
  const byApp = new Map<string, typeof checkRows>();
  for (const c of checkRows) {
    const list = byApp.get(c.appId) ?? [];
    list.push(c);
    byApp.set(c.appId, list);
  }
  const counts: AppCounts = { total: appRows.length, up: 0, degraded: 0, down: 0, paused: 0, unknown: 0 };
  for (const app of appRows) {
    const status = deriveAppStatus(app.enabled, byApp.get(app.id) ?? []);
    if (status === 'UP') counts.up += 1;
    else if (status === 'DEGRADED') counts.degraded += 1;
    else if (status === 'DOWN') counts.down += 1;
    else if (status === 'PAUSED') counts.paused += 1;
    else counts.unknown += 1;
  }
  return counts;
}

export async function countOpenIncidents(db: Database, allowedAppIds: string[] | null = null): Promise<number> {
  if (allowedAppIds !== null && allowedAppIds.length === 0) return 0;
  const conditions = [isNull(incidents.resolvedAt)];
  if (allowedAppIds !== null) conditions.push(inArray(checks.appId, allowedAppIds));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(incidents)
    .innerJoin(checks, eq(incidents.checkId, checks.id))
    .where(and(...conditions));
  return row?.n ?? 0;
}

export async function countRunsSince(
  db: Database,
  since: Date,
  allowedAppIds: string[] | null = null,
): Promise<number> {
  if (allowedAppIds !== null && allowedAppIds.length === 0) return 0;
  const conditions = [gte(runs.startedAt, since)];
  if (allowedAppIds !== null) conditions.push(inArray(checks.appId, allowedAppIds));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .innerJoin(checks, eq(runs.checkId, checks.id))
    .where(and(...conditions));
  return row?.n ?? 0;
}

export interface FullStats {
  apps: { total: number; up: number; degraded: number; down: number; paused: number };
  openIncidents: number;
  queueDepth: number;
  runsLast24h: number;
}

export async function computeStats(
  db: Database,
  queueDepth: number,
  allowedAppIds: string[] | null = null,
): Promise<FullStats> {
  const [counts, openIncidents, runsLast24h] = await Promise.all([
    computeAppCounts(db, allowedAppIds),
    countOpenIncidents(db, allowedAppIds),
    countRunsSince(db, new Date(Date.now() - WINDOW_MS.h24), allowedAppIds),
  ]);
  return {
    apps: {
      total: counts.total,
      up: counts.up,
      degraded: counts.degraded,
      down: counts.down,
      paused: counts.paused,
    },
    openIncidents,
    queueDepth,
    runsLast24h,
  };
}
