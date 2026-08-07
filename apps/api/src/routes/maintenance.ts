// Maintenance windows (backlog task 6). Planned-work alert suppression, so a
// deploy does not page everyone attached to the application.
//
// Suppression is applied at alert dispatch (services/alerter.ts), never at the
// scheduler: checks keep running and every run is recorded, so the history
// stays honest and the dead-man's switch is unaffected.
import { and, desc, eq, gt, lte } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createMaintenanceWindowBodySchema,
  idParamSchema,
  maintenanceWindowListSchema,
  maintenanceWindowSchema,
  type MaintenanceWindow,
} from '@vyzus/shared';
import { applications, maintenanceWindows, users } from '../db/schema.js';
import { assertAppAccess } from '../lib/access.js';
import { forbidden, notFound } from '../lib/errors.js';

type Row = {
  window: typeof maintenanceWindows.$inferSelect;
  appName: string | null;
  createdByEmail: string | null;
};

function toWindow(row: Row, now: Date): MaintenanceWindow {
  const w = row.window;
  return {
    id: w.id,
    appId: w.appId,
    appName: row.appName,
    reason: w.reason,
    startsAt: w.startsAt.toISOString(),
    endsAt: w.endsAt.toISOString(),
    createdBy: w.createdBy,
    createdByEmail: row.createdByEmail,
    createdAt: w.createdAt.toISOString(),
    // Derived here rather than in each client, so everyone agrees on "now".
    active: w.startsAt.getTime() <= now.getTime() && now.getTime() < w.endsAt.getTime(),
  };
}

export const maintenanceRoutes: FastifyPluginAsyncZod = async (app) => {
  function selectWindows() {
    return app.db
      .select({
        window: maintenanceWindows,
        appName: applications.name,
        createdByEmail: users.email,
      })
      .from(maintenanceWindows)
      .leftJoin(applications, eq(maintenanceWindows.appId, applications.id))
      .leftJoin(users, eq(maintenanceWindows.createdBy, users.id));
  }

  // GET /maintenance — newest first. Readable by any authenticated user: a
  // viewer needs to know why their application stopped alerting.
  app.get(
    '/',
    { preHandler: app.authenticate, schema: { response: { 200: maintenanceWindowListSchema } } },
    async () => {
      const rows = await selectWindows().orderBy(desc(maintenanceWindows.startsAt));
      const now = new Date();
      return rows.map((r) => toWindow(r, now));
    },
  );

  // POST /maintenance — editor or admin. A platform-wide window (appId null)
  // is admin-only: silencing everything is a bigger decision than silencing
  // one application an editor already manages.
  app.post(
    '/',
    {
      preHandler: [app.authenticate, app.requireRole('editor')],
      schema: { body: createMaintenanceWindowBodySchema, response: { 201: maintenanceWindowSchema } },
    },
    async (req, reply) => {
      const { appId, reason, startsAt, endsAt } = req.body;
      // Silencing the whole platform is a bigger decision than silencing one
      // application an editor already manages.
      if (appId === null) {
        if (req.authUser!.role !== 'admin') throw forbidden('A platform-wide window requires role: admin');
      } else {
        await assertAppAccess(app.db, req.authUser!, appId);
      }

      const [created] = await app.db
        .insert(maintenanceWindows)
        .values({
          appId,
          reason,
          startsAt: new Date(startsAt),
          endsAt: new Date(endsAt),
          createdBy: req.authUser!.id,
        })
        .returning();

      const rows = await selectWindows().where(eq(maintenanceWindows.id, created!.id));
      req.log.info({ windowId: created!.id, appId, reason }, 'maintenance window created');
      return reply.status(201).send(toWindow(rows[0]!, new Date()));
    },
  );

  // DELETE /maintenance/:id — ends a window early (or removes a future one).
  app.delete(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('editor')], schema: { params: idParamSchema } },
    async (req, reply) => {
      const [deleted] = await app.db
        .delete(maintenanceWindows)
        .where(eq(maintenanceWindows.id, req.params.id))
        .returning({ id: maintenanceWindows.id });
      if (!deleted) throw notFound('Maintenance window not found');
      req.log.info({ windowId: deleted.id }, 'maintenance window removed');
      return reply.status(204).send();
    },
  );

  // GET /maintenance/active — just the ones suppressing right now, for the
  // dashboard banner.
  app.get(
    '/active',
    { preHandler: app.authenticate, schema: { response: { 200: maintenanceWindowListSchema } } },
    async () => {
      const now = new Date();
      const rows = await selectWindows().where(
        and(lte(maintenanceWindows.startsAt, now), gt(maintenanceWindows.endsAt, now)),
      );
      return rows.map((r) => toWindow(r, now));
    },
  );
};
