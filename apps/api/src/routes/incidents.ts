import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { incidentListSchema, incidentPageResponseSchema, listIncidentsQuerySchema, idParamSchema } from '@vyzus/shared';
import { applications, checks, incidents } from '../db/schema.js';
import { toIncident } from '../lib/mappers.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { accessibleAppIds, assertAppAccess, viewerAppScope } from '../lib/access.js';

// Incidents joined with their owning check + app so responses carry
// appId/appName/checkName (banner + timeline render without follow-up fetches).
const INCIDENT_SELECT = {
  incident: incidents,
  appId: applications.id,
  appName: applications.name,
  checkName: checks.name,
} as const;

export const incidentRoutes: FastifyPluginAsyncZod = async (app) => {
  // GET /incidents?open=&appId=&cursor=&limit= — the global Incidents tab,
  // keyset-paginated on (opened_at, id) desc.
  app.get(
    '/incidents',
    {
      preHandler: app.authenticate,
      schema: { querystring: listIncidentsQuerySchema, response: { 200: incidentPageResponseSchema } },
    },
    async (req) => {
      const { open, appId, cursor, limit } = req.query;
      const conditions = [];
      if (open === true) conditions.push(isNull(incidents.resolvedAt));
      if (appId) conditions.push(eq(checks.appId, appId));
      const allowedIds = await accessibleAppIds(app.db, req.authUser!);
      const scope = viewerAppScope(allowedIds, checks.appId);
      if (scope) conditions.push(scope);
      if (cursor) {
        const c = decodeCursor(cursor);
        const cDate = new Date(c.s);
        conditions.push(or(lt(incidents.openedAt, cDate), and(eq(incidents.openedAt, cDate), lt(incidents.id, c.id)))!);
      }
      const rows = await app.db
        .select(INCIDENT_SELECT)
        .from(incidents)
        .innerJoin(checks, eq(incidents.checkId, checks.id))
        .innerJoin(applications, eq(checks.appId, applications.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(incidents.openedAt), desc(incidents.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? encodeCursor({ s: last.incident.openedAt.toISOString(), id: last.incident.id })
          : null;
      return {
        incidents: page.map((r) =>
          toIncident(r.incident, { appId: r.appId, appName: r.appName, checkName: r.checkName }),
        ),
        nextCursor,
      };
    },
  );

  // GET /apps/:id/incidents
  app.get(
    '/apps/:id/incidents',
    { preHandler: app.authenticate, schema: { params: idParamSchema, response: { 200: incidentListSchema } } },
    async (req) => {
      await assertAppAccess(app.db, req.authUser!, req.params.id);
      const rows = await app.db
        .select(INCIDENT_SELECT)
        .from(incidents)
        .innerJoin(checks, eq(incidents.checkId, checks.id))
        .innerJoin(applications, eq(checks.appId, applications.id))
        .where(eq(checks.appId, req.params.id))
        .orderBy(desc(incidents.openedAt))
        .limit(200);
      return rows.map((r) => toIncident(r.incident, { appId: r.appId, appName: r.appName, checkName: r.checkName }));
    },
  );
};
