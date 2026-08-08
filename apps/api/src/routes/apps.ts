import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createAppBodySchema,
  updateAppBodySchema,
  appDetailSchema,
  appListSchema,
  listAppsQuerySchema,
  enqueuedRunResponseSchema,
  idParamSchema,
  appRunListQuerySchema,
  appRunListResponseSchema,
  reorderChecksBodySchema,
  checkListSchema,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_SCREENSHOT_REFRESH_MINUTES,
  type AppSummary,
  type AppDetail,
  type CheckWithAvailability,
  type HttpModeConfig,
} from '@vyzus/shared';
import { applications, checks, runs } from '../db/schema.js';
import type { ApplicationRow, CheckRow } from '../db/schema.js';
import { encryptJson } from '../lib/crypto.js';
import { toApp, toCheck, toAppRun } from '../lib/mappers.js';
import { availabilityForChecks, deriveAppStatus, WINDOW_MS } from '../lib/queries.js';
import { badRequest, notFound } from '../lib/errors.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { accessibleAppIds, assertAppAccess } from '../lib/access.js';

const editorOrAdmin = (app: Parameters<FastifyPluginAsyncZod>[0]) => [app.authenticate, app.requireRole('editor')];

function defaultUptimeConfig(): HttpModeConfig {
  return {
    mode: 'http',
    maxDurationMs: 0,
    visualDiffPercent: 0,
    certExpiryWarningDays: 0,
    expectedStatus: 200,
    screenshot: 'on_change',
    screenshotRefreshMinutes: DEFAULT_SCREENSHOT_REFRESH_MINUTES,
  };
}

async function loadAppDetail(app: Parameters<FastifyPluginAsyncZod>[0], appRow: ApplicationRow): Promise<AppDetail> {
  const checkRows = await app.db
    .select()
    .from(checks)
    .where(eq(checks.appId, appRow.id))
    .orderBy(asc(checks.sortOrder), asc(checks.createdAt));
  const now = Date.now();
  const checksWithAvail: CheckWithAvailability[] = await Promise.all(
    checkRows.map(async (c) => {
      const [a24, a7, a30] = await Promise.all([
        availabilityForChecks(app.db, [c.id], new Date(now - WINDOW_MS.h24)),
        availabilityForChecks(app.db, [c.id], new Date(now - WINDOW_MS.d7)),
        availabilityForChecks(app.db, [c.id], new Date(now - WINDOW_MS.d30)),
      ]);
      return { ...toCheck(c), availability24h: a24, availability7d: a7, availability30d: a30 };
    }),
  );
  return {
    ...toApp(appRow),
    status: deriveAppStatus(appRow.enabled, checkRows),
    checks: checksWithAvail,
  };
}

async function buildSummary(
  app: Parameters<FastifyPluginAsyncZod>[0],
  appRow: ApplicationRow,
  checkRows: CheckRow[],
): Promise<AppSummary> {
  const checkIds = checkRows.map((c) => c.id);
  const availability24h = await availabilityForChecks(app.db, checkIds, new Date(Date.now() - WINDOW_MS.h24));
  const ranChecks = checkRows.filter((c) => c.lastRunAt != null);
  ranChecks.sort((a, b) => b.lastRunAt!.getTime() - a.lastRunAt!.getTime());
  const mostRecent = ranChecks[0];

  let latestScreenshotRunId: string | null = null;
  if (checkIds.length > 0) {
    const [shot] = await app.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(inArray(runs.checkId, checkIds), isNotNull(runs.screenshotPath)))
      .orderBy(desc(runs.startedAt))
      .limit(1);
    latestScreenshotRunId = shot?.id ?? null;
  }

  // Overview embeds: response-time + sparkline series from the app's primary
  // (uptime, else first) check's recent runs — removes the dashboard's per-card
  // N+1 (GET /apps/:id/checks + GET /checks/:id/runs).
  const primaryCheck = checkRows.find((c) => c.type === 'uptime') ?? checkRows[0];
  let lastResponseTimeMs: number | null = null;
  let recentDurationsMs: number[] = [];
  if (primaryCheck) {
    const recent = await app.db
      .select({ durationMs: runs.durationMs })
      .from(runs)
      .where(eq(runs.checkId, primaryCheck.id))
      .orderBy(desc(runs.startedAt))
      .limit(20);
    recentDurationsMs = recent.map((r) => r.durationMs).reverse(); // oldest→newest
    lastResponseTimeMs = recent[0]?.durationMs ?? null;
  }

  return {
    ...toApp(appRow),
    status: deriveAppStatus(appRow.enabled, checkRows),
    availability24h,
    lastRun: mostRecent?.lastRunAt ? mostRecent.lastRunAt.toISOString() : null,
    lastStatus: mostRecent?.lastStatus ?? null,
    checksCount: checkRows.length,
    latestScreenshotRunId,
    lastResponseTimeMs,
    recentDurationsMs,
    checkStatuses: checkRows.map((c) => ({ id: c.id, type: c.type, lastStatus: c.lastStatus })),
  };
}

export const appRoutes: FastifyPluginAsyncZod = async (app) => {
  const write = editorOrAdmin(app);

  // GET /apps — overview grid with embedded summary.
  app.get(
    '/',
    { preHandler: app.authenticate, schema: { querystring: listAppsQuerySchema, response: { 200: appListSchema } } },
    async (req) => {
      const allowedIds = await accessibleAppIds(app.db, req.authUser!);
      let appRows = await app.db.select().from(applications).orderBy(applications.name);
      if (allowedIds !== null) appRows = appRows.filter((a) => allowedIds.includes(a.id));
      const allChecks = await app.db.select().from(checks);
      const byApp = new Map<string, CheckRow[]>();
      for (const c of allChecks) {
        const list = byApp.get(c.appId) ?? [];
        list.push(c);
        byApp.set(c.appId, list);
      }
      let summaries = await Promise.all(appRows.map((a) => buildSummary(app, a, byApp.get(a.id) ?? [])));
      if (req.query.tag) summaries = summaries.filter((s) => s.tags.includes(req.query.tag!));
      if (req.query.status) summaries = summaries.filter((s) => s.status === req.query.status);
      return summaries;
    },
  );

  // POST /apps — create app + default uptime check.
  app.post(
    '/',
    { preHandler: write, schema: { body: createAppBodySchema, response: { 201: appDetailSchema } } },
    async (req, reply) => {
      const { name, landingUrl, tags, authConfig, enabled, intervalMinutes } = req.body;
      const authConfigEnc = authConfig != null ? encryptJson(authConfig, app.encryptionKey) : null;

      const detail = await app.db.transaction(async (tx) => {
        const [appRow] = await tx
          .insert(applications)
          .values({ name, landingUrl, tags, authConfigEnc, enabled })
          .returning();
        const [checkRow] = await tx
          .insert(checks)
          .values({
            appId: appRow!.id,
            type: 'uptime',
            name: 'Landing uptime',
            intervalMinutes: intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
            config: defaultUptimeConfig(),
          })
          .returning();
        return { appRow: appRow!, checkRow: checkRow! };
      });

      // Sync the new check's schedule (Phase 3 scheduler; no-op stub for now).
      await app.scheduler.syncCheck(detail.checkRow, detail.appRow.enabled);
      return reply.status(201).send(await loadAppDetail(app, detail.appRow));
    },
  );

  // GET /apps/:id — full detail.
  app.get(
    '/:id',
    { preHandler: app.authenticate, schema: { params: idParamSchema, response: { 200: appDetailSchema } } },
    async (req) => {
      const [appRow] = await app.db.select().from(applications).where(eq(applications.id, req.params.id)).limit(1);
      if (!appRow) throw notFound('Application not found');
      await assertAppAccess(app.db, req.authUser!, appRow.id);
      return loadAppDetail(app, appRow);
    },
  );

  // PATCH /apps/:id — partial update; enabled toggles reschedule all checks.
  app.patch(
    '/:id',
    {
      preHandler: write,
      schema: { params: idParamSchema, body: updateAppBodySchema, response: { 200: appDetailSchema } },
    },
    async (req) => {
      const { id } = req.params;
      const [existing] = await app.db.select().from(applications).where(eq(applications.id, id)).limit(1);
      if (!existing) throw notFound('Application not found');

      const patch: Partial<typeof applications.$inferInsert> = {};
      if (req.body.name !== undefined) patch.name = req.body.name;
      if (req.body.landingUrl !== undefined) patch.landingUrl = req.body.landingUrl;
      if (req.body.tags !== undefined) patch.tags = req.body.tags;
      if (req.body.enabled !== undefined) patch.enabled = req.body.enabled;
      if (req.body.authConfig !== undefined) {
        patch.authConfigEnc = req.body.authConfig === null ? null : encryptJson(req.body.authConfig, app.encryptionKey);
      }

      const [appRow] = await app.db.update(applications).set(patch).where(eq(applications.id, id)).returning();

      // If enabled changed, re-sync every check's schedule.
      if (req.body.enabled !== undefined && req.body.enabled !== existing.enabled) {
        const checkRows = await app.db.select().from(checks).where(eq(checks.appId, id));
        if (!req.body.enabled) {
          await app.scheduler.removeChecksForApp(checkRows.map((c) => c.id));
        } else {
          for (const c of checkRows) await app.scheduler.syncCheck(c, true);
        }
      }
      return loadAppDetail(app, appRow!);
    },
  );

  // DELETE /apps/:id — cascade + remove schedules + artifact files.
  app.delete('/:id', { preHandler: write, schema: { params: idParamSchema } }, async (req, reply) => {
    const { id } = req.params;
    const checkRows = await app.db.select({ id: checks.id }).from(checks).where(eq(checks.appId, id));
    const [deleted] = await app.db
      .delete(applications)
      .where(eq(applications.id, id))
      .returning({ id: applications.id });
    if (!deleted) throw notFound('Application not found');

    await app.scheduler.removeChecksForApp(checkRows.map((c) => c.id));
    // Best-effort artifact cleanup — never fail the request on fs errors.
    const dir = path.join(app.config.ARTIFACTS_DIR, id);
    await fs.rm(dir, { recursive: true, force: true }).catch((err) => {
      req.log.warn({ err, dir }, 'failed to remove artifact directory');
    });
    return reply.status(204).send();
  });

  // POST /apps/:id/screenshot — on-demand screenshot on the app's uptime
  // check. Editor/admin unrestricted; a viewer may trigger this on an app
  // they're assigned to (running an existing check isn't "editing" it).
  app.post(
    '/:id/screenshot',
    { preHandler: app.authenticate, schema: { params: idParamSchema, response: { 202: enqueuedRunResponseSchema } } },
    async (req, reply) => {
      const { id } = req.params;
      const [appRow] = await app.db.select().from(applications).where(eq(applications.id, id)).limit(1);
      if (!appRow) throw notFound('Application not found');
      await assertAppAccess(app.db, req.authUser!, appRow.id);
      if (!appRow.enabled) throw badRequest('Application is disabled', 'APP_DISABLED');
      const [uptime] = await app.db
        .select()
        .from(checks)
        .where(and(eq(checks.appId, id), eq(checks.type, 'uptime')))
        .limit(1);
      if (!uptime) throw notFound('No uptime check for this application');
      const { runId } = await app.scheduler.enqueueRun(uptime.id, 'screenshot');
      return reply.status(202).send({ runId });
    },
  );

  // PUT /apps/:id/checks/order — persists check tab / "run all" order.
  // Body must be exactly the app's current check ids, reordered.
  app.put(
    '/:id/checks/order',
    {
      preHandler: write,
      schema: { params: idParamSchema, body: reorderChecksBodySchema, response: { 200: checkListSchema } },
    },
    async (req) => {
      const { id } = req.params;
      const { checkIds } = req.body;
      const existing = await app.db.select({ id: checks.id }).from(checks).where(eq(checks.appId, id));
      const existingIds = new Set(existing.map((c) => c.id));
      if (existingIds.size !== checkIds.length || !checkIds.every((cid) => existingIds.has(cid))) {
        throw badRequest("checkIds must be exactly the app's current check ids", 'INVALID_ORDER');
      }
      await app.db.transaction(async (tx) => {
        for (let i = 0; i < checkIds.length; i++) {
          await tx.update(checks).set({ sortOrder: i }).where(eq(checks.id, checkIds[i]!));
        }
      });
      const rows = await app.db
        .select()
        .from(checks)
        .where(eq(checks.appId, id))
        .orderBy(asc(checks.sortOrder), asc(checks.createdAt));
      return rows.map(toCheck);
    },
  );

  // GET /apps/:id/runs — run history merged across every check of the
  // application (not scoped to one check), with optional checkId/status
  // filters. Same keyset pagination as GET /checks/:id/runs.
  app.get(
    '/:id/runs',
    {
      preHandler: app.authenticate,
      schema: {
        params: idParamSchema,
        querystring: appRunListQuerySchema,
        response: { 200: appRunListResponseSchema },
      },
    },
    async (req) => {
      const { id } = req.params;
      const { cursor, limit, status, checkId, hasScreenshot } = req.query;
      await assertAppAccess(app.db, req.authUser!, id);

      const conditions = [eq(checks.appId, id)];
      if (checkId) conditions.push(eq(runs.checkId, checkId));
      if (status) conditions.push(eq(runs.status, status));
      // Filtered in SQL, not client-side, so a page of `limit` is `limit`
      // actual screenshots rather than `limit` raw runs mostly thrown away.
      if (hasScreenshot) conditions.push(isNotNull(runs.screenshotPath));
      if (cursor) {
        const c = decodeCursor(cursor);
        const cDate = new Date(c.s);
        conditions.push(or(lt(runs.startedAt, cDate), and(eq(runs.startedAt, cDate), lt(runs.id, c.id)))!);
      }

      const rows = await app.db
        .select({ run: runs, checkName: checks.name, checkType: checks.type })
        .from(runs)
        .innerJoin(checks, eq(runs.checkId, checks.id))
        .where(and(...conditions))
        .orderBy(desc(runs.startedAt), desc(runs.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last ? encodeCursor({ s: last.run.startedAt.toISOString(), id: last.run.id }) : null;
      return { runs: page.map((r) => toAppRun(r.run, { name: r.checkName, type: r.checkType })), nextCursor };
    },
  );
};
