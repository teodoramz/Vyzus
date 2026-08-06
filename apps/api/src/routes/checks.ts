import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createCheckBodySchema,
  updateCheckBodySchema,
  checkSchema,
  checkListSchema,
  enqueuedRunResponseSchema,
  uptimeConfigSchema,
  journeyConfigSchema,
  idParamSchema,
  appIdParamSchema,
  dryRunBodySchema,
  dryRunResultSchema,
  type CheckType,
} from '@vyzus/shared';
import { applications, checks } from '../db/schema.js';
import type { CheckConfigJson } from '../db/schema.js';
import { toCheck } from '../lib/mappers.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertAppAccess } from '../lib/access.js';

const CONFIG_SCHEMA_BY_TYPE = {
  uptime: uptimeConfigSchema,
  journey: journeyConfigSchema,
} as const;

function validateConfigForType(type: CheckType, config: unknown): CheckConfigJson {
  const parsed = CONFIG_SCHEMA_BY_TYPE[type].safeParse(config);
  if (!parsed.success) {
    throw badRequest(`config does not match check type '${type}'`, 'CONFIG_TYPE_MISMATCH');
  }
  return parsed.data;
}

export const checkRoutes: FastifyPluginAsyncZod = async (app) => {
  const write = [app.authenticate, app.requireRole('editor')];

  async function nextSortOrder(appId: string): Promise<number> {
    const [row] = await app.db
      .select({ next: sql<number>`coalesce(max(${checks.sortOrder}), -1) + 1` })
      .from(checks)
      .where(eq(checks.appId, appId));
    return row?.next ?? 0;
  }

  // GET /apps/:appId/checks
  app.get(
    '/apps/:appId/checks',
    { preHandler: app.authenticate, schema: { params: appIdParamSchema, response: { 200: checkListSchema } } },
    async (req) => {
      await assertAppAccess(app.db, req.authUser!, req.params.appId);
      const rows = await app.db
        .select()
        .from(checks)
        .where(eq(checks.appId, req.params.appId))
        .orderBy(asc(checks.sortOrder), asc(checks.createdAt));
      return rows.map(toCheck);
    },
  );

  // POST /apps/:appId/checks
  app.post(
    '/apps/:appId/checks',
    {
      preHandler: write,
      schema: { params: appIdParamSchema, body: createCheckBodySchema, response: { 201: checkSchema } },
    },
    async (req, reply) => {
      const { appId } = req.params;
      const [appRow] = await app.db.select().from(applications).where(eq(applications.id, appId)).limit(1);
      if (!appRow) throw notFound('Application not found');

      const b = req.body;
      const [row] = await app.db
        .insert(checks)
        .values({
          appId,
          type: b.type,
          name: b.name,
          intervalMinutes: b.intervalMinutes,
          timeoutMs: b.timeoutMs,
          failureThreshold: b.failureThreshold,
          enabled: b.enabled,
          config: b.config,
          sortOrder: await nextSortOrder(appId),
        })
        .returning();
      await app.scheduler.syncCheck(row!, appRow.enabled);
      return reply.status(201).send(toCheck(row!));
    },
  );

  // GET /checks/:id
  app.get(
    '/checks/:id',
    { preHandler: app.authenticate, schema: { params: idParamSchema, response: { 200: checkSchema } } },
    async (req) => {
      const [row] = await app.db.select().from(checks).where(eq(checks.id, req.params.id)).limit(1);
      if (!row) throw notFound('Check not found');
      await assertAppAccess(app.db, req.authUser!, row.appId);
      return toCheck(row);
    },
  );

  // PATCH /checks/:id — interval/enabled changes re-sync the schedule.
  app.patch(
    '/checks/:id',
    {
      preHandler: write,
      schema: { params: idParamSchema, body: updateCheckBodySchema, response: { 200: checkSchema } },
    },
    async (req) => {
      const { id } = req.params;
      const [existing] = await app.db.select().from(checks).where(eq(checks.id, id)).limit(1);
      if (!existing) throw notFound('Check not found');

      const patch: Partial<typeof checks.$inferInsert> = {};
      const b = req.body;
      if (b.name !== undefined) patch.name = b.name;
      if (b.intervalMinutes !== undefined) patch.intervalMinutes = b.intervalMinutes;
      if (b.timeoutMs !== undefined) patch.timeoutMs = b.timeoutMs;
      if (b.failureThreshold !== undefined) patch.failureThreshold = b.failureThreshold;
      if (b.enabled !== undefined) patch.enabled = b.enabled;
      if (b.type !== undefined) patch.type = b.type;
      if (b.config !== undefined) {
        const targetType = b.type ?? existing.type;
        patch.config = validateConfigForType(targetType, b.config);
      }

      const [row] = await app.db.update(checks).set(patch).where(eq(checks.id, id)).returning();

      // Any change to interval/enabled (or app disabled) must re-sync the repeatable.
      const [appRow] = await app.db.select().from(applications).where(eq(applications.id, row!.appId)).limit(1);
      await app.scheduler.syncCheck(row!, appRow?.enabled ?? false);
      return toCheck(row!);
    },
  );

  // DELETE /checks/:id
  app.delete('/checks/:id', { preHandler: write, schema: { params: idParamSchema } }, async (req, reply) => {
    const { id } = req.params;
    const [row] = await app.db.delete(checks).where(eq(checks.id, id)).returning({ id: checks.id });
    if (!row) throw notFound('Check not found');
    await app.scheduler.removeCheck(id);
    return reply.status(204).send();
  });

  // POST /checks/:id/run — run now (priority enqueue). Editor/admin
  // unrestricted; a viewer may run an existing check on an app they're
  // assigned to (running isn't "editing" it).
  app.post(
    '/checks/:id/run',
    { preHandler: app.authenticate, schema: { params: idParamSchema, response: { 202: enqueuedRunResponseSchema } } },
    async (req, reply) => {
      const { id } = req.params;
      const [row] = await app.db.select().from(checks).where(eq(checks.id, id)).limit(1);
      if (!row) throw notFound('Check not found');
      await assertAppAccess(app.db, req.authUser!, row.appId);
      const { runId } = await app.scheduler.enqueueRun(id, 'manual');
      return reply.status(202).send({ runId });
    },
  );

  // POST /checks/dry-run — run an unsaved config once, result inline, no
  // persistence. The API blocks on the BullMQ job return value with a
  // 30 s + timeout budget (04-api-spec). Static route wins over /checks/:id.
  app.post(
    '/checks/dry-run',
    { preHandler: write, schema: { body: dryRunBodySchema, response: { 200: dryRunResultSchema } } },
    async (req) => {
      const { appId, timeoutMs } = req.body;
      const [appRow] = await app.db.select().from(applications).where(eq(applications.id, appId)).limit(1);
      if (!appRow) throw notFound('Application not found');
      const budgetMs = 30_000 + timeoutMs;
      try {
        return await app.scheduler.dryRun(
          { dryRun: true, appId, type: req.body.type, config: req.body.config, timeoutMs },
          budgetMs,
        );
      } catch (err) {
        req.log.warn({ err }, 'dry-run did not complete');
        return {
          status: 'error' as const,
          durationMs: budgetMs,
          metrics: null,
          errorMessage: 'Dry run did not complete in time (is a worker running?)',
        };
      }
    },
  );
};
