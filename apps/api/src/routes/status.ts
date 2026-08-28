// Public status page.
//
// Unauthenticated and deliberately narrow. Applications opt IN
// (`applications.is_public`, default false) and the response has its own shape
// rather than reusing the authenticated views — see schemas/status.ts.
//
// Deliberately does not use lib/access.ts: that layer answers "what may this
// *user* see", and there is no user here. Passing it a null user would be the
// kind of shortcut that leaks the first time its defaults change.
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  statusPageSchema,
  DEFAULT_STATUS_PAGE_TITLE,
  SETTINGS_KEYS,
  type AppStatus,
  type PublicAppStatus,
  type PublicIncident,
  type StatusPage,
} from '@vyzus/shared';
import { applications, checks, incidents, runs, settings } from '../db/schema.js';
import { deriveAppStatus, WINDOW_MS } from '../lib/queries.js';
import { hitFixedWindow } from '../lib/fixed-window.js';
import { tooManyRequests } from '../lib/errors.js';

/**
 * Five queries per request on the only unauthenticated endpoint that touches
 * the database — uncached, a free amplification primitive. The payload derives
 * from check results that change on intervals of minutes, so the cache costs
 * no useful freshness.
 */
const CACHE_KEY = 'vyzus:status-page';
const CACHE_SECONDS = 30;
/** Generous for humans and any CDN in front; only a script notices it. */
const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 60;

/** Worst-first, so the headline reflects the most serious thing happening. */
const SEVERITY: AppStatus[] = ['DOWN', 'DEGRADED', 'UNKNOWN', 'PAUSED', 'UP'];

function worst(statuses: AppStatus[]): AppStatus {
  for (const s of SEVERITY) if (statuses.includes(s)) return s;
  return 'UP';
}

export const statusRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/', { schema: { response: { 200: statusPageSchema } } }, async (req, reply) => {
    const limit = await hitFixedWindow(app.redis, `vyzus:status-rl:${req.ip}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
    if (!limit.allowed) {
      reply.header('Retry-After', String(limit.retryAfterSeconds));
      throw tooManyRequests('Too many requests', 'RATE_LIMITED');
    }

    // Let a browser, proxy or CDN absorb repeats before they reach us.
    reply.header('Cache-Control', `public, max-age=${CACHE_SECONDS}`);

    const cached = await app.redis.get(CACHE_KEY);
    if (cached) return JSON.parse(cached) as StatusPage;

    const now = new Date();

    const [titleRow] = await app.db
      .select()
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEYS.statusPageTitle))
      .limit(1);
    const title = titleRow ? String(titleRow.value) : DEFAULT_STATUS_PAGE_TITLE;

    const publicApps = await app.db.select().from(applications).where(eq(applications.isPublic, true));
    if (publicApps.length === 0) {
      const empty = {
        title,
        overall: 'UNKNOWN' as const,
        applications: [],
        recentIncidents: [],
        generatedAt: now.toISOString(),
      };
      // Publishing nothing is the default state; it should not be the one
      // uncached path.
      await app.redis.set(CACHE_KEY, JSON.stringify(empty), 'EX', CACHE_SECONDS);
      return empty;
    }

    const appIds = publicApps.map((a) => a.id);
    const checkRows = await app.db.select().from(checks).where(inArray(checks.appId, appIds));
    const checksByApp = new Map<string, typeof checkRows>();
    for (const c of checkRows) {
      const list = checksByApp.get(c.appId) ?? [];
      list.push(c);
      checksByApp.set(c.appId, list);
    }

    // Two grouped queries rather than one per app: this is the most-hit
    // endpoint and is served to anyone, so it must not be an N+1.
    async function availability(sinceMs: number): Promise<Map<string, number | null>> {
      const rows = await app.db
        .select({
          appId: checks.appId,
          total: sql<number>`count(*)::int`,
          passed: sql<number>`count(*) filter (where ${runs.status} = 'passed')::int`,
        })
        .from(runs)
        .innerJoin(checks, eq(runs.checkId, checks.id))
        .where(and(inArray(checks.appId, appIds), gte(runs.startedAt, new Date(now.getTime() - sinceMs))))
        .groupBy(checks.appId);
      return new Map(rows.map((r) => [r.appId, r.total > 0 ? r.passed / r.total : null]));
    }
    const [avail24h, avail30d] = await Promise.all([availability(WINDOW_MS.h24), availability(WINDOW_MS.d30)]);

    const applicationsOut: PublicAppStatus[] = publicApps.map((a) => ({
      id: a.id,
      name: a.name,
      status: deriveAppStatus(a.enabled, checksByApp.get(a.id) ?? []),
      availability24h: avail24h.get(a.id) ?? null,
      availability30d: avail30d.get(a.id) ?? null,
    }));

    // Public applications only, stripped to timing. `appName` is the only
    // identity exposed; the check name would describe internal topology.
    const incidentRows = await app.db
      .select({
        id: incidents.id,
        appName: applications.name,
        openedAt: incidents.openedAt,
        resolvedAt: incidents.resolvedAt,
      })
      .from(incidents)
      .innerJoin(checks, eq(incidents.checkId, checks.id))
      .innerJoin(applications, eq(checks.appId, applications.id))
      .where(and(eq(applications.isPublic, true), gte(incidents.openedAt, new Date(now.getTime() - WINDOW_MS.d30))))
      .orderBy(desc(incidents.openedAt))
      .limit(20);

    const recentIncidents: PublicIncident[] = incidentRows.map((i) => ({
      id: i.id,
      appName: i.appName,
      openedAt: i.openedAt.toISOString(),
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
      downtimeSeconds: i.resolvedAt
        ? Math.max(0, Math.round((i.resolvedAt.getTime() - i.openedAt.getTime()) / 1000))
        : null,
    }));

    const page = {
      title,
      overall: worst(applicationsOut.map((a) => a.status)),
      applications: applicationsOut,
      recentIncidents,
      generatedAt: now.toISOString(),
    };
    await app.redis.set(CACHE_KEY, JSON.stringify(page), 'EX', CACHE_SECONDS);
    return page;
  });
};
